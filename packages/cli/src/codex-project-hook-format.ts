import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, normalize, posix, resolve, win32 } from "node:path";
import { z } from "zod";
import { CODEX_CONTRACT_RELEASE } from "./codex-pretooluse.js";

const hexadecimal256 = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedVersion = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/\p{C}/u.test(value));

export const codexProjectHookReceiptSchema = z
  .object({
    adapterSha256: hexadecimal256,
    adapterVersion: boundedVersion,
    contractRelease: z.literal(CODEX_CONTRACT_RELEASE),
    hookDefinitionSha256: hexadecimal256,
    hookSha256: hexadecimal256,
    installationId: hexadecimal256,
    integration: z.literal("codex-project-hook"),
    launchArgumentsSha256: hexadecimal256,
    nodeVersion: boundedVersion,
    rootBinding: hexadecimal256,
    schemaVersion: z.literal("1.0"),
  })
  .strict();

export type CodexProjectHookReceipt = z.infer<typeof codexProjectHookReceiptSchema>;

export interface CodexProjectHookFormatInput {
  readonly adapterBytes: Uint8Array;
  readonly adapterEntry: string;
  readonly adapterVersion: string;
  readonly installationId: string;
  readonly nodeExecutable: string;
  readonly nodeVersion: string;
  readonly repositoryIdentity: {
    readonly dev: bigint;
    readonly ino: bigint;
  };
  readonly repositoryRoot: string;
}

export interface CodexProjectHookArtifacts {
  readonly hook: Record<string, unknown>;
  readonly hookBytes: Buffer;
  readonly receipt: CodexProjectHookReceipt;
  readonly receiptBytes: Buffer;
}

export interface CodexProjectHookLaunchContext {
  readonly deploymentTrust: "project";
  readonly installationId: string;
  readonly rootBinding: string;
}

const rootBindingDomain = Buffer.from("AgentHawk Codex root binding v1\0", "ascii");
const maximumPathCodeUnits = 16_384;
const maximumPathUtf8Bytes = 16_384;
const maximumFilesystemIdentity = (1n << 64n) - 1n;

export function createCodexProjectHookIdentifier(
  generate: (size: number) => Buffer = randomBytes,
): string {
  const bytes = generate(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new Error("Codex project-hook identifier generation failed.");
  }
  return bytes.toString("hex");
}

export function computeCodexProjectRootBinding(input: {
  readonly installationId: string;
  readonly repositoryIdentity: { readonly dev: bigint; readonly ino: bigint };
  readonly repositoryRoot: string;
}): string {
  const installationId = hexadecimal256.parse(input.installationId);
  if (
    input.repositoryIdentity.dev < 0n ||
    input.repositoryIdentity.dev > maximumFilesystemIdentity ||
    input.repositoryIdentity.ino <= 0n ||
    input.repositoryIdentity.ino > maximumFilesystemIdentity
  ) {
    throw new Error("Codex project-hook repository identity is invalid.");
  }
  validateCanonicalPortableAbsolutePath(input.repositoryRoot);
  const root = Buffer.from(input.repositoryRoot, "utf8");
  const fields = [
    Buffer.from(installationId, "hex"),
    root,
    Buffer.from(input.repositoryIdentity.dev.toString(10), "ascii"),
    Buffer.from(input.repositoryIdentity.ino.toString(10), "ascii"),
  ];
  const hash = createHash("sha256").update(rootBindingDomain);
  for (const field of fields) {
    const length = Buffer.alloc(8);
    length.writeBigUInt64BE(BigInt(field.length));
    hash.update(length).update(field);
  }
  return hash.digest("hex");
}

export function parseCodexProjectHookLaunchArguments(
  arguments_: readonly string[],
): CodexProjectHookLaunchContext {
  if (arguments_.length !== 3 || arguments_[0] !== "--agenthawk-deployment-trust=project") {
    throw new Error("Codex project-hook launch declaration is invalid.");
  }
  const installationPrefix = "--agenthawk-installation-id=";
  const bindingPrefix = "--agenthawk-root-binding=";
  if (!arguments_[1]?.startsWith(installationPrefix) || !arguments_[2]?.startsWith(bindingPrefix)) {
    throw new Error("Codex project-hook launch declaration is invalid.");
  }
  return {
    deploymentTrust: "project",
    installationId: hexadecimal256.parse(arguments_[1].slice(installationPrefix.length)),
    rootBinding: hexadecimal256.parse(arguments_[2].slice(bindingPrefix.length)),
  };
}

