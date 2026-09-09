import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  packageSpecifications,
  releaseVersion,
  validateReleaseManifest,
} from "./package-policy.mjs";

function manifest(index: number, packed = false): Record<string, unknown> {
  const value = JSON.parse(
    readFileSync(
      new URL(`../${packageSpecifications[index].directory}/package.json`, import.meta.url),
      "utf8",
    ),
  ) as Record<string, unknown>;
  if (packed && index === 1)
    (value.dependencies as Record<string, string>)["@agenthawk/core"] = releaseVersion;
  return value;
}

describe("own package exact runtime closure", () => {
  it.each([0, 1])("accepts source and packed manifests for package %s", (index) => {
    for (const packed of [false, true])
      expect(() =>
        validateReleaseManifest({
          manifest: manifest(index, packed),
          specification: packageSpecifications[index],
          packed,
        }),
      ).not.toThrow();
  });

  it.each([
    "preinstall",
    "install",
    "postinstall",
    "preprepare",
    "prepare",
    "postprepare",
    "prepublish",
    "prepublishOnly",
    "prepack",
    "postpack",
    "publish",
    "postpublish",
  ])("rejects lifecycle %s", (script) => {
    for (const index of [0, 1]) {
      const value = manifest(index);
      value.scripts = { [script]: "inert fixture never executed" };
      expect(() =>
        validateReleaseManifest({ manifest: value, specification: packageSpecifications[index] }),
      ).toThrow();
    }
  });

  it.each([
    "bundleDependencies",
    "bundledDependencies",
    "optionalDependencies",
    "peerDependencies",
  ])("rejects any %s declaration", (field) => {
    for (const index of [0, 1])
      for (const data of [undefined, {}, [], null, { unexpected: "1.0.0" }]) {
        const value = manifest(index);
        value[field] = data;
        expect(() =>
          validateReleaseManifest({ manifest: value, specification: packageSpecifications[index] }),
        ).toThrow();
      }
  });

  it.each([0, 1])("rejects changed and expanded dependency graphs for package %s", (index) => {
    for (const data of [
      undefined,
      null,
      {},
      { extra: "1.0.0" },
      { ...(manifest(index).dependencies as object), extra: "1.0.0" },
    ]) {
      const value = manifest(index);
      value.dependencies = data;
      expect(() =>
        validateReleaseManifest({ manifest: value, specification: packageSpecifications[index] }),
      ).toThrow();
    }
    for (const key of Object.keys(manifest(index).dependencies as object)) {
      const value = manifest(index);
      (value.dependencies as Record<string, string>)[key] = "*";
      expect(() =>
        validateReleaseManifest({ manifest: value, specification: packageSpecifications[index] }),
      ).toThrow();
    }
    for (const type of [undefined, "commonjs"]) {
      const value = manifest(index);
      value.type = type;
      expect(() =>
        validateReleaseManifest({ manifest: value, specification: packageSpecifications[index] }),
      ).toThrow();
    }
  });

  it("does not accept a workspace edge in a packed CLI or a packed edge in source", () => {
    for (const packed of [false, true])
      expect(() =>
        validateReleaseManifest({
          manifest: manifest(1, !packed),
          specification: packageSpecifications[1],
          packed,
        }),
      ).toThrow();
  });

  it.each([0, 1])(
    "rejects malformed script records and undeclared module selectors for package %s",
    (index) => {
      for (const scripts of [null, [], 1, "string", { build: null }, { install: undefined }]) {
        const value = manifest(index);
        value.scripts = scripts;
        expect(() =>
          validateReleaseManifest({ manifest: value, specification: packageSpecifications[index] }),
        ).toThrow();
      }
      for (const field of ["main", "module", "browser", "imports"]) {
        const value = manifest(index);
        value[field] = "./dist/index.js";
        expect(() =>
          validateReleaseManifest({ manifest: value, specification: packageSpecifications[index] }),
        ).toThrow();
      }
      const value = manifest(index);
      value.exports = { ".": { default: "./dist/index.js" } };
      expect(() =>
        validateReleaseManifest({ manifest: value, specification: packageSpecifications[index] }),
      ).toThrow();
    },
  );
});
