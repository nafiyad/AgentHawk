import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { CLAUDE_CONTRACT_RELEASE } from "../src/claude-pretooluse.js";
import {
  buildClaudeProjectHookArtifacts,
  buildClaudeProjectHookLockBytes,
  CLAUDE_PROJECT_HOOK_CONTRACT_RELEASE,
  claudeProjectHookReceiptSchema,
  computeClaudeLaunchArgumentsSha256,
  computeClaudeProjectRootBinding,
  createClaudeProjectHookIdentifier,
  parseClaudeProjectHookLaunchArguments,
  parseClaudeProjectHookLockBytes,
  parseClaudeProjectHookReceiptBytes,
  parseClaudeProjectHookSettingsBytes,
  verifyClaudeProjectHookReceiptBinding,
  verifyClaudeProjectHookSettingsBytes,
} from "../src/claude-project-hook-format.js";

const installationId = "00".repeat(32);
const repositoryRoot = resolve("fixture", "repository");

describe("Claude project-hook root binding", () => {
  it("round-trips only the canonical bounded operation lock", () => {
    const operationId = "ab".repeat(32);
    const bytes = buildClaudeProjectHookLockBytes(operationId);
    expect(bytes.toString("utf8")).toBe(`{"operationId":"${operationId}","schemaVersion":"1.0"}\n`);
    expect(parseClaudeProjectHookLockBytes(bytes)).toEqual({
      operationId,
      schemaVersion: "1.0",
    });
    for (const invalid of [
      Buffer.from(` {"operationId":"${operationId}","schemaVersion":"1.0"}\n`),
      Buffer.from(`{"operationId":"${operationId.toUpperCase()}","schemaVersion":"1.0"}\n`),
      Buffer.from(
        `{"operationId":"${operationId}","operationId":"${operationId}","schemaVersion":"1.0"}\n`,
      ),
      Buffer.from(`{"operationId":"${operationId}","schemaVersion":"1.0","pid":1}\n`),
      Buffer.from([0xff]),
      Buffer.alloc(1_025, 0x20),
    ]) {
      expect(parseClaudeProjectHookLockBytes(invalid)).toBeUndefined();
    }
  });

  it("matches the fixed canonical framing vector", () => {
    expect(
      computeClaudeProjectRootBinding({
        installationId,
        repositoryIdentity: { dev: 7n, ino: 42n },
        repositoryRoot: "/fixture/repository",
      }),
    ).toBe("39daffb07b3551ec5a32246bee521fe210d18d57f87af31ce492b1767ac79f91");
  });

  it.each([
    "A".repeat(64),
    "0".repeat(63),
    `0x${"0".repeat(64)}`,
    `${"0".repeat(32)}-${"0".repeat(32)}`,
  ])("rejects a noncanonical identifier: %s", (candidate) => {
    expect(() =>
      computeClaudeProjectRootBinding({
        installationId: candidate,
        repositoryIdentity: { dev: 1n, ino: 2n },
        repositoryRoot,
      }),
    ).toThrow();
  });

  it.each([
    { dev: -1n, ino: 2n },
    { dev: 1n, ino: 0n },
    { dev: 1n, ino: -1n },
    { dev: 1n << 64n, ino: 2n },
    { dev: 1n, ino: 1n << 64n },
  ])("rejects invalid bigint identity $dev/$ino", (repositoryIdentity) => {
    expect(() =>
      computeClaudeProjectRootBinding({ installationId, repositoryIdentity, repositoryRoot }),
    ).toThrow();
  });

  it.each([
    "",
    "relative/repository",
    "/repo/../other",
    "C:relative\\repository",
    "C:\\repo\\..\\other",
    `/${"x".repeat(16_385)}`,
    `/${"😀".repeat(8_193)}`,
    "/invalid\ud800root",
  ])("rejects a noncanonical repository root: %j", (candidate) => {
    expect(() =>
      computeClaudeProjectRootBinding({
        installationId,
        repositoryIdentity: { dev: 1n, ino: 2n },
        repositoryRoot: candidate,
      }),
    ).toThrow();
  });

  it("requires exactly 32 CSPRNG bytes", () => {
    expect(createClaudeProjectHookIdentifier(() => Buffer.alloc(32, 0xab))).toBe("ab".repeat(32));
    expect(() => createClaudeProjectHookIdentifier(() => Buffer.alloc(31))).toThrow();
    expect(() =>
      createClaudeProjectHookIdentifier(() => Uint8Array.from(Buffer.alloc(32)) as Buffer),
    ).toThrow();
  });
});

