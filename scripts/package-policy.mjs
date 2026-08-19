import { lstat } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const packageSpecifications = [
  {
    directory: "packages/core",
    maximumBytes: 250_000,
    paths: [
      "LICENSE",
      "README.md",
      "dist/approvals/index.d.ts",
      "dist/approvals/index.js",
      "dist/cache/metadata-cache.d.ts",
      "dist/cache/metadata-cache.js",
      "dist/cli-contract.d.ts",
      "dist/cli-contract.js",
      "dist/config.d.ts",
      "dist/config.js",
      "dist/domain.d.ts",
      "dist/domain.js",
      "dist/http/safe-http-client.d.ts",
      "dist/http/safe-http-client.js",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/npm/provider.d.ts",
      "dist/npm/provider.js",
      "dist/npm/spec.d.ts",
      "dist/npm/spec.js",
      "dist/osv/provider.d.ts",
      "dist/osv/provider.js",
      "dist/policy/engine.d.ts",
      "dist/policy/engine.js",
      "dist/scan/dependencies.d.ts",
      "dist/scan/dependencies.js",
      "dist/time.d.ts",
      "dist/time.js",
      "package.json",
    ],
  },
  {
    directory: "packages/cli",
    maximumBytes: 150_000,
    paths: [
      "LICENSE",
      "README.md",
      "dist/check.d.ts",
      "dist/check.js",
      "dist/diff.d.ts",
      "dist/diff.js",
      "dist/index.d.ts",
      "dist/index.js",
      "dist/program.d.ts",
      "dist/program.js",
      "dist/runner.d.ts",
      "dist/runner.js",
      "dist/scan.d.ts",
      "dist/scan.js",
      "dist/terminal.d.ts",
      "dist/terminal.js",
      "package.json",
    ],
  },
];

export async function validatePackageReport({
  directory,
  manifest,
  report,
  specification,
  stat = lstat,
}) {
  assert(report?.name === manifest.name, `${manifest.name} pack identity is inconsistent`);
  assert(
    Number.isSafeInteger(report.unpackedSize) &&
      report.unpackedSize > 0 &&
      report.unpackedSize <= specification.maximumBytes,
    `${manifest.name} package is unexpectedly large`,
  );
  assert(Array.isArray(report.files), `${manifest.name} pack file list is missing`);

  const actual = [];
  for (const file of report.files) {
    const path = file?.path;
    assert(typeof path === "string" && canonical(path), `${manifest.name} has unsafe path ${path}`);
    actual.push(path);
    const absolute = resolve(directory, ...path.split("/"));
    const contained = relative(resolve(directory), absolute);
    assert(
      contained.length > 0 && !contained.startsWith(`..${sep}`) && !isAbsolute(contained),
      `${manifest.name} path escapes package root`,
    );
    let current = resolve(directory);
    const segments = path.split("/");
    for (const [index, segment] of segments.entries()) {
      current = resolve(current, segment);
      const status = await stat(current);
      const final = index === segments.length - 1;
      assert(
        !status.isSymbolicLink() && (final ? status.isFile() : status.isDirectory()),
        `${manifest.name} includes non-regular ${path}`,
      );
    }
  }

  const expected = [...specification.paths].sort();
  const sorted = [...actual].sort();
  assert(new Set(actual).size === actual.length, `${manifest.name} pack contains duplicate paths`);
  assert(
    JSON.stringify(sorted) === JSON.stringify(expected),
    `${manifest.name} pack manifest differs from the reviewed allowlist`,
  );
}

function canonical(path) {
  if (path.length < 1 || path.length > 512 || path.includes("\\") || path.startsWith("/"))
    return false;
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === ".."))
    return false;
  return !/(^|\/)(src|test|coverage)(\/|$)|\.(map|tsbuildinfo|tgz)$|(^|\/)(\.env|\.npmrc)$/iu.test(
    path,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
