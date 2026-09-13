import { createHash } from "node:crypto";
import { constants } from "node:fs";
import * as filesystem from "node:fs/promises";
import { posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { types } from "node:util";
import { createBoundedRuntimeStorage } from "./claude-artifact-storage.mjs";
import { imageDownloader } from "./fixture-image-download.mjs";
import { fixtureImageLayerPlan, IMAGE_METADATA } from "./fixture-image-layer-policy.mjs";

/** @typedef {import("./fixture-image-layer-policy.mjs").ImageLayer} ImageLayer */
/** @typedef {import("node:fs").BigIntStats} Stat */
/** @typedef {import("./claude-artifact-storage.mjs").StorageHandle} Handle */
/** @typedef {import("./claude-artifact-storage.mjs").RuntimeFilesystem} Filesystem */
/** @typedef {ReturnType<typeof createBoundedRuntimeStorage>} Storage */
/** @typedef {{metadata(signal: AbortSignal): Promise<unknown>, layer(base: unknown, index: number, sink: (chunk: unknown) => Promise<void>, signal: AbortSignal): Promise<void>}} Downloader */
/** @typedef {{filesystem?: Filesystem, platform?: string, getUid?: () => number, downloader?: Downloader, planFor?: (base: unknown) => ReadonlyArray<ImageLayer> | undefined}} Overrides */

const MAX_IO = 262_144;
const CHUNK_BYTES = 65_536;
const TOTAL_BYTES = 409_613_156;
// biome-ignore lint/suspicious/noControlCharactersInRegex: reject controls and non-Linux separators in destination input.
const INVALID_PATH = /[\x00-\x1f\x7f\\]/;
const FLAGS = Object.freeze({
  imagePrepared: false,
  executed: false,
  isolated: false,
  portableRuntime: false,
  nativeSupport: false,
});
const REASONS = new Set([
  "unsupported_host",
  "invalid_destination",
  "destination_unavailable",
  "metadata_rejected",
  "download_failed",
  "storage_failed",
  "ownership_changed",
  "layer_mismatch",
  "invalid_plan",
  "closure_unconfirmed",
  "cancelled",
  "deadline_exceeded",
]);
const FIELDS = /** @type {const} */ ([
  "dev",
  "ino",
  "size",
  "mtimeNs",
  "ctimeNs",
  "uid",
  "mode",
  "nlink",
]);
/** @typedef {Readonly<Pick<Stat, typeof FIELDS[number]>>} Observation */
/** @typedef {Readonly<{destination: string, base: unknown, layers: ReadonlyArray<ImageLayer>, directory: Observation, ancestors: ReadonlyArray<Readonly<{path: string, observation: Observation}>>, files: ReadonlyArray<Readonly<{file: string, observation: Observation}>>}>} Evidence */
class LayerError extends Error {}
/** @param {string} code @returns {never} */
function fail(code) {
  throw new LayerError(code);
}
/** @param {unknown} error */
function reason(error) {
  if (error instanceof Error && error.message === "download_cleanup_unconfirmed")
    return "closure_unconfirmed";
  if (error instanceof Error && error.message === "download_timeout") return "deadline_exceeded";
  if (error instanceof Error && error.message === "download_cancelled") return "cancelled";
  if (error instanceof Error && error.message === "download_invalid_input")
    return "download_failed";
  if (error instanceof Error && REASONS.has(error.message)) return error.message;
  return "storage_failed";
}
/** @param {Stat} stat @returns {Observation} */
function observe(stat) {
  if (FIELDS.some((field) => typeof stat[field] !== "bigint")) fail("ownership_changed");
  return Object.freeze({
    dev: stat.dev,
    ino: stat.ino,
    size: stat.size,
    mtimeNs: stat.mtimeNs,
    ctimeNs: stat.ctimeNs,
    uid: stat.uid,
    mode: stat.mode,
    nlink: stat.nlink,
  });
}
/** @param {Observation} left @param {Observation} right */
function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}
/** @param {Observation} left @param {Observation} right */
function sameContent(left, right) {
  return FIELDS.every((field) => left[field] === right[field]);
}
/** @param {Stat} stat @param {bigint} uid @param {boolean} privateMode @param {boolean} owned */
function directory(stat, uid, privateMode, owned) {
  observe(stat);
  return (
    stat.isDirectory() &&
    !stat.isSymbolicLink() &&
    stat.ino > 0n &&
    (stat.uid === uid || (!owned && stat.uid === 0n)) &&
    (privateMode ? (stat.mode & 0o7777n) === 0o700n : (stat.mode & 0o7022n) === 0n)
  );
}
/** @param {Stat} stat @param {bigint} uid */
function regular(stat, uid) {
  observe(stat);
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.ino > 0n &&
    stat.uid === uid &&
    stat.nlink === 1n &&
    (stat.mode & 0o7777n) === 0o600n
  );
}
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = /** @type {(this: Uint8Array) => number} */ (
  Object.getOwnPropertyDescriptor(typedArray, "byteLength")?.get
);
const backingBuffer = /** @type {(this: Uint8Array) => ArrayBufferLike} */ (
  Object.getOwnPropertyDescriptor(typedArray, "buffer")?.get
);
const elementType = /** @type {(this: Uint8Array) => string | undefined} */ (
  Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)?.get
);
const arrayBufferLength = /** @type {(this: ArrayBuffer) => number} */ (
  Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")?.get
);
const copyBytes = Uint8Array.prototype.set;
const isAborted = /** @type {(this: AbortSignal) => boolean} */ (
  Object.getOwnPropertyDescriptor(AbortSignal.prototype, "aborted")?.get
);
const subscribe = EventTarget.prototype.addEventListener;
const unsubscribe = EventTarget.prototype.removeEventListener;
/** @param {unknown} chunk */
function snapshot(chunk) {
  if (
    !ArrayBuffer.isView(chunk) ||
    ![Buffer.prototype, Uint8Array.prototype].includes(Object.getPrototypeOf(chunk))
  )
    fail("layer_mismatch");
  const input = /** @type {Uint8Array} */ (chunk);
  const length = byteLength.call(input);
  if (elementType.call(input) !== "Uint8Array" || length < 1 || length > CHUNK_BYTES)
    fail("layer_mismatch");
  arrayBufferLength.call(/** @type {ArrayBuffer} */ (backingBuffer.call(input)));
  const result = Buffer.alloc(length);
  copyBytes.call(result, input);
  return result;
}
/** @param {ReadonlyArray<ImageLayer> | undefined} source */
function copyPlan(source) {
  if (!Array.isArray(source) || source.length !== 8) fail("invalid_plan");
  const names = new Set();
  let total = 0;
  const layers = source.map(({ digest, size, file }) => {
    if (
      typeof digest !== "string" ||
      !/^sha256:[a-f0-9]{64}$/.test(digest) ||
      !Number.isSafeInteger(size) ||
      size < 1 ||
      size > 211_662_335 ||
      file !== `${digest.slice(7)}.blob` ||
      names.has(file)
    )
      fail("invalid_plan");
    total += size;
    names.add(file);
    return Object.freeze({ digest, size, file });
  });
  if (total > TOTAL_BYTES) fail("invalid_plan");
  return Object.freeze(layers);
}

