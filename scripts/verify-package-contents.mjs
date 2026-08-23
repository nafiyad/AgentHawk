import { execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
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
  const hookEntrypoint = join(root, "packages", "cli", "dist", "codex-pretooluse-entry.js");
  const malformed = await executeWithInput(process.execPath, [hookEntrypoint], {
    cwd: root,
    input: "not-json",
    timeout: 10_000,
  });
  assert(malformed.code === 2, "Codex hook malformed-input exit code is inconsistent");
  assert(malformed.stdout === "", "Codex hook emergency path wrote stdout");
  assert(
    malformed.stderr === "AgentHawk denied the tool call because security evaluation failed.\n",
    "Codex hook emergency denial is inconsistent",
  );
  process.stdout.write("Verified core import and CLI/hook startup entrypoints.\n");
}

async function verifyRuntimeVersion() {
  const core = await import("../packages/core/dist/index.js");
  const cli = await import("../packages/cli/dist/version.js");
  assert(core.AGENTHAWK_VERSION === releaseVersion, "Core runtime version is inconsistent");
  assert(cli.AGENTHAWK_CLI_VERSION === releaseVersion, "CLI runtime constant is inconsistent");
  const { stdout } = await execute(
    process.execPath,
    [join(root, "packages", "cli", "dist", "index.js"), "--version"],
    { cwd: root, encoding: "utf8", maxBuffer: 65_536, timeout: 10_000, windowsHide: true },
  );
  assert(stdout.trim() === releaseVersion, "CLI runtime version is inconsistent");
  const doctor = await execute(
    process.execPath,
    [join(root, "packages", "cli", "dist", "index.js"), "doctor", "--format", "json"],
    { cwd: root, encoding: "utf8", maxBuffer: 65_536, timeout: 15_000, windowsHide: true },
  );
  const doctorReport = JSON.parse(doctor.stdout);
  assert(doctorReport.command === "doctor", "CLI doctor smoke failed");
  assert(doctorReport.packages?.aligned === true, "CLI/core runtime alignment failed");
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
    await verifyPackedInit(outputDirectory, manifest, pnpmCli);
    process.stdout.write(
      "Verified release:prepare invocation, packed manifests, exact workspace rewrite, and packed init.\n",
    );
  } finally {
    await rm(outputDirectory, { force: true, recursive: true });
  }
}

async function verifyPackedInit(outputDirectory, manifest, pnpmCli) {
  const consumerDirectory = await mkdtemp(join(tmpdir(), "agenthawk-packed-consumer-"));
  try {
    const coreArchive = manifest.packages.find(({ name }) => name === "@agenthawk/core");
    const cliArchive = manifest.packages.find(({ name }) => name === "@agenthawk/cli");
    assert(
      coreArchive !== undefined && cliArchive !== undefined,
      "Release packages are incomplete",
    );
    const coreSpecifier = `file:${join(outputDirectory, coreArchive.file).replaceAll("\\", "/")}`;
    const cliSpecifier = `file:${join(outputDirectory, cliArchive.file).replaceAll("\\", "/")}`;
    const runtimeSpecifiers = await installedRuntimeSpecifiers();
    const dependencies = {
      "@agenthawk/cli": cliSpecifier,
      "@agenthawk/core": coreSpecifier,
      ...runtimeSpecifiers,
    };
    await writeFile(
      join(consumerDirectory, "package.json"),
      `${JSON.stringify({
        dependencies,
        name: "agenthawk-packed-consumer",
        private: true,
        version: "0.0.0",
      })}\n`,
      { encoding: "utf8", flag: "wx" },
    );
    await writeFile(
      join(consumerDirectory, "pnpm-workspace.yaml"),
      `${[
        "packages: []",
        "overrides:",
        ...Object.entries({ "@agenthawk/core": coreSpecifier, ...runtimeSpecifiers }).map(
          ([name, specifier]) => `  '${name}': '${specifier}'`,
        ),
        "",
      ].join("\n")}`,
      { encoding: "utf8", flag: "wx" },
    );
    await execute(
      process.execPath,
      [pnpmCli, "install", "--ignore-scripts", "--offline", "--reporter=append-only"],
      {
        cwd: consumerDirectory,
        encoding: "utf8",
        maxBuffer: 1_048_576,
        timeout: 30_000,
        windowsHide: true,
      },
    );
    const cliEntrypoint = join(
      consumerDirectory,
      "node_modules",
      "@agenthawk",
      "cli",
      "dist",
      "index.js",
    );
    const initDirectory = join(consumerDirectory, "clean-project");
    await mkdir(initDirectory);
    const initArguments = [cliEntrypoint, "init", "--integration", "cursor", "--format", "json"];
    const initialized = await execute(process.execPath, initArguments, {
      cwd: initDirectory,
      encoding: "utf8",
      maxBuffer: 65_536,
      timeout: 10_000,
      windowsHide: true,
    });
    assert(
      JSON.stringify(JSON.parse(initialized.stdout).created) ===
        JSON.stringify(["policy", "cursor"]),
      "Packed CLI init creation smoke failed",
    );
    const repeated = await execute(process.execPath, initArguments, {
      cwd: initDirectory,
      encoding: "utf8",
      maxBuffer: 65_536,
      timeout: 10_000,
      windowsHide: true,
    });
    assert(
      JSON.stringify(JSON.parse(repeated.stdout).unchanged) ===
        JSON.stringify(["policy", "cursor"]),
      "Packed CLI init idempotency smoke failed",
    );
    const validated = await execute(
      process.execPath,
      [cliEntrypoint, "policy", "validate", "--file", ".agenthawk.yml", "--format", "json"],
      {
        cwd: initDirectory,
        encoding: "utf8",
        maxBuffer: 65_536,
        timeout: 10_000,
        windowsHide: true,
      },
    );
    assert(JSON.parse(validated.stdout).valid === true, "Packed initialized policy is invalid");
    await verifyPackedCodexHook(consumerDirectory);
  } finally {
    await rm(consumerDirectory, { force: true, recursive: true });
  }
}

