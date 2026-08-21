import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import {
  packageSpecifications,
  releaseVersion,
  validatePackageReport,
  validateReleaseManifest,
} from "../../../scripts/package-policy.mjs";
import { readTarEntries } from "../../../scripts/prepare-release-artifacts.mjs";

const specification = packageSpecifications.find(({ directory }) => directory === "packages/cli");
const manifest = { name: "@agenthawk/cli" };
const workspace = resolve(import.meta.dirname, "../../..");
const regular = async () => ({
  isDirectory: () => true,
  isFile: () => true,
  isSymbolicLink: () => false,
});

describe("package content policy", () => {
  it("accepts only the complete reviewed manifest", async () => {
    await expect(validate(specification.paths)).resolves.toBeUndefined();
  });

  it("rejects every omitted runtime module", async () => {
    for (const path of specification.paths.filter((value) => value.startsWith("dist/"))) {
      await expect(validate(specification.paths.filter((value) => value !== path))).rejects.toThrow(
        "reviewed allowlist",
      );
    }
  });

  it.each([
    "DIST/SRC/evil.ts",
    "dist\\src\\evil.ts",
    "dist/.ENV",
    ".NPMRC",
    "evil.MAP",
    "evil.TGZ",
    "../outside.js",
    "/absolute.js",
  ])("rejects hostile path %s", async (path) => {
    await expect(validate([...specification.paths, path])).rejects.toThrow();
  });

  it("rejects symlinks and non-regular files", async () => {
    const symlink = async () => ({
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => true,
    });
    const directory = async () => ({
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    });
    await expect(validate(specification.paths, symlink)).rejects.toThrow("non-regular");
    await expect(validate(specification.paths, directory)).rejects.toThrow("non-regular");
  });

  it.each([-1, 0, 1.5, 150_001, "1", null])("rejects invalid unpacked size %s", async (size) => {
    await expect(validate(specification.paths, regular, size)).rejects.toThrow(
      "unexpectedly large",
    );
  });
});

describe("release manifest policy", () => {
  it("accepts both reviewed source manifests", async () => {
    for (const current of packageSpecifications) {
      const source = await sourceManifest(current);
      expect(() =>
        validateReleaseManifest({ manifest: source, specification: current }),
      ).not.toThrow();
    }
  });

  it("accepts only an exact CLI dependency in the packed manifest", async () => {
    const source = await sourceManifest(specification);
    const packed = structuredClone(source);
    packed.dependencies["@agenthawk/core"] = releaseVersion;
    expect(() =>
      validateReleaseManifest({ manifest: packed, specification, packed: true }),
    ).not.toThrow();
    packed.dependencies["@agenthawk/core"] = "^0.1.0-alpha.1";
    expect(() =>
      validateReleaseManifest({ manifest: packed, specification, packed: true }),
    ).toThrow("exact core release version");
  });

  it.each([
    ["private flag", (value) => (value.private = true)],
    ["wrong version", (value) => (value.version = "0.1.0-alpha.2")],
    ["missing disclosure", (value) => value.files.pop()],
    ["wrong dual-use declaration", (value) => (value.contentPolicy.class = "benign")],
    ["public access removed", (value) => (value.publishConfig.access = "restricted")],
    ["provenance disabled", (value) => (value.publishConfig.provenance = false)],
    ["registry redirected", (value) => (value.publishConfig.registry = "https://example.invalid/")],
    ["Node engine widened", (value) => (value.engines.node = ">=20")],
    ["stable tag selected", (value) => (value.publishConfig.tag = "latest")],
    ["publish lifecycle added", (value) => (value.scripts.prepublishOnly = "node publish.js")],
    ["bundled dependency added", (value) => (value.bundleDependencies = ["commander"])],
  ])("rejects %s", async (_label, mutate) => {
    const source = structuredClone(await sourceManifest(specification));
    mutate(source);
    expect(() => validateReleaseManifest({ manifest: source, specification })).toThrow();
  });
});

describe("release tar policy", () => {
  it("accepts a checksummed regular entry with a complete terminator", () => {
    const entries = readTarEntries(tarArchive());
    expect(entries).toHaveLength(1);
    expect(entries[0]?.path).toBe("package/package.json");
    expect(entries[0]?.data.toString("utf8")).toBe("{}");
  });

  it.each([
    ["path traversal", { path: "package/../outside" }],
    ["symbolic link", { type: 50 }],
    ["bad checksum", { corruptChecksum: true }],
    ["missing terminator", { terminatorBlocks: 0 }],
    ["incomplete terminator", { terminatorBlocks: 1 }],
    ["data after terminator", { trailing: Buffer.from("x") }],
  ])("rejects %s", (_label, options) => {
    expect(() => readTarEntries(tarArchive(options))).toThrow();
  });
});

async function validate(paths, stat = regular, unpackedSize = 1) {
  return validatePackageReport({
    directory: "/safe/package",
    manifest,
    report: {
      name: manifest.name,
      unpackedSize,
      files: paths.map((path) => ({ path })),
    },
    specification,
    stat,
  });
}

async function sourceManifest(current) {
  return JSON.parse(await readFile(join(workspace, current.directory, "package.json"), "utf8"));
}

function tarArchive({
  path = "package/package.json",
  type = 48,
  corruptChecksum = false,
  terminatorBlocks = 2,
  trailing = Buffer.alloc(0),
} = {}) {
  const data = Buffer.from("{}", "utf8");
  const header = Buffer.alloc(512);
  header.write(path, 0, 100, "utf8");
  writeOctal(header, 124, 12, data.byteLength);
  header[156] = type;
  header.fill(32, 148, 156);
  const checksum = header.reduce((total, value) => total + value, 0);
  header.write(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8, "ascii");
  if (corruptChecksum) header[0] ^= 1;
  const padding = Buffer.alloc(Math.ceil(data.byteLength / 512) * 512 - data.byteLength);
  return gzipSync(
    Buffer.concat([header, data, padding, Buffer.alloc(terminatorBlocks * 512), trailing]),
  );
}

function writeOctal(buffer, offset, width, value) {
  buffer.write(`${value.toString(8).padStart(width - 1, "0")}\0`, offset, width, "ascii");
}