/**
 * Trusted development seams have per-instance evidence, never production authority.
 * No caller pin, URL, receipt or filesystem override exists in the command.
 * @param {Overrides} overrides
 */
export function createImageLayerVerifier(overrides = {}) {
  const raw = overrides.filesystem ?? filesystem;
  const platform = overrides.platform ?? process.platform;
  const getUid =
    overrides.getUid ??
    (() => {
      if (!process.getuid) fail("unsupported_host");
      return process.getuid();
    });
  const downloader = overrides.downloader ?? imageDownloader;
  const planFor = overrides.planFor ?? fixtureImageLayerPlan;
  /** @type {WeakMap<object, Evidence>} */
  const evidence = new WeakMap();
  /** @param {unknown} destination @param {AbortSignal | undefined} signal */
  const verify = async (destination, signal) => {
    let retained = false;
    /** @type {string | undefined} */ let stopped;
    /** @type {AbortSignal | undefined} */ let subscribed;
    /** @type {Storage | undefined} */ let storage;
    /** @type {Evidence | undefined} */ let candidate;
    /** @type {ReturnType<typeof failure> | undefined} */ let result;
    const controller = new AbortController();
    /** @param {string} code */
    const stop = (code) => {
      stopped ??= code;
      controller.abort();
    };
    const abort = () => stop("cancelled");
    const timer = setTimeout(() => stop("deadline_exceeded"), 1_200_000);
    timer.unref();
    /** @param {string} code */
    const failure = (code) =>
      Object.freeze({
        schemaVersion: 1,
        status: "failed",
        reason: code,
        retainedState: retained ? "present_or_uncertain" : "not_created",
        layersVerified: false,
        ...FLAGS,
      });
    const check = () => {
      if (stopped) fail(stopped);
    };
    let operations = 0;
    // Reserve room for shutdown closes. At most one admitted handle is live; the
    // margin prevents exhausting the bound from obstructing its required close.
    /** @param {boolean} closing */
    const tick = (closing = false) => {
      if (!closing) check();
      operations += 1;
      if (operations > (closing ? MAX_IO : MAX_IO - 32)) fail("storage_failed");
    };
    /** @param {Handle} handle @returns {Handle} */
    const trackHandle = (handle) => ({
      stat: async (options) => {
        tick();
        return await handle.stat(options);
      },
      read: async (...args) => {
        tick();
        return await handle.read(...args);
      },
      write: async (...args) => {
        tick();
        return await handle.write(...args);
      },
      sync: async () => {
        tick();
        await handle.sync();
      },
      close: async () => {
        tick(true);
        await handle.close();
      },
    });
    /** @type {Filesystem} */
    const counted = {
      realpath: async (path) => {
        tick();
        return await raw.realpath(path);
      },
      lstat: async (...args) => {
        tick();
        return await raw.lstat(...args);
      },
      mkdir: async (...args) => {
        tick();
        return await raw.mkdir(...args);
      },
      open: async (...args) => {
        tick();
        return trackHandle(await raw.open(...args));
      },
      opendir: async (...args) => {
        tick();
        const handle = await raw.opendir(...args);
        return {
          read: async () => {
            tick();
            return await handle.read();
          },
          close: async () => {
            tick(true);
            await handle.close();
          },
        };
      },
    };
    try {
      if (signal !== undefined) {
        if (!(signal instanceof AbortSignal) || types.isProxy(signal)) fail("invalid_destination");
        const alreadyAborted = isAborted.call(signal);
        subscribe.call(signal, "abort", abort, { once: true });
        subscribed = signal;
        if (alreadyAborted) abort();
      }
      check();
      if (platform !== "linux") fail("unsupported_host");
      const activeUid = getUid();
      if (!Number.isSafeInteger(activeUid) || activeUid < 0) fail("unsupported_host");
      const uid = BigInt(activeUid);
      if (
        typeof destination !== "string" ||
        Buffer.byteLength(destination, "utf8") > 4096 ||
        INVALID_PATH.test(destination) ||
        !posix.isAbsolute(destination) ||
        posix.resolve(destination) !== destination ||
        destination === "/" ||
        destination.split("/").length - 1 > 64
      )
        fail("invalid_destination");
      const root = destination;
      storage = createBoundedRuntimeStorage(counted, controller.signal);
      const io = storage.filesystem;
      const parent = posix.dirname(root);
      /** @type {Map<string, Observation>} */ const ancestors = new Map();
      const stat = async (/** @type {string} */ path) => await io.lstat(path, { bigint: true });
      if ((await io.realpath(parent)) !== parent) fail("invalid_destination");
      for (let current = parent; ; current = posix.dirname(current)) {
        const observed = await stat(current);
        if (!directory(observed, uid, false, current === parent)) fail("invalid_destination");
        ancestors.set(current, observe(observed));
        if (current === "/") break;
      }
      if ((await io.lstatIfPresent(root, { bigint: true })) !== undefined)
        fail("destination_unavailable");
      const fenceAncestors = async () => {
        for (const [path, before] of ancestors) {
          const now = await stat(path);
          if (!directory(now, uid, false, path === parent) || !sameIdentity(before, now))
            fail("ownership_changed");
        }
        check();
      };
      // Fresh network metadata must carry ADR 0024's genuine private capability.
      const base = await downloader.metadata(controller.signal);
      check();
      const layers = copyPlan(planFor(base));
      await fenceAncestors();
      retained = true; // mkdir may complete after a timeout; never claim no state.
      await io.mkdir(root, { mode: 0o700 });
      const created = await stat(root);
      if (!directory(created, uid, true, true) || (await io.realpath(root)) !== root)
        fail("ownership_changed");
      const rootIdentity = observe(created);
      /** @type {Observation | undefined} */ let finalRoot;
      const fenceRoot = async () => {
        await fenceAncestors();
        const now = await stat(root);
        if (
          !directory(now, uid, true, true) ||
          !sameIdentity(rootIdentity, now) ||
          (finalRoot && !sameContent(finalRoot, now))
        )
          fail("ownership_changed");
      };
      /** @param {{close(): Promise<void>}} handle */
      const close = async (handle) => {
        try {
          await handle.close();
        } catch {
          fail("closure_unconfirmed");
        }
      };
      /** @type {Map<string, Observation>} */ const files = new Map();
      /** @param {ImageLayer} layer */
      const reread = async (layer) => {
        await fenceRoot();
        const path = posix.join(root, layer.file);
        const before = await stat(path);
        const previous = files.get(layer.file);
        if (!regular(before, uid) || (previous && !sameContent(previous, before)))
          fail("ownership_changed");
        if (before.size !== BigInt(layer.size)) fail("layer_mismatch");
        const handle = await io.open(
          path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        );
        const opened = await handle.stat({ bigint: true });
        if (!regular(opened, uid) || !sameContent(before, opened)) fail("ownership_changed");
        const hash = createHash("sha256");
        const buffer = Buffer.alloc(CHUNK_BYTES);
        let position = 0;
        while (position <= layer.size) {
          const length = Math.min(CHUNK_BYTES, layer.size + 1 - position);
          const { bytesRead } = await handle.read(buffer, 0, length, position);
          check();
          if (!Number.isInteger(bytesRead) || bytesRead < 0 || bytesRead > length)
            fail("storage_failed");
          if (bytesRead === 0) break;
          position += bytesRead;
          if (position > layer.size) fail("layer_mismatch");
          hash.update(buffer.subarray(0, bytesRead));
        }
        if (position !== layer.size || `sha256:${hash.digest("hex")}` !== layer.digest)
          fail("layer_mismatch");
        const after = await handle.stat({ bigint: true });
        const afterPath = await stat(path);
        if (
          !regular(after, uid) ||
          !regular(afterPath, uid) ||
          !sameContent(opened, after) ||
          !sameContent(opened, afterPath)
        )
          fail("ownership_changed");
        await close(handle);
        await fenceRoot();
        const closed = await stat(path);
        if (!regular(closed, uid) || !sameContent(after, closed)) fail("ownership_changed");
        files.set(layer.file, observe(closed));
      };
      let total = 0;
      for (const [index, layer] of layers.entries()) {
        await fenceRoot();
        const path = posix.join(root, layer.file);
        const handle = await io.open(
          path,
          constants.O_WRONLY |
            constants.O_CREAT |
            constants.O_EXCL |
            constants.O_NOFOLLOW |
            constants.O_NONBLOCK,
          0o600,
        );
        const opened = await handle.stat({ bigint: true });
        if (!regular(opened, uid) || opened.size !== 0n || !sameContent(opened, await stat(path)))
          fail("ownership_changed");
        const hash = createHash("sha256");
        let position = 0;
        let chunks = 0;
        let accepting = true;
        let sinkBusy = false;
        try {
          await downloader.layer(
            base,
            index,
            async (chunk) => {
              check();
              if (!accepting || sinkBusy) fail("download_failed");
              sinkBusy = true;
              try {
                const bytes = snapshot(chunk);
                if (
                  ++chunks > 65_536 ||
                  position + bytes.length > layer.size ||
                  total + bytes.length > TOTAL_BYTES
                )
                  fail("layer_mismatch");
                let offset = 0;
                while (offset < bytes.length) {
                  check();
                  const { bytesWritten } = await handle.write(
                    bytes,
                    offset,
                    bytes.length - offset,
                    position + offset,
                  );
                  check();
                  if (
                    !Number.isInteger(bytesWritten) ||
                    bytesWritten <= 0 ||
                    bytesWritten > bytes.length - offset
                  )
                    fail("storage_failed");
                  offset += bytesWritten;
                }
                position += bytes.length;
                total += bytes.length;
                hash.update(bytes);
              } catch (error) {
                // The transport redacts sink failures; retain the first local cause
                // before it cancels and performs its own required settlement.
                stop(reason(error));
                throw error;
              } finally {
                sinkBusy = false;
              }
            },
            controller.signal,
          );
        } finally {
          accepting = false;
        }
        check();
        if (sinkBusy) fail("closure_unconfirmed");
        if (position !== layer.size || `sha256:${hash.digest("hex")}` !== layer.digest)
          fail("layer_mismatch");
        await handle.sync();
        const finished = await handle.stat({ bigint: true });
        if (
          !regular(finished, uid) ||
          !sameIdentity(opened, finished) ||
          finished.size !== BigInt(layer.size) ||
          !sameContent(finished, await stat(path))
        )
          fail("ownership_changed");
        await close(handle);
        files.set(layer.file, observe(finished));
        await reread(layer);
      }
      finalRoot = observe(await stat(root));
      const enumerate = async () => {
        await fenceRoot();
        const handle = await io.opendir(root, { bufferSize: 1 });
        const seen = new Set();
        let eof = false;
        for (let count = 0; count <= layers.length; count += 1) {
          const entry = await handle.read();
          check();
          if (entry === null) {
            eof = true;
            break;
          }
          if (
            !files.has(entry.name) ||
            seen.has(entry.name) ||
            !entry.isFile() ||
            entry.isSymbolicLink()
          )
            fail("layer_mismatch");
          seen.add(entry.name);
        }
        if (!eof || seen.size !== layers.length) fail("layer_mismatch");
        await close(handle);
        await fenceRoot();
      };
      await enumerate();
      for (const layer of layers) await reread(layer);
      await enumerate();
      for (const [file, before] of files) {
        const now = await stat(posix.join(root, file));
        if (!regular(now, uid) || !sameContent(before, now)) fail("ownership_changed");
      }
      await fenceRoot();
      check();
      candidate = Object.freeze({
        destination: root,
        base,
        layers,
        directory: finalRoot,
        ancestors: Object.freeze(
          [...ancestors].map(([path, observation]) => Object.freeze({ path, observation })),
        ),
        files: Object.freeze(
          [...files].map(([file, observation]) => Object.freeze({ file, observation })),
        ),
      });
    } catch (error) {
      const code = reason(error);
      // Preserve whichever failure or cancellation arrived first; stopping also
      // prevents any admitted producer from starting further writes.
      stop(code);
      result = failure(code === "closure_unconfirmed" ? code : (stopped ?? code));
    } finally {
      if (storage && !(await storage.settle())) result = failure("closure_unconfirmed");
      else if (stopped && result?.reason !== "closure_unconfirmed") result = failure(stopped);
      clearTimeout(timer);
      if (subscribed) unsubscribe.call(subscribed, "abort", abort);
    }
    if (result) return result;
    if (!candidate) return failure("storage_failed");
    const summary = Object.freeze({
      schemaVersion: 1,
      status: "verified_layers",
      layersVerified: true,
      manifestDigest: IMAGE_METADATA.manifest.digest,
      configDigest: IMAGE_METADATA.config.digest,
      layerCount: candidate.layers.length,
      compressedBytes: candidate.layers.reduce((sum, layer) => sum + layer.size, 0),
      ...FLAGS,
    });
    evidence.set(summary, candidate);
    return summary;
  };
  /** @param {unknown} token */
  const inputs = (token) => evidence.get(/** @type {object} */ (token));
  return Object.freeze({ verify, inputs });
}
const production = createImageLayerVerifier();
export const verifyFixtureImageLayers = production.verify;
export const fixtureImageLayerInputs = production.inputs;

