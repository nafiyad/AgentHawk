import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { join } from "node:path";
import { packageSpecifications, validateReleaseManifest } from "./package-policy.mjs";

function fail(reason = "source_invalid") {
  const error = new Error(reason);
  error.reason = reason;
  throw error;
}

function same(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

/** Bounded regular-file snapshot through the caller's tracked storage guard. */
export async function readRuntimeBuildFile(io, path, maximumBytes) {
  const before = await io.lstat(path, { bigint: true });
  const valid = (stat) =>
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.nlink === 1n &&
    stat.ino > 0n &&
    stat.size >= 0n &&
    stat.size <= BigInt(maximumBytes) &&
    (stat.mode & 0o022n) === 0n;
  if (!valid(before) || (await io.realpath(path)) !== path) fail();
  const handle = await io.open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    if (!same(before, await handle.stat({ bigint: true }))) fail();
    const bytes = Buffer.alloc(Number(before.size));
    let position = 0;
    let reads = 0;
    while (position < bytes.length) {
      if (++reads > bytes.length + 1) fail();
      const length = Math.min(65_536, bytes.length - position);
      const result = await handle.read(bytes, position, length, position);
      if (
        !Number.isSafeInteger(result.bytesRead) ||
        result.bytesRead < 1 ||
        result.bytesRead > length
      )
        fail();
      position += result.bytesRead;
    }
    const extra = await handle.read(Buffer.alloc(1), 0, 1, position);
    const after = await handle.stat({ bigint: true });
    const pathAfter = await io.lstat(path, { bigint: true });
    if (
      extra.bytesRead !== 0 ||
      !valid(after) ||
      !valid(pathAfter) ||
      !same(before, after) ||
      !same(after, pathAfter) ||
      (await io.realpath(path)) !== path
    )
      fail();
    return bytes;
  } finally {
    await handle.close();
  }
}

function text(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    fail();
  }
}

/** Observe content, not a supplied commit or Git stat-cache success receipt. */
export async function observeRuntimeBuildSource({ root, io, execute, requireFreshOutput = false }) {
  const git = async (...args) =>
    text(
      await execute("git", [
        "--no-optional-locks",
        "-c",
        "core.fsmonitor=false",
        "-c",
        "core.untrackedCache=false",
        ...args,
      ]),
    );
  if (
    (await io.realpath(root)) !== root ||
    (await git("rev-parse", "--show-toplevel")).trim() !== root
  )
    fail();
  const commit = (await git("rev-parse", "--verify", "HEAD")).trim();
  const tree = (await git("rev-parse", "--verify", "HEAD^{tree}")).trim();
  if (!/^[0-9a-f]{40}$/u.test(commit) || !/^[0-9a-f]{40}$/u.test(tree)) fail();
  if ((await git("status", "--porcelain=v1", "-z", "--untracked-files=all")) !== "")
    fail("source_dirty");
  // Git porcelain intentionally omits ignored files; these roots feed tsc's globs.
  if (
    (await git(
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "-z",
      "--",
      "packages/core/src",
      "packages/cli/src",
    )) !== ""
  )
    fail("source_dirty");
  await git("diff", "--cached", "--no-ext-diff", "--quiet", "HEAD", "--");
  const index = await git("ls-files", "--stage", "-z");
  if (!index.endsWith("\0")) fail();
  const entries = index.slice(0, -1).split("\0");
  if (entries.length > 2048) fail();
  let aggregateBytes = 0;
  let lockfileSha256;
  const manifests = new Map();
  const seen = new Set();
  for (const entry of entries) {
    const match = /^(100644|100755) ([0-9a-f]{40}) 0\t([A-Za-z0-9._/-]{1,240})$/u.exec(entry);
    if (!match) fail();
    const [, , expected, path] = match;
    if (
      path.split("/").some((part) => part === "" || part === "." || part === "..") ||
      seen.has(path)
    )
      fail();
    seen.add(path);
    const bytes = await readRuntimeBuildFile(io, join(root, path), 2_097_152);
    aggregateBytes += bytes.length;
    if (aggregateBytes > 33_554_432) fail();
    const actual = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    if (actual !== expected) fail("source_dirty");
    if (path === "pnpm-lock.yaml")
      lockfileSha256 = createHash("sha256").update(bytes).digest("hex");
    if (path === "packages/core/package.json" || path === "packages/cli/package.json") {
      try {
        manifests.set(path, JSON.parse(text(bytes)));
      } catch {
        fail();
      }
    }
  }
  if (!lockfileSha256) fail();
  for (const specification of packageSpecifications) {
    validateReleaseManifest({
      manifest: manifests.get(`${specification.directory}/package.json`),
      specification,
    });
    for (const required of ["package.json", "tsconfig.json", "tsconfig.build.json"]) {
      if (!seen.has(`${specification.directory}/${required}`)) fail();
    }
    if (
      requireFreshOutput &&
      (await io.lstatIfPresent(join(root, specification.directory, "dist"), { bigint: true }))
    ) {
      fail("output_exists");
    }
  }
  if (!seen.has("tsconfig.json")) fail();
  // Re-observe the index and commit after all bounded content reads.
  if (
    (await git("ls-files", "--stage", "-z")) !== index ||
    (await git("rev-parse", "--verify", "HEAD")).trim() !== commit ||
    (await git("status", "--porcelain=v1", "-z", "--untracked-files=all")) !== ""
  )
    fail("source_dirty");
  return Object.freeze({ commit, tree, lockfileSha256 });
}
