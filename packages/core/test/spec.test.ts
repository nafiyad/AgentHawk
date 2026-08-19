import { describe, expect, it } from "vitest";
import { NpmSpecError, parseNpmSpec } from "../src/npm/spec.js";

describe("parseNpmSpec", () => {
  it.each([
    ["lodash", "lodash", "latest", "wildcard"],
    ["lodash@4.17.21", "lodash", "4.17.21", "exact"],
    ["lodash@^4.17.0", "lodash", "^4.17.0", "range"],
    ["lodash@next", "lodash", "next", "tag"],
    ["@scope/package", "@scope/package", "latest", "wildcard"],
    ["@scope/package@1.2.3-beta.1", "@scope/package", "1.2.3-beta.1", "exact"],
  ] as const)("parses registry spec %s", (raw, name, requestedSpec, selectorKind) => {
    expect(parseNpmSpec(raw)).toEqual({
      type: "registry",
      raw,
      name,
      requestedSpec,
      selectorKind,
    });
  });

  it.each([
    ["alias@npm:real-package@1.0.0", "alias"],
    ["package@workspace:*", "workspace"],
    ["package@file:../package", "file"],
    ["package@https://example.test/package.tgz", "url"],
    ["package@git+https://example.test/repo.git", "git"],
    ["owner/repository#main", "git"],
    ["../local-package", "directory"],
  ] as const)("classifies non-registry spec %s", (raw, kind) => {
    expect(parseNpmSpec(raw)).toMatchObject({ type: "non_registry", raw, kind });
  });

  it.each([
    "",
    "UPPERCASE",
    "bad package",
    "@scope",
    "@scope/",
    "@bad!scope/package",
    "package@not/a/tag",
    "package\u0000@1.0.0",
    `package@${"x".repeat(600)}`,
    "a".repeat(215),
  ])("rejects invalid input %j", (raw) => {
    expect(() => parseNpmSpec(raw)).toThrow(NpmSpecError);
  });
});
