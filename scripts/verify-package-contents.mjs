import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import { packageSpecifications, validatePackageReport } from "./package-policy.mjs";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const npmCli =
  process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");

for (const specification of packageSpecifications) {
  const directory = join(root, specification.directory);
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  assert(
    manifest.private === true,
    `${manifest.name} must remain private before release authorization`,
  );
  assert(manifest.version === "0.0.0", `${manifest.name} must retain the unreleased version`);
  assert(manifest.license === "Apache-2.0", `${manifest.name} license metadata is missing`);
  assert(manifest.engines?.node === ">=20", `${manifest.name} Node engine is inconsistent`);
  assert(
    manifest.repository?.url === "git+https://github.com/nafiyad/AgentHawk.git",
    `${manifest.name} repository metadata is inconsistent`,
  );
  if (manifest.name === "@agenthawk/cli") {
    assert(manifest.bin?.agenthawk === "./dist/index.js", "CLI binary metadata is inconsistent");
    assert(
      manifest.dependencies?.["@agenthawk/core"] === "workspace:*",
      "CLI must retain its unpublished workspace dependency lock",
    );
  }

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
