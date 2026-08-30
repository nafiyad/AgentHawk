import { createHash, randomBytes } from "node:crypto";
import { isAbsolute, normalize, posix, resolve, win32 } from "node:path";
import { z } from "zod";
import { parseStrictJson } from "./hook-json.js";

export const CLAUDE_PROJECT_HOOK_CONTRACT_RELEASE = "2.1.241";

const hexadecimal256 = z.string().regex(/^[0-9a-f]{64}$/u);
const boundedVersion = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => !/\p{C}/u.test(value));

export const claudeProjectHookReceiptSchema = z
  .object({
    schemaVersion: z.literal("1.0"),
    adapter: z.literal("claude-code"),
    adapterVersion: boundedVersion,
    contractRelease: z.literal(CLAUDE_PROJECT_HOOK_CONTRACT_RELEASE),
    installationId: hexadecimal256,
    rootBinding: hexadecimal256,
    nodeVersion: boundedVersion,
    settingsSha256: hexadecimal256,
    launchArgumentsSha256: hexadecimal256,
    adapterSha256: hexadecimal256,
  })
  .strict();

export type ClaudeProjectHookReceipt = z.infer<typeof claudeProjectHookReceiptSchema>;

const claudeProjectHookSettingsSchema = z
  .object({
    hooks: z
      .object({
        PreToolUse: z.tuple([
          z
            .object({
              matcher: z.literal("Bash|PowerShell"),
              hooks: z.tuple([
                z
                  .object({
                    type: z.literal("command"),
                    command: z.string().min(1).max(16_384),
                    args: z.tuple([
                      z.string(),
                      z.literal("--deployment-trust"),
                      z.literal("project"),
                      z.literal("--installation-id"),
                      hexadecimal256,
                      z.literal("--root-binding"),
                      hexadecimal256,
                    ]),
                    timeout: z.literal(10),
                  })
                  .strict(),
              ]),
            })
            .strict(),
        ]),
      })
      .strict(),
  })
  .strict();

export type ClaudeProjectHookSettings = z.infer<typeof claudeProjectHookSettingsSchema>;

export interface ClaudeProjectHookFormatInput {
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

export interface ClaudeProjectHookArtifacts {
  readonly launchArguments: readonly string[];
  readonly receipt: ClaudeProjectHookReceipt;
  readonly receiptBytes: Buffer;
  readonly settings: ClaudeProjectHookSettings;
  readonly settingsBytes: Buffer;
}

export interface ClaudeProjectHookLaunchContext {
  readonly deploymentTrust: "project";
  readonly installationId: string;
  readonly rootBinding: string;
}

export interface VerifiedClaudeProjectHookSettings {
  readonly adapterEntry: string;
  readonly nodeExecutable: string;
}

const rootBindingDomain = Buffer.from("AgentHawk Claude root binding v1\0", "ascii");
const launchArgumentsDomain = Buffer.from("AgentHawk Claude launch arguments v1\0", "ascii");
const maximumFilesystemIdentity = (1n << 64n) - 1n;
const maximumPathCodeUnits = 16_384;
const maximumPathUtf8Bytes = 16_384;

export function createClaudeProjectHookIdentifier(
  generate: (size: number) => Buffer = randomBytes,
): string {
  const bytes = generate(32);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 32) {
    throw new Error("Claude project-hook identifier generation failed.");
  }
  return bytes.toString("hex");
}

export function computeClaudeProjectRootBinding(input: {
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
    throw new Error("Claude project-hook repository identity is invalid.");
  }
  validateCanonicalPortableAbsolutePath(input.repositoryRoot);
  return digestFramedFields(rootBindingDomain, [
    Buffer.from(installationId, "hex"),
    Buffer.from(input.repositoryRoot, "utf8"),
    Buffer.from(input.repositoryIdentity.dev.toString(10), "ascii"),
    Buffer.from(input.repositoryIdentity.ino.toString(10), "ascii"),
  ]);
}

export function computeClaudeLaunchArgumentsSha256(arguments_: readonly string[]): string {
  if (arguments_.length !== 7) {
    throw new Error("Claude project-hook launch arguments are invalid.");
  }
  const fields = arguments_.map((argument) => {
    validateLaunchArgument(argument);
    return Buffer.from(argument, "utf8");
  });
  const hash = createHash("sha256").update(launchArgumentsDomain);
  const count = Buffer.alloc(8);
  count.writeBigUInt64BE(BigInt(fields.length));
  hash.update(count);
  for (const field of fields) updateFramedField(hash, field);
  return hash.digest("hex");
}

export function parseClaudeProjectHookLaunchArguments(
  arguments_: readonly string[],
): ClaudeProjectHookLaunchContext {
  if (
    arguments_.length !== 6 ||
    arguments_[0] !== "--deployment-trust" ||
    arguments_[1] !== "project" ||
    arguments_[2] !== "--installation-id" ||
    arguments_[4] !== "--root-binding"
  ) {
    throw new Error("Claude project-hook launch declaration is invalid.");
  }
  return {
    deploymentTrust: "project",
    installationId: hexadecimal256.parse(arguments_[3]),
    rootBinding: hexadecimal256.parse(arguments_[5]),
  };
}

export function verifyClaudeProjectHookReceiptBinding(
  receipt: ClaudeProjectHookReceipt,
  repositoryRoot: string,
  repositoryIdentity: { readonly dev: bigint; readonly ino: bigint },
): boolean {
  try {
    return (
      computeClaudeProjectRootBinding({
        installationId: receipt.installationId,
        repositoryIdentity,
        repositoryRoot,
      }) === receipt.rootBinding
    );
  } catch {
    return false;
  }
}

