import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createFixtureRuntimePreparer,
  fixtureRuntimePlan,
  runFixtureRuntimeCommand,
} from "./prepare-fixture-runtime.mjs";

afterEach(() => vi.useRealTimers());
const flags = { executed: false, portableRuntime: false, nativeSupport: false };
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
function fixture() {
  const destination = resolve("synthetic-runtime-parent", "output");
  const root = resolve("synthetic-runtime-source");
  const source = { commit: "a".repeat(40), tree: "b".repeat(40), lockfileSha256: "c".repeat(64) };
  const archives = {
    core: Buffer.from("inert own core fixture"),
    cli: Buffer.from("inert own cli fixture"),
  };
  const names = ["agenthawk-core-0.1.0-alpha.1.tgz", "agenthawk-cli-0.1.0-alpha.1.tgz"];
  const state = {
    index: 0,
    extra: false,
    mode: 0o40700n,
    parentIno: 1n,
    scratchIno: 2n,
    closeFails: false,
  };
  const io = {
    realpath: vi.fn(async (path: string) => path),
    lstat: vi.fn(async (path: string) => ({
      dev: 1n,
      ino: path === dirname(destination) ? state.parentIno : state.scratchIno,
      uid: 1000n,
      mode: state.mode,
      isDirectory: () => true,
      isSymbolicLink: () => false,
    })),
    mkdir: vi.fn(async () => {}),
    open: vi.fn(async () => {
      throw new Error("unexpected fixture open");
    }),
    opendir: vi.fn(async (_path: string) => ({
      read: vi.fn(async () => {
        const name = [...names, ...(state.extra ? ["unexpected"] : [])][state.index++];
        return name ? { name, isFile: () => true, isSymbolicLink: () => false } : null;
      }),
      close: vi.fn(async () => {
        if (state.closeFails) throw new Error("synthetic close failed");
      }),
    })),
  };
  const inspect = vi.fn(async (_input: unknown) => ({
    status: "available",
    parentIdentity: { dev: 1n, ino: 1n },
  }));
  const observe = vi.fn(async (_input: unknown) => ({ ...source }));
  const run = vi.fn(async (file: string, args: string[], _options: unknown) => ({
    status: "completed",
    stdout: Buffer.from(
      args.includes("--version")
        ? file === "pnpm"
          ? "10.34.5\n"
          : "Version 7.0.2\n"
        : "discard build output",
    ),
  }));
  const readFile = vi.fn(async (_io: unknown, path: string, _maximum: number) =>
    path.includes("-core-") ? archives.core : archives.cli,
  );
  const download = vi.fn(
    async (_name: string, consume: (chunk: Buffer) => unknown, _signal: AbortSignal) => {
      await consume(Buffer.from("inert pinned transport fixture"));
    },
  );
  const plan = vi.fn((_input: unknown) => ({ status: "planned", ...flags }));
  const describe = vi.fn((_input: unknown) => ({
    packages: Object.entries(archives).map(([name, bytes]) => ({
      name: `@agenthawk/${name}`,
      archiveSha256: sha256(bytes),
    })),
  }));
  const write = vi.fn(async (_input: unknown) => ({
    status: "assembled",
    source,
    storedTreeSha256: "d".repeat(64),
    sourceBinding: "caller_observation_only",
    ...flags,
  }));
  const overrides = {
    filesystem: io,
    root,
    platform: "linux",
    nodeVersion: "v24.14.0",
    getUid: () => 1000,
    inspect,
    observe,
    run,
    readFile,
    download,
    plan,
    describe,
    write,
  };
  const prepare = () => createFixtureRuntimePreparer(overrides)(destination);
  return {
    destination,
    root,
    source,
    archives,
    state,
    io,
    inspect,
    observe,
    run,
    readFile,
    download,
    plan,
    describe,
    write,
    overrides,
    prepare,
  };
}

