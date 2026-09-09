import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { packageSpecifications, releaseVersion } from "./package-policy.mjs";
import { RUNTIME_ARCHIVE_POLICY } from "./runtime-archive-policy.mjs";
import * as production from "./runtime-assembly-inputs.mjs";

const rejected = {
  status: "rejected",
  executed: false,
  portableRuntime: false,
  nativeSupport: false,
};
const source = () => ({
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  lockfileSha256: "c".repeat(64),
  nodeVersion: "v24.14.0",
  pnpmVersion: "10.34.5",
  typescriptVersion: "7.0.2",
});
type Entry = { path: string; data: Buffer };
function archive(entries: Entry[], type = 48) {
  return gzipSync(
    Buffer.concat([
      ...entries.flatMap(({ path, data }) => {
        const header = Buffer.alloc(512);
        header.write(path, 0, 100);
        header.write(`${data.length.toString(8).padStart(11, "0")}\0`, 124, 12);
        header[156] = type;
        header.fill(32, 148, 156);
        const sum = header.reduce((total, byte) => total + byte, 0);
        header.write(`${sum.toString(8).padStart(7, "0")}\0`, 148, 8);
        return [header, data, Buffer.alloc((512 - (data.length % 512)) % 512)];
      }),
      Buffer.alloc(1024),
    ]),
  );
}
function ownEntries(index: number, mutate?: (value: Record<string, unknown>) => void): Entry[] {
  const specification = packageSpecifications[index];
  const manifest = JSON.parse(
    readFileSync(new URL(`../${specification.directory}/package.json`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
  if (index === 1)
    (manifest.dependencies as Record<string, string>)["@agenthawk/core"] = releaseVersion;
  mutate?.(manifest);
  return specification.paths.map((path) => ({
    path: `package/${path}`,
    data: Buffer.from(path === "package.json" ? JSON.stringify(manifest) : "inert fixture"),
  }));
}
function input() {
  return {
    source: source(),
    coreArchive: archive(ownEntries(0)),
    cliArchive: archive(ownEntries(1)),
    externalArchives: Object.fromEntries(
      Object.entries(RUNTIME_ARCHIVE_POLICY).map(([name, policy]) => [
        name,
        Buffer.alloc(policy.compressedBytes),
      ]),
    ),
  };
}

// Composition mechanics only: these mocks do not establish genuine archive pins.
async function composition() {
  const entries = [{ path: "LICENSE", data: Buffer.from("inert external fixture") }];
  const verify = vi.fn((name: keyof typeof RUNTIME_ARCHIVE_POLICY) => ({
    status: "inventory",
    name,
    files: [{}],
    fileBytes: entries[0].data.length,
  }));
  const files = vi.fn(() => entries.map((entry) => ({ ...entry, data: Buffer.from(entry.data) })));
  vi.doMock("./runtime-archive-policy.mjs", () => ({
    RUNTIME_ARCHIVE_POLICY,
    verifyRuntimeArchive: verify,
    runtimeArchiveFiles: files,
  }));
  return { module: await import("./runtime-assembly-inputs.mjs"), verify, files };
}

afterEach(() => {
  vi.doUnmock("./runtime-archive-policy.mjs");
  vi.resetModules();
});

describe("six-package input plan", () => {
  it("rejects real incorrect external pins without exposing any own entries", () => {
    const result = production.createRuntimeAssemblyPlan(input());
    expect(result).toEqual(rejected);
    expect(production.describeRuntimeAssemblyPlan(result)).toBeUndefined();
    expect(production.runtimeAssemblyFiles(result)).toBeUndefined();
  });

  it("brands only fully validated composition and preserves deterministic copied bytes", async () => {
    const { module, verify } = await composition();
    const value = input();
    const plan = module.createRuntimeAssemblyPlan(value);
    expect(plan.status).toBe("planned");
    expect(verify.mock.calls.map(([name]) => name)).toEqual(Object.keys(RUNTIME_ARCHIVE_POLICY));
    const description = module.describeRuntimeAssemblyPlan(plan);
    const files = module.runtimeAssemblyFiles(plan);
    if (!description || !files) throw new Error("missing fixture plan");
    expect(description.sourceBinding).toBe("caller_observation_only");
    expect(description.packages.map((entry) => entry.name)).toEqual([
      "@agenthawk/core",
      "@agenthawk/cli",
      "commander",
      "semver",
      "yaml",
      "zod",
    ]);
    expect(description.executed || description.portableRuntime || description.nativeSupport).toBe(
      false,
    );
    expect(
      Object.isFrozen(plan) &&
        Object.isFrozen(description) &&
        Object.isFrozen(description.source) &&
        Object.isFrozen(description.packages) &&
        description.packages.every(Object.isFrozen),
    ).toBe(true);
    expect(description.plannedTreeSha256).toBe(
      createHash("sha256")
        .update(JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))))
        .digest("hex"),
    );
    expect(files.every((file) => file.path.startsWith("runtime/node_modules/"))).toBe(true);
    const firstBytes = Buffer.from(files[0].data);
    value.coreArchive.fill(1);
    value.cliArchive.fill(2);
    value.source.commit = "d".repeat(40);
    for (const bytes of Object.values(value.externalArchives)) bytes.fill(3);
    files[0].data.fill(4);
    files[0].path = "forged";
    expect(module.runtimeAssemblyFiles(plan)?.[0].data).toEqual(firstBytes);
    expect(module.describeRuntimeAssemblyPlan(plan)?.source.commit).toBe("a".repeat(40));
    for (const forged of [
      { ...plan },
      JSON.parse(JSON.stringify(description)),
      null,
      undefined,
      1,
      rejected,
    ]) {
      expect(module.describeRuntimeAssemblyPlan(forged)).toBeUndefined();
      expect(module.runtimeAssemblyFiles(forged)).toBeUndefined();
    }
    expect(module.describeRuntimeAssemblyPlan(module.createRuntimeAssemblyPlan(input()))).toEqual(
      description,
    );
  });

  it.each(["source", "coreArchive", "cliArchive", "externalArchives"])(
    "rejects missing/accessor input %s without invoking it",
    (key) => {
      const value: Record<string, unknown> = input();
      delete value[key];
      expect(production.createRuntimeAssemblyPlan(value)).toEqual(rejected);
      const getter = vi.fn(() => {
        throw new Error("fixture-private-secret");
      });
      Object.defineProperty(value, key, { get: getter });
      expect(production.createRuntimeAssemblyPlan(value)).toEqual(rejected);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it.each([
    null,
    [],
    "fixture-private-secret",
    1,
    Object.create({}),
    new Proxy(
      {},
      {
        ownKeys() {
          throw new Error("fixture-private-secret");
        },
      },
    ),
  ])("rejects malformed input %# with closed redacted output", (value) => {
    expect(production.createRuntimeAssemblyPlan(value)).toEqual(rejected);
  });

  it("rejects extra keys, symbols, malformed source identities and tool versions", () => {
    for (const value of [
      { ...input(), extra: true },
      { ...input(), [Symbol("secret")]: true },
    ])
      expect(production.createRuntimeAssemblyPlan(value)).toEqual(rejected);
    for (const key of Object.keys(source()))
      for (const change of [undefined, "", "fixture-private-secret", "A".repeat(64), 1]) {
        const value = input();
        Object.assign(value.source, { [key]: change });
        expect(production.createRuntimeAssemblyPlan(value)).toEqual(rejected);
      }
    const value = input();
    Object.assign(value.source, { extra: true });
    expect(production.createRuntimeAssemblyPlan(value)).toEqual(rejected);
  });

  it("requires exact four external names without caller pins or overrides", () => {
    for (const change of [
      { extra: Buffer.alloc(1) },
      { commander: undefined },
      { url: "https://example.invalid" },
    ]) {
      const value = input();
      Object.assign(value.externalArchives, change);
      expect(production.createRuntimeAssemblyPlan(value)).toEqual(rejected);
    }
    const value = input();
    delete value.externalArchives.zod;
    expect(production.createRuntimeAssemblyPlan(value)).toEqual(rejected);
  });

  it.each([
    null,
    undefined,
    "fixture-private-secret",
    new Uint8Array(1),
    Buffer.from(new SharedArrayBuffer(1)),
    new Proxy(Buffer.alloc(1), {}),
    Buffer.alloc(0),
    Buffer.alloc(1_000_001),
  ])("rejects non-owned/bounded own buffer %#", (bytes) => {
    expect(production.createRuntimeAssemblyPlan({ ...input(), coreArchive: bytes })).toEqual(
      rejected,
    );
  });

  it("snapshots intrinsic Buffer bytes without invoking caller fields", async () => {
    const { module } = await composition();
    const value = input();
    for (const key of ["length", "byteLength", "buffer", Symbol.iterator])
      Object.defineProperty(value.coreArchive, key, {
        get() {
          throw new Error("not invoked");
        },
      });
    expect(module.createRuntimeAssemblyPlan(value).status).toBe("planned");
  });

  it("requires exact own allowlists, regular entries, valid UTF8 and bounded contents", () => {
    const variants = [
      ownEntries(0).slice(1),
      [...ownEntries(0), { path: "package/extra", data: Buffer.alloc(0) }],
      ownEntries(0).map((entry) => ({
        ...entry,
        path: entry.path.replace("dist/index.js", "dist/./index.js"),
      })),
      ownEntries(0).map((entry) =>
        entry.path === "package/LICENSE" ? { ...entry, data: Buffer.from(" \n") } : entry,
      ),
      ownEntries(0).map((entry) =>
        entry.path === "package/package.json" ? { ...entry, data: Buffer.from([255]) } : entry,
      ),
      ownEntries(0).map((entry) =>
        entry.path === "package/README.md" ? { ...entry, data: Buffer.alloc(250001) } : entry,
      ),
    ];
    for (const entries of variants)
      expect(
        production.createRuntimeAssemblyPlan({ ...input(), coreArchive: archive(entries) }),
      ).toEqual(rejected);
    expect(
      production.createRuntimeAssemblyPlan({ ...input(), coreArchive: archive(ownEntries(0), 50) }),
    ).toEqual(rejected);
    expect(
      production.createRuntimeAssemblyPlan({
        ...input(),
        coreArchive: gzipSync(Buffer.alloc(2_000_001)),
      }),
    ).toEqual(rejected);
  });

  it("rejects own manifest graph drift before external verification", async () => {
    const { module, verify } = await composition();
    const value = input();
    value.coreArchive = archive(
      ownEntries(0, (manifest) => {
        manifest.dependencies = { semver: "*", zod: "4.4.3" };
      }),
    );
    expect(module.createRuntimeAssemblyPlan(value)).toEqual(rejected);
    expect(verify).not.toHaveBeenCalled();
  });

  it("does not brand partial verification or a forged inventory with no entry capability", async () => {
    const { module, files } = await composition();
    files.mockImplementationOnce(() => undefined as never);
    const result = module.createRuntimeAssemblyPlan(input());
    expect(result).toEqual(rejected);
    expect(module.runtimeAssemblyFiles(result)).toBeUndefined();
  });
});
