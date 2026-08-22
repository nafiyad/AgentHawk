import { z } from "zod";
import { NpmSpecError, parseNpmSpec } from "../npm/spec.js";
import { type ShellDialect, shellDialectSchema } from "./domain.js";

export const qualificationReasonSchema = z.enum([
  "not_dependency_action",
  "direct_dependency_add",
  "ephemeral_execution_unsupported",
  "shell_dialect_unsupported",
  "shell_composition",
  "unsupported_executable",
  "unsupported_subcommand",
  "unsupported_flag",
  "double_dash",
  "no_operands",
  "non_registry_operand",
  "workspace_operand",
  "unsupported_package_manager",
  "command_empty",
  "command_limit",
  "operand_limit",
  "invalid_operand",
  "control_character",
]);
export type QualificationReason = z.infer<typeof qualificationReasonSchema>;

const qualifiedPackageSchema = z
  .object({
    name: z.string().min(1).max(214),
    requestedSpec: z.string().min(1).max(512),
    selectorKind: z.enum(["exact", "range", "tag", "wildcard"]),
  })
  .strict();
export type QualifiedPackage = z.infer<typeof qualifiedPackageSchema>;

export const commandQualificationSchema = z.discriminatedUnion("category", [
  z
    .object({ category: z.literal("unrelated"), reasonCode: z.literal("not_dependency_action") })
    .strict(),
  z
    .object({
      category: z.literal("dependency_add"),
      reasonCode: z.literal("direct_dependency_add"),
      manager: z.enum(["npm", "pnpm"]),
      operation: z.literal("add"),
      packages: z.array(qualifiedPackageSchema).min(1).max(8),
    })
    .strict(),
  z
    .object({
      category: z.literal("ephemeral_execution"),
      reasonCode: z.literal("ephemeral_execution_unsupported"),
    })
    .strict(),
  z
    .object({
      category: z.literal("install_like_unsupported"),
      reasonCode: qualificationReasonSchema.exclude([
        "not_dependency_action",
        "direct_dependency_add",
        "ephemeral_execution_unsupported",
        "command_empty",
        "command_limit",
        "operand_limit",
        "invalid_operand",
        "control_character",
      ]),
    })
    .strict(),
  z
    .object({
      category: z.literal("invalid"),
      reasonCode: z.enum([
        "command_empty",
        "command_limit",
        "operand_limit",
        "invalid_operand",
        "control_character",
      ]),
    })
    .strict(),
]);
export type CommandQualification = z.infer<typeof commandQualificationSchema>;

const shellStructureCharacters = new Set([
  '"',
  "'",
  "\\",
  "`",
  "$",
  ";",
  "&",
  "|",
  "<",
  ">",
  "(",
  ")",
  "{",
  "}",
  "[",
  "]",
  "?",
]);
const unsupportedManagerExecutablePattern =
  /^(?:.*[\\/])?(?:npm|pnpm|npx|pnpx)(?:\.(?:cmd|exe))?$/iu;
const managerExecutables = new Set(["npm", "pnpm", "npx", "pnpx", "yarn", "bun"]);
const ambiguousExecutables = new Set([
  "bash",
  "busybox",
  "chroot",
  "cmd",
  "cmd.exe",
  "command",
  "corepack",
  "dash",
  "daemon",
  "daemonize",
  "doas",
  "env",
  "eval",
  "exec",
  "fish",
  "ionice",
  "ksh",
  "nice",
  "node",
  "nohup",
  "nsenter",
  "perl",
  "powershell",
  "powershell.exe",
  "prlimit",
  "pwsh",
  "pwsh.exe",
  "python",
  "python3",
  "runuser",
  "ruby",
  "s6-setuidgid",
  "script",
  "setsid",
  "setpriv",
  "sh",
  "stdbuf",
  "strace",
  "su",
  "sudo",
  "systemd-run",
  "taskset",
  "time",
  "timeout",
  "unshare",
  "watch",
  "xargs",
  "zsh",
]);
const reservedWords = new Set([
  "!",
  "case",
  "coproc",
  "do",
  "done",
  "elif",
  "else",
  "esac",
  "fi",
  "for",
  "function",
  "if",
  "in",
  "select",
  "then",
  "until",
  "while",
]);

function hasShellStructure(value: string): boolean {
  return (
    [...value].some((character) => shellStructureCharacters.has(character)) ||
    /(?:^| +)#/u.test(value)
  );
}

