import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as runtime from "./runtime-archive-policy.mjs";

const { RUNTIME_ARCHIVE_POLICY: policies, inspectRuntimeTar, verifyRuntimeArchive } = runtime;
const rejected = {
  status: "rejected",
  executed: false,
  portableRuntime: false,
  nativeSupport: false,
};
type Entry = { path: string; data: Buffer; mode?: number; prefix?: string };
const marker = "fixture-private-sentinel-not-for-output";

function numeric(header: Buffer, offset: number, width: number, value: number) {
  header.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}

function checksum(header: Buffer) {
  header.fill(32, 148, 156);
  numeric(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
}

function tar(entries: Entry[], mutate?: (header: Buffer, index: number) => void) {
  return Buffer.concat([
    ...entries.flatMap((entry, index) => {
      const header = Buffer.alloc(512);
      header.write(entry.path, 0, 100, "ascii");
      numeric(header, 100, 8, entry.mode ?? 0o644);
      numeric(header, 108, 8, 0);
      numeric(header, 116, 8, 0);
      numeric(header, 124, 12, entry.data.length);
      numeric(header, 136, 12, 1);
      header[156] = 48;
      header.write("ustar\0", 257, "ascii");
      header.write("00", 263, "ascii");
      numeric(header, 329, 8, 0);
      numeric(header, 337, 8, 0);
      if (entry.prefix) header.write(entry.prefix, 345, 155, "ascii");
      mutate?.(header, index);
      checksum(header);
      return [header, entry.data, Buffer.alloc((512 - (entry.data.length % 512)) % 512)];
    }),
    Buffer.alloc(1024),
  ]);
}

function fixture(
  name: keyof typeof policies = "commander",
  changes: Record<string, unknown> = {},
): Entry[] {
  const policy = policies[name];
  const manifest = {
    name,
    version: policy.version,
    license: policy.license,
    main: policy.main,
    type: policy.type,
    ...{
      commander: { exports: { ".": { types: "./typings/index.d.ts", default: "./index.js" } } },
      semver: { bin: { semver: "bin/semver.js" } },
      yaml: {
        exports: {
          ".": {
            types: "./dist/index.d.ts",
            node: "./dist/index.js",
            default: "./browser/index.js",
          },
        },
        bin: "./bin.mjs",
      },
      zod: {
        exports: {
          ".": {
            "@zod/source": "./src/index.ts",
            types: "./index.d.cts",
            import: "./index.js",
            require: "./index.cjs",
          },
        },
        module: "./index.js",
      },
    }[name],
    ...changes,
  };
  return [
    { path: "package/package.json", data: Buffer.from(JSON.stringify(manifest)) },
    { path: "package/LICENSE", data: Buffer.from("Fixture license text") },
    ...policy.requiredFiles.map((path) => ({
      path: `package/${path}`,
      data: Buffer.from("inert fixture"),
    })),
  ];
}

function structural(entries = fixture(), mutate?: (header: Buffer, index: number) => void) {
  return inspectRuntimeTar("commander", tar(entries, mutate));
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.doUnmock("node:crypto");
  vi.doUnmock("node:zlib");
  vi.resetModules();
});

