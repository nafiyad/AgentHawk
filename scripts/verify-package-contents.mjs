import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  packageSpecifications,
  releaseVersion,
  validatePackageReport,
  validateReleaseManifest,
} from "./package-policy.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const npmCli =
  process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

for (const specification of packageSpecifications) {
  const directory = join(root, specification.directory);
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  validateReleaseManifest({ manifest, specification });

  const { stdout } = await execute(
    process.execPath,
    [npmCli, "pack", "--dry-run", "--ignore-scripts", "--offline", "--json"],
    { cwd: directory, encoding: "utf8", maxBuffer: 1_048_576, timeout: 30_000, windowsHide: true },
  );
  const [report] = JSON.parse(stdout);
  await validatePackageReport({ directory, manifest, report, specification });
  const paths = new Set(report.files.map((file) => file.path));
  process.stdout.write(
    `Verified ${manifest.name}: ${paths.size} files, ${report.unpackedSize} bytes unpacked.\n`,
  );
}

await verifyConsumerEntrypoints();
await verifyRuntimeVersion();
await verifyPackedReleaseArtifacts();

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function verifyConsumerEntrypoints() {
  const core = await import("../packages/core/dist/index.js");
  assert(
    typeof core.evaluationReportSchema?.safeParse === "function",
    "Core entrypoint smoke failed",
  );
  const { stdout } = await execute(
    process.execPath,
    [join(root, "packages", "cli", "dist", "index.js"), "--help"],
    { cwd: root, encoding: "utf8", maxBuffer: 65_536, timeout: 10_000, windowsHide: true },
  );
  assert(stdout.includes("Usage: agenthawk"), "CLI entrypoint smoke failed");
  process.stdout.write("Verified core import and CLI startup entrypoints.\n");
}

async function verifyRuntimeVersion() {
  const core = await import("../packages/core/dist/index.js");
  assert(core.AGENTHAWK_VERSION === releaseVersion, "Core runtime version is inconsistent");
  const { stdout } = await execute(
    process.execPath,
    [join(root, "packages", "cli", "dist", "index.js"), "--version"],
    { cwd: root, encoding: "utf8", maxBuffer: 65_536, timeout: 10_000, windowsHide: true },
  );
  assert(stdout.trim() === releaseVersion, "CLI runtime version is inconsistent");
  process.stdout.write(`Verified runtime version ${releaseVersion}.\n`);
}

async function verifyPackedReleaseArtifacts() {
  const outputDirectory = await mkdtemp(join(tmpdir(), "agenthawk-release-check-"));
  try {
    const pnpmCli = process.env.npm_execpath;
    assert(typeof pnpmCli === "string" && pnpmCli.length > 0, "pnpm CLI path is unavailable");
    await execute(
      process.execPath,
      [pnpmCli, "run", "release:prepare", outputDirectory, "0".repeat(40)],
      {
        cwd: root,
        encoding: "utf8",
        maxBuffer: 1_048_576,
        timeout: 60_000,
        windowsHide: true,
      },
    );
    const manifest = JSON.parse(
      await readFile(join(outputDirectory, "release-manifest.json"), "utf8"),
    );
    assert(manifest.packages.length === 2, "Release artifact count is inconsistent");
    assert(
      manifest.packages.every(({ version }) => version === releaseVersion),
      "Release artifact versions are inconsistent",
    );
    process.stdout.write(
      "Verified release:prepare invocation, packed manifests, and exact workspace rewrite.\n",
    );
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
}