function isManagerLikeExecutable(token: string): boolean {
  const lower = token.toLowerCase();
  if (managerExecutables.has(lower) || unsupportedManagerExecutablePattern.test(token)) return true;
  const deobfuscated = token.replace(/["'\\`$(){}[\]?*,]/gu, "").toLowerCase();
  return (
    managerExecutables.has(deobfuscated) || unsupportedManagerExecutablePattern.test(deobfuscated)
  );
}

function executableBaseName(token: string): string {
  return (token.split(/[\\/]/u).pop() ?? token).toLowerCase();
}

function isAmbiguousCommand(command: string, words: readonly string[]): boolean {
  const executable = words[0] ?? "";
  const executableBase = executableBaseName(executable);
  return (
    hasShellStructure(command) ||
    command.includes("*") ||
    reservedWords.has(executableBase) ||
    ambiguousExecutables.has(executableBase) ||
    /^[a-z_][a-z0-9_]*\+?=/iu.test(executable) ||
    isManagerLikeExecutable(executable)
  );
}

export function qualifyCommand(
  command: string,
  dialect: ShellDialect = "posix",
): CommandQualification {
  if (typeof command !== "string" || command.trim().length === 0) {
    return { category: "invalid", reasonCode: "command_empty" };
  }
  if (command.length > 16_384) {
    return { category: "invalid", reasonCode: "command_limit" };
  }
  if (Buffer.byteLength(command, "utf8") > 16_384) {
    return { category: "invalid", reasonCode: "command_limit" };
  }
  if (
    /\p{C}/u.test(command) ||
    /[\t\r\n\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]/u.test(command)
  ) {
    return { category: "invalid", reasonCode: "control_character" };
  }
  if (shellDialectSchema.parse(dialect) !== "posix") {
    return { category: "install_like_unsupported", reasonCode: "shell_dialect_unsupported" };
  }

  const trimmed = command.trim();
  const words = trimmed.split(/ +/u);
  const executable = words[0] ?? "";
  const subcommand = words[1];
  if (
    executable === "npx" ||
    executable === "pnpx" ||
    (executable === "npm" && (subcommand === "exec" || subcommand === "x")) ||
    (executable === "pnpm" && (subcommand === "dlx" || subcommand === "exec"))
  ) {
    return {
      category: "ephemeral_execution",
      reasonCode: "ephemeral_execution_unsupported",
    };
  }

  const exactManager = executable === "npm" || executable === "pnpm";
  if (!exactManager) {
    if (!isAmbiguousCommand(trimmed, words)) {
      return { category: "unrelated", reasonCode: "not_dependency_action" };
    }
    const simpleExecutable = /^(?:npm|pnpm)$/iu.test(executable);
    const executableBase = executableBaseName(executable);
    return {
      category: "install_like_unsupported",
      reasonCode: simpleExecutable
        ? "unsupported_executable"
        : isManagerLikeExecutable(executable) ||
            ambiguousExecutables.has(executableBase) ||
            reservedWords.has(executableBase) ||
            /^[a-z_][a-z0-9_]*\+?=/iu.test(executable)
          ? "unsupported_package_manager"
          : "shell_composition",
    };
  }

  if (hasShellStructure(trimmed)) {
    return { category: "install_like_unsupported", reasonCode: "shell_composition" };
  }

  const supportedSubcommand =
    executable === "npm"
      ? subcommand === "install" || subcommand === "i" || subcommand === "add"
      : subcommand === "add";
  if (!supportedSubcommand) {
    return { category: "install_like_unsupported", reasonCode: "unsupported_subcommand" };
  }

  const operands = words.slice(2);
  if (operands.length === 0) {
    return { category: "install_like_unsupported", reasonCode: "no_operands" };
  }
  if (operands.length > 8) {
    return { category: "invalid", reasonCode: "operand_limit" };
  }
  if (operands.includes("--")) {
    return { category: "install_like_unsupported", reasonCode: "double_dash" };
  }
  if (operands.some((operand) => operand.startsWith("-"))) {
    return { category: "install_like_unsupported", reasonCode: "unsupported_flag" };
  }

  const packages: QualifiedPackage[] = [];
  for (const operand of operands) {
    try {
      const parsed = parseNpmSpec(operand);
      if (parsed.type !== "registry") {
        return {
          category: "install_like_unsupported",
          reasonCode: parsed.kind === "workspace" ? "workspace_operand" : "non_registry_operand",
        };
      }
      if (operand.includes("*")) {
        return { category: "install_like_unsupported", reasonCode: "shell_composition" };
      }
      packages.push({
        name: parsed.name,
        requestedSpec: parsed.requestedSpec,
        selectorKind: parsed.selectorKind,
      });
    } catch (error) {
      if (error instanceof NpmSpecError) {
        return { category: "invalid", reasonCode: "invalid_operand" };
      }
      return { category: "invalid", reasonCode: "invalid_operand" };
    }
  }

  return commandQualificationSchema.parse({
    category: "dependency_add",
    reasonCode: "direct_dependency_add",
    manager: executable,
    operation: "add",
    packages,
  });
}
