import { describe, expect, it } from "vitest";
import {
  compareDirectDependencies,
  directDependencies,
  packageManifestSchema,
} from "../src/scan/dependencies.js";

describe("directDependencies", () => {
  it("classifies and deterministically orders direct dependencies including scoped names", () => {
    expect(
      directDependencies({
        devDependencies: { zod: "4.0.0" },
        dependencies: { "@scope/pkg": "^1.0.0", alpha: "2.0.0" },
        optionalDependencies: { native: "~3.0.0" },
        peerDependencies: { react: ">=18" },
      }),
    ).toEqual([
      { name: "@scope/pkg", requestedSpec: "^1.0.0", section: "dependencies" },
      { name: "alpha", requestedSpec: "2.0.0", section: "dependencies" },
      { name: "native", requestedSpec: "~3.0.0", section: "optionalDependencies" },
      { name: "react", requestedSpec: ">=18", section: "peerDependencies" },
      { name: "zod", requestedSpec: "4.0.0", section: "devDependencies" },
    ]);
  });

  it.each([{ dependencies: { empty: "" } }, { dependencies: { valid: 1 } }, { dependencies: [] }])(
    "rejects malformed dependency maps",
    (manifest) => {
      expect(() => packageManifestSchema.parse(manifest)).toThrow();
    },
  );

  it("bounds aggregate dependency count and individual names/specifiers", () => {
    expect(() =>
      packageManifestSchema.parse({
        dependencies: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`pkg-${index}`, "1"]),
        ),
      }),
    ).toThrow();
    expect(() =>
      packageManifestSchema.parse({ dependencies: { ["x".repeat(215)]: "1" } }),
    ).toThrow();
    expect(() =>
      packageManifestSchema.parse({ dependencies: { valid: "x".repeat(2_049) } }),
    ).toThrow();
  });
});

describe("compareDirectDependencies", () => {
  it("reports additions, version changes, and section changes without reporting removals", () => {
    const base = {
      dependencies: { moved: "1.0.0", removed: "1.0.0", updated: "^1.0.0" },
    };
    const current = {
      dependencies: { added: "latest", updated: "^2.0.0" },
      devDependencies: { moved: "1.0.0" },
    };
    expect(compareDirectDependencies(base, current)).toEqual([
      { kind: "added", name: "added", requestedSpec: "latest", section: "dependencies" },
      {
        kind: "section_changed",
        name: "moved",
        previousSection: "dependencies",
        previousSpec: "1.0.0",
        requestedSpec: "1.0.0",
        section: "devDependencies",
      },
      {
        kind: "version_changed",
        name: "updated",
        previousSection: "dependencies",
        previousSpec: "^1.0.0",
        requestedSpec: "^2.0.0",
        section: "dependencies",
      },
    ]);
  });

  it("prefers the matching prior section when a name exists in multiple sections", () => {
    expect(
      compareDirectDependencies(
        { dependencies: { shared: "1" }, devDependencies: { shared: "2" } },
        { devDependencies: { shared: "3" } },
      ),
    ).toEqual([
      {
        kind: "version_changed",
        name: "shared",
        previousSection: "devDependencies",
        previousSpec: "2",
        requestedSpec: "3",
        section: "devDependencies",
      },
    ]);
  });
});
