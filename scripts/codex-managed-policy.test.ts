import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  MANAGED_ONLY_POLICY_BYTES,
  ManagedPolicyError,
  withManagedOnlyPolicy,
} from "./codex-managed-policy.mjs";

async function fixture() {
  return mkdtemp(join(tmpdir(), "agenthawk-managed-policy-test-"));
}

describe("Codex managed-only policy transaction", () => {
  it("publishes exact policy for verification and removes only its created state", async () => {
    const root = await fixture();
    try {
      await expect(
        withManagedOnlyPolicy({
          commonDataRoot: root,
          verify: async () => {
            expect(await readFile(join(root, "OpenAI", "Codex", "requirements.toml"))).toEqual(
              MANAGED_ONLY_POLICY_BYTES,
            );
            return "passed";
          },
        }),
      ).resolves.toBe("passed");
      await expect(
        readFile(join(root, "OpenAI", "Codex", "requirements.toml")),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("refuses a pre-existing Codex directory without changing it", async () => {
    const root = await fixture();
    const codex = join(root, "OpenAI", "Codex");
    try {
      await mkdir(codex, { recursive: true });
      await writeFile(join(codex, "owner.txt"), "foreign");
      await expect(
        withManagedOnlyPolicy({ commonDataRoot: root, verify: async () => "unreachable" }),
      ).rejects.toThrowError(new ManagedPolicyError("managed_policy_codex_directory_collision"));
      await expect(readFile(join(codex, "owner.txt"), "utf8")).resolves.toBe("foreign");
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("does not overwrite or remove a create-time requirements collision", async () => {
    const root = await fixture();
    const collision = Buffer.from("foreign = true\n");
    try {
      await expect(
        withManagedOnlyPolicy({
          commonDataRoot: root,
          verify: async () => "unreachable",
          hooks: {
            beforePublish: async ({ requirements }) => writeFile(requirements, collision),
          },
        }),
      ).rejects.toThrowError(new ManagedPolicyError("managed_policy_codex_directory_not_empty"));
      await expect(readFile(join(root, "OpenAI", "Codex", "requirements.toml"))).resolves.toEqual(
        collision,
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });

  it("refuses cleanup after an identical-byte replacement", async () => {
    const root = await fixture();
    try {
      await expect(
        withManagedOnlyPolicy({
          commonDataRoot: root,
          verify: async () => "passed",
          hooks: {
            beforeCleanup: async ({ requirements }) => {
              const displaced = `${requirements}.displaced`;
              await rename(requirements, displaced);
              await writeFile(requirements, MANAGED_ONLY_POLICY_BYTES);
            },
          },
        }),
      ).rejects.toThrowError(
        new ManagedPolicyError("managed_policy_requirements_identity_changed"),
      );
      await expect(readFile(join(root, "OpenAI", "Codex", "requirements.toml"))).resolves.toEqual(
        MANAGED_ONLY_POLICY_BYTES,
      );
    } finally {
      await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
  });
});