describe("Claude project-hook format", () => {
  it("keeps the receipt contract release synchronized with the fixture edge", () => {
    expect(`v${CLAUDE_PROJECT_HOOK_CONTRACT_RELEASE}`).toBe(CLAUDE_CONTRACT_RELEASE);
  });

  it("matches the fixed canonical launch-vector digest", () => {
    expect(
      computeClaudeLaunchArgumentsSha256([
        "/packed/claude-pretooluse-entry.js",
        "--deployment-trust",
        "project",
        "--installation-id",
        installationId,
        "--root-binding",
        "ab".repeat(32),
      ]),
    ).toBe("748c3ebbd4e94aab12c832bba0d8f29ef9ebee9a8658eff421d303bd1c486aef");
  });

  it("parses only the exact six project launch arguments", () => {
    const rootBinding = "ab".repeat(32);
    const arguments_ = [
      "--deployment-trust",
      "project",
      "--installation-id",
      installationId,
      "--root-binding",
      rootBinding,
    ];
    expect(parseClaudeProjectHookLaunchArguments(arguments_)).toEqual({
      deploymentTrust: "project",
      installationId,
      rootBinding,
    });
    for (const candidate of [
      arguments_.slice(0, -1),
      [...arguments_, "extra"],
      ["--deployment-trust", "managed", ...arguments_.slice(2)],
      [...arguments_.slice(0, 3), "A".repeat(64), ...arguments_.slice(4)],
      [...arguments_.slice(0, 5), "0".repeat(63)],
    ]) {
      expect(() => parseClaudeProjectHookLaunchArguments(candidate)).toThrow();
    }
  });

  it("matches the fixed native artifact vector", () => {
    const vector =
      process.platform === "win32"
        ? {
            adapterEntry: "C:\\packed\\claude-pretooluse-entry.js",
            launchArgumentsSha256:
              "b9238869a0ba8007b4cff49069dbc9150cc340158bbd79a10424354d534d20c0",
            nodeExecutable: "C:\\runtime\\node.exe",
            receiptSha256: "428c241a82aed279f65f021b94dee10ac6ed649c702e1f1d96672eb06d8d740a",
            repositoryRoot: "C:\\fixture\\repository",
            rootBinding: "0320cd6da3f909bde9a6b0d03060b56a8abb0c6aaa6d3e21372a880c6cf5eccd",
            settingsSha256: "bdd4341c8560b5098386a3156cb99d3eabf55c8131ee38a92b17fa55ccd6e7e8",
          }
        : {
            adapterEntry: "/packed/claude-pretooluse-entry.js",
            launchArgumentsSha256:
              "9141bc2bb53c38d0db1241a1c9c9419a6d0c12ab090b2d072d5669a07f9774f2",
            nodeExecutable: "/runtime/node",
            receiptSha256: "16f392f4876e56aef1972f48203d6e4d7db001982b89006929c517ad850b0475",
            repositoryRoot: "/fixture/repository",
            rootBinding: "39daffb07b3551ec5a32246bee521fe210d18d57f87af31ce492b1767ac79f91",
            settingsSha256: "c46f6d14d1c5e7fb08e15d504ce68dd1f7afb0ab1c03de689ee583b2a96e5a7a",
          };
    const artifacts = buildClaudeProjectHookArtifacts({
      adapterBytes: Buffer.from("adapter fixture"),
      adapterEntry: vector.adapterEntry,
      adapterVersion: "0.1.0-alpha.1",
      installationId,
      nodeExecutable: vector.nodeExecutable,
      nodeVersion: "v22.18.0",
      repositoryIdentity: { dev: 7n, ino: 42n },
      repositoryRoot: vector.repositoryRoot,
    });

    expect(artifacts.receipt.rootBinding).toBe(vector.rootBinding);
    expect(artifacts.receipt.settingsSha256).toBe(vector.settingsSha256);
    expect(artifacts.receipt.launchArgumentsSha256).toBe(vector.launchArgumentsSha256);
    expect(createHash("sha256").update(artifacts.receiptBytes).digest("hex")).toBe(
      vector.receiptSha256,
    );
  });

  it("builds stable compact settings and a path-redacted closed receipt", () => {
    const adapterBytes = Buffer.from("adapter fixture", "utf8");
    const input = {
      adapterBytes,
      adapterEntry: resolve("packed path", "claude-pretooluse-entry.js"),
      adapterVersion: "0.1.0-alpha.1",
      installationId,
      nodeExecutable: resolve("runtime path", "node executable"),
      nodeVersion: "v22.18.0",
      repositoryIdentity: { dev: 7n, ino: 42n },
      repositoryRoot,
    };
    const first = buildClaudeProjectHookArtifacts(input);
    const second = buildClaudeProjectHookArtifacts(input);

    expect(first).toEqual(second);
    expect(first.settings).toEqual({
      hooks: {
        PreToolUse: [
          {
            matcher: "Bash|PowerShell",
            hooks: [
              {
                type: "command",
                command: input.nodeExecutable,
                args: [
                  input.adapterEntry,
                  "--deployment-trust",
                  "project",
                  "--installation-id",
                  installationId,
                  "--root-binding",
                  first.receipt.rootBinding,
                ],
                timeout: 10,
              },
            ],
          },
        ],
      },
    });
    expect(first.settingsBytes.at(-1)).toBe(0x0a);
    expect(first.settingsBytes.toString("utf8")).not.toContain("\n ");
    expect(first.receiptBytes.at(-1)).toBe(0x0a);
    expect(parseClaudeProjectHookSettingsBytes(first.settingsBytes)).toEqual(first.settings);
    expect(parseClaudeProjectHookReceiptBytes(first.receiptBytes)).toEqual(first.receipt);
    expect(first.receipt.settingsSha256).toBe(
      createHash("sha256").update(first.settingsBytes).digest("hex"),
    );
    expect(first.receipt.adapterSha256).toBe(
      createHash("sha256").update(adapterBytes).digest("hex"),
    );
    expect(first.receipt.launchArgumentsSha256).toBe(
      computeClaudeLaunchArgumentsSha256(first.launchArguments),
    );
    expect(first.receiptBytes.toString("utf8")).not.toContain(repositoryRoot);
    expect(first.receiptBytes.toString("utf8")).not.toContain(input.nodeExecutable);
    expect(first.receiptBytes.toString("utf8")).not.toContain(input.adapterEntry);
    expect(first.settingsBytes.toString("utf8")).toContain(installationId);
    expect(first.settingsBytes.toString("utf8")).toContain(first.receipt.rootBinding);
  });

  it("rejects noncanonical, duplicate, unknown, oversized, and invalid-UTF-8 records", () => {
    const artifacts = buildFixture();
    const receipt = artifacts.receiptBytes.toString("utf8").trimEnd();
    expect(
      parseClaudeProjectHookReceiptBytes(Buffer.concat([Buffer.from(" "), artifacts.receiptBytes])),
    ).toBeUndefined();
    expect(parseClaudeProjectHookReceiptBytes(Buffer.from(receipt))).toBeUndefined();
    expect(
      parseClaudeProjectHookReceiptBytes(
        Buffer.from(
          `${receipt.replace('"schemaVersion":"1.0"', '"schemaVersion":"1.0","schemaVersion":"1.0"')}\n`,
        ),
      ),
    ).toBeUndefined();
    expect(
      parseClaudeProjectHookReceiptBytes(
        Buffer.from(`${receipt.slice(0, -1)},"trust":"managed"}\n`),
      ),
    ).toBeUndefined();
    expect(parseClaudeProjectHookReceiptBytes(Buffer.alloc(8_193, 0x20))).toBeUndefined();
    expect(parseClaudeProjectHookReceiptBytes(Buffer.from([0xff]))).toBeUndefined();

    const settings = artifacts.settingsBytes.toString("utf8").trimEnd();
    expect(
      parseClaudeProjectHookSettingsBytes(
        Buffer.concat([Buffer.from(" "), artifacts.settingsBytes]),
      ),
    ).toBeUndefined();
    expect(parseClaudeProjectHookSettingsBytes(Buffer.from(settings))).toBeUndefined();
    expect(
      parseClaudeProjectHookSettingsBytes(
        Buffer.from(`${settings.replace('"hooks":', '"hooks":{},"hooks":')}\n`),
      ),
    ).toBeUndefined();
    expect(
      parseClaudeProjectHookSettingsBytes(
        Buffer.from(`${settings.replace('"hooks":', '"unknown":true,"hooks":')}\n`),
      ),
    ).toBeUndefined();
    expect(parseClaudeProjectHookSettingsBytes(Buffer.alloc(65_537, 0x20))).toBeUndefined();
    expect(parseClaudeProjectHookSettingsBytes(Buffer.from([0xff]))).toBeUndefined();
  });

  it("binds root location, identity, installation, settings, launch arguments, and adapter bytes", () => {
    const original = buildFixture();
    const moved = buildFixture({ repositoryRoot: resolve("different", "repository") });
    const replacedRoot = buildFixture({ repositoryIdentity: { dev: 7n, ino: 43n } });
    const replacedInstallation = buildFixture({ installationId: "11".repeat(32) });
    const replacedAdapter = buildFixture({ adapterBytes: Buffer.from("different adapter") });
    const replacedNode = buildFixture({ nodeExecutable: resolve("different", "node") });
    const replacedAdapterEntry = buildFixture({
      adapterEntry: resolve("different", "claude-pretooluse-entry.js"),
    });

    expect(moved.receipt.rootBinding).not.toBe(original.receipt.rootBinding);
    expect(replacedRoot.receipt.rootBinding).not.toBe(original.receipt.rootBinding);
    expect(replacedInstallation.receipt.rootBinding).not.toBe(original.receipt.rootBinding);
    expect(replacedAdapter.receipt.adapterSha256).not.toBe(original.receipt.adapterSha256);
    expect(replacedAdapter.receipt.settingsSha256).toBe(original.receipt.settingsSha256);
    expect(replacedNode.receipt.settingsSha256).not.toBe(original.receipt.settingsSha256);
    expect(replacedNode.receipt.launchArgumentsSha256).toBe(original.receipt.launchArgumentsSha256);
    expect(replacedAdapterEntry.receipt.settingsSha256).not.toBe(original.receipt.settingsSha256);
    expect(replacedAdapterEntry.receipt.launchArgumentsSha256).not.toBe(
      original.receipt.launchArgumentsSha256,
    );
  });

  it("verifies receipt binding and the exact settings declaration", () => {
    const artifacts = buildFixture();
    expect(
      verifyClaudeProjectHookReceiptBinding(artifacts.receipt, repositoryRoot, {
        dev: 7n,
        ino: 42n,
      }),
    ).toBe(true);
    expect(
      verifyClaudeProjectHookReceiptBinding(artifacts.receipt, repositoryRoot, {
        dev: 7n,
        ino: 43n,
      }),
    ).toBe(false);
    expect(
      verifyClaudeProjectHookSettingsBytes(artifacts.receipt, artifacts.settingsBytes),
    ).toEqual({
      adapterEntry: artifacts.launchArguments[0],
      nodeExecutable: artifacts.settings.hooks.PreToolUse[0].hooks[0].command,
    });
    expect(
      verifyClaudeProjectHookSettingsBytes(
        { ...artifacts.receipt, launchArgumentsSha256: "ff".repeat(32) },
        artifacts.settingsBytes,
      ),
    ).toBeUndefined();
    expect(
      verifyClaudeProjectHookSettingsBytes(
        artifacts.receipt,
        Buffer.concat([Buffer.from(" "), artifacts.settingsBytes]),
      ),
    ).toBeUndefined();
  });

  it.each(["relative/node", "line\nbreak", `/${"x".repeat(4_097)}`])(
    "rejects an unsafe launch path: %j",
    (nodeExecutable) => {
      expect(() => buildFixture({ nodeExecutable })).toThrow();
    },
  );

  it.each(["relative/adapter", "nul\0adapter", `/${"😀".repeat(2_049)}`])(
    "rejects an unsafe adapter path: %j",
    (adapterEntry) => {
      expect(() => buildFixture({ adapterEntry })).toThrow();
    },
  );

  it("length-frames launch arguments instead of delimiter-joining them", () => {
    const first = ["ab", "c", "d", "e", "f", "g", "h"];
    const second = ["a", "bc", "d", "e", "f", "g", "h"];
    expect(computeClaudeLaunchArgumentsSha256(first)).not.toBe(
      computeClaudeLaunchArgumentsSha256(second),
    );
  });

  it("rejects invalid versions and unknown receipt fields", () => {
    expect(() => buildFixture({ adapterVersion: "line\nbreak" })).toThrow();
    expect(() => buildFixture({ nodeVersion: "" })).toThrow();
    expect(() =>
      claudeProjectHookReceiptSchema.parse({ ...buildFixture().receipt, trust: "managed" }),
    ).toThrow();
  });

  it.each(
    [
      [],
      ["only-one"],
      Array.from({ length: 8 }, (_, index) => `argument-${index}`),
      ["ok", "ok", "ok", "ok", "ok", "ok", "line\nbreak"],
    ].map((arguments_) => [arguments_] as const),
  )("rejects an invalid launch digest vector: %j", (arguments_) => {
    expect(() => computeClaudeLaunchArgumentsSha256(arguments_)).toThrow();
  });
});

function buildFixture(
  overrides: Partial<Parameters<typeof buildClaudeProjectHookArtifacts>[0]> = {},
) {
  return buildClaudeProjectHookArtifacts({
    adapterBytes: Buffer.from("adapter fixture"),
    adapterEntry: resolve("packed path", "claude-pretooluse-entry.js"),
    adapterVersion: "0.1.0-alpha.1",
    installationId,
    nodeExecutable: resolve("runtime path", "node executable"),
    nodeVersion: "v22.18.0",
    repositoryIdentity: { dev: 7n, ino: 42n },
    repositoryRoot,
    ...overrides,
  });
}
