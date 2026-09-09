import { createHash } from "node:crypto";
import {
  packageSpecifications,
  releaseVersion,
  validateReleaseManifest,
} from "./package-policy.mjs";
import { readTarEntries } from "./prepare-release-artifacts.mjs";
import {
  RUNTIME_ARCHIVE_POLICY,
  runtimeArchiveFiles,
  verifyRuntimeArchive,
} from "./runtime-archive-policy.mjs";

const plans = new WeakMap();
const ownPackages = packageSpecifications.map((entry) => ({
  ...entry,
  paths: [...entry.paths].sort(),
}));
const externalNames = Object.keys(RUNTIME_ARCHIVE_POLICY);
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength").get;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer").get;
const rejected = Object.freeze({
  status: "rejected",
  executed: false,
  portableRuntime: false,
  nativeSupport: false,
});

function requireCondition(value) {
  if (!value) throw new Error("runtime_assembly_inputs_rejected");
}

function record(value, keys) {
  requireCondition(value !== null && typeof value === "object");
  requireCondition([Object.prototype, null].includes(Object.getPrototypeOf(value)));
  const actual = Reflect.ownKeys(value);
  requireCondition(actual.length === keys.length && keys.every((key) => actual.includes(key)));
  const result = {};
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    requireCondition(descriptor && Object.hasOwn(descriptor, "value"));
    result[key] = descriptor.value;
  }
  return result;
}

function snapshot(value, maximum) {
  requireCondition(ArrayBuffer.isView(value) && Object.getPrototypeOf(value) === Buffer.prototype);
  const size = byteLength.call(value);
  requireCondition(size > 0 && size <= maximum && backingBuffer.call(value) instanceof ArrayBuffer);
  const copy = Buffer.alloc(size);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function sourceObservation(value) {
  const source = record(value, [
    "commit",
    "tree",
    "lockfileSha256",
    "nodeVersion",
    "pnpmVersion",
    "typescriptVersion",
  ]);
  for (const [key, size] of [
    ["commit", 40],
    ["tree", 40],
    ["lockfileSha256", 64],
  ]) {
    requireCondition(
      typeof source[key] === "string" &&
        source[key].length === size &&
        /^[0-9a-f]+$/.test(source[key]),
    );
  }
  requireCondition(
    typeof source.nodeVersion === "string" &&
      source.nodeVersion.length <= 32 &&
      /^v?(22|24)\.[0-9]+\.[0-9]+$/.test(source.nodeVersion),
  );
  requireCondition(source.pnpmVersion === "10.34.5" && source.typescriptVersion === "7.0.2");
  return Object.freeze(source);
}

function ownArchive(bytes, specification) {
  const archive = snapshot(bytes, 1_000_000);
  // Keep the release reader's independent 2 MB expansion bound unchanged.
  const entries = readTarEntries(archive);
  requireCondition(entries.length === specification.paths.length);
  const paths = entries.map(({ path }) => path.replace(/^package\//, "")).sort();
  requireCondition(JSON.stringify(paths) === JSON.stringify(specification.paths));
  const fileBytes = entries.reduce((total, { data }) => total + data.length, 0);
  requireCondition(fileBytes > 0 && fileBytes <= specification.maximumBytes);
  const manifestBytes = entries.find(({ path }) => path === "package/package.json").data;
  requireCondition(manifestBytes.length > 0 && manifestBytes.length <= 65536);
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(manifestBytes));
  validateReleaseManifest({ manifest, specification, packed: true });
  for (const path of ["package/LICENSE", "package/DISCLOSURE"])
    requireCondition(entries.find((entry) => entry.path === path).data.some((byte) => byte > 32));
  return {
    metadata: Object.freeze({
      name: specification.name,
      version: releaseVersion,
      archiveSha256: digest(archive),
      fileCount: entries.length,
      fileBytes,
    }),
    entries: entries.map(({ path, data }) => ({ path: path.slice(8), data })),
  };
}

/** Trusted development assembly seam. Source fields are observations, never provenance authority. */
export function createRuntimeAssemblyPlan(value) {
  try {
    const input = record(value, ["source", "coreArchive", "cliArchive", "externalArchives"]);
    const source = sourceObservation(input.source);
    const external = record(input.externalArchives, externalNames);
    const packages = [
      ownArchive(input.coreArchive, ownPackages[0]),
      ownArchive(input.cliArchive, ownPackages[1]),
    ];
    for (const name of externalNames) {
      const policy = RUNTIME_ARCHIVE_POLICY[name];
      const archive = snapshot(external[name], policy.compressedBytes);
      const inventory = verifyRuntimeArchive(name, archive);
      const entries = runtimeArchiveFiles(inventory);
      requireCondition(inventory.status === "inventory" && entries !== undefined);
      packages.push({
        metadata: Object.freeze({
          name,
          version: policy.version,
          archiveSha256: digest(archive),
          archiveIntegrity: policy.integrity,
          fileCount: inventory.files.length,
          fileBytes: inventory.fileBytes,
        }),
        entries,
      });
    }
    const files = packages
      .flatMap(({ metadata, entries }) =>
        entries.map(({ path, data }) => ({
          path: `runtime/node_modules/${metadata.name}/${path}`,
          size: data.length,
          sha256: digest(data),
          data,
        })),
      )
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const plannedTreeSha256 = digest(
      JSON.stringify(files.map(({ path, size, sha256 }) => ({ path, size, sha256 }))),
    );
    const description = Object.freeze({
      schemaVersion: 1,
      sourceBinding: "caller_observation_only",
      source,
      packages: Object.freeze(packages.map(({ metadata }) => metadata)),
      fileCount: files.length,
      fileBytes: files.reduce((total, { size }) => total + size, 0),
      plannedTreeSha256,
      executed: false,
      portableRuntime: false,
      nativeSupport: false,
    });
    const plan = Object.freeze({
      status: "planned",
      executed: false,
      portableRuntime: false,
      nativeSupport: false,
    });
    plans.set(plan, { description, files });
    return plan;
  } catch {
    return rejected;
  }
}

/**
 * A plain inventory, copied receipt, or rejected input is never a plan.
 * @returns {{schemaVersion: number, sourceBinding: string, source: {commit: string, tree: string, lockfileSha256: string, nodeVersion: string, pnpmVersion: string, typescriptVersion: string}, packages: {name: string, version: string, archiveSha256: string, archiveIntegrity?: string, fileCount: number, fileBytes: number}[], fileCount: number, fileBytes: number, plannedTreeSha256: string, executed: boolean, portableRuntime: boolean, nativeSupport: boolean} | undefined}
 */
export function describeRuntimeAssemblyPlan(plan) {
  return plans.get(plan)?.description;
}

/**
 * Copies isolate both caller inputs and later writes from the retained verified bytes.
 * @returns {{path: string, size: number, sha256: string, data: Buffer}[] | undefined}
 */
export function runtimeAssemblyFiles(plan) {
  return plans
    .get(plan)
    ?.files.map(({ data, ...entry }) => ({ ...entry, data: Buffer.from(data) }));
}
