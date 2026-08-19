import { describe, expect, it } from "vitest";
import { packageSpecifications, validatePackageReport } from "../../../scripts/package-policy.mjs";

const specification = packageSpecifications.find(({ directory }) => directory === "packages/cli");
const manifest = { name: "@agenthawk/cli" };
const regular = async () => ({
  isDirectory: () => true,
  isFile: () => true,
  isSymbolicLink: () => false,
});

describe("package content policy", () => {
  it("accepts only the complete reviewed manifest", async () => {
    await expect(validate(specification.paths)).resolves.toBeUndefined();
  });

  it("rejects every omitted runtime module", async () => {
    for (const path of specification.paths.filter((value) => value.startsWith("dist/"))) {
      await expect(validate(specification.paths.filter((value) => value !== path))).rejects.toThrow(
        "reviewed allowlist",
      );
    }
  });

  it.each([
    "DIST/SRC/evil.ts",
    "dist\\src\\evil.ts",
    "dist/.ENV",
    ".NPMRC",
    "evil.MAP",
    "evil.TGZ",
    "../outside.js",
    "/absolute.js",
  ])("rejects hostile path %s", async (path) => {
    await expect(validate([...specification.paths, path])).rejects.toThrow();
  });

  it("rejects symlinks and non-regular files", async () => {
    const symlink = async () => ({
      isDirectory: () => false,
      isFile: () => true,
      isSymbolicLink: () => true,
    });
    const directory = async () => ({
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => false,
    });
    await expect(validate(specification.paths, symlink)).rejects.toThrow("non-regular");
    await expect(validate(specification.paths, directory)).rejects.toThrow("non-regular");
  });
});

async function validate(paths, stat = regular) {
  return validatePackageReport({
    directory: "/safe/package",
    manifest,
    report: {
      name: manifest.name,
      unpackedSize: 1,
      files: paths.map((path) => ({ path })),
    },
    specification,
    stat,
  });
}