export function buildCodexProjectHookArtifacts(
  input: CodexProjectHookFormatInput,
): CodexProjectHookArtifacts {
  validateAbsoluteLaunchPath(input.nodeExecutable);
  validateAbsoluteLaunchPath(input.adapterEntry);
  validateCanonicalNativeAbsolutePath(input.repositoryRoot, "repository root");
  const installationId = hexadecimal256.parse(input.installationId);
  const adapterVersion = boundedVersion.parse(input.adapterVersion);
  const nodeVersion = boundedVersion.parse(input.nodeVersion);
  const rootBinding = computeCodexProjectRootBinding({
    installationId,
    repositoryIdentity: input.repositoryIdentity,
    repositoryRoot: input.repositoryRoot,
  });
  const fixedArguments = [
    `--agenthawk-deployment-trust=project`,
    `--agenthawk-installation-id=${installationId}`,
    `--agenthawk-root-binding=${rootBinding}`,
  ] as const;
  const launchArguments = [input.nodeExecutable, input.adapterEntry, ...fixedArguments];
  const command = launchArguments.map(quotePosixArgument).join(" ");
  const commandWindows = `& ${launchArguments.map(quotePowerShellLiteral).join(" ")}`;
  validateGeneratedCommand(command);
  validateGeneratedCommand(commandWindows);
  const hookDefinition = {
    matcher: "^Bash$",
    hooks: [
      {
        type: "command",
        async: false,
        command,
        commandWindows,
        timeout: 10,
        statusMessage: "Evaluating dependency action",
      },
    ],
  };
  const hook = {
    description:
      "AgentHawk Codex project dependency admission hook for rust-v0.149.0. Machine-local; do not commit.",
    hooks: { PreToolUse: [hookDefinition] },
  };
  const hookBytes = serializeJson(hook);
  if (hookBytes.length > 65_536) throw new Error("Codex project-hook declaration is too large.");
  const receipt = codexProjectHookReceiptSchema.parse({
    adapterSha256: digest(input.adapterBytes),
    adapterVersion,
    contractRelease: CODEX_CONTRACT_RELEASE,
    hookDefinitionSha256: digest(serializeJson(hookDefinition)),
    hookSha256: digest(hookBytes),
    installationId,
    integration: "codex-project-hook",
    launchArgumentsSha256: digest(serializeJson(launchArguments)),
    nodeVersion,
    rootBinding,
    schemaVersion: "1.0",
  });
  return { hook, hookBytes, receipt, receiptBytes: serializeJson(receipt) };
}

export function quotePosixArgument(value: string): string {
  validateLaunchArgument(value);
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function quotePowerShellLiteral(value: string): string {
  validateLaunchArgument(value);
  return `'${value.replaceAll("'", "''")}'`;
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateAbsoluteLaunchPath(value: string): void {
  validateLaunchArgument(value);
  validateCanonicalNativeAbsolutePath(value, "launch path");
}

function validateCanonicalNativeAbsolutePath(value: string, label: string): void {
  if (!isAbsolute(value) || normalize(value) !== value || resolve(value) !== value) {
    throw new Error(`Codex project-hook ${label} is invalid.`);
  }
}

function validateCanonicalPortableAbsolutePath(value: string): void {
  validateBoundedUtf8Path(value);
  const canonicalPosix = posix.isAbsolute(value) && posix.normalize(value) === value;
  const fullyQualifiedWindows =
    /^[A-Za-z]:\\/u.test(value) || /^\\\\[^\\]+\\[^\\]+(?:\\|$)/u.test(value);
  const canonicalWindows =
    fullyQualifiedWindows && win32.isAbsolute(value) && win32.normalize(value) === value;
  if (!canonicalPosix && !canonicalWindows) {
    throw new Error("Codex project-hook repository root is invalid.");
  }
}

function validateBoundedUtf8Path(value: string): void {
  if (
    !value ||
    value.length > maximumPathCodeUnits ||
    Buffer.byteLength(value, "utf8") > maximumPathUtf8Bytes ||
    /\p{C}/u.test(value)
  ) {
    throw new Error("Codex project-hook repository root is invalid.");
  }
}

function validateLaunchArgument(value: string): void {
  if (
    !value ||
    value.length > 4_096 ||
    Buffer.byteLength(value, "utf8") > 16_384 ||
    /\p{C}/u.test(value) ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    throw new Error("Codex project-hook launch argument is invalid.");
  }
}

function validateGeneratedCommand(value: string): void {
  if (Buffer.byteLength(value, "utf8") > 16_384) {
    throw new Error("Codex project-hook command is too large.");
  }
}
