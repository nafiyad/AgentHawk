import { randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readdir, readFile, rmdir, unlink } from "node:fs/promises";
import { join } from "node:path";

const POLICY = Buffer.from("allow_managed_hooks_only = true\n", "utf8");

export class ManagedPolicyError extends Error {
  constructor(code) {
    super(code);
    this.name = "ManagedPolicyError";
    this.code = code;
  }
}

function policyError(code) {
  return new ManagedPolicyError(`managed_policy_${code}`);
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function observeDirectory(path, code) {
  const observed = await lstat(path, { bigint: true });
  if (!observed.isDirectory() || observed.isSymbolicLink()) throw policyError(code);
  return observed;
}

async function removeOwnedFile(path, identity, expected, code) {
  const observed = await lstat(path, { bigint: true });
  if (!observed.isFile() || observed.isSymbolicLink() || !sameIdentity(identity, observed)) {
    throw policyError(`${code}_identity_changed`);
  }
  const content = await readFile(path);
  if (!content.equals(expected)) throw policyError(`${code}_content_changed`);
  await unlink(path);
}

async function removeOwnedEmptyDirectory(path, identity, code) {
  const observed = await observeDirectory(path, `${code}_invalid`);
  if (!sameIdentity(identity, observed)) throw policyError(`${code}_identity_changed`);
  if ((await readdir(path)).length !== 0) throw policyError(`${code}_not_empty`);
  await rmdir(path);
}

export async function withManagedOnlyPolicy({ commonDataRoot, verify, hooks = {} }) {
  const openAi = join(commonDataRoot, "OpenAI");
  const codex = join(openAi, "Codex");
  const requirements = join(codex, "requirements.toml");
  const stage = join(codex, `.agenthawk-requirements-${randomBytes(16).toString("hex")}.tmp`);
  let createdOpenAi = false;
  let createdCodex = false;
  let openAiIdentity;
  let codexIdentity;
  let stageIdentity;
  let requirementsIdentity;
  let primaryError;
  let result;
  try {
    try {
      await mkdir(openAi);
      createdOpenAi = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
    openAiIdentity = await observeDirectory(openAi, "openai_parent_invalid");
    try {
      await mkdir(codex);
      createdCodex = true;
    } catch (error) {
      if (error?.code === "EEXIST") throw policyError("codex_directory_collision");
      throw error;
    }
    codexIdentity = await observeDirectory(codex, "codex_directory_invalid");
    await hooks.afterCodexCreated?.({ codex, openAi, requirements, stage });
    const stageFile = await open(stage, "wx", 0o600);
    try {
      await stageFile.writeFile(POLICY);
      await stageFile.sync();
      stageIdentity = await stageFile.stat({ bigint: true });
    } finally {
      await stageFile.close();
    }
    await hooks.beforePublish?.({ codex, openAi, requirements, stage });
    try {
      await link(stage, requirements);
    } catch (error) {
      if (error?.code === "EEXIST") throw policyError("requirements_collision");
      throw error;
    }
    requirementsIdentity = await lstat(requirements, { bigint: true });
    if (!sameIdentity(stageIdentity, requirementsIdentity)) {
      throw policyError("publication_identity_mismatch");
    }
    await removeOwnedFile(stage, stageIdentity, POLICY, "stage");
    stageIdentity = undefined;
    result = await verify();
  } catch (error) {
    primaryError = error;
  }
  let cleanupError;
  try {
    await hooks.beforeCleanup?.({ codex, openAi, requirements, stage });
    if (requirementsIdentity) {
      await removeOwnedFile(requirements, requirementsIdentity, POLICY, "requirements");
    }
    if (stageIdentity) await removeOwnedFile(stage, stageIdentity, POLICY, "stage");
    if (createdCodex && codexIdentity) {
      await removeOwnedEmptyDirectory(codex, codexIdentity, "codex_directory");
    }
    if (createdOpenAi && openAiIdentity) {
      await removeOwnedEmptyDirectory(openAi, openAiIdentity, "openai_directory");
    }
  } catch (error) {
    cleanupError = error;
  }
  if (cleanupError) throw cleanupError;
  if (primaryError) throw primaryError;
  return result;
}

export const MANAGED_ONLY_POLICY_BYTES = Buffer.from(POLICY);