describe("fixed runtime archive policy", () => {
  it("has only fixed pins and claim-separated pure entrypoints", () => {
    expect(Object.keys(runtime).sort()).toEqual([
      "RUNTIME_ARCHIVE_POLICY",
      "inspectRuntimeTar",
      "runtimeArchiveFiles",
      "verifyRuntimeArchive",
    ]);
    expect(Object.keys(policies)).toEqual(["commander", "semver", "yaml", "zod"]);
    expect(Object.isFrozen(policies)).toBe(true);
    for (const policy of Object.values(policies)) {
      expect(Object.isFrozen(policy)).toBe(true);
      expect(Object.isFrozen(policy.requiredFiles)).toBe(true);
      expect(Buffer.from(policy.integrity.slice(7), "base64")).toHaveLength(64);
    }
  });

  it("matches current source manifests, lockfile packages, importers and empty runtime snapshots", () => {
    const require = createRequire(new URL("../packages/cli/package.json", import.meta.url));
    const { parse } = require("yaml") as {
      parse(input: string): {
        packages: Record<string, { resolution: { integrity: string } }>;
        snapshots: Record<string, object>;
        importers: Record<
          string,
          { dependencies: Record<string, { specifier: string; version: string }> }
        >;
      };
    };
    const lock = parse(readFileSync(new URL("../pnpm-lock.yaml", import.meta.url), "utf8"));
    for (const [packageName, expected] of Object.entries({
      core: ["semver", "zod"],
      cli: ["@agenthawk/core", "commander", "yaml", "zod"],
    })) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../packages/${packageName}/package.json`, import.meta.url), "utf8"),
      ) as { dependencies: Record<string, string>; version: string };
      expect(Object.keys(manifest.dependencies).sort()).toEqual(expected);
      expect(Object.keys(lock.importers[`packages/${packageName}`].dependencies).sort()).toEqual(
        expected,
      );
      expect(manifest.version).toBe("0.1.0-alpha.1");
      for (const field of [
        "optionalDependencies",
        "peerDependencies",
        "bundledDependencies",
        "bundleDependencies",
      ]) {
        expect(Object.hasOwn(manifest, field)).toBe(false);
        expect(Object.hasOwn(lock.importers[`packages/${packageName}`], field)).toBe(false);
      }
      if (packageName === "cli") {
        expect(manifest.dependencies["@agenthawk/core"]).toBe("workspace:*");
        expect(lock.importers["packages/cli"].dependencies["@agenthawk/core"]).toEqual({
          specifier: "workspace:*",
          version: "link:../core",
        });
      }
    }
    for (const [name, policy] of Object.entries(policies)) {
      expect(lock.packages[`${name}@${policy.version}`].resolution.integrity).toBe(
        policy.integrity,
      );
      expect(lock.snapshots[`${name}@${policy.version}`]).toEqual({});
      let uses = 0;
      for (const packageName of ["core", "cli"]) {
        const manifest = JSON.parse(
          readFileSync(new URL(`../packages/${packageName}/package.json`, import.meta.url), "utf8"),
        ) as { dependencies: Record<string, string> };
        if (!Object.hasOwn(manifest.dependencies, name)) continue;
        uses++;
        expect(manifest.dependencies[name]).toBe(policy.version);
        expect(lock.importers[`packages/${packageName}`].dependencies[name]).toEqual({
          specifier: policy.version,
          version: policy.version,
        });
      }
      expect(uses).toBeGreaterThan(0);
    }
  });

  it("uses real cryptography for the known SHA-512 vector and rejects that non-archive", () => {
    expect(createHash("sha512").update("abc").digest("hex")).toBe(
      "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
    );
    expect(verifyRuntimeArchive("commander", Buffer.from("abc"))).toEqual(rejected);
  });

  it("never exposes entries for structural, forged or rejected inventories", () => {
    const inventory = structural();
    for (const value of [
      inventory,
      { ...inventory, integrity: "sha512_pin_matched" },
      rejected,
      null,
      1,
    ])
      expect(runtime.runtimeArchiveFiles(value)).toBeUndefined();
  });

  it("copies entries only after complete checks (TEST-ONLY mocked pin and decoder)", async () => {
    const policy = policies.commander;
    const base = fixture();
    const baseSize = base.reduce((total, entry) => total + entry.data.length, 0);
    let complete: Buffer | undefined;
    for (let small = 0; small <= 5; small++) {
      const entries = [
        ...base,
        { path: "package/large-a", data: Buffer.alloc(policy.largestFile, 65) },
        { path: "package/large-b", data: Buffer.alloc(policy.largestFile, 66) },
        {
          path: "package/remainder",
          data: Buffer.alloc(policy.fileBytes - baseSize - 2 * policy.largestFile - small),
        },
        ...Array.from({ length: 5 }, (_, index) => ({
          path: `package/extra-${index}`,
          data: Buffer.alloc(index < small ? 1 : 0),
        })),
      ];
      const bytes = tar(entries);
      if (bytes.length === policy.tarBytes) complete = bytes;
    }
    if (!complete) throw new Error("fixture totals must match the independent policy");
    const originalHash = createHash;
    vi.doMock("node:crypto", () => ({
      createHash: (algorithm: string) =>
        algorithm === "sha512"
          ? {
              update() {
                return this;
              },
              digest() {
                return policy.integrity.slice(7);
              },
            }
          : originalHash(algorithm),
    }));
    vi.doMock("node:zlib", () => ({ gunzipSync: () => Buffer.from(complete as Buffer) }));
    const module = await import("./runtime-archive-policy.mjs");
    const result = module.verifyRuntimeArchive("commander", Buffer.alloc(policy.compressedBytes));
    expect(result.status).toBe("inventory");
    const files = module.runtimeArchiveFiles(result);
    expect(files).toHaveLength(policy.files);
    expect(module.runtimeArchiveFiles({ ...result })).toBeUndefined();
    if (!files) throw new Error("missing fixture entries");
    files[0].data.fill(1);
    files[0].path = "forged";
    const again = module.runtimeArchiveFiles(result);
    expect(again?.[0].path).toBe("package.json");
    expect(again?.[0].data).toEqual(base[0].data);
    expect(Object.keys(result)).not.toContain("data");
  });

  it.each([
    undefined,
    null,
    1,
    "__proto__",
    "toString",
    "commander@15.0.0",
    "Commander",
    {
      toString() {
        throw new Error(marker);
      },
    },
  ])("rejects unknown identity without coercion, case %#", (name) => {
    expect(verifyRuntimeArchive(name, Buffer.alloc(1))).toEqual(rejected);
    expect(inspectRuntimeTar(name, Buffer.alloc(1536))).toEqual(rejected);
  });

  it.each([
    null,
    undefined,
    "secret",
    new Uint8Array(1),
    new DataView(new ArrayBuffer(1)),
    new Proxy(Buffer.alloc(1), {}),
    Buffer.from(new SharedArrayBuffer(16)),
  ])("rejects non-Buffer or shared inputs, case %#", (bytes) => {
    expect(verifyRuntimeArchive("commander", bytes)).toEqual(rejected);
    expect(inspectRuntimeTar("commander", bytes)).toEqual(rejected);
  });

  it("reads intrinsic Buffer data without invoking hostile fields", () => {
    const bytes = tar(fixture());
    for (const key of ["length", "byteLength", "buffer", Symbol.iterator])
      Object.defineProperty(bytes, key, {
        get() {
          throw new Error(marker);
        },
      });
    expect(inspectRuntimeTar("commander", bytes).status).toBe("inventory");
  });

  it("rejects bounds and wrong compressed bytes before decompression", async () => {
    const decode = vi.fn(() => {
      throw new Error(marker);
    });
    vi.doMock("node:zlib", () => ({ gunzipSync: decode }));
    const module = await import("./runtime-archive-policy.mjs");
    for (const size of [
      0,
      policies.commander.compressedBytes - 1,
      policies.commander.compressedBytes,
      policies.commander.compressedBytes + 1,
    ])
      expect(module.verifyRuntimeArchive("commander", Buffer.alloc(size))).toEqual(rejected);
    expect(decode).not.toHaveBeenCalled();
  });

  it("catches decoder failure after a TEST-ONLY mocked hash; never a real pin success", async () => {
    vi.doMock("node:crypto", () => ({
      createHash: () => ({
        update() {
          return this;
        },
        digest() {
          return policies.commander.integrity.slice(7);
        },
      }),
    }));
    const decode = vi.fn(() => {
      throw new Error(marker);
    });
    vi.doMock("node:zlib", () => ({ gunzipSync: decode }));
    const module = await import("./runtime-archive-policy.mjs");
    expect(
      module.verifyRuntimeArchive("commander", Buffer.alloc(policies.commander.compressedBytes)),
    ).toEqual(rejected);
    expect(decode).toHaveBeenCalledWith(expect.any(Buffer), {
      maxOutputLength: policies.commander.tarBytes,
    });
  });

  it("bounds real decompression even with a TEST-ONLY mocked hash", async () => {
    vi.doMock("node:crypto", () => ({
      createHash: () => ({
        update() {
          return this;
        },
        digest() {
          return policies.commander.integrity.slice(7);
        },
      }),
    }));
    const module = await import("./runtime-archive-policy.mjs");
    const compressed = gzipSync(Buffer.alloc(policies.commander.tarBytes + 1));
    expect(
      module.verifyRuntimeArchive(
        "commander",
        Buffer.concat([
          compressed,
          Buffer.alloc(policies.commander.compressedBytes - compressed.length),
        ]),
      ),
    ).toEqual(rejected);
  });
});

describe("bounded structural tar inventory (not integrity evidence)", () => {
  it.each(Object.keys(policies) as (keyof typeof policies)[])(
    "accepts inert mechanics for %s and freezes redacted deterministic inventory",
    (name) => {
      const entries = fixture(name);
      const result = inspectRuntimeTar(name, tar(entries));
      expect(result.status).toBe("inventory");
      if (!("files" in result)) throw new Error("missing fixture inventory");
      expect(result.integrity).toBe("not_checked");
      expect(result.executed || result.portableRuntime || result.nativeSupport).toBe(false);
      expect(
        Object.isFrozen(result) &&
          Object.isFrozen(result.files) &&
          result.files.every(Object.isFrozen),
      ).toBe(true);
      expect(result.files.map((file) => file.path)).toEqual(
        entries.map((entry) => entry.path.slice(8)).sort(),
      );
      expect(result.files.find((file) => file.path === "LICENSE")?.sha256).toBe(
        createHash("sha256").update(entries[1].data).digest("hex"),
      );
      expect(result).toEqual(inspectRuntimeTar(name, tar([...entries].reverse())));
      expect(JSON.stringify(result)).not.toContain("Fixture license text");
      expect(verifyRuntimeArchive(name, gzipSync(tar(entries)))).toEqual(rejected);
    },
  );

  it("accepts reviewed executable mode and split ustar prefix", () => {
    const entries = fixture();
    entries[2] = {
      path: "index.js",
      data: Buffer.from("inert"),
      prefix: "package",
      mode: 0o755,
    } as Entry;
    expect(structural(entries).status).toBe("inventory");
  });

  it.each([
    "package/../secret",
    "package/./secret",
    "/package/file",
    "package//file",
    "package/file/",
    "other/file",
    "package",
    "package/.env",
    "package/.env.local",
    "package/.npmrc",
    "package/.git/config",
    "package/.ssh/key",
    "package/node_modules/foo",
    "package/credentials",
    "package/id_rsa",
    "package/CON.txt",
    "package/AUX",
    "package/com1",
    "package/file.",
    "package/file ",
    "package/a:b",
    "package/a\\b",
    "package/a\n",
    `package/${"a/".repeat(17)}z`,
  ])("rejects noncanonical or sensitive target %s", (path) => {
    expect(structural([...fixture(), { path, data: Buffer.from(marker) }])).toEqual(rejected);
  });

  it.each([
    ["extra", "extra"],
    ["extra", "Extra"],
    ["extra", "extra/child"],
    ["extra/child", "extra"],
    ["Dir/a", "dir/b"],
    ["Dir/a", "dir/a"],
  ])("rejects duplicate, case and file-prefix collisions %s %s", (first, second) => {
    expect(
      structural([
        ...fixture(),
        ...[first, second].map((path) => ({ path: `package/${path}`, data: Buffer.alloc(0) })),
      ]),
    ).toEqual(rejected);
  });

  it.each([49, 50, 51, 52, 53, 54, 55, 76, 75, 120, 103, 83])(
    "rejects nonregular typeflag %s",
    (type) => {
      expect(
        structural(fixture(), (header) => {
          header[156] = type;
        }),
      ).toEqual(rejected);
    },
  );

  it.each([0, 0o600, 0o777, 0o4755, 0o2644, 0o100644])("rejects unreviewed mode %s", (mode) => {
    expect(
      structural(fixture(), (header) => {
        numeric(header, 100, 8, mode);
      }),
    ).toEqual(rejected);
  });

  it.each([100, 108, 116, 124, 136, 329, 337])("rejects base-256 numeric field %s", (offset) => {
    expect(
      structural(fixture(), (header) => {
        header[offset] = 128;
      }),
    ).toEqual(rejected);
  });

  it.each([
    "        ",
    "\0\0\0\0\0\0\0\0",
    "0008\0\0\0\0",
    "0 01\0\0\0\0",
    "-001\0\0\0\0",
    "0001x\0\0\0",
  ])("rejects malformed required octal field %j", (value) => {
    expect(
      structural(fixture(), (header) => {
        header.write(value, 100, 8, "latin1");
      }),
    ).toEqual(rejected);
  });

  it("accepts entirely absent owner fields but rejects partial or malformed ownership", () => {
    expect(
      structural(fixture(), (header) => {
        header.fill(0, 108, 124);
      }).status,
    ).toBe("inventory");
    for (const start of [108, 116]) {
      expect(
        structural(fixture(), (header) => {
          header.fill(0, start, start + 8);
          header[start + 1] = 48;
        }),
      ).toEqual(rejected);
      expect(
        structural(fixture(), (header) => {
          header.fill(32, start, start + 8);
        }),
      ).toEqual(rejected);
    }
  });

  it.each([157, 257, 263, 329, 337, 500])(
    "rejects link, magic/version, device and reserved data at %s",
    (offset) => {
      expect(
        structural(fixture(), (header) => {
          header[offset] = 49;
        }),
      ).toEqual(rejected);
    },
  );

  it.each([0, 265, 297, 345])(
    "rejects controls/high bytes and bytes after field NUL at %s",
    (offset) => {
      expect(
        structural(fixture(), (header) => {
          header[offset] = 255;
        }),
      ).toEqual(rejected);
      expect(
        structural(fixture(), (header) => {
          header[offset] = 0;
          header[offset + 1] = 65;
        }),
      ).toEqual(rejected);
    },
  );

  it("rejects checksum mismatch and malformed checksum encoding", () => {
    const archive = tar(fixture());
    archive[100] ^= 1;
    expect(inspectRuntimeTar("commander", archive)).toEqual(rejected);
    archive[148] = 255;
    expect(inspectRuntimeTar("commander", archive)).toEqual(rejected);
  });

  it("does not mask high bits in the ustar version", () => {
    for (const offsets of [[263], [264], [263, 264]]) {
      expect(
        structural(fixture(), (header) => {
          for (const offset of offsets) header[offset] = 0xb0;
        }),
      ).toEqual(rejected);
    }
  });

  it("rejects truncated headers/content/terminators, extra records and nonzero padding", () => {
    const archive = tar(fixture());
    for (const size of [
      0,
      1,
      511,
      512,
      1024,
      archive.length - 1,
      archive.length - 512,
      archive.length - 1024,
    ])
      expect(inspectRuntimeTar("commander", archive.subarray(0, size))).toEqual(rejected);
    expect(inspectRuntimeTar("commander", Buffer.concat([archive, Buffer.alloc(512)]))).toEqual(
      rejected,
    );
    archive[1023] = 1;
    expect(inspectRuntimeTar("commander", archive)).toEqual(rejected);
    const badEnd = tar(fixture());
    badEnd[badEnd.length - 1] = 1;
    expect(inspectRuntimeTar("commander", badEnd)).toEqual(rejected);
  });

  it("rejects missing identity, license or required runtime files", () => {
    for (let index = 0; index < fixture().length; index++)
      expect(structural(fixture().filter((_, entryIndex) => index !== entryIndex))).toEqual(
        rejected,
      );
    const empty = fixture();
    empty[1].data = Buffer.from(" \n\t");
    expect(structural(empty)).toEqual(rejected);
  });

  it.each([null, [], 1, "private", "invalid-json", "\ufeff{}", { name: "wrong" }])(
    "rejects malformed manifest %j",
    (value) => {
      const entries = fixture();
      entries[0].data = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
      expect(structural(entries)).toEqual(rejected);
    },
  );

  it.each(["name", "version", "license", "main", "type"])(
    "rejects identity or entry metadata mismatch %s",
    (key) => {
      expect(structural(fixture("commander", { [key]: marker }))).toEqual(rejected);
    },
  );

  it.each([
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ])("requires absence of reviewed edge field %s even malformed/empty", (key) => {
    for (const value of [{}, [], null, true, { evil: "1.0.0" }])
      expect(structural(fixture("commander", { [key]: value }))).toEqual(rejected);
  });

  it.each([
    "preinstall",
    "install",
    "postinstall",
    "prepublish",
    "preprepare",
    "prepare",
    "postprepare",
    "prepack",
    "postpack",
  ])("rejects lifecycle hook %s without executing it", (hook) => {
    expect(structural(fixture("commander", { scripts: { [hook]: marker } }))).toEqual(rejected);
  });

  it("accepts publication-only scripts as inert data and rejects malformed scripts", () => {
    expect(
      structural(fixture("commander", { scripts: { prepublishOnly: marker, test: marker } }))
        .status,
    ).toBe("inventory");
    for (const value of [null, [], "bad", { test: null }])
      expect(structural(fixture("commander", { scripts: value }))).toEqual(rejected);
  });

  it("bounds bytes, file count, individual and aggregate data, manifest size", () => {
    expect(inspectRuntimeTar("commander", Buffer.alloc(policies.commander.tarBytes + 1))).toEqual(
      rejected,
    );
    const many = fixture();
    for (let i = 0; i < policies.commander.files; i++)
      many.push({ path: `package/extra${i}`, data: Buffer.alloc(0) });
    expect(structural(many)).toEqual(rejected);
    expect(
      structural([
        ...fixture(),
        { path: "package/large", data: Buffer.alloc(policies.commander.largestFile + 1) },
      ]),
    ).toEqual(rejected);
    const manifest = fixture();
    manifest[0].data = Buffer.alloc(65537);
    expect(structural(manifest)).toEqual(rejected);
    expect(
      structural([
        ...fixture(),
        { path: "package/a", data: Buffer.alloc(87647) },
        { path: "package/b", data: Buffer.alloc(87647) },
        { path: "package/c", data: Buffer.alloc(33000) },
      ]),
    ).toEqual(rejected);
    expect(
      structural(fixture(), (header) => {
        numeric(header, 124, 12, 80000);
      }),
    ).toEqual(rejected);
  });

  it("checks entrypoint/export targets as inert data and never resolves escaped paths", () => {
    expect(
      structural(
        fixture("commander", {
          exports: {
            ".": { types: "./typings/index.d.ts", default: "./index.js" },
            "./types/*": "./typings/*",
          },
          types: "typings/index.d.ts",
        }),
      ).status,
    ).toBe("inventory");
    for (const value of [
      null,
      [],
      3,
      "index.js",
      "../secret",
      "./missing.js",
      "./typings/../index.js",
      "./missing/*",
      "./typings/*/*",
    ])
      expect(
        structural(
          fixture("commander", {
            exports: {
              ".": { types: "./typings/index.d.ts", default: "./index.js" },
              "./bad": value,
            },
          }),
        ),
      ).toEqual(rejected);
    for (const key of ["module", "types", "bin"]) {
      expect(structural(fixture("commander", { [key]: null }))).toEqual(rejected);
      expect(structural(fixture("commander", { [key]: "../secret" }))).toEqual(rejected);
    }
    expect(structural(fixture("commander", { types: "./index.js" })).status).toBe("inventory");
    let deep: unknown = "./index.js";
    for (let i = 0; i < 14; i++) deep = { nested: deep };
    expect(
      structural(
        fixture("commander", {
          exports: {
            ".": { types: "./typings/index.d.ts", default: "./index.js" },
            "./deep": deep,
          },
        }),
      ),
    ).toEqual(rejected);
  });

  it.each(["commander", "semver", "yaml", "zod"] as const)(
    "rejects reviewed root selector drift for %s",
    (name) => {
      for (const value of [
        {},
        null,
        "./LICENSE",
        { ".": "./LICENSE" },
        { ".": { default: "./LICENSE" } },
      ]) {
        expect(inspectRuntimeTar(name, tar(fixture(name, { exports: value })))).toEqual(rejected);
      }
      for (const value of [null, "./LICENSE", { extra: "LICENSE" }]) {
        expect(inspectRuntimeTar(name, tar(fixture(name, { bin: value })))).toEqual(rejected);
        expect(inspectRuntimeTar(name, tar(fixture(name, { module: value })))).toEqual(rejected);
      }
    },
  );

  it.each(["commander", "yaml", "zod"] as const)(
    "rejects changed conditional export priority for %s",
    (name) => {
      const entries = fixture(name);
      const manifest = JSON.parse(entries[0].data.toString("utf8")) as {
        exports: Record<string, Record<string, string>>;
      };
      manifest.exports["."] = Object.fromEntries(Object.entries(manifest.exports["."]).reverse());
      entries[0].data = Buffer.from(JSON.stringify(manifest));
      expect(inspectRuntimeTar(name, tar(entries))).toEqual(rejected);
    },
  );

  it("never includes candidate bytes or caught diagnostics in rejections", () => {
    const result = structural([...fixture(), { path: `package/.env`, data: Buffer.from(marker) }]);
    expect(result).toEqual(rejected);
    expect(Object.isFrozen(result)).toBe(true);
    expect(JSON.stringify(result)).not.toContain(marker);
  });
});
