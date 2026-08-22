import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open, rename, rm } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { isAbsolute, join, parse, posix, resolve, sep, win32 } from "node:path";
import { z } from "zod";
import { cancellationError, type OperationContext, throwIfCancelled } from "../operation.js";
import { parseStrictIsoTimestamp, validClockValue } from "../time.js";

const cacheSchemaVersion = 1;
const defaultMaximumBytes = 1_048_576;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;

const cacheEntrySchema = z
  .object({
    schemaVersion: z.literal(cacheSchemaVersion),
    provider: z.enum(["npm", "osv"]),
    keyDigest: z.string().regex(digestPattern),
    storedAt: z.string(),
    expiresAt: z.string(),
    payload: z.unknown(),
  })
  .strict();

export type CacheProvider = "npm" | "osv";
export type CacheReadResult<T> =
  | { status: "missing" | "corrupt" }
  | { status: "fresh" | "stale"; storedAt: string; expiresAt: string; value: T };
export type CacheProbeState = "writable" | "unwritable" | "unsafe";

export interface MetadataCacheOptions {
  maximumBytes?: number;
  now?: () => Date;
  root?: string;
}

export class MetadataCache {
  readonly #maximumBytes: number;
  readonly #now: () => Date;
  readonly #root: string;

  constructor(options: MetadataCacheOptions = {}) {
    this.#maximumBytes = options.maximumBytes ?? defaultMaximumBytes;
    this.#now = options.now ?? (() => new Date());
    this.#root = options.root ?? defaultCacheRoot();
    if (!Number.isInteger(this.#maximumBytes) || this.#maximumBytes < 1) {
      throw new TypeError("maximumBytes must be a positive integer.");
    }
  }

  async read<T>(
    provider: CacheProvider,
    key: string,
    parsePayload: (value: unknown) => T,
    options: OperationContext = {},
  ): Promise<CacheReadResult<T>> {
    throwIfCancelled(options);
    const keyDigest = cacheKeyDigest(provider, key);
    let handle: FileHandle;
    try {
      handle = await open(this.#path(keyDigest), constants.O_RDONLY);
    } catch (error) {
      if (options.signal?.aborted) throw cancellationError(options.signal);
      return isMissing(error) ? { status: "missing" } : { status: "corrupt" };
    }
    try {
      const stats = await handle.stat();
      if (!stats.isFile() || stats.size > this.#maximumBytes) return { status: "corrupt" };
      const buffer = Buffer.alloc(this.#maximumBytes + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        throwIfCancelled(options);
        const chunk = await handle.read(buffer, bytesRead, buffer.length - bytesRead, bytesRead);
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > this.#maximumBytes) return { status: "corrupt" };

      let source: string;
      try {
        source = new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
      } catch {
        return { status: "corrupt" };
      }
      let entry: z.infer<typeof cacheEntrySchema>;
      try {
        entry = cacheEntrySchema.parse(JSON.parse(source));
      } catch {
        return { status: "corrupt" };
      }
      const storedAt = parseStrictIsoTimestamp(entry.storedAt);
      const expiresAt = parseStrictIsoTimestamp(entry.expiresAt);
      const now = validClockValue(this.#now(), "Cache clock");
      const nowTimestamp = parseStrictIsoTimestamp(now);
      if (
        entry.provider !== provider ||
        entry.keyDigest !== keyDigest ||
        storedAt === undefined ||
        expiresAt === undefined ||
        nowTimestamp === undefined ||
        storedAt > nowTimestamp ||
        expiresAt < storedAt
      ) {
        return { status: "corrupt" };
      }
      let value: T;
      try {
        value = parsePayload(entry.payload);
      } catch {
        return { status: "corrupt" };
      }
      return {
        expiresAt: entry.expiresAt,
        status: nowTimestamp < expiresAt ? "fresh" : "stale",
        storedAt: entry.storedAt,
        value,
      };
    } catch {
      if (options.signal?.aborted) throw cancellationError(options.signal);
      return { status: "corrupt" };
    } finally {
      await handle.close().catch(ignoreCleanupError);
    }
  }

  async write(
    provider: CacheProvider,
    key: string,
    payload: unknown,
    ttlMilliseconds: number,
    options: OperationContext = {},
  ): Promise<boolean> {
    throwIfCancelled(options);
    if (!Number.isInteger(ttlMilliseconds) || ttlMilliseconds < 1) {
      throw new TypeError("ttlMilliseconds must be a positive integer.");
    }
    const storedAt = validClockValue(this.#now(), "Cache clock");
    const storedTimestamp = parseStrictIsoTimestamp(storedAt);
    if (storedTimestamp === undefined) throw new TypeError("Cache clock must return a valid date.");
    const expiresTimestamp = storedTimestamp + ttlMilliseconds;
    if (!Number.isFinite(expiresTimestamp)) throw new TypeError("Cache TTL is out of range.");
    const expiresDate = new Date(expiresTimestamp);
    if (!Number.isFinite(expiresDate.getTime())) throw new TypeError("Cache TTL is out of range.");
    const expiresAt = expiresDate.toISOString();
    const keyDigest = cacheKeyDigest(provider, key);
    let serialized: string;
    try {
      serialized = JSON.stringify({
        schemaVersion: cacheSchemaVersion,
        provider,
        keyDigest,
        storedAt,
        expiresAt,
        payload,
      });
    } catch {
      return false;
    }
    if (Buffer.byteLength(serialized, "utf8") > this.#maximumBytes) return false;

    const temporary = join(this.#root, `.${keyDigest.slice(7)}.${randomUUID()}.tmp`);
    try {
      await mkdir(this.#root, { mode: 0o700, recursive: true });
      throwIfCancelled(options);
      const handle = await open(
        temporary,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      try {
        await handle.writeFile(serialized, { encoding: "utf8", signal: options.signal });
        await handle.sync();
      } finally {
        await handle.close();
      }
      throwIfCancelled(options);
      await rename(temporary, this.#path(keyDigest));
      throwIfCancelled(options);
      return true;
    } catch {
      await rm(temporary, { force: true }).catch(ignoreCleanupError);
      if (options.signal?.aborted) throw cancellationError(options.signal);
      return false;
    }
  }

  async probeWritable(): Promise<CacheProbeState> {
    if (!isAbsolute(this.#root)) return "unsafe";
    const probe = join(this.#root, `.doctor-${randomUUID()}.tmp`);
    let created = false;
    let state: CacheProbeState = "unwritable";
    try {
      const beforeCreation = await inspectDirectoryPath(this.#root);
      if (beforeCreation === "unsafe") return "unsafe";
      if (beforeCreation === "unreadable") return "unwritable";
      try {
        await mkdir(this.#root, { mode: 0o700, recursive: true });
      } catch {
        const afterFailure = await inspectDirectoryPath(this.#root);
        return afterFailure === "unsafe" ? "unsafe" : "unwritable";
      }
      const afterCreation = await inspectDirectoryPath(this.#root);
      if (afterCreation !== "safe") {
        return afterCreation === "unsafe" ? "unsafe" : "unwritable";
      }
      const handle = await open(
        probe,
        constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
        0o600,
      );
      created = true;
      try {
        await handle.writeFile("agenthawk-doctor\n", "utf8");
        await handle.sync();
      } finally {
        await handle.close();
      }
      state = "writable";
    } catch {
      state = "unwritable";
    }
    if (!created) return state;
    try {
      await rm(probe);
    } catch {
      return "unsafe";
    }
    return state;
  }

  #path(keyDigest: string): string {
    return join(this.#root, `${keyDigest.slice(7)}.json`);
  }
}

type DirectoryPathState = "safe" | "missing" | "unsafe" | "unreadable";

function ignoreCleanupError(): undefined {
  return undefined;
}

async function inspectDirectoryPath(path: string): Promise<DirectoryPathState> {
  const absolute = resolve(path);
  const root = parse(absolute).root;
  const relativeComponents = absolute.slice(root.length).split(sep).filter(Boolean);
  if (relativeComponents.length === 0) return "unsafe";

  let current = root;
  for (const component of relativeComponents) {
    current = join(current, component);
    try {
      const stats = await lstat(current);
      if (stats.isSymbolicLink() || !stats.isDirectory()) return "unsafe";
    } catch (error) {
      return isMissing(error) ? "missing" : "unreadable";
    }
  }
  return "safe";
}

export function cacheKeyDigest(provider: CacheProvider, key: string): string {
  return `sha256:${createHash("sha256").update(`${provider}\0${key}`, "utf8").digest("hex")}`;
}

export function defaultCacheRoot(
  environment: NodeJS.ProcessEnv = process.env,
  operatingSystem: NodeJS.Platform = platform(),
  userHome: string = homedir(),
): string {
  if (operatingSystem === "win32") {
    return environment.LOCALAPPDATA && win32.isAbsolute(environment.LOCALAPPDATA)
      ? join(environment.LOCALAPPDATA, "AgentHawk", "Cache")
      : join(userHome, "AppData", "Local", "AgentHawk", "Cache");
  }
  if (operatingSystem === "darwin") return join(userHome, "Library", "Caches", "AgentHawk");
  return environment.XDG_CACHE_HOME && posix.isAbsolute(environment.XDG_CACHE_HOME)
    ? join(environment.XDG_CACHE_HOME, "agenthawk")
    : join(userHome, ".cache", "agenthawk");
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && error.code === "ENOENT");
}