describe("fresh fixture runtime orchestration", () => {
  it("orders fresh observed build, closed pack, fixed acquisition and measured assembly", async () => {
    const f = fixture();
    const result = await f.prepare();
    expect(result).toMatchObject({
      status: "assembled",
      sourceBinding: "observed_fresh_build",
      ...flags,
    });
    expect(f.observe).toHaveBeenCalledTimes(4);
    expect(f.observe.mock.calls[0]?.[0]).toMatchObject({ requireFreshOutput: true });
    expect(f.io.mkdir).toHaveBeenCalledWith(`${f.destination}.build`, { mode: 0o700 });
    expect(f.run.mock.calls.filter(([, args]) => args.includes("pack"))).toHaveLength(2);
    expect(f.run.mock.calls.filter(([, args]) => args.includes("-p"))).toHaveLength(2);
    expect(f.download.mock.calls.map(([name]) => name)).toEqual([
      "commander",
      "semver",
      "yaml",
      "zod",
    ]);
    expect(f.write).toHaveBeenCalledOnce();
    expect(JSON.stringify(result)).not.toContain(f.destination);
  });
  it("uses only fixed own compiler and lifecycle-disabled pack commands", async () => {
    const f = fixture();
    await f.prepare();
    for (const [file, args, options] of f.run.mock.calls) {
      expect([process.execPath, "pnpm"]).toContain(file);
      expect(args).not.toContain("install");
      expect(options).toMatchObject({
        cwd: f.root,
        env: {
          npm_config_ignore_scripts: "true",
          npm_config_ignore_pnpmfile: "true",
          npm_config_userconfig: "/dev/null",
          GIT_CONFIG_GLOBAL: "/dev/null",
          COREPACK_ENABLE_NETWORK: "0",
        },
      });
      const environment = (options as { env: Record<string, string> }).env;
      expect(environment).not.toHaveProperty("NODE_OPTIONS");
      expect(environment).not.toHaveProperty("GITHUB_TOKEN");
      expect(environment).not.toHaveProperty("HTTP_PROXY");
      if (args.includes("pack"))
        expect(args).toEqual(
          expect.arrayContaining(["--config.ignore-scripts=true", "--config.ignore-pnpmfile=true"]),
        );
    }
  });
  it("refuses unsupported hosts before filesystem or subprocess activity", async () => {
    const f = fixture();
    const result = await createFixtureRuntimePreparer({ ...f.overrides, platform: "win32" })(
      f.destination,
    );
    expect(result).toMatchObject({
      reason: "unsupported_host",
      retainedState: "not_created",
      ...flags,
    });
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("refuses cancelled work without starting", async () => {
    const f = fixture();
    const controller = new AbortController();
    controller.abort();
    expect(
      await createFixtureRuntimePreparer(f.overrides)(f.destination, controller.signal),
    ).toHaveProperty("reason", "cancelled");
    expect(f.run).not.toHaveBeenCalled();
  });
  it("rejects malformed cancellation input", async () => {
    const f = fixture();
    expect(await createFixtureRuntimePreparer(f.overrides)(f.destination, {})).toHaveProperty(
      "reason",
      "invalid_destination",
    );
  });
  it.each([0, 1])("requires fresh destination and scratch preflight %s", async (index) => {
    const f = fixture();
    let calls = 0;
    f.inspect.mockImplementation(async () =>
      ++calls === index + 1
        ? ({ status: "rejected", reason: "destination_unavailable" } as never)
        : { status: "available", parentIdentity: { dev: 1n, ino: 1n } },
    );
    expect(await f.prepare()).toMatchObject({
      reason: "destination_unavailable",
      retainedState: "not_created",
    });
    expect(f.io.mkdir).not.toHaveBeenCalled();
    expect(f.run).not.toHaveBeenCalled();
  });
  it("rejects parent replacement between preflights", async () => {
    const f = fixture();
    f.inspect.mockResolvedValueOnce({ status: "available", parentIdentity: { dev: 1n, ino: 2n } });
    expect(await f.prepare()).toHaveProperty("reason", "ownership_changed");
    expect(f.run).not.toHaveBeenCalled();
  });
  it.each(["source_dirty", "output_exists", "closure_unconfirmed"])(
    "stops at fresh source failure %s",
    async (reason) => {
      const f = fixture();
      f.observe.mockRejectedValueOnce({ reason });
      expect(await f.prepare()).toMatchObject({ reason, retainedState: "not_created" });
      expect(f.run).not.toHaveBeenCalled();
      expect(f.download).not.toHaveBeenCalled();
    },
  );
  it.each(["pnpm", "compiler"])("rejects an unexpected %s version", async (tool) => {
    const f = fixture();
    const run = f.run.getMockImplementation();
    if (!run) throw new Error("fixture runner missing");
    f.run.mockImplementation(async (file, args, options) =>
      (tool === "pnpm" ? file === "pnpm" : file !== "pnpm") && args.includes("--version")
        ? { status: "completed", stdout: Buffer.from("unexpected version") }
        : run(file, args, options),
    );
    expect(await f.prepare()).toHaveProperty("reason", "toolchain_invalid");
    expect(f.io.mkdir).not.toHaveBeenCalled();
  });
  it("rejects an unsupported Node version", async () => {
    const f = fixture();
    expect(
      await createFixtureRuntimePreparer({ ...f.overrides, nodeVersion: "v26.0.0" })(f.destination),
    ).toHaveProperty("reason", "toolchain_invalid");
  });
  it.each(["process_failed", "process_timeout", "process_output_limit", "closure_unconfirmed"])(
    "does not continue after a %s build",
    async (reason) => {
      const f = fixture();
      const run = f.run.getMockImplementation();
      if (!run) throw new Error("fixture runner missing");
      f.run.mockImplementation(async (file, args, options) =>
        args.includes("-p") ? ({ status: "failed", reason } as never) : run(file, args, options),
      );
      expect(await f.prepare()).toMatchObject({ reason, retainedState: "present_or_uncertain" });
      expect(f.download).not.toHaveBeenCalled();
      expect(f.write).not.toHaveBeenCalled();
    },
  );
  it.each([2, 3, 4])("fences source again at observation %s", async (changedAt) => {
    const f = fixture();
    let calls = 0;
    f.observe.mockImplementation(async () => ({
      ...f.source,
      commit: ++calls === changedAt ? "e".repeat(40) : f.source.commit,
    }));
    expect(await f.prepare()).toHaveProperty("reason", "source_changed");
    if (changedAt < 4) expect(f.write).not.toHaveBeenCalled();
  });
  it("retains uncertain scratch state when mkdir fails", async () => {
    const f = fixture();
    f.io.mkdir.mockRejectedValue(new Error("synthetic private path"));
    expect(await f.prepare()).toMatchObject({
      reason: "storage_failed",
      retainedState: "present_or_uncertain",
    });
  });
  it.each(["parent", "scratch", "mode"])("detects %s directory changes", async (kind) => {
    const f = fixture();
    f.io.mkdir.mockImplementation(async () => {
      if (kind === "parent") f.state.parentIno = 3n;
      if (kind === "mode") f.state.mode = 0o40777n;
    });
    if (kind === "scratch") {
      const run = f.run.getMockImplementation();
      if (!run) throw new Error("fixture runner missing");
      f.run.mockImplementation(async (file, args, options) => {
        if (args.includes("-p")) f.state.scratchIno = 8n;
        return run(file, args, options);
      });
    }
    expect(await f.prepare()).toHaveProperty("reason", "ownership_changed");
    expect(f.download).not.toHaveBeenCalled();
  });
  it("rejects extra pack output and closes the enumerator", async () => {
    const f = fixture();
    f.state.extra = true;
    expect(await f.prepare()).toHaveProperty("reason", "archive_invalid");
    expect(f.download).not.toHaveBeenCalled();
  });
  it("does not claim closure after directory close failure", async () => {
    const f = fixture();
    f.state.closeFails = true;
    expect(await f.prepare()).toHaveProperty("reason", "closure_unconfirmed");
    expect(f.write).not.toHaveBeenCalled();
  });
  it("rejects oversized streamed download before plan or materialization", async () => {
    const f = fixture();
    f.download.mockImplementation(async (_name, consume) => {
      await consume(Buffer.alloc(1_000_000));
    });
    expect(await f.prepare()).toHaveProperty("reason", "download_failed");
    expect(f.plan).not.toHaveBeenCalled();
    expect(f.write).not.toHaveBeenCalled();
  });
  it("contains transport errors without disclosing messages", async () => {
    const f = fixture();
    f.download.mockRejectedValue(new Error("synthetic secret and private path"));
    const result = await f.prepare();
    expect(result).toHaveProperty("status", "failed");
    expect(JSON.stringify(result)).not.toContain("synthetic secret");
    expect(result).toHaveProperty("reason", "download_failed");
  });
  it("preserves unconfirmed network closure from the actual transport error shape", async () => {
    const f = fixture();
    f.download.mockRejectedValue(new Error("download_cleanup_unconfirmed"));
    expect(await f.prepare()).toHaveProperty("reason", "closure_unconfirmed");
    expect(f.write).not.toHaveBeenCalled();
  });
  it("never lets cancellation overwrite unconfirmed transport closure", async () => {
    const f = fixture();
    const controller = new AbortController();
    f.download.mockImplementation(async () => {
      controller.abort();
      throw new Error("download_cleanup_unconfirmed");
    });
    expect(
      await createFixtureRuntimePreparer(f.overrides)(f.destination, controller.signal),
    ).toHaveProperty("reason", "closure_unconfirmed");
  });
  it("rejects unverified archive plans", async () => {
    const f = fixture();
    f.plan.mockReturnValue({ status: "rejected", ...flags });
    expect(await f.prepare()).toHaveProperty("reason", "archive_invalid");
    expect(f.write).not.toHaveBeenCalled();
  });
  it("binds own archive hashes to actual controlled build bytes", async () => {
    const f = fixture();
    f.describe.mockReturnValue({
      packages: [{ name: "@agenthawk/core", archiveSha256: "f".repeat(64) }],
    });
    expect(await f.prepare()).toHaveProperty("reason", "archive_invalid");
    expect(f.write).not.toHaveBeenCalled();
  });
  it.each(["tree_mismatch", "closure_unconfirmed"])(
    "preserves writer failure %s",
    async (reason) => {
      const f = fixture();
      f.write.mockResolvedValue({ status: "rejected", reason } as never);
      expect(await f.prepare()).toHaveProperty("reason", reason);
    },
  );
  it("cancellation after writing cannot become successful freshness evidence", async () => {
    const f = fixture();
    const controller = new AbortController();
    const write = f.write.getMockImplementation();
    if (!write) throw new Error("fixture writer missing");
    f.write.mockImplementation(async (input) => {
      controller.abort();
      return write(input);
    });
    expect(
      await createFixtureRuntimePreparer(f.overrides)(f.destination, controller.signal),
    ).toHaveProperty("reason", "cancelled");
  });
  it("enforces the aggregate deadline and retains state", async () => {
    vi.useFakeTimers();
    const f = fixture();
    f.download.mockImplementation(
      async (_name, _consume, signal) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener("abort", () => reject(new Error("synthetic cancellation")), {
            once: true,
          }),
        ),
    );
    const pending = f.prepare();
    await vi.advanceTimersByTimeAsync(480_100);
    expect(await pending).toMatchObject({
      reason: "deadline_exceeded",
      retainedState: "present_or_uncertain",
    });
  });
});

describe("finalized fresh-preparation capability", () => {
  function deferred() {
    let release: () => void = () => {};
    let reject: (reason: unknown) => void = () => {};
    const pending = new Promise<void>((resolve, fail) => {
      release = resolve;
      reject = fail;
    });
    return { pending, release, reject };
  }

  function holdSettlement(f: ReturnType<typeof fixture>) {
    const closing = deferred();
    const closed = deferred();
    const opendir = f.io.opendir.getMockImplementation();
    if (!opendir) throw new Error("fixture directory missing");
    const retainedPath = join(f.destination, "synthetic-settlement-handle");
    f.io.opendir.mockImplementation(async (path) =>
      path === retainedPath
        ? {
            read: vi.fn(async () => null),
            close: vi.fn(async () => {
              closing.release();
              await closed.pending;
            }),
          }
        : opendir(path),
    );
    let observations = 0;
    f.observe.mockImplementation(async (input) => {
      if (++observations === 4) {
        // The bounded storage owns this deliberately retained trusted-test
        // handle; successful preparation still has to wait for its closure.
        const { io } = input as { io: { opendir: (path: string) => Promise<unknown> } };
        await io.opendir(retainedPath);
      }
      return { ...f.source };
    });
    return { closing, closed };
  }

  it("recovers the exact opaque plan only from the finalized frozen result", async () => {
    const f = fixture();
    const result = await f.prepare();
    const plan = f.plan.mock.results[0]?.value;
    expect(result).toHaveProperty("status", "assembled");
    expect(fixtureRuntimePlan(result)).toBe(plan);
    expect(Object.isFrozen(result)).toBe(true);
    const written = await f.write.mock.results[0]?.value;
    expect(result).toEqual({ ...written, sourceBinding: "observed_fresh_build", ...flags });
    expect(Reflect.ownKeys(result)).toEqual(Reflect.ownKeys(written));
    expect(fixtureRuntimePlan(written)).toBeUndefined();
    expect(fixtureRuntimePlan(plan)).toBeUndefined();
  });

  it.each(["spread", "json", "structured", "prototype", "proxy"])(
    "refuses a %s copy without weakening the original capability",
    async (kind) => {
      const f = fixture();
      const result = await f.prepare();
      const copy =
        kind === "spread"
          ? { ...result }
          : kind === "json"
            ? JSON.parse(JSON.stringify(result))
            : kind === "structured"
              ? structuredClone(result)
              : kind === "prototype"
                ? Object.create(result)
                : new Proxy(result, {});
      expect(fixtureRuntimePlan(copy)).toBeUndefined();
      expect(fixtureRuntimePlan(result)).toBe(f.plan.mock.results[0]?.value);
    },
  );

  it("never inspects arbitrary caller objects or forged success fields", () => {
    const inspect = vi.fn(() => {
      throw new Error("untrusted getter must not run");
    });
    const accessor = Object.defineProperty({}, "status", { get: inspect });
    const proxy = new Proxy({}, { get: inspect, getPrototypeOf: inspect, ownKeys: inspect });
    const revoked = Proxy.revocable({}, {});
    revoked.revoke();
    for (const input of [
      undefined,
      null,
      false,
      0,
      "assembled",
      Symbol("synthetic"),
      {},
      accessor,
      proxy,
      revoked.proxy,
      Object.freeze({ status: "assembled", sourceBinding: "observed_fresh_build", ...flags }),
    ])
      expect(fixtureRuntimePlan(input)).toBeUndefined();
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not expose freshness before the final source fence completes", async () => {
    const f = fixture();
    const entered = deferred();
    const fence = deferred();
    let observations = 0;
    f.observe.mockImplementation(async () => {
      if (++observations === 4) {
        entered.release();
        await fence.pending;
      }
      return { ...f.source };
    });
    let completed = false;
    const pending = f.prepare().then((value) => {
      completed = true;
      return value;
    });
    await entered.pending;
    expect(completed).toBe(false);
    expect(fixtureRuntimePlan(await f.write.mock.results[0]?.value)).toBeUndefined();
    expect(fixtureRuntimePlan(f.plan.mock.results[0]?.value)).toBeUndefined();
    fence.release();
    const result = await pending;
    expect(fixtureRuntimePlan(result)).toBe(f.plan.mock.results[0]?.value);
  });

  it("does not expose freshness until every retained handle is closed", async () => {
    const f = fixture();
    const { closing, closed } = holdSettlement(f);
    let completed = false;
    const pending = f.prepare().then((value) => {
      completed = true;
      return value;
    });
    await closing.pending;
    expect(completed).toBe(false);
    expect(fixtureRuntimePlan(await f.write.mock.results[0]?.value)).toBeUndefined();
    closed.release();
    const result = await pending;
    expect(result).toHaveProperty("status", "assembled");
    expect(fixtureRuntimePlan(result)).toBe(f.plan.mock.results[0]?.value);
  });

  it.each(["source_changed", "closure_unconfirmed"])(
    "never brands a result after final source failure %s",
    async (reason) => {
      const f = fixture();
      let observations = 0;
      f.observe.mockImplementation(async () => {
        if (++observations === 4) throw { reason };
        return { ...f.source };
      });
      const result = await f.prepare();
      expect(result).toMatchObject({ status: "failed", reason, ...flags });
      expect(f.write).toHaveBeenCalledOnce();
      expect(fixtureRuntimePlan(result)).toBeUndefined();
      expect(fixtureRuntimePlan(await f.write.mock.results[0]?.value)).toBeUndefined();
    },
  );

  it("never brands success when final settlement fails", async () => {
    const f = fixture();
    const { closing, closed } = holdSettlement(f);
    const pending = f.prepare();
    await closing.pending;
    closed.reject(new Error("synthetic close failure"));
    const result = await pending;
    expect(result).toMatchObject({ status: "failed", reason: "closure_unconfirmed", ...flags });
    expect(fixtureRuntimePlan(result)).toBeUndefined();
    expect(fixtureRuntimePlan(await f.write.mock.results[0]?.value)).toBeUndefined();
  });

  it.each([false, true])(
    "cannot brand cancelled final settlement, including close failure %s",
    async (closeFails) => {
      const f = fixture();
      const { closing, closed } = holdSettlement(f);
      const controller = new AbortController();
      const pending = createFixtureRuntimePreparer(f.overrides)(f.destination, controller.signal);
      await closing.pending;
      controller.abort();
      if (closeFails) closed.reject(new Error("synthetic close failure"));
      else closed.release();
      const result = await pending;
      expect(result).toMatchObject({
        status: "failed",
        reason: closeFails ? "closure_unconfirmed" : "cancelled",
        ...flags,
      });
      expect(fixtureRuntimePlan(result)).toBeUndefined();
      expect(fixtureRuntimePlan(await f.write.mock.results[0]?.value)).toBeUndefined();
    },
  );
});

describe("closed development command", () => {
  it.each(
    [[], ["--source-sha", "a".repeat(40)], ["--skip-check"], ["one", "two"], [null]].map(
      (args) => ({ args }),
    ),
  )("rejects extra authority and malformed arguments %#", async ({ args }) => {
    const prepare = vi.fn();
    expect(await runFixtureRuntimeCommand(args, prepare)).toMatchObject({
      exitCode: 2,
      result: { reason: "invalid_destination", ...flags },
    });
    expect(prepare).not.toHaveBeenCalled();
  });
  it("returns success only for an assembled nonexecuting tree", async () => {
    const prepare = vi.fn(async () => ({ status: "assembled", ...flags }));
    expect(await runFixtureRuntimeCommand([join("/fixture", "new")], prepare)).toMatchObject({
      exitCode: 0,
      result: { status: "assembled", ...flags },
    });
  });
  it("returns failure for a closed preparation rejection", async () => {
    const prepare = vi.fn(async () => ({ status: "failed", reason: "output_exists", ...flags }));
    expect(await runFixtureRuntimeCommand(["/fixture/new"], prepare)).toHaveProperty("exitCode", 1);
  });
});
