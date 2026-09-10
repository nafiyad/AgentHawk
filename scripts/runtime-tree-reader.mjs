import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createBoundedRuntimeStorage } from "./claude-artifact-storage.mjs";
import { describeRuntimeAssemblyPlan, runtimeAssemblyFiles } from "./runtime-assembly-inputs.mjs";

const OPERATION_MS = 240_000;
const MAX_IO = 262_144;
const MAX_DIRECTORIES = 2048;
const READ_BYTES = 65_536;
const FLAGS = Object.freeze({ executed: false, portableRuntime: false, nativeSupport: false });
const PACKAGES = ["@agenthawk/core", "@agenthawk/cli", "commander", "semver", "yaml", "zod"];
const REASONS = new Set([
  "unsupported_host",
  "invalid_source",
  "invalid_plan",
  "storage_failed",
  "ownership_changed",
  "tree_mismatch",
  "closure_unconfirmed",
  "cancelled",
  "deadline_exceeded",
]);
const snapshots = new WeakMap();
const FIELDS = ["dev", "ino", "size", "mtimeNs", "ctimeNs", "uid", "mode", "nlink"];

class ReadError extends Error {}
function fail(code) {
  throw new ReadError(code);
}
function sha256(data) {
  return createHash("sha256").update(data).digest("hex");
}
function identity(stat) {
  if (FIELDS.some((field) => typeof stat[field] !== "bigint")) fail("ownership_changed");
  return Object.freeze(Object.fromEntries(FIELDS.map((field) => [field, stat[field]])));
}
function sameIdentity(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}
function sameObservation(a, b) {
  return FIELDS.every((field) => a[field] === b[field]);
}
function directory(stat, uid, privateDirectory, owned = true) {
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.ino > 0n &&
    (stat.uid === uid || (!owned && stat.uid === 0n)) &&
    (privateDirectory ? (stat.mode & 0o7777n) === 0o700n : (stat.mode & 0o022n) === 0n)
  );
}
function regularFile(stat, uid) {
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.ino > 0n &&
    stat.uid === uid &&
    stat.nlink === 1n &&
    (stat.mode & 0o7777n) === 0o600n
  );
}
function failure(code) {
  return Object.freeze({ schemaVersion: 1, status: "rejected", reason: code, ...FLAGS });
}
function reason(error) {
  return error instanceof ReadError && REASONS.has(error.message)
    ? error.message
    : "storage_failed";
}