async function verifyPackedCodexHook(consumerDirectory) {
  const hookEntrypoint = join(
    consumerDirectory,
    "node_modules",
    "@agenthawk",
    "cli",
    "dist",
    "codex-pretooluse-entry.js",
  );
  const malformed = await executeWithInput(process.execPath, [hookEntrypoint], {
    cwd: consumerDirectory,
    input: "not-json",
    timeout: 10_000,
  });
  assert(malformed.code === 2, "Packed Codex hook did not fail closed on malformed input");
  assert(malformed.stdout === "", "Packed Codex hook emergency path wrote stdout");
  assert(
    malformed.stderr === "AgentHawk denied the tool call because security evaluation failed.\n",
    "Packed Codex hook emergency denial is inconsistent",
  );
  const privateCommand = "npm add packed-private-fixture";
  const privatePath = join(consumerDirectory, "private-transcript.jsonl");
  const denied = await executeWithInput(process.execPath, [hookEntrypoint], {
    cwd: consumerDirectory,
    input: JSON.stringify({
      cwd: consumerDirectory,
      hook_event_name: "PreToolUse",
      model: "packed-fixture-model",
      permission_mode: "default",
      session_id: "packed-private-session",
      tool_input: { command: privateCommand },
      tool_name: "Bash",
      tool_use_id: "packed-private-tool",
      transcript_path: privatePath,
      turn_id: "packed-private-turn",
    }),
    timeout: 10_000,
  });
  assert(denied.code === 0, "Packed Codex hook ordinary denial exit code is inconsistent");
  assert(denied.stderr === "", "Packed Codex hook ordinary denial wrote stderr");
  const denial = JSON.parse(denied.stdout);
  assert(
    denial.hookSpecificOutput?.permissionDecision === "deny",
    "Packed Codex hook ordinary denial is inconsistent",
  );
  assert(
    !denied.stdout.includes("allow") && !denied.stdout.includes("updatedInput"),
    "Packed Codex hook emitted forbidden host authority",
  );
  for (const privateValue of [privateCommand, privatePath, "packed-private"]) {
    assert(!denied.stdout.includes(privateValue), "Packed Codex hook leaked private input");
  }
  const neutral = await executeWithInput(process.execPath, [hookEntrypoint], {
    cwd: consumerDirectory,
    input: JSON.stringify({
      cwd: consumerDirectory,
      hook_event_name: "PreToolUse",
      model: "packed-fixture-model",
      permission_mode: "default",
      session_id: "packed-neutral-session",
      tool_input: { command: "git status" },
      tool_name: "Bash",
      tool_use_id: "packed-neutral-tool",
      transcript_path: null,
      turn_id: "packed-neutral-turn",
    }),
    timeout: 10_000,
  });
  assert(neutral.code === 0, "Packed Codex hook neutral exit code is inconsistent");
  assert(neutral.stdout === "", "Packed Codex hook neutral path wrote stdout");
  assert(neutral.stderr === "", "Packed Codex hook neutral path wrote stderr");
}

async function installedRuntimeSpecifiers() {
  const packages = [
    { directory: "packages/cli", names: ["commander", "yaml"] },
    { directory: "packages/core", names: ["semver", "zod"] },
  ];
  const specifiers = {};
  for (const { directory, names } of packages) {
    const manifest = JSON.parse(await readFile(join(root, directory, "package.json"), "utf8"));
    const require = createRequire(join(root, directory, "package.json"));
    for (const name of names) {
      const expectedVersion = manifest.dependencies[name];
      assert(typeof expectedVersion === "string", `Runtime dependency ${name} is undeclared`);
      let current = dirname(require.resolve(name));
      let matched;
      for (let depth = 0; depth < 8; depth += 1) {
        try {
          const installedManifest = JSON.parse(
            await readFile(join(current, "package.json"), "utf8"),
          );
          if (installedManifest.name === name) {
            assert(
              installedManifest.version === expectedVersion,
              `Runtime dependency ${name} version is inconsistent`,
            );
            matched = current;
            break;
          }
        } catch {}
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
      }
      assert(matched !== undefined, `Runtime dependency ${name} could not be located`);
      specifiers[name] = `link:${matched.replaceAll("\\", "/")}`;
    }
  }
  return specifiers;
}

async function executeWithInput(file, args, { cwd, input, timeout }) {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(file, args, {
      cwd,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    const stdout = [];
    const stderr = [];
    let total = 0;
    let settled = false;
    const fail = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(error);
    };
    const timer = setTimeout(() => {
      child.kill();
      fail(new Error("Hook consumer smoke timed out"));
    }, timeout);
    timer.unref();
    const collect = (target) => (chunk) => {
      total += chunk.length;
      if (total > 65_536) {
        child.kill();
        fail(new Error("Hook consumer smoke output exceeded its limit"));
        return;
      }
      target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", fail);
    child.once("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        code,
        stderr: Buffer.concat(stderr).toString("utf8"),
        stdout: Buffer.concat(stdout).toString("utf8"),
      });
    });
    child.stdin.end(input);
  });
}
