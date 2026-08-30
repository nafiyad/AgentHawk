import { link, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildClaudeProjectHookArtifacts } from "../src/claude-project-hook-format.js";
import {
  type ClaudeProjectHookInvocationDependencies,
  verifyClaudeProjectHookInvocation,
} from "../src/claude-project-hook-invocation.js";
import { runBoundedGit } from "../src/diff.js";
import { loadRepositoryAuthority, type RepositoryAuthority } from "../src/repository-authority.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map(async (root) => await rm(root, { force: true, recursive: true })),
  );
});

describe("Claude project-hook invocation verification", () => {
  it("rejects a non-project declaration without filesystem access", async () => {
    const fixture = await ownedFixture();
    await expect(
      verifyClaudeProjectHookInvocation(
        fixture.authority,
        { ...fixture.context, deploymentTrust: "unknown" } as unknown as typeof fixture.context,
        {},
        {
          inspectPath: async () => {
            throw new Error("filesystem must not be observed");
          },
        },
      ),
    ).resolves.toBe(false);
  });

  it("accepts only the exact current root-bound pair", async () => {
    const fixture = await ownedFixture();
    await expect(verify(fixture)).resolves.toBe(true);
    await expect(
      verifyClaudeProjectHookInvocation(
        fixture.authority,
        fixture.context,
        {},
        {
          adapterEntry: fixture.dependencies.adapterEntry as string,
        },
      ),
    ).resolves.toBe(true);
    await expect(
      verifyClaudeProjectHookInvocation(
        fixture.authority,
        { ...fixture.context, installationId: "cd".repeat(32) },
        {},
        fixture.dependencies,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyClaudeProjectHookInvocation(
        fixture.authority,
        { ...fixture.context, rootBinding: "dc".repeat(32) },
        {},
        fixture.dependencies,
      ),
    ).resolves.toBe(false);
    await expect(
      verifyClaudeProjectHookInvocation(
        {
          ...fixture.authority,
          repositoryIdentity: {
            ...fixture.authority.repositoryIdentity,
            ino: fixture.authority.repositoryIdentity.ino + 1n,
          },
        },
        fixture.context,
        {},
        fixture.dependencies,
      ),
    ).resolves.toBe(false);
  });

  it("rejects missing, modified, malformed, oversized, and multiply linked state", async () => {
    const cases: Array<(fixture: Awaited<ReturnType<typeof ownedFixture>>) => Promise<void>> = [
      async (fixture) => await rm(fixture.settingsPath),
      async (fixture) => await rm(fixture.receiptPath),
      async (fixture) => await writeFile(fixture.settingsPath, '{"hooks":{}}\n'),
      async (fixture) => await writeFile(fixture.receiptPath, Buffer.from([0xff])),
      async (fixture) => await writeFile(fixture.receiptPath, Buffer.alloc(8_193, 0x20)),
      async (fixture) => {
        await link(fixture.settingsPath, join(fixture.root, "settings-hardlink.json"));
      },
    ];
    for (const mutate of cases) {
      const fixture = await ownedFixture();
      await mutate(fixture);
      await expect(verify(fixture)).resolves.toBe(false);
    }
  });

  it("rejects every operation lock and current runtime or adapter drift", async () => {
    const locked = await ownedFixture();
    await writeFile(join(locked.root, ".agenthawk-claude-integration.lock"), "foreign\n");
    await expect(verify(locked)).resolves.toBe(false);

    const adapterDrift = await ownedFixture();
    await writeFile(adapterDrift.dependencies.adapterEntry ?? "", "changed adapter");
    await expect(verify(adapterDrift)).resolves.toBe(false);

    const versionDrift = await ownedFixture();
    await expect(
      verifyClaudeProjectHookInvocation(
        versionDrift.authority,
        versionDrift.context,
        {},
        { ...versionDrift.dependencies, nodeVersion: "v24.0.0" },
      ),
    ).resolves.toBe(false);

    const pathDrift = await ownedFixture();
    const alternate = join(pathDrift.root, "alternate-adapter.js");
    await writeFile(alternate, "adapter fixture");
    await expect(
      verifyClaudeProjectHookInvocation(
        pathDrift.authority,
        pathDrift.context,
        {},
        { ...pathDrift.dependencies, adapterEntry: alternate },
      ),
    ).resolves.toBe(false);

    const linkedAdapter = await ownedFixture();
    await link(
      linkedAdapter.dependencies.adapterEntry ?? "",
      join(linkedAdapter.root, "adapter-hardlink.js"),
    );
    await expect(verify(linkedAdapter)).resolves.toBe(true);
  });

  it("rejects canonical-root and matching-snapshot drift", async () => {
    const movedRoot = await ownedFixture();
    await expect(
      verifyClaudeProjectHookInvocation(
        movedRoot.authority,
        movedRoot.context,
        {},
        {
          ...movedRoot.dependencies,
          realPath: async (path) =>
            path === movedRoot.root ? `${movedRoot.root}-replacement` : await realpath(path),
        },
      ),
    ).resolves.toBe(false);

    const changing = await ownedFixture();
    let rootObservations = 0;
    await expect(
      verifyClaudeProjectHookInvocation(
        changing.authority,
        changing.context,
        {},
        {
          ...changing.dependencies,
          realPath: async (path) => {
            if (path === changing.root) {
              rootObservations += 1;
              if (rootObservations === 3) {
                await writeFile(changing.settingsPath, '{"hooks":{}}\n');
              }
            }
            return await realpath(path);
          },
        },
      ),
    ).resolves.toBe(false);
  });

  it("propagates cancellation instead of converting it to a verification result", async () => {
    const fixture = await ownedFixture();
    const controller = new AbortController();
    controller.abort();
    await expect(
      verifyClaudeProjectHookInvocation(
        fixture.authority,
        fixture.context,
        { signal: controller.signal },
        fixture.dependencies,
      ),
    ).rejects.toMatchObject({ name: "OperationCancelledError" });
  });
});

async function verify(fixture: Awaited<ReturnType<typeof ownedFixture>>): Promise<boolean> {
  return await verifyClaudeProjectHookInvocation(
    fixture.authority,
    fixture.context,
    {},
    fixture.dependencies,
  );
}

async function ownedFixture(): Promise<{
  authority: RepositoryAuthority;
  context: { deploymentTrust: "project"; installationId: string; rootBinding: string };
  dependencies: ClaudeProjectHookInvocationDependencies;
  receiptPath: string;
  root: string;
  settingsPath: string;
}> {
  const created = await mkdtemp(join(tmpdir(), "agenthawk-claude-invocation-"));
  roots.push(created);
  await runBoundedGit(["init", "--quiet"], created);
  const root = await realpath(created);
  await writeFile(join(root, ".agenthawk.yml"), "version: 1\n");
  await mkdir(join(root, ".claude"), { recursive: true });
  await mkdir(join(root, ".agenthawk", "integrations"), { recursive: true });
  const adapterEntry = join(root, "packed-claude-pretooluse-entry.js");
  const adapterBytes = Buffer.from("adapter fixture", "utf8");
  await writeFile(adapterEntry, adapterBytes);
  const authority = await loadRepositoryAuthority(root);
  const nodeExecutable = await realpath(process.execPath);
  const installationId = "ab".repeat(32);
  const artifacts = buildClaudeProjectHookArtifacts({
    adapterBytes,
    adapterEntry,
    adapterVersion: "0.1.0-alpha.1",
    installationId,
    nodeExecutable,
    nodeVersion: process.version,
    repositoryIdentity: authority.repositoryIdentity,
    repositoryRoot: authority.repositoryRoot,
  });
  const settingsPath = join(root, ".claude", "settings.local.json");
  const receiptPath = join(root, ".agenthawk", "integrations", "claude-v1.json");
  await writeFile(settingsPath, artifacts.settingsBytes);
  await writeFile(receiptPath, artifacts.receiptBytes);
  return {
    authority,
    context: {
      deploymentTrust: "project",
      installationId,
      rootBinding: artifacts.receipt.rootBinding,
    },
    dependencies: {
      adapterEntry,
      adapterVersion: "0.1.0-alpha.1",
      nodeExecutable,
      nodeVersion: process.version,
    },
    receiptPath,
    root,
    settingsPath,
  };
}