function expectedFiles(plan) {
  const description = describeRuntimeAssemblyPlan(plan);
  const original = runtimeAssemblyFiles(plan);
  if (!description || !Array.isArray(original) || original.length === 0 || original.length > 1400)
    fail("invalid_plan");
  const files = [];
  const paths = new Set();
  let bytes = 0;
  for (const { path, size, sha256: digest, data } of original) {
    if (
      typeof path !== "string" ||
      path.length > 512 ||
      !/^[A-Za-z0-9_@./-]+$/.test(path) ||
      path.split("/").some((part) => !part || part === "." || part === "..") ||
      !PACKAGES.some((name) => path.startsWith(`runtime/node_modules/${name}/`)) ||
      paths.has(path.toLowerCase()) ||
      !Number.isSafeInteger(size) ||
      size < 0 ||
      size > 1_048_576 ||
      !Buffer.isBuffer(data) ||
      data.length !== size ||
      sha256(data) !== digest
    )
      fail("invalid_plan");
    paths.add(path.toLowerCase());
    bytes += size;
    if (bytes > 7_000_000) fail("invalid_plan");
    // Original archive bytes only establish expectations; never provide snapshot bytes.
    files.push({ path, size, sha256: digest });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (
    description.fileCount !== files.length ||
    description.fileBytes !== bytes ||
    description.plannedTreeSha256 !== sha256(JSON.stringify(files))
  )
    fail("invalid_plan");
  // The record is compared to the deterministic writer output as data, never parsed for authority.
  const record = Buffer.from(
    `${JSON.stringify({
      ...description,
      status: "assembled",
      storedTreeSha256: description.plannedTreeSha256,
      ...FLAGS,
    })}\n`,
  );
  if (record.length > READ_BYTES) fail("invalid_plan");
  return {
    description,
    files,
    record: { path: "assembly-record.json", size: record.length, sha256: sha256(record) },
  };
}

/** Read-only trusted filesystem/platform seams; not command-line options. */
export function createRuntimeTreeReader(overrides = {}) {
  const rawIo = overrides.filesystem ?? filesystem;
  const platform = overrides.platform ?? process.platform;
  const getUid = overrides.getUid ?? (() => process.getuid());
  return async (input) => {
    let result;
    let candidate;
    let storage;
    let subscribed;
    let stopped;
    const controller = new AbortController();
    const stop = (code) => {
      stopped ??= code;
      controller.abort();
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("deadline_exceeded"), OPERATION_MS);
    timer.unref();
    try {
      const { source, plan, signal } = input ?? {};
      if (signal !== undefined) {
        if (!(signal instanceof AbortSignal)) fail("invalid_source");
        subscribed = signal;
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      }
      const check = () => {
        if (stopped) fail(stopped);
      };
      check();
      if (platform !== "linux") fail("unsupported_host");
      const uid = BigInt(getUid());
      if (
        uid < 0n ||
        typeof source !== "string" ||
        source.length > 4096 ||
        [...source].some(
          (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
        ) ||
        !isAbsolute(source) ||
        resolve(source) !== source ||
        dirname(source) === source
      )
        fail("invalid_source");
      const { description, files, record } = expectedFiles(plan);
      const allFiles = [...files, record];
      const directories = new Map([[source, undefined]]);
      const expected = new Map([[source, new Set()]]);
      for (const file of allFiles) {
        let parent = source;
        for (const part of file.path.split("/").slice(0, -1)) {
          const path = join(parent, part);
          if (!directories.has(path)) {
            directories.set(path, undefined);
            expected.set(path, new Set());
            expected.get(parent).add(part);
            if (directories.size > MAX_DIRECTORIES) fail("invalid_plan");
          }
          parent = path;
        }
        expected.get(parent).add(basename(file.path));
      }
      if (allFiles.some((file) => directories.has(join(source, ...file.path.split("/")))))
        fail("invalid_plan");
      storage = createBoundedRuntimeStorage(rawIo, controller.signal);
      const io = storage.filesystem;
      let operations = 0;
      const tick = () => {
        check();
        if (++operations > MAX_IO) fail("storage_failed");
      };
      const stat = async (path) => {
        tick();
        return await io.lstat(path, { bigint: true });
      };
      const ancestors = new Map();
      const parent = dirname(source);
      if ((await io.realpath(source)) !== source || (await io.realpath(parent)) !== parent)
        fail("invalid_source");
      for (let current = parent; ; current = dirname(current)) {
        const observed = await stat(current);
        if (!directory(observed, uid, false, current === parent)) fail("invalid_source");
        ancestors.set(current, identity(observed));
        if (dirname(current) === current) break;
      }
      const checkAncestors = async () => {
        for (const [path, previous] of ancestors) {
          const observed = await stat(path);
          if (
            !directory(observed, uid, false, path === parent) ||
            !sameIdentity(previous, observed)
          )
            fail("ownership_changed");
        }
      };
      const checkDirectory = async (path) => {
        const observed = await stat(path);
        if (!directory(observed, uid, true) || !sameObservation(directories.get(path), observed))
          fail("ownership_changed");
      };
      const checkChain = async (path) => {
        await checkAncestors();
        for (let current = path; ; current = dirname(current)) {
          await checkDirectory(current);
          if (current === source) break;
          if (!current.startsWith(`${source}${sep}`)) fail("tree_mismatch");
        }
        check();
      };
      // Expected paths only, parents first; no recursive traversal through caller entries.
      for (const path of directories.keys()) {
        if (path === source) await checkAncestors();
        else await checkChain(dirname(path));
        const observed = await stat(path);
        if (!directory(observed, uid, true)) fail("ownership_changed");
        directories.set(path, identity(observed));
        await checkChain(path);
      }
      const close = async (handle) => {
        try {
          await handle.close();
        } catch {
          fail("closure_unconfirmed");
        }
      };
      const enumerate = async () => {
        for (const [path, names] of expected) {
          await checkChain(path);
          const handle = await io.opendir(path, { bufferSize: 1 });
          const seen = new Set();
          for (let count = 0; count <= names.size; count += 1) {
            tick();
            const entry = await handle.read();
            check();
            if (entry === null) break;
            if (
              !entry ||
              typeof entry.name !== "string" ||
              !names.has(entry.name) ||
              seen.has(entry.name) ||
              entry.isSymbolicLink()
            )
              fail("tree_mismatch");
            const child = join(path, entry.name);
            if (directories.has(child) ? !entry.isDirectory() : !entry.isFile())
              fail("tree_mismatch");
            seen.add(entry.name);
          }
          if (seen.size !== names.size) fail("tree_mismatch");
          await close(handle);
          await checkChain(path);
        }
      };
      const fileIdentities = new Map();
      const readFile = async (file) => {
        const path = join(source, ...file.path.split("/"));
        await checkChain(dirname(path));
        const before = await stat(path);
        if (!regularFile(before, uid)) fail("ownership_changed");
        const previous = fileIdentities.get(file.path);
        if (previous && !sameObservation(previous, before)) fail("ownership_changed");
        if (before.size !== BigInt(file.size)) fail("tree_mismatch");
        const handle = await io.open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const opened = await handle.stat({ bigint: true });
        if (!regularFile(opened, uid) || !sameObservation(before, opened))
          fail("ownership_changed");
        const bytes = Buffer.alloc(file.size + 1);
        let position = 0;
        while (position <= file.size) {
          tick();
          const length = Math.min(READ_BYTES, file.size + 1 - position);
          const { bytesRead } = await handle.read(bytes, position, length, position);
          check();
          if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length)
            fail("storage_failed");
          if (bytesRead === 0) break;
          position += bytesRead;
        }
        const after = await handle.stat({ bigint: true });
        const afterPath = await stat(path);
        if (
          !regularFile(after, uid) ||
          !regularFile(afterPath, uid) ||
          !sameObservation(opened, after) ||
          !sameObservation(opened, afterPath)
        )
          fail("ownership_changed");
        const data = Buffer.from(bytes.subarray(0, position));
        if (position !== file.size || sha256(data) !== file.sha256) fail("tree_mismatch");
        const measured = identity(after);
        await close(handle);
        await checkChain(dirname(path));
        const closedPath = await stat(path);
        if (!regularFile(closedPath, uid) || !sameObservation(measured, closedPath))
          fail("ownership_changed");
        fileIdentities.set(file.path, measured);
        return { ...file, data };
      };
      await enumerate();
      for (const file of allFiles) await readFile(file);
      await enumerate();
      const measured = [];
      for (const file of allFiles) measured.push(await readFile(file));
      await enumerate();
      // Last pathname fence catches replacement during a later file's read or close.
      for (const [path, previous] of fileIdentities) {
        const observed = await stat(join(source, ...path.split("/")));
        if (!regularFile(observed, uid) || !sameObservation(previous, observed))
          fail("ownership_changed");
      }
      for (const path of directories.keys()) await checkDirectory(path);
      await checkAncestors();
      check();
      const actualFiles = measured.slice(0, files.length);
      const sourceTreeSha256 = sha256(
        JSON.stringify(
          actualFiles.map(({ path, size, sha256: digest }) => ({ path, size, sha256: digest })),
        ),
      );
      if (sourceTreeSha256 !== description.plannedTreeSha256) fail("tree_mismatch");
      candidate = {
        plan,
        source,
        directories,
        fileIdentities,
        files: actualFiles,
        description: Object.freeze({
          ...description,
          status: "measured",
          sourceTreeSha256,
          ...FLAGS,
        }),
      };
    } catch (error) {
      result = failure(stopped ?? reason(error));
    } finally {
      if (storage && !(await storage.settle())) result = failure("closure_unconfirmed");
      else if (stopped) result = failure(stopped);
      clearTimeout(timer);
      subscribed?.removeEventListener("abort", abort);
    }
    if (result) return result;
    // A private capability exists only after successful measurement AND confirmed settlement.
    const token = Object.freeze({ schemaVersion: 1, status: "measured", ...FLAGS });
    snapshots.set(token, candidate);
    return token;
  };
}
export const readRuntimeTree = createRuntimeTreeReader();

/** No path or filesystem identity escapes the bounded public description. */
export function describeRuntimeTreeSnapshot(token) {
  return snapshots.get(token)?.description;
}

/** Fresh copies of actual reads, bound to the identical in-process plan. */
export function runtimeTreeSnapshotFiles(token, plan) {
  const snapshot = snapshots.get(token);
  if (!snapshot || snapshot.plan !== plan) return undefined;
  return snapshot.files.map(({ data, ...entry }) => ({ ...entry, data: Buffer.from(data) }));
}

function sameMap(a, b) {
  return (
    a.size === b.size &&
    [...a].every(([path, observed]) => b.has(path) && sameObservation(observed, b.get(path)))
  );
}

/** Complete same-tree point-in-time observations; not immunity to same-account races. */
export function runtimeTreeSnapshotsMatch(a, b) {
  const left = snapshots.get(a);
  const right = snapshots.get(b);
  return Boolean(
    left &&
      right &&
      left.plan === right.plan &&
      left.source === right.source &&
      left.description.sourceTreeSha256 === right.description.sourceTreeSha256 &&
      sameMap(left.directories, right.directories) &&
      sameMap(left.fileIdentities, right.fileIdentities),
  );
}

/** Separate physical trees: no overlap or shared root/directory/file identity. */
export function runtimeTreeSnapshotsDisjoint(a, b) {
  const left = snapshots.get(a);
  const right = snapshots.get(b);
  if (
    !left ||
    !right ||
    left.plan !== right.plan ||
    left.source === right.source ||
    left.source.startsWith(`${right.source}${sep}`) ||
    right.source.startsWith(`${left.source}${sep}`)
  )
    return false;
  const identities = new Set(
    [...left.directories.values(), ...left.fileIdentities.values()].map(
      ({ dev, ino }) => `${dev}:${ino}`,
    ),
  );
  return [...right.directories.values(), ...right.fileIdentities.values()].every(
    ({ dev, ino }) => !identities.has(`${dev}:${ino}`),
  );
}
