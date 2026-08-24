import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildCodexProjectHookArtifacts,
  codexProjectHookLockSchema,
  codexProjectHookReceiptSchema,
  computeCodexProjectRootBinding,
  createCodexProjectHookIdentifier,
  parseCodexProjectHookLaunchArguments,
  parseCodexProjectHookReceiptBytes,
  quotePosixArgument,
  quotePowerShellLiteral,
  verifyCodexProjectHookBytes,
  verifyCodexProjectHookReceiptBinding,
} from "../src/codex-project-hook-format.js";

const installationId = "00".repeat(32);
const repositoryRoot = resolve("fixture", "repository");

describe("Codex project-hook root binding", () => {
  it("matches the fixed canonical framing vector", () => {
    expect(
      computeCodexProjectRootBinding({
        installationId,
        repositoryIdentity: { dev: 7n, ino: 42n },
        repositoryRoot: "/fixture/repository",
      }),
    ).toBe("806528a6f1aee5edcd442c1622333b17605292cd3a2cfb016836848c14911d16");
  });

  it.each([
    "A".repeat(64),
    "0".repeat(63),
    `0x${"0".repeat(64)}`,
    `${"0".repeat(32)}-${"0".repeat(32)}`,
  ])("rejects a noncanonical identifier: %s", (candidate) => {
    expect(() =>
      computeCodexProjectRootBinding({
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
      computeCodexProjectRootBinding({ installationId, repositoryIdentity, repositoryRoot }),
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
      computeCodexProjectRootBinding({
        installationId,
        repositoryIdentity: { dev: 1n, ino: 2n },
        repositoryRoot: candidate,
      }),
    ).toThrow();
  });

  it("requires exactly 32 CSPRNG bytes", () => {
    expect(createCodexProjectHookIdentifier(() => Buffer.alloc(32, 0xab))).toBe("ab".repeat(32));
    expect(() => createCodexProjectHookIdentifier(() => Buffer.alloc(31))).toThrow();
  });
});

describe("Codex project-hook format", () => {
  it("builds one stable closed project hook and a path-redacted receipt", () => {
    const adapterBytes = Buffer.from("adapter fixture", "utf8");
    const input = {
      adapterBytes,
      adapterEntry: resolve("packed path", "codex-pretooluse-entry.js"),
      adapterVersion: "0.1.0-alpha.1",
      installationId,
      nodeExecutable: resolve("runtime path", "node executable"),
      nodeVersion: "v22.18.0",
      repositoryIdentity: { dev: 7n, ino: 42n },
      repositoryRoot,
    };
    const first = buildCodexProjectHookArtifacts(input);
    const second = buildCodexProjectHookArtifacts(input);

    expect(first).toEqual(second);
    expect(first.hook).toEqual({
      description:
        "AgentHawk Codex project dependency admission hook for rust-v0.149.0. Machine-local; do not commit.",
      hooks: {
        PreToolUse: [
          {
            matcher: "^Bash$",
            hooks: [
              {
                type: "command",
                async: false,
                command: expect.any(String),
                commandWindows: expect.any(String),
                timeout: 10,
                statusMessage: "Evaluating dependency action",
              },
            ],
          },
        ],
      },
    });
    expect(first.hookBytes.at(-1)).toBe(0x0a);
    expect(first.hookBytes.length).toBeLessThanOrEqual(65_536);
    expect(first.receiptBytes.at(-1)).toBe(0x0a);
    expect(parseCodexProjectHookReceiptBytes(first.receiptBytes)).toEqual(first.receipt);
    expect(
      parseCodexProjectHookReceiptBytes(Buffer.concat([Buffer.from(" "), first.receiptBytes])),
    ).toBeUndefined();
    expect(parseCodexProjectHookReceiptBytes(Buffer.from([0xff]))).toBeUndefined();
    expect(
      codexProjectHookReceiptSchema.parse(JSON.parse(first.receiptBytes.toString("utf8"))),
    ).toEqual(first.receipt);
    expect(first.receipt.adapterSha256).toBe(
      createHash("sha256").update(adapterBytes).digest("hex"),
    );
    expect(first.receiptBytes.toString("utf8")).not.toContain(repositoryRoot);
    expect(first.receiptBytes.toString("utf8")).not.toContain(input.nodeExecutable);
    expect(first.receiptBytes.toString("utf8")).not.toContain(input.adapterEntry);
    expect(first.hookBytes.toString("utf8")).toContain(installationId);
    expect(first.hookBytes.toString("utf8")).toContain(first.receipt.rootBinding);
    expect(verifyCodexProjectHookBytes(first.receipt, first.hookBytes)).toEqual({
      adapterEntry: input.adapterEntry,
      nodeExecutable: input.nodeExecutable,
    });
    expect(
      verifyCodexProjectHookReceiptBinding(
        first.receipt,
        input.repositoryRoot,
        input.repositoryIdentity,
      ),
    ).toBe(true);
    expect(
      verifyCodexProjectHookReceiptBinding(first.receipt, input.repositoryRoot, {
        dev: 7n,
        ino: 43n,
      }),
    ).toBe(false);
  });

  it("rejects drifted or semantically foreign hook bytes", () => {
    const artifacts = buildCodexProjectHookArtifacts({
      adapterBytes: Buffer.from("adapter"),
      adapterEntry: resolve("adapter.js"),
      adapterVersion: "0.1.0-alpha.1",
      installationId,
      nodeExecutable: resolve("node"),
      nodeVersion: "v22.18.0",
      repositoryIdentity: { dev: 1n, ino: 2n },
      repositoryRoot,
    });
    const changed = Buffer.from(artifacts.hookBytes);
    changed[10] = changed[10] === 0x61 ? 0x62 : 0x61;
    expect(verifyCodexProjectHookBytes(artifacts.receipt, changed)).toBeUndefined();
    expect(
      verifyCodexProjectHookBytes(artifacts.receipt, Buffer.from('{"hooks":{}}\n')),
    ).toBeUndefined();
  });

  it("accepts only the closed operation-lock record", () => {
    expect(
      codexProjectHookLockSchema.parse({ operationId: "ab".repeat(32), schemaVersion: "1.0" }),
    ).toEqual({ operationId: "ab".repeat(32), schemaVersion: "1.0" });
    expect(() =>
      codexProjectHookLockSchema.parse({
        operationId: "AB".repeat(32),
        schemaVersion: "1.0",
      }),
    ).toThrow();
    expect(() =>
      codexProjectHookLockSchema.parse({
        operationId: "ab".repeat(32),
        schemaVersion: "1.0",
        pid: 1,
      }),
    ).toThrow();
  });

  it.each(["space value", "quote'value", "dollar$value", "tick`value", "%!^value"])(
    "quotes hostile but non-control arguments without interpolation: %s",
    (value) => {
      expect(quotePosixArgument(value)).toMatch(/^'.*'$/u);
      expect(quotePowerShellLiteral(value)).toMatch(/^'.*'$/u);
    },
  );

  it("uses exact non-interpolating quote escapes", () => {
    expect(quotePosixArgument("quote'value")).toBe("'quote'\"'\"'value'");
    expect(quotePowerShellLiteral("quote'value")).toBe("'quote''value'");
    expect(quotePosixArgument("$value`still-literal")).toBe("'$value`still-literal'");
    expect(quotePowerShellLiteral("$value`still-literal")).toBe("'$value`still-literal'");
  });

  it("binds repository location, identity, installation, and adapter bytes independently", () => {
    const base = {
      adapterBytes: Buffer.from("adapter-a"),
      adapterEntry: resolve("adapter.js"),
      adapterVersion: "0.1.0-alpha.1",
      installationId,
      nodeExecutable: resolve("node"),
      nodeVersion: "v22.18.0",
      repositoryIdentity: { dev: 1n, ino: 2n },
      repositoryRoot,
    };
    const original = buildCodexProjectHookArtifacts(base);
    const moved = buildCodexProjectHookArtifacts({
      ...base,
      repositoryRoot: resolve("different", "repository"),
    });
    const replacedRoot = buildCodexProjectHookArtifacts({
      ...base,
      repositoryIdentity: { dev: 1n, ino: 3n },
    });
    const replacedAdapter = buildCodexProjectHookArtifacts({
      ...base,
      adapterBytes: Buffer.from("adapter-b"),
    });

    expect(moved.receipt.rootBinding).not.toBe(original.receipt.rootBinding);
    expect(replacedRoot.receipt.rootBinding).not.toBe(original.receipt.rootBinding);
    expect(replacedAdapter.receipt.adapterSha256).not.toBe(original.receipt.adapterSha256);
    expect(replacedAdapter.receipt.hookSha256).toBe(original.receipt.hookSha256);
  });

  it.each(["relative/node", "line\nbreak", `/${"x".repeat(4_097)}`])(
    "rejects an unsafe launch path: %j",
    (nodeExecutable) => {
      expect(() =>
        buildCodexProjectHookArtifacts({
          adapterBytes: Buffer.from("adapter"),
          adapterEntry: resolve("adapter.js"),
          adapterVersion: "0.1.0-alpha.1",
          installationId,
          nodeExecutable,
          nodeVersion: "v22.18.0",
          repositoryIdentity: { dev: 1n, ino: 2n },
          repositoryRoot,
        }),
      ).toThrow();
    },
  );

  it.runIf(process.platform === "win32")(
    "rejects current-drive-rooted Windows launch and repository paths",
    () => {
      const base = {
        adapterBytes: Buffer.from("adapter"),
        adapterEntry: resolve("adapter.js"),
        adapterVersion: "0.1.0-alpha.1",
        installationId,
        nodeExecutable: resolve("node.exe"),
        nodeVersion: "v22.18.0",
        repositoryIdentity: { dev: 1n, ino: 2n },
        repositoryRoot,
      };
      expect(() =>
        buildCodexProjectHookArtifacts({ ...base, nodeExecutable: "/node.exe" }),
      ).toThrow();
      expect(() =>
        buildCodexProjectHookArtifacts({ ...base, adapterEntry: "\\adapter.js" }),
      ).toThrow();
      expect(() => buildCodexProjectHookArtifacts({ ...base, repositoryRoot: "/repo" })).toThrow();
    },
  );

  it("rejects drive-relative and dot-segment launch paths", () => {
    const base = {
      adapterBytes: Buffer.from("adapter"),
      adapterEntry: resolve("adapter.js"),
      adapterVersion: "0.1.0-alpha.1",
      installationId,
      nodeExecutable: resolve("node"),
      nodeVersion: "v22.18.0",
      repositoryIdentity: { dev: 1n, ino: 2n },
      repositoryRoot,
    };
    expect(() =>
      buildCodexProjectHookArtifacts({ ...base, nodeExecutable: "C:node.exe" }),
    ).toThrow();
    expect(() =>
      buildCodexProjectHookArtifacts({ ...base, adapterEntry: "C:\\adapter\\..\\entry.js" }),
    ).toThrow();
  });

  it("rejects a generated command over the aggregate UTF-8 bound", () => {
    const longSegment = "😀".repeat(2_020);
    expect(() =>
      buildCodexProjectHookArtifacts({
        adapterBytes: Buffer.from("adapter"),
        adapterEntry: resolve("/", "a", longSegment),
        adapterVersion: "0.1.0-alpha.1",
        installationId,
        nodeExecutable: resolve("/", "n", longSegment),
        nodeVersion: "v22.18.0",
        repositoryIdentity: { dev: 1n, ino: 2n },
        repositoryRoot,
      }),
    ).toThrow("Codex project-hook command is too large.");
  });

  it.each(["line\nbreak", "carriage\rreturn", "nul\0value", "escape\u001bvalue"])(
    "rejects control-bearing arguments: %j",
    (value) => {
      expect(() => quotePosixArgument(value)).toThrow();
      expect(() => quotePowerShellLiteral(value)).toThrow();
    },
  );

  it("rejects unknown receipt fields", () => {
    const parsed = codexProjectHookReceiptSchema.safeParse({
      ...buildCodexProjectHookArtifacts({
        adapterBytes: Buffer.from("adapter"),
        adapterEntry: resolve("adapter.js"),
        adapterVersion: "0.1.0-alpha.1",
        installationId,
        nodeExecutable: resolve("node"),
        nodeVersion: "v22.18.0",
        repositoryIdentity: { dev: 1n, ino: 2n },
        repositoryRoot,
      }).receipt,
      trust: "managed",
    });
    expect(parsed.success).toBe(false);
  });

  it("parses only the exact ordered project launch declaration", () => {
    const rootBinding = "ab".repeat(32);
    expect(
      parseCodexProjectHookLaunchArguments([
        "--agenthawk-deployment-trust=project",
        `--agenthawk-installation-id=${installationId}`,
        `--agenthawk-root-binding=${rootBinding}`,
      ]),
    ).toEqual({ deploymentTrust: "project", installationId, rootBinding });
  });

  it.each(
    [
      [],
      ["--agenthawk-deployment-trust=project"],
      [
        `--agenthawk-installation-id=${installationId}`,
        "--agenthawk-deployment-trust=project",
        `--agenthawk-root-binding=${"ab".repeat(32)}`,
      ],
      [
        "--agenthawk-deployment-trust=managed",
        `--agenthawk-installation-id=${installationId}`,
        `--agenthawk-root-binding=${"ab".repeat(32)}`,
      ],
      [
        "--agenthawk-deployment-trust=project",
        `--wrong-installation-id=${installationId}`,
        `--agenthawk-root-binding=${"ab".repeat(32)}`,
      ],
      [
        "--agenthawk-deployment-trust=project",
        `--agenthawk-installation-id=${installationId}`,
        `--wrong-root-binding=${"ab".repeat(32)}`,
      ],
      [
        "--agenthawk-deployment-trust=project",
        `--agenthawk-installation-id=${"AB".repeat(32)}`,
        `--agenthawk-root-binding=${"ab".repeat(32)}`,
      ],
      [
        "--agenthawk-deployment-trust=project",
        `--agenthawk-installation-id=${installationId}`,
        `--agenthawk-root-binding=${"ab".repeat(32)}`,
        "--extra",
      ],
    ].map((arguments_) => [arguments_] as const),
  )("rejects a malformed launch declaration: %j", (arguments_) => {
    expect(() => parseCodexProjectHookLaunchArguments(arguments_)).toThrow();
  });
});
