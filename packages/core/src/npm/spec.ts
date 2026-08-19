import { valid, validRange } from "semver";

const packageSegmentPattern = /^[a-z0-9](?:[a-z0-9._~-]*[a-z0-9])?$/u;
const tagPattern = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u;
const maximumSpecLength = 512;

export type NpmSelectorKind = "exact" | "range" | "tag" | "wildcard";

export interface NpmRegistrySpec {
  type: "registry";
  raw: string;
  name: string;
  requestedSpec: string;
  selectorKind: NpmSelectorKind;
}

export type NonRegistryKind = "alias" | "directory" | "file" | "git" | "url" | "workspace";

export interface NpmNonRegistrySpec {
  type: "non_registry";
  raw: string;
  name?: string;
  kind: NonRegistryKind;
}

export type ParsedNpmSpec = NpmRegistrySpec | NpmNonRegistrySpec;

export class NpmSpecError extends Error {
  readonly code = "invalid_npm_spec";

  constructor(message: string) {
    super(message);
    this.name = "NpmSpecError";
  }
}

export function parseNpmSpec(input: string): ParsedNpmSpec {
  const raw = input.trim();
  if (raw.length === 0) {
    throw new NpmSpecError("Package specification must not be empty.");
  }
  if (raw.length > maximumSpecLength) {
    throw new NpmSpecError(`Package specification exceeds ${maximumSpecLength} characters.`);
  }
  if (/\p{C}|\s/u.test(raw)) {
    throw new NpmSpecError("Package specification contains whitespace or control characters.");
  }

  const named = splitNameAndSelector(raw);
  const nonRegistry = classifyNonRegistry(raw, named);
  if (nonRegistry) {
    return nonRegistry;
  }

  const name = named?.name ?? raw;
  const requestedSpec = named?.selector || "latest";
  validatePackageName(name);

  return {
    type: "registry",
    raw,
    name,
    requestedSpec,
    selectorKind: classifySelector(requestedSpec),
  };
}

function splitNameAndSelector(raw: string): { name: string; selector: string } | undefined {
  if (raw.startsWith("@")) {
    const slash = raw.indexOf("/");
    if (slash < 2) {
      return undefined;
    }
    const separator = raw.indexOf("@", slash);
    if (separator === -1) {
      return undefined;
    }
    return { name: raw.slice(0, separator), selector: raw.slice(separator + 1) };
  }

  const separator = raw.indexOf("@");
  if (separator <= 0) {
    return undefined;
  }
  return { name: raw.slice(0, separator), selector: raw.slice(separator + 1) };
}

function classifyNonRegistry(
  raw: string,
  named: { name: string; selector: string } | undefined,
): NpmNonRegistrySpec | undefined {
  const candidate = named?.selector ?? raw;
  const name = named?.name;
  const result = (kind: NonRegistryKind): NpmNonRegistrySpec => ({
    type: "non_registry",
    raw,
    ...(name ? { name } : {}),
    kind,
  });

  if (candidate.startsWith("npm:")) return result("alias");
  if (candidate.startsWith("workspace:")) return result("workspace");
  if (candidate.startsWith("file:") || candidate.startsWith("link:")) return result("file");
  if (/^(?:https?):\/\//u.test(candidate)) return result("url");
  if (/^(?:git(?:\+[^:]+)?|github|gitlab|bitbucket):/u.test(candidate)) return result("git");
  if (/^(?:\.{0,2}\/|~\/|[a-zA-Z]:[\\/])/u.test(candidate)) return result("directory");
  if (/^[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(?:#.*)?$/u.test(candidate)) return result("git");

  return undefined;
}

function validatePackageName(name: string): void {
  if (name.length > 214) {
    throw new NpmSpecError("Package name exceeds npm's 214-character limit.");
  }
  if (name.startsWith("@")) {
    const parts = name.slice(1).split("/");
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      throw new NpmSpecError("Scoped package names must use @scope/name.");
    }
    if (!packageSegmentPattern.test(parts[0]) || !packageSegmentPattern.test(parts[1])) {
      throw new NpmSpecError("Scoped package name contains unsupported characters.");
    }
    return;
  }
  if (!packageSegmentPattern.test(name)) {
    throw new NpmSpecError("Package name contains unsupported characters.");
  }
}

function classifySelector(selector: string): NpmSelectorKind {
  if (selector === "" || selector === "*" || selector === "latest") return "wildcard";
  if (valid(selector)) return "exact";
  if (validRange(selector)) return "range";
  if (tagPattern.test(selector)) return "tag";
  throw new NpmSpecError("Registry selector is not a valid version, range, or tag.");
}
