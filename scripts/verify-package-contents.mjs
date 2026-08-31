import { execFile, spawn } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
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
  const claudeHookEntrypoint = join(root, "packages", "cli", "dist", "claude-pretooluse-entry.js");
  const claudeMalformed = await executeWithInput(process.execPath, [claudeHookEntrypoint], {
    cwd: root,
    input: "not-json",
    timeout: 10_000,
  });
  assert(claudeMalformed.code === 2, "Claude hook malformed-input exit code is inconsistent");
  assert(claudeMalformed.stdout === "", "Claude hook emergency path wrote stdout");
  assert(
    claudeMalformed.stderr ===
      "AgentHawk denied the tool call because security evaluation failed.\n",
    "Claude hook emergency denial is inconsistent",
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
    await execute("git", ["init", "--quiet"], {
      cwd: initDirectory,
      encoding: "utf8",
      maxBuffer: 65_536,
      timeout: 10_000,
      windowsHide: true,
    });
    await writeFile(
      join(initDirectory, ".gitignore"),
      [
        ".claude/settings.local.json",
        ".agenthawk/integrations/claude-v1.json",
        ".agenthawk-claude-integration.lock",
        ".agenthawk-claude-integration-*",
        "",
      ].join("\n"),
      { encoding: "utf8", flag: "wx" },
    );
    const claudeStatus = await execute(
      process.execPath,
      [cliEntrypoint, "integrations", "claude", "status", "--format", "json"],
      {
        cwd: initDirectory,
        encoding: "utf8",
        maxBuffer: 65_536,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    const claudeStatusReport = JSON.parse(claudeStatus.stdout);
    assert(
      claudeStatusReport.command === "integrations_claude_status" &&
        claudeStatusReport.localSettings === "absent" &&
        claudeStatusReport.sharedSettings === "absent" &&
        claudeStatusReport.localSettingsIgnored === "ignored" &&
        claudeStatusReport.integrationArtifactsIgnored === "ignored" &&
        claudeStatusReport.ownership === "absent" &&
        claudeStatusReport.readiness === "not_applicable" &&
        claudeStatusReport.activation === "unproven" &&
        claudeStatusReport.providersContacted === false,
      "Packed Claude project-hook status smoke failed",
    );
    const status = await execute(
      process.execPath,
      [cliEntrypoint, "integrations", "codex", "status", "--format", "json"],
      {
        cwd: initDirectory,
        encoding: "utf8",
        maxBuffer: 65_536,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    const statusReport = JSON.parse(status.stdout);
    assert(
      statusReport.command === "integrations_codex_status" &&
        statusReport.ownership === "absent" &&
        statusReport.readiness === "not_applicable" &&
        statusReport.providersContacted === false,
      "Packed Codex project-hook status smoke failed",
    );
    const installed = await execute(
      process.execPath,
      [cliEntrypoint, "integrations", "codex", "install", "--format", "json"],
      {
        cwd: initDirectory,
        encoding: "utf8",
        maxBuffer: 65_536,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    const installedReport = JSON.parse(installed.stdout);
    assert(
      installedReport.command === "integrations_codex_install" &&
        installedReport.outcome === "installed" &&
        installedReport.ownership === "owned_exact" &&
        installedReport.readiness === "current",
      "Packed Codex project-hook install smoke failed",
    );
    const packedReceipt = JSON.parse(
      await readFile(join(initDirectory, ".agenthawk", "integrations", "codex-v1.json"), "utf8"),
    );
    const projectLaunchArguments = [
      `--agenthawk-deployment-trust=project`,
      `--agenthawk-installation-id=${packedReceipt.installationId}`,
      `--agenthawk-root-binding=${packedReceipt.rootBinding}`,
    ];
    const projectHookEntrypoint = join(dirname(cliEntrypoint), "codex-pretooluse-entry.js");
    const projectInput = JSON.stringify({
      cwd: await realpath(initDirectory),
      hook_event_name: "PreToolUse",
      model: "packed-project-model",
      permission_mode: "default",
      session_id: "packed-project-session",
      tool_input: { command: "npm install --global packed-project-fixture" },
      tool_name: "Bash",
      tool_use_id: "packed-project-tool",
      transcript_path: null,
      turn_id: "packed-project-turn",
    });
    const projectDenied = await executeWithInput(
      process.execPath,
      [projectHookEntrypoint, ...projectLaunchArguments],
      { cwd: initDirectory, input: projectInput, timeout: 15_000 },
    );
    assert(
      projectDenied.code === 0 &&
        JSON.parse(projectDenied.stdout).hookSpecificOutput?.permissionDecision === "deny" &&
        projectDenied.stderr === "",
      "Packed Codex project invocation verification failed",
    );
    const rejectedLaunch = await executeWithInput(
      process.execPath,
      [
        projectHookEntrypoint,
        projectLaunchArguments[0],
        `--agenthawk-installation-id=${"0".repeat(64)}`,
        projectLaunchArguments[2],
      ],
      { cwd: initDirectory, input: projectInput, timeout: 15_000 },
    );
    assert(
      rejectedLaunch.code === 2 &&
        rejectedLaunch.stdout === "" &&
        rejectedLaunch.stderr ===
          "AgentHawk denied the tool call because security evaluation failed.\n",
      "Packed Codex project invocation mismatch did not fail closed",
    );
    const removed = await execute(
      process.execPath,
      [cliEntrypoint, "integrations", "codex", "remove", "--format", "json"],
      {
        cwd: initDirectory,
        encoding: "utf8",
        maxBuffer: 65_536,
        timeout: 15_000,
        windowsHide: true,
      },
    );
    const removedReport = JSON.parse(removed.stdout);
    assert(
      removedReport.command === "integrations_codex_remove" &&
        removedReport.outcome === "removed" &&
        removedReport.ownership === "absent",
      "Packed Codex project-hook remove smoke failed",
    );
    await verifyPackedCodexHook(consumerDirectory);
    await verifyPackedClaudeHook(consumerDirectory, initDirectory);
  } finally {
    await rm(consumerDirectory, { force: true, recursive: true });
  }
}

async function verifyPackedClaudeHook(consumerDirectory, projectDirectory) {
  const cliEntrypoint = join(
    consumerDirectory,
    "node_modules",
    "@agenthawk",
    "cli",
    "dist",
    "index.js",
  );
  const hookEntrypoint = join(
    consumerDirectory,
    "node_modules",
    "@agenthawk",
    "cli",
    "dist",
    "claude-pretooluse-entry.js",
  );
  const malformed = await executeWithInput(process.execPath, [hookEntrypoint], {
    cwd: consumerDirectory,
    input: "not-json",
    timeout: 10_000,
  });
  assert(malformed.code === 2, "Packed Claude hook did not deny malformed input");
  assert(malformed.stdout === "", "Packed Claude hook emergency path wrote stdout");
  assert(
    malformed.stderr === "AgentHawk denied the tool call because security evaluation failed.\n",
    "Packed Claude hook emergency denial is inconsistent",
  );
  const privateCommand = "npm add packed-private-fixture";
  const denied = await executeWithInput(process.execPath, [hookEntrypoint], {
    cwd: consumerDirectory,
    input: JSON.stringify({
      cwd: consumerDirectory,
      hook_event_name: "PreToolUse",
      permission_mode: "default",
      session_id: "packed-private-session",
      tool_input: { command: privateCommand },
      tool_name: "PowerShell",
      tool_use_id: "packed-private-tool",
      transcript_path: join(consumerDirectory, "private-transcript.jsonl"),
    }),
    timeout: 10_000,
  });
  assert(
    denied.code === 0 &&
      denied.stderr === "" &&
      JSON.parse(denied.stdout).hookSpecificOutput?.permissionDecision === "deny",
    "Packed Claude hook ordinary denial is inconsistent",
  );
  assert(!denied.stdout.includes(privateCommand), "Packed Claude hook leaked private input");
  const neutral = await executeWithInput(process.execPath, [hookEntrypoint], {
    cwd: consumerDirectory,
    input: JSON.stringify({
      cwd: consumerDirectory,
      hook_event_name: "PreToolUse",
      permission_mode: "default",
      session_id: "packed-neutral-session",
      tool_input: { command: "git status" },
      tool_name: "Bash",
      tool_use_id: "packed-neutral-tool",
      transcript_path: join(consumerDirectory, "neutral-transcript.jsonl"),
    }),
    timeout: 10_000,
  });
  assert(
    neutral.code === 0 && neutral.stdout === "" && neutral.stderr === "",
    "Packed Claude hook neutral result is inconsistent",
  );

  const canonicalRoot = await realpath(projectDirectory);
  const rootStats = await lstat(canonicalRoot, { bigint: true });
  const canonicalHookEntrypoint = await realpath(hookEntrypoint);
  const formatModule = await import(
    pathToFileURL(join(dirname(hookEntrypoint), "claude-project-hook-format.js")).href
  );
  const artifacts = formatModule.buildClaudeProjectHookArtifacts({
    adapterBytes: await readFile(canonicalHookEntrypoint),
    adapterEntry: canonicalHookEntrypoint,
    adapterVersion: releaseVersion,
    installationId: "ab".repeat(32),
    nodeExecutable: await realpath(process.execPath),
    nodeVersion: process.version,
    repositoryIdentity: { dev: rootStats.dev, ino: rootStats.ino },
    repositoryRoot: canonicalRoot,
  });
  const settingsPath = join(canonicalRoot, ".claude", "settings.local.json");
  const receiptPath = join(canonicalRoot, ".agenthawk", "integrations", "claude-v1.json");
  await mkdir(dirname(settingsPath), { recursive: true });
  await mkdir(dirname(receiptPath), { recursive: true });
  await writeFile(settingsPath, artifacts.settingsBytes, { flag: "wx" });
  await writeFile(receiptPath, artifacts.receiptBytes, { flag: "wx" });
  const projectStatus = await execute(
    process.execPath,
    [cliEntrypoint, "integrations", "claude", "status", "--format", "json"],
    {
      cwd: canonicalRoot,
      encoding: "utf8",
      maxBuffer: 65_536,
      timeout: 15_000,
      windowsHide: true,
    },
  );
  const projectStatusReport = JSON.parse(projectStatus.stdout);
  assert(
    projectStatusReport.ownership === "owned_exact" &&
      projectStatusReport.readiness === "current" &&
      projectStatusReport.activation === "unproven" &&
      projectStatusReport.exitCodeMeaning === "integration_current" &&
      projectStatusReport.blockers.length === 0,
    "Packed Claude project-hook receipt-aware status failed",
  );
  const projectArguments = artifacts.launchArguments.slice(1);
  const projectNeutral = await executeWithInput(
    process.execPath,
    [hookEntrypoint, ...projectArguments],
    {
      cwd: canonicalRoot,
      input: JSON.stringify({
        cwd: canonicalRoot,
        hook_event_name: "PreToolUse",
        permission_mode: "default",
        session_id: "packed-project-session",
        tool_input: { command: "git status" },
        tool_name: "Bash",
        tool_use_id: "packed-project-tool",
        transcript_path: join(canonicalRoot, "project-transcript.jsonl"),
      }),
      timeout: 15_000,
    },
  );
  assert(
    projectNeutral.code === 0 && projectNeutral.stdout === "" && projectNeutral.stderr === "",
    "Packed Claude project invocation verification failed",
  );
  const rejectedProject = await executeWithInput(
    process.execPath,
    [hookEntrypoint, ...projectArguments.slice(0, -1), "cd".repeat(32)],
    {
      cwd: canonicalRoot,
      input: JSON.stringify({
        cwd: canonicalRoot,
        hook_event_name: "PreToolUse",
        permission_mode: "default",
        session_id: "packed-rejected-session",
        tool_input: { command: "git status" },
        tool_name: "Bash",
        tool_use_id: "packed-rejected-tool",
        transcript_path: join(canonicalRoot, "rejected-transcript.jsonl"),
      }),
      timeout: 15_000,
    },
  );
  assert(
    rejectedProject.code === 2 &&
      rejectedProject.stdout === "" &&
      rejectedProject.stderr ===
        "AgentHawk denied the tool call because security evaluation failed.\n",
    "Packed Claude project invocation mismatch did not fail closed",
  );
  await rm(settingsPath);
  await rm(receiptPath);
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
    { directory: "packages/cli", names: ["commander", "yaml", "zod"] },
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
