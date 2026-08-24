#!/usr/bin/env node

import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";

import { ManagedPolicyError, withManagedOnlyPolicy } from "./codex-managed-policy.mjs";
import { verifyCodexManagedOnly } from "./verify-codex-app-server.mjs";

function parseArguments(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!value || (key !== "--common-data-root" && key !== "--codex-entry")) {
      throw new ManagedPolicyError("managed_policy_arguments_invalid");
    }
    values.set(key, value);
  }
  const commonDataRoot = values.get("--common-data-root");
  const codexEntry = values.get("--codex-entry");
  if (!commonDataRoot || !codexEntry || !isAbsolute(commonDataRoot) || !isAbsolute(codexEntry)) {
    throw new ManagedPolicyError("managed_policy_arguments_invalid");
  }
  return { commonDataRoot, codexEntry };
}

async function main() {
  try {
    if (process.env.RUNNER_ENVIRONMENT !== "github-hosted" || process.env.RUNNER_OS !== "Windows") {
      throw new ManagedPolicyError("managed_policy_runner_invalid");
    }
    const { commonDataRoot, codexEntry } = parseArguments(process.argv.slice(2));
    const result = await withManagedOnlyPolicy({
      commonDataRoot,
      verify: () => verifyCodexManagedOnly({ codexEntry }),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const code =
      error instanceof ManagedPolicyError ? error.code : "managed_policy_unexpected_failure";
    process.stderr.write(`AgentHawk Codex managed-policy verification failed: ${code}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) await main();
