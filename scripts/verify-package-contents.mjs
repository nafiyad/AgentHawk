import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);
const root = resolve(import.meta.dirname, "..");
const npmCli =
  process.platform === "win32"
    ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
    : resolve(dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js");
const packages = [
  {
    directory: "packages/core",
    maximumBytes: 250_000,
    required: ["dist/index.js", "dist/index.d.ts"],
  },
  {
    directory: "packages/cli",
    maximumBytes: 150_000,
    required: ["dist/index.js", "dist/index.d.ts", "dist/runner.js"],
  },
];

for (const specification of packages) {
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
  assert(report?.name === manifest.name, `${manifest.name} pack identity is inconsistent`);
  assert(
    report.unpackedSize <= specification.maximumBytes,
    `${manifest.name} package is unexpectedly large`,
  );
  const paths = new Set(report.files.map((file) => file.path));
  for (const path of ["package.json", "README.md", "LICENSE", ...specification.required]) {
    assert(paths.has(path), `${manifest.name} package is missing ${path}`);
  }
  for (const path of paths) {
    assert(!/(^|\/)(src|test|coverage)(\/|$)/u.test(path), `${manifest.name} leaks ${path}`);
    assert(!/\.(map|tsbuildinfo|tgz)$/u.test(path), `${manifest.name} includes ${path}`);
    assert(!/(^|\/)(\.env|\.npmrc)$/u.test(path), `${manifest.name} includes sensitive ${path}`);
  }
  process.stdout.write(
    `Verified ${manifest.name}: ${paths.size} files, ${report.unpackedSize} bytes unpacked.\n`,
  );
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
