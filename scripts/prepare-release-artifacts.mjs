import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { gunzipSync } from "node:zlib";
import {
  packageSpecifications,
  releaseVersion,
  validateReleaseManifest,
} from "./package-policy.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const npmCli = {
  file: "npm-12.0.2.tgz",
  integrity:
    "sha512-uIXokLlBj6FpNUTQX1PmT5pz7BlIN9QlixX+zdaSNHsd0qUXsbDLr50xzY6Sw7cJVr0uzHKDOle0swmPW/p5Qw==",
  version: "12.0.2",
};

export async function prepareReleaseArtifacts({ outputDirectory, sourceCommit, npmTarball }) {
  assert(isAbsolute(outputDirectory), "release output directory must be absolute");
  assert(/^[0-9a-f]{40}$/u.test(sourceCommit), "source commit must be a lowercase full SHA");
  await mkdir(outputDirectory, { recursive: true });
  assert((await readdir(outputDirectory)).length === 0, "release output directory must be empty");

  const packages = [];
  for (const specification of packageSpecifications) {
    const directory = join(root, specification.directory);
    const sourceManifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
    validateReleaseManifest({ manifest: sourceManifest, specification });
    const expectedFile = `${specification.name.replace("@", "").replace("/", "-")}-${releaseVersion}.tgz`;
    await pack(directory, outputDirectory);
    const archivePath = join(outputDirectory, expectedFile);
    const archive = await readFile(archivePath);
    assert(archive.byteLength <= 1_000_000, `${specification.name} tarball is unexpectedly large`);
    const entries = readTarEntries(archive);
    assert(
      entries.reduce((total, entry) => total + entry.data.byteLength, 0) <=
        specification.maximumBytes,
      `${specification.name} tarball contents are unexpectedly large`,
    );
    const actualPaths = entries.map(({ path }) => path.replace(/^package\//u, "")).sort();
    const expectedPaths = [...specification.paths].sort();
    assert(
      JSON.stringify(actualPaths) === JSON.stringify(expectedPaths),
      `${specification.name} tarball differs from the reviewed allowlist`,
    );
    const manifestEntry = entries.find(({ path }) => path === "package/package.json");
    assert(manifestEntry !== undefined, `${specification.name} packed manifest is missing`);
    const packedManifest = JSON.parse(decodeUtf8(manifestEntry.data, "packed package manifest"));
    validateReleaseManifest({ manifest: packedManifest, specification, packed: true });
    packages.push({
      file: expectedFile,
      name: specification.name,
      sha256: digest(archive, "sha256", "hex"),
      unpackedFiles: actualPaths.length,
      version: releaseVersion,
    });
  }
  assert(
    JSON.stringify((await readdir(outputDirectory)).sort()) ===
      JSON.stringify(packages.map(({ file }) => file).sort()),
    "package creation emitted unexpected release files",
  );

  let verifiedNpm;
  if (npmTarball !== undefined) {
    const status = await lstat(npmTarball);
    assert(status.isFile() && !status.isSymbolicLink(), "npm CLI tarball must be a regular file");
    const archive = await readFile(npmTarball);
    assert(
      archive.byteLength > 0 && archive.byteLength <= 10_000_000,
      "npm CLI tarball size is invalid",
    );
    assert(
      `sha512-${digest(archive, "sha512", "base64")}` === npmCli.integrity,
      "npm CLI tarball integrity is invalid",
    );
    await copyFile(npmTarball, join(outputDirectory, npmCli.file));
    verifiedNpm = {
      file: npmCli.file,
      integrity: npmCli.integrity,
      sha256: digest(archive, "sha256", "hex"),
      version: npmCli.version,
    };
  }

  const manifest = {
    schemaVersion: "1.0",
    sourceCommit,
    version: releaseVersion,
    packages,
    npmCli: verifiedNpm,
    publication: {
      access: "public",
      provenance: true,
      promotion: "maintainer-2fa",
      staging: "npm-oidc",
      tag: "alpha",
    },
  };
  const manifestBytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  await writeFile(join(outputDirectory, "release-manifest.json"), manifestBytes, { flag: "wx" });

  const checksumTargets = [
    ...packages.map(({ file }) => file),
    ...(verifiedNpm === undefined ? [] : [verifiedNpm.file]),
    "release-manifest.json",
  ].sort();
  const checksumLines = [];
  for (const file of checksumTargets) {
    const bytes = await readFile(join(outputDirectory, file));
    checksumLines.push(`${digest(bytes, "sha256", "hex")}  ${file}`);
  }
  await writeFile(join(outputDirectory, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, {
    flag: "wx",
  });
  return manifest;
}

async function pack(directory, outputDirectory) {
  const pnpmCli = process.env.npm_execpath;
  assert(typeof pnpmCli === "string" && pnpmCli.length > 0, "pnpm CLI path is unavailable");
  await execute(
    process.execPath,
    [pnpmCli, "--dir", directory, "pack", "--pack-destination", outputDirectory],
    {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, npm_config_ignore_scripts: "true" },
      maxBuffer: 1_048_576,
      timeout: 30_000,
      windowsHide: true,
    },
  );
}

export function readTarEntries(archive) {
  const tar = gunzipSync(archive, { maxOutputLength: 2_000_000 });
  const entries = [];
  const seen = new Set();
  let terminated = false;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((value) => value === 0)) {
      assert(offset + 1_024 <= tar.length, "release tarball terminator is incomplete");
      const remainder = tar.subarray(offset);
      assert(
        remainder.every((value) => value === 0),
        "release tarball has data after its terminator",
      );
      terminated = true;
      break;
    }
    verifyTarChecksum(header);
    const name = tarText(header.subarray(0, 100));
    const prefix = tarText(header.subarray(345, 500));
    const path = prefix.length === 0 ? name : `${prefix}/${name}`;
    assert(/^package\/[A-Za-z0-9._/-]+$/u.test(path), `release tarball has unsafe path ${path}`);
    assert(
      !path.includes("//") && !path.split("/").includes(".."),
      `release tarball has unsafe path ${path}`,
    );
    const type = header[156];
    assert(type === 0 || type === 48, `release tarball has non-regular entry ${path}`);
    const size = tarNumber(header.subarray(124, 136));
    assert(Number.isSafeInteger(size) && size >= 0, `release tarball has invalid size for ${path}`);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    assert(dataEnd <= tar.length, `release tarball is truncated at ${path}`);
    assert(!seen.has(path), `release tarball repeats ${path}`);
    seen.add(path);
    entries.push({ data: tar.subarray(dataStart, dataEnd), path });
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  assert(terminated, "release tarball terminator is missing");
  assert(entries.length > 0, "release tarball is empty");
  return entries;
}

function verifyTarChecksum(header) {
  const expected = tarNumber(header.subarray(148, 156));
  let actual = 0;
  for (const [index, value] of header.entries()) {
    actual += index >= 148 && index < 156 ? 32 : value;
  }
  assert(actual === expected, "release tarball header checksum is invalid");
}

function tarNumber(value) {
  const text = tarText(value).trim();
  assert(/^[0-7]+$/u.test(text), "release tarball numeric field is invalid");
  return Number.parseInt(text, 8);
}

function tarText(value) {
  const end = value.indexOf(0);
  return value.subarray(0, end === -1 ? value.length : end).toString("utf8");
}

function decodeUtf8(value, label) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(value);
  } catch {
    throw new Error(`${label} is not valid UTF-8`);
  }
}

function digest(value, algorithm, encoding) {
  return createHash(algorithm).update(value).digest(encoding);
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const [, , outputDirectory, sourceCommit, npmTarball] = process.argv;
  assert(
    outputDirectory !== undefined,
    "usage: prepare-release-artifacts <output> <SHA> [npm.tgz]",
  );
  await prepareReleaseArtifacts({
    outputDirectory: resolve(outputDirectory),
    sourceCommit,
    npmTarball: npmTarball === undefined ? undefined : resolve(npmTarball),
  });
  process.stdout.write(`Prepared verified AgentHawk ${releaseVersion} release artifacts.\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