export function verifyClaudeProjectHookSettingsBytes(
  receipt: ClaudeProjectHookReceipt,
  settingsBytes: Uint8Array,
): VerifiedClaudeProjectHookSettings | undefined {
  try {
    if (digest(settingsBytes) !== receipt.settingsSha256) return undefined;
    const settings = parseClaudeProjectHookSettingsBytes(settingsBytes);
    if (!settings) return undefined;
    const handler = settings.hooks.PreToolUse[0].hooks[0];
    const context = parseClaudeProjectHookLaunchArguments(handler.args.slice(1));
    if (
      context.installationId !== receipt.installationId ||
      context.rootBinding !== receipt.rootBinding ||
      computeClaudeLaunchArgumentsSha256(handler.args) !== receipt.launchArgumentsSha256
    ) {
      return undefined;
    }
    return { adapterEntry: handler.args[0], nodeExecutable: handler.command };
  } catch {
    return undefined;
  }
}

export function buildClaudeProjectHookArtifacts(
  input: ClaudeProjectHookFormatInput,
): ClaudeProjectHookArtifacts {
  validateAbsoluteLaunchPath(input.nodeExecutable);
  validateAbsoluteLaunchPath(input.adapterEntry);
  validateCanonicalNativeAbsolutePath(input.repositoryRoot, "repository root");
  const installationId = hexadecimal256.parse(input.installationId);
  const adapterVersion = boundedVersion.parse(input.adapterVersion);
  const nodeVersion = boundedVersion.parse(input.nodeVersion);
  const rootBinding = computeClaudeProjectRootBinding({
    installationId,
    repositoryIdentity: input.repositoryIdentity,
    repositoryRoot: input.repositoryRoot,
  });
  const launchArguments = [
    input.adapterEntry,
    "--deployment-trust",
    "project",
    "--installation-id",
    installationId,
    "--root-binding",
    rootBinding,
  ] as const;
  const settings = claudeProjectHookSettingsSchema.parse({
    hooks: {
      PreToolUse: [
        {
          matcher: "Bash|PowerShell",
          hooks: [
            {
              type: "command",
              command: input.nodeExecutable,
              args: launchArguments,
              timeout: 10,
            },
          ],
        },
      ],
    },
  });
  const settingsBytes = serializeCompactJson(settings);
  if (settingsBytes.length > 65_536) {
    throw new Error("Claude project-hook settings are too large.");
  }
  const receipt = claudeProjectHookReceiptSchema.parse({
    schemaVersion: "1.0",
    adapter: "claude-code",
    adapterVersion,
    contractRelease: CLAUDE_PROJECT_HOOK_CONTRACT_RELEASE,
    installationId,
    rootBinding,
    nodeVersion,
    settingsSha256: digest(settingsBytes),
    launchArgumentsSha256: computeClaudeLaunchArgumentsSha256(launchArguments),
    adapterSha256: digest(input.adapterBytes),
  });
  return {
    launchArguments,
    receipt,
    receiptBytes: serializeCompactJson(receipt),
    settings,
    settingsBytes,
  };
}

export function parseClaudeProjectHookReceiptBytes(
  receiptBytes: Uint8Array,
): ClaudeProjectHookReceipt | undefined {
  try {
    if (receiptBytes.byteLength > 8_192) return undefined;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(receiptBytes);
    const receipt = claudeProjectHookReceiptSchema.parse(parseStrictJson(source));
    return Buffer.from(receiptBytes).equals(serializeCompactJson(receipt)) ? receipt : undefined;
  } catch {
    return undefined;
  }
}

export function parseClaudeProjectHookSettingsBytes(
  settingsBytes: Uint8Array,
): ClaudeProjectHookSettings | undefined {
  try {
    if (settingsBytes.byteLength > 65_536) return undefined;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(settingsBytes);
    const settings = claudeProjectHookSettingsSchema.parse(parseStrictJson(source));
    const handler = settings.hooks.PreToolUse[0].hooks[0];
    validateAbsoluteLaunchPath(handler.command);
    validateAbsoluteLaunchPath(handler.args[0]);
    for (const argument of handler.args) validateLaunchArgument(argument);
    return Buffer.from(settingsBytes).equals(serializeCompactJson(settings)) ? settings : undefined;
  } catch {
    return undefined;
  }
}

function digestFramedFields(domain: Buffer, fields: readonly Buffer[]): string {
  const hash = createHash("sha256").update(domain);
  for (const field of fields) updateFramedField(hash, field);
  return hash.digest("hex");
}

function updateFramedField(hash: ReturnType<typeof createHash>, field: Buffer): void {
  const length = Buffer.alloc(8);
  length.writeBigUInt64BE(BigInt(field.length));
  hash.update(length).update(field);
}

function serializeCompactJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, "utf8");
}

function digest(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

function validateAbsoluteLaunchPath(value: string): void {
  validateLaunchArgument(value);
  validateCanonicalNativeAbsolutePath(value, "launch path");
}

function validateCanonicalNativeAbsolutePath(value: string, label: string): void {
  validateBoundedUtf8Path(value);
  if (!isAbsolute(value) || normalize(value) !== value || resolve(value) !== value) {
    throw new Error(`Claude project-hook ${label} is invalid.`);
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
    throw new Error("Claude project-hook repository root is invalid.");
  }
}

function validateBoundedUtf8Path(value: string): void {
  if (
    !value ||
    value.length > maximumPathCodeUnits ||
    Buffer.byteLength(value, "utf8") > maximumPathUtf8Bytes ||
    /\p{C}/u.test(value) ||
    Buffer.from(value, "utf8").toString("utf8") !== value
  ) {
    throw new Error("Claude project-hook path is invalid.");
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
    throw new Error("Claude project-hook launch argument is invalid.");
  }
}
