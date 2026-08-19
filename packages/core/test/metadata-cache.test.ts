import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cacheKeyDigest, defaultCacheRoot, MetadataCache } from "../src/cache/metadata-cache.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "agenthawk-cache-"));
  roots.push(value);
  return value;
}

function pathFor(cacheRoot: string, provider: "npm" | "osv", key: string): string {
  return join(cacheRoot, `${cacheKeyDigest(provider, key).slice(7)}.json`);
}

describe("MetadataCache", () => {
  it("validates size, TTL, clock, and date-range boundaries", async () => {
    expect(() => new MetadataCache({ maximumBytes: 0 })).toThrow(TypeError);
    expect(() => new MetadataCache({ maximumBytes: 1.5 })).toThrow(TypeError);
    const cacheRoot = await root();
    const cache = new MetadataCache({ root: cacheRoot });
    await expect(cache.write("npm", "zero", {}, 0)).rejects.toThrow(TypeError);
    await expect(cache.write("npm", "fraction", {}, 1.5)).rejects.toThrow(TypeError);
    await expect(cache.write("npm", "range", {}, Number.MAX_SAFE_INTEGER)).rejects.toThrow(
      "Cache TTL is out of range.",
    );
    const badClock = new MetadataCache({ root: cacheRoot, now: () => new Date("invalid") });
    await expect(badClock.write("npm", "clock", {}, 1)).rejects.toThrow(TypeError);
  });

  it("round-trips fresh normalized public metadata and becomes stale at the exact TTL", async () => {
    const cacheRoot = await root();
    let now = new Date("2026-08-19T18:00:00.000Z");
    const cache = new MetadataCache({ root: cacheRoot, now: () => now });
    expect(await cache.write("npm", "example@1", { ok: true }, 1_000)).toBe(true);
    await expect(cache.read("npm", "example@1", (value) => value)).resolves.toMatchObject({
      status: "fresh",
      value: { ok: true },
    });
    now = new Date("2026-08-19T18:00:01.000Z");
    await expect(cache.read("npm", "example@1", (value) => value)).resolves.toMatchObject({
      status: "stale",
    });
  });

  it("isolates providers and hashes hostile keys into one safe filename", async () => {
    const cacheRoot = await root();
    const key = "../../secrets\\token?name=@scope/pkg";
    const cache = new MetadataCache({ root: cacheRoot });
    await cache.write("npm", key, { public: true }, 1_000);
    expect(pathFor(cacheRoot, "npm", key)).toMatch(/[a-f0-9]{64}\.json$/u);
    await expect(cache.read("osv", key, (value) => value)).resolves.toEqual({ status: "missing" });
  });

  it.each([
    ["malformed JSON", Buffer.from("{")],
    ["invalid UTF-8", Buffer.from([0xff, 0xfe])],
    ["oversized", Buffer.alloc(129, 0x20)],
  ])("treats %s as corruption without reflecting content", async (_label, content) => {
    const cacheRoot = await root();
    const key = "example";
    await writeFile(pathFor(cacheRoot, "npm", key), content);
    const cache = new MetadataCache({ maximumBytes: 128, root: cacheRoot });
    await expect(cache.read("npm", key, (value) => value)).resolves.toEqual({ status: "corrupt" });
  });

  it("rejects key tampering and payloads that fail provider validation", async () => {
    const cacheRoot = await root();
    const cache = new MetadataCache({ root: cacheRoot });
    await cache.write("npm", "right", { secretShape: true }, 10_000);
    const right = await readFile(pathFor(cacheRoot, "npm", "right"));
    await writeFile(pathFor(cacheRoot, "npm", "wrong"), right);
    await expect(cache.read("npm", "wrong", (value) => value)).resolves.toEqual({
      status: "corrupt",
    });
    await expect(
      cache.read("npm", "right", () => {
        throw new Error("invalid payload");
      }),
    ).resolves.toEqual({ status: "corrupt" });
  });

  it.each([
    ["schema", { schemaVersion: 2 }],
    ["provider", { provider: "osv" }],
    ["digest", { keyDigest: `sha256:${"0".repeat(64)}` }],
    ["stored timestamp", { storedAt: "2026-02-30T00:00:00.000Z" }],
    ["expiry timestamp", { expiresAt: "not-a-date" }],
    ["future storage", { storedAt: "2026-08-19T18:00:01.000Z" }],
    ["inverted lifetime", { expiresAt: "2026-08-19T17:59:59.000Z" }],
    ["unknown field", { extra: true }],
  ])("rejects a cache envelope with a tampered %s", async (_label, mutation) => {
    const cacheRoot = await root();
    const key = "tamper";
    const cache = new MetadataCache({
      root: cacheRoot,
      now: () => new Date("2026-08-19T18:00:00.000Z"),
    });
    expect(await cache.write("npm", key, { ok: true }, 10_000)).toBe(true);
    const path = pathFor(cacheRoot, "npm", key);
    const envelope = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...envelope, ...mutation }));
    await expect(cache.read("npm", key, (value) => value)).resolves.toEqual({
      status: "corrupt",
    });
  });

  it("treats non-files and invalid read clocks as corruption", async () => {
    const cacheRoot = await root();
    const key = "example";
    await mkdir(pathFor(cacheRoot, "npm", key));
    const cache = new MetadataCache({ root: cacheRoot });
    await expect(cache.read("npm", key, (value) => value)).resolves.toEqual({ status: "corrupt" });

    const otherKey = "clock";
    const writer = new MetadataCache({ root: cacheRoot });
    expect(await writer.write("npm", otherKey, {}, 10_000)).toBe(true);
    const badClock = new MetadataCache({ root: cacheRoot, now: () => new Date("invalid") });
    await expect(badClock.read("npm", otherKey, (value) => value)).resolves.toEqual({
      status: "corrupt",
    });
  });

  it("atomically refreshes an existing key and rejects oversized or cyclic writes", async () => {
    const cacheRoot = await root();
    const cache = new MetadataCache({ maximumBytes: 512, root: cacheRoot });
    expect(await cache.write("osv", "example@1", { value: 1 }, 10_000)).toBe(true);
    expect(await cache.write("osv", "example@1", { value: 2 }, 10_000)).toBe(true);
    await expect(cache.read("osv", "example@1", (value) => value)).resolves.toMatchObject({
      value: { value: 2 },
    });
    expect(await cache.write("osv", "large", { value: "x".repeat(1_000) }, 10_000)).toBe(false);
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(await cache.write("osv", "cyclic", cyclic, 10_000)).toBe(false);
  });

  it("fails closed when its cache root cannot be created", async () => {
    const parent = await root();
    const cacheRoot = join(parent, "not-a-directory");
    await writeFile(cacheRoot, "occupied");
    const cache = new MetadataCache({ root: cacheRoot });
    await expect(cache.write("npm", "example", {}, 1_000)).resolves.toBe(false);
    await expect(cache.read("npm", "example", (value) => value)).resolves.toEqual({
      status: "missing",
    });
  });
});

describe("defaultCacheRoot", () => {
  it("uses platform conventions without embedding keys in paths", () => {
    expect(defaultCacheRoot({ LOCALAPPDATA: "C:\\Local" }, "win32", "C:\\Home")).toBe(
      join("C:\\Local", "AgentHawk", "Cache"),
    );
    expect(defaultCacheRoot({}, "win32", "C:\\Home")).toBe(
      join("C:\\Home", "AppData", "Local", "AgentHawk", "Cache"),
    );
    expect(defaultCacheRoot({}, "darwin", "/home/user")).toBe(
      join("/home/user", "Library", "Caches", "AgentHawk"),
    );
    expect(defaultCacheRoot({ XDG_CACHE_HOME: "/cache" }, "linux", "/home/user")).toBe(
      join("/cache", "agenthawk"),
    );
    expect(defaultCacheRoot({}, "linux", "/home/user")).toBe(
      join("/home/user", ".cache", "agenthawk"),
    );
  });
});