/** @param {unknown} args @param {typeof verifyFixtureImageLayers} verify @param {AbortSignal | undefined} signal */
export async function runImageLayerCommand(
  args,
  verify = verifyFixtureImageLayers,
  signal = undefined,
) {
  if (
    !Array.isArray(args) ||
    args.length !== 1 ||
    typeof args[0] !== "string" ||
    args[0].startsWith("-")
  )
    return {
      exitCode: 2,
      result: Object.freeze({
        schemaVersion: 1,
        status: "failed",
        reason: "invalid_destination",
        retainedState: "not_created",
        layersVerified: false,
        ...FLAGS,
      }),
    };
  try {
    const result = await verify(args[0], signal);
    return { exitCode: result.status === "verified_layers" ? 0 : 1, result };
  } catch {
    return {
      exitCode: 1,
      result: Object.freeze({
        schemaVersion: 1,
        status: "failed",
        reason: "closure_unconfirmed",
        retainedState: "present_or_uncertain",
        layersVerified: false,
        ...FLAGS,
      }),
    };
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  const { exitCode, result } = await runImageLayerCommand(
    process.argv.slice(2),
    verifyFixtureImageLayers,
    controller.signal,
  );
  process.removeListener("SIGINT", stop);
  process.removeListener("SIGTERM", stop);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = exitCode;
}
