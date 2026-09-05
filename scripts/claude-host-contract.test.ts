import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildClaudeContainerCreateArgs,
  buildClaudeFixtureInvocation,
  inspectClaudeContainerBoundary,
} from "./claude-host-contract.mjs";

const IMAGE_ID = `sha256:${"a".repeat(64)}`;
const CONTAINER_ID = "b".repeat(64);
const NAME = `agenthawk-claude-${"c".repeat(32)}`;
const PATH_VALUE = "/usr/local/bin:/usr/bin:/bin";
const PRIVATE_VALUE = "fixture-private-do-not-retain";
const identity = { imageId: IMAGE_ID, name: NAME };

// Independent daemon-record fixture, never generated from the launch implementation.
function inspection() {
  return {
    image: {
      Id: IMAGE_ID,
      Os: "linux",
      Architecture: "amd64",
      Config: {
        Env: [`PATH=${PATH_VALUE}`],
        Volumes: null,
        OnBuild: null,
        Healthcheck: { Test: ["NONE"] },
      },
    },
    container: {
      Id: CONTAINER_ID,
      Image: IMAGE_ID,
      Name: `/${NAME}`,
      Path: "/usr/bin/env",
      Args: [
        "-i",
        `PATH=${PATH_VALUE}`,
        "HOME=/work/home",
        "TMPDIR=/tmp",
        "/usr/local/bin/node",
        "/opt/agenthawk/verify-claude-host.mjs",
      ],
      State: {
        Status: "created",
        Running: false,
        Paused: false,
        Restarting: false,
        Dead: false,
        OOMKilled: false,
        Pid: 0,
        ExitCode: 0,
        Error: "",
        StartedAt: "0001-01-01T00:00:00Z",
        FinishedAt: "0001-01-01T00:00:00Z",
      },
      RestartCount: 0,
      Config: {
        Image: IMAGE_ID,
        Hostname: "agenthawk-fixture",
        Domainname: "",
        User: "10001:10001",
        WorkingDir: "/work",
        Entrypoint: ["/usr/bin/env"],
        Cmd: [
          "-i",
          `PATH=${PATH_VALUE}`,
          "HOME=/work/home",
          "TMPDIR=/tmp",
          "/usr/local/bin/node",
          "/opt/agenthawk/verify-claude-host.mjs",
        ],
        Env: [`PATH=${PATH_VALUE}`],
        Labels: { "org.agenthawk.fixture": "claude-2.1.241" },
        Volumes: null,
        Tty: false,
        OpenStdin: false,
        StdinOnce: false,
        AttachStdin: false,
        AttachStdout: true,
        AttachStderr: true,
        StopTimeout: 5,
        StopSignal: "SIGTERM",
        OnBuild: null,
        Healthcheck: { Test: ["NONE"] },
      },
      HostConfig: {
        Binds: null,
        ContainerIDFile: "",
        LogConfig: { Type: "none", Config: {} },
        NetworkMode: "none",
        PortBindings: {},
        RestartPolicy: { Name: "no", MaximumRetryCount: 0 },
        AutoRemove: false,
        VolumeDriver: "",
        VolumesFrom: null,
        ConsoleSize: [0, 0],
        CapAdd: null,
        CapDrop: ["ALL"],
        CgroupnsMode: "private",
        Dns: [],
        DnsOptions: [],
        DnsSearch: [],
        ExtraHosts: null,
        GroupAdd: null,
        IpcMode: "private",
        Cgroup: "",
        Links: null,
        OomScoreAdj: 0,
        PidMode: "",
        Privileged: false,
        PublishAllPorts: false,
        ReadonlyRootfs: true,
        SecurityOpt: ["no-new-privileges=true"],
        Tmpfs: {
          "/work": "rw,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001",
          "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
        },
        UTSMode: "",
        UsernsMode: "",
        ShmSize: 16_777_216,
        Runtime: "runc",
        Isolation: "",
        CpuShares: 0,
        Memory: 1_073_741_824,
        NanoCpus: 1_000_000_000,
        CgroupParent: "",
        BlkioWeight: 0,
        BlkioWeightDevice: [],
        BlkioDeviceReadBps: [],
        BlkioDeviceWriteBps: [],
        BlkioDeviceReadIOps: [],
        BlkioDeviceWriteIOps: [],
        CpuPeriod: 0,
        CpuQuota: 0,
        CpuRealtimePeriod: 0,
        CpuRealtimeRuntime: 0,
        CpusetCpus: "",
        CpusetMems: "",
        Devices: [],
        DeviceCgroupRules: null,
        DeviceRequests: null,
        MemoryReservation: 0,
        MemorySwap: 1_073_741_824,
        MemorySwappiness: null,
        OomKillDisable: false,
        PidsLimit: 64,
        Ulimits: [],
        CpuCount: 0,
        CpuPercent: 0,
        IOMaximumIOps: 0,
        IOMaximumBandwidth: 0,
        MaskedPaths: [
          "/proc/acpi",
          "/proc/asound",
          "/proc/interrupts",
          "/proc/kcore",
          "/proc/keys",
          "/proc/latency_stats",
          "/proc/sched_debug",
          "/proc/scsi",
          "/proc/timer_list",
          "/proc/timer_stats",
          "/sys/firmware",
          "/sys/devices/virtual/powercap",
        ],
        ReadonlyPaths: ["/proc/bus", "/proc/fs", "/proc/irq", "/proc/sys", "/proc/sysrq-trigger"],
        Init: true,
      },
      Mounts: [],
      NetworkSettings: {
        Ports: {},
        Networks: {
          none: {
            IPAddress: "",
            Gateway: "",
            GlobalIPv6Address: "",
            IPv6Gateway: "",
            MacAddress: "",
            IPPrefixLen: 0,
            GlobalIPv6PrefixLen: 0,
            IPAMConfig: null,
            Links: null,
            Aliases: null,
            DriverOpts: null,
          },
        },
      },
    },
  };
}

function inspect(records = inspection(), expectedId = CONTAINER_ID) {
  return inspectClaudeContainerBoundary(identity, records.image, records.container, expectedId);
}

function altered(value: unknown): unknown {
  if (value === null) return [];
  if (typeof value === "boolean") return !value;
  if (typeof value === "number") return value + 1;
  if (typeof value === "string") return `${value}-changed`;
  if (Array.isArray(value)) return [...value, "unexpected"];
  return null;
}

function hostileRecord(value: object, kind: string) {
  const copy = { ...value };
  if (kind === "prototype") return Object.setPrototypeOf(copy, { inherited: true });
  if (kind === "symbol") return Object.assign(copy, { [Symbol("fixture")]: PRIVATE_VALUE });
  if (kind === "too many fields") {
    return Object.assign(
      copy,
      Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`extra-${index}`, "x"])),
    );
  }
  if (kind === "accessor") {
    return Object.defineProperty(copy, Object.keys(copy)[0], {
      enumerable: true,
      get() {
        throw new Error(PRIVATE_VALUE);
      },
    });
  }
  if (kind === "revoked proxy") {
    const { proxy, revoke } = Proxy.revocable(copy, {});
    revoke();
    return proxy;
  }
  return new Proxy(copy, {
    [kind]() {
      throw new Error(PRIVATE_VALUE);
    },
  });
}

afterEach(() => vi.unstubAllEnvs());

it.each([8192, 8193])("bounds descriptor property names at %i characters", (length) => {
  const records = inspection();
  Object.defineProperty(records.image, "x".repeat(length), { value: null, enumerable: true });
  expect(inspect(records).status).toBe(length === 8192 ? "matched" : "rejected");
});

describe("Claude isolated container launch vector", () => {
  it("returns only the exact bounded create vector, without starting or mounting a host path", () => {
    expect(buildClaudeContainerCreateArgs(identity)).toEqual([
      "create",
      "--pull",
      "never",
      "--name",
      NAME,
      "--network",
      "none",
      "--read-only",
      "--user",
      "10001:10001",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges=true",
      "--ipc",
      "private",
      "--cgroupns",
      "private",
      "--init",
      "--no-healthcheck",
      "--restart",
      "no",
      "--log-driver",
      "none",
      "--memory",
      "1073741824",
      "--memory-swap",
      "1073741824",
      "--cpus",
      "1",
      "--pids-limit",
      "64",
      "--shm-size",
      "16777216",
      "--stop-timeout",
      "5",
      "--stop-signal",
      "SIGTERM",
      "--attach",
      "stdout",
      "--attach",
      "stderr",
      "--hostname",
      "agenthawk-fixture",
      "--workdir",
      "/work",
      "--env",
      `PATH=${PATH_VALUE}`,
      "--label",
      "org.agenthawk.fixture=claude-2.1.241",
      "--tmpfs",
      "/work:rw,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001",
      "--tmpfs",
      "/tmp:rw,noexec,nosuid,nodev,size=64m,mode=1777",
      "--entrypoint",
      "/usr/bin/env",
      IMAGE_ID,
      "-i",
      `PATH=${PATH_VALUE}`,
      "HOME=/work/home",
      "TMPDIR=/tmp",
      "/usr/local/bin/node",
      "/opt/agenthawk/verify-claude-host.mjs",
    ]);
  });

  it.each(
    [
      undefined,
      null,
      [],
      "identity",
      {},
      { ...identity, extra: true },
      { imageId: IMAGE_ID },
      { name: NAME },
      { ...identity, imageId: "claude:latest" },
      { ...identity, imageId: `sha256:${"A".repeat(64)}` },
      { ...identity, imageId: `sha256:${"a".repeat(63)}` },
      { ...identity, imageId: `${IMAGE_ID}\n` },
      { ...identity, name: "ordinary-container" },
      { ...identity, name: `${NAME} --privileged` },
      { ...identity, name: `${NAME}\n` },
      { ...identity, name: `agenthawk-claude-${"a".repeat(31)}` },
      { ...identity, name: `agenthawk-claude-${"A".repeat(32)}` },
    ].map((input) => ({ input })),
  )("rejects malformed or injectable container identity %j", ({ input }) => {
    expect(() => buildClaudeContainerCreateArgs(input)).toThrow(
      /^Claude container identity invalid\.$/u,
    );
    const records = inspection();
    expect(
      inspectClaudeContainerBoundary(input, records.image, records.container, CONTAINER_ID),
    ).toEqual({ status: "rejected", reason: "identity_invalid" });
  });

  it("rejects inherited required identities disguised by unrelated own fields", () => {
    const input = Object.assign(Object.create(identity), { unrelated: 1, another: 2 });
    expect(() => buildClaudeContainerCreateArgs(input)).toThrow();
    const records = inspection();
    expect(
      inspectClaudeContainerBoundary(input, records.image, records.container, CONTAINER_ID).status,
    ).toBe("rejected");
  });

  it("returns immutable detached arguments", () => {
    const input = { ...identity };
    const args = buildClaudeContainerCreateArgs(input);
    input.name = "changed";
    expect(args).toContain(NAME);
    expect(() => args.push("--privileged")).toThrow(TypeError);
  });
});

describe("Claude daemon-inspection boundary", () => {
  it("matches the independent never-started profile and binds the returned exact ID", () => {
    expect(inspect()).toEqual({ status: "matched", containerId: CONTAINER_ID });
    expect(Object.isFrozen(inspect())).toBe(true);
  });

  it("accepts unrelated informational fields while still checking the explicit security profile", () => {
    const records = inspection();
    records.image.Config.Informational = "reviewed separately";
    records.container.State.Informational = "reviewed separately";
    expect(inspect(records)).toEqual({ status: "matched", containerId: CONTAINER_ID });
  });

  it.each([
    undefined,
    null,
    "",
    "b".repeat(63),
    "B".repeat(64),
    "d".repeat(64),
    `${CONTAINER_ID}\n`,
  ])("rejects absent, malformed, or substituted expected container ID %j", (expectedId) => {
    const records = inspection();
    expect(
      inspectClaudeContainerBoundary(identity, records.image, records.container, expectedId).status,
    ).toBe("rejected");
  });

  it.each([null, [], {}, false].map((value) => ({ value })))(
    "rejects malformed image, container, and nested records %j",
    ({ value }) => {
      const records = inspection();
      expect(
        inspectClaudeContainerBoundary(identity, value, records.container, CONTAINER_ID),
      ).toEqual({ status: "rejected", reason: "image_profile_mismatch" });
      expect(inspectClaudeContainerBoundary(identity, records.image, value, CONTAINER_ID)).toEqual({
        status: "rejected",
        reason: "container_identity_or_state_mismatch",
      });
    },
  );

  const sections = [
    ["image", "image_profile_mismatch", ["Id", "Os", "Architecture", "Config"]],
    ["image.Config", "image_profile_mismatch", Object.keys(inspection().image.Config)],
    [
      "container",
      "container_identity_or_state_mismatch",
      ["Id", "Image", "Name", "Path", "Args", "State", "RestartCount"],
    ],
    [
      "container.State",
      "container_identity_or_state_mismatch",
      Object.keys(inspection().container.State),
    ],
    ["container.Config", "container_config_mismatch", Object.keys(inspection().container.Config)],
    [
      "container.HostConfig",
      "host_config_mismatch",
      Object.keys(inspection().container.HostConfig),
    ],
    [
      "container.NetworkSettings.Networks.none",
      "mount_or_network_mismatch",
      Object.keys(inspection().container.NetworkSettings.Networks.none),
    ],
  ] as const;

  for (const [section, reason, keys] of sections) {
    for (const operation of ["omit", "change"] as const) {
      it.each(keys)(`${operation} of ${section}.%s rejects the profile`, (key) => {
        const records = inspection();
        let target = records;
        for (const segment of section.split(".")) target = target[segment];
        if (operation === "omit") delete target[key];
        else target[key] = altered(target[key]);
        expect(inspect(records)).toEqual({ status: "rejected", reason });
      });
    }
  }

  it.each([
    ["Mounts", [{ Type: "bind", Source: "/private/home", Destination: "/work" }]],
    ["Mounts", [{ Type: "volume", Name: "unexpected", Destination: "/work" }]],
    ["Mounts", null],
    ["NetworkSettings", null],
    ["NetworkSettings", {}],
    [
      "NetworkSettings",
      {
        Ports: { "80/tcp": [{ HostPort: "80" }] },
        Networks: inspection().container.NetworkSettings.Networks,
      },
    ],
    ["NetworkSettings", { Ports: {}, Networks: {} }],
    ["NetworkSettings", { Ports: {}, Networks: { bridge: {} } }],
    [
      "NetworkSettings",
      { Ports: {}, Networks: { ...inspection().container.NetworkSettings.Networks, bridge: {} } },
    ],
    ["NetworkSettings", { Ports: {}, Networks: { none: [] } }],
  ])("rejects unexpected actual %s state", (key, value) => {
    const records = inspection();
    records.container[key] = value;
    expect(inspect(records)).toEqual({ status: "rejected", reason: "mount_or_network_mismatch" });
  });

  it("rejects unknown HostConfig fields instead of inheriting new daemon privileges", () => {
    const records = inspection();
    records.container.HostConfig.NewPrivilege = true;
    expect(inspect(records)).toEqual({ status: "rejected", reason: "host_config_mismatch" });
  });

  it.each([undefined, null, {}])("rejects a missing whole HostConfig %j", (value) => {
    const records = inspection();
    records.container.HostConfig = value;
    expect(inspect(records)).toEqual({ status: "rejected", reason: "host_config_mismatch" });
  });

  it.each([
    ["/work", "rw,nosuid,nodev,size=64m,mode=0777,uid=10001,gid=10001"],
    ["/work", "rw,nosuid,nodev,size=64m,mode=0700,uid=0,gid=0"],
    ["/tmp", "rw,nosuid,nodev,size=64m,mode=1777"],
    ["/tmp", "rw,noexec,nosuid,nodev,size=1024m,mode=1777"],
  ])("rejects permission, identity, execution or capacity weakening at tmpfs %s", (path, value) => {
    const records = inspection();
    records.container.HostConfig.Tmpfs[path] = value;
    expect(inspect(records).status).toBe("rejected");
  });

  it.each(
    [
      [`PATH=${PATH_VALUE}`, "LD_PRELOAD=/private/library.so"],
      [`PATH=${PATH_VALUE}`, "NODE_OPTIONS=--require=/private/hook.js"],
      [`PATH=${PATH_VALUE}`, `PATH=${PATH_VALUE}`],
      [`PATH=${PATH_VALUE}`, `ANTHROPIC_AUTH_TOKEN=${PRIVATE_VALUE}`],
      ["PATH=/private/bin"],
    ].map((env) => ({ env })),
  )("rejects image and container inherited environment injection %j", ({ env }) => {
    for (const target of ["image", "container"]) {
      const records = inspection();
      records[target].Config.Env = env;
      expect(inspect(records).status).toBe("rejected");
    }
  });

  it.each([{ Test: ["CMD", "echo", "unexpected"] }, { Test: ["NONE"], Interval: 1 }, null])(
    "rejects non-disabled or extra image/container healthcheck state %j",
    (healthcheck) => {
      for (const target of ["image", "container"]) {
        const records = inspection();
        records[target].Config.Healthcheck = healthcheck;
        expect(inspect(records).status).toBe("rejected");
      }
    },
  );

  it.each([{}, { "80/tcp": {} }, null])(
    "rejects declared exposed ports even without runtime publication %j",
    (ports) => {
      const records = inspection();
      records.container.Config.ExposedPorts = ports;
      expect(inspect(records)).toEqual({ status: "rejected", reason: "container_config_mismatch" });
    },
  );

  it("keeps rejection reports fixed and detached from supplied daemon diagnostics", () => {
    const records = inspection();
    records.container.State.Error = PRIVATE_VALUE;
    const result = inspect(records);
    expect(result).toEqual({ status: "rejected", reason: "container_identity_or_state_mismatch" });
    expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
    expect(Object.isFrozen(result)).toBe(true);
    records.container.State.Error = "";
    expect(result.status).toBe("rejected");
    expect(inspect(records).status).toBe("matched");
  });
});

describe("Claude contract hostile JavaScript record boundaries", () => {
  it.each([
    "prototype",
    "symbol",
    "too many fields",
    "accessor",
    "revoked proxy",
    "getPrototypeOf",
    "ownKeys",
    "getOwnPropertyDescriptor",
  ])("contains %s inputs without invoking accessors or exposing private exceptions", (kind) => {
    const records = inspection();
    const badIdentity = hostileRecord(identity, kind);
    expect(() => buildClaudeContainerCreateArgs(badIdentity)).toThrow(
      /^Claude container identity invalid\.$/u,
    );
    expect(() =>
      buildClaudeFixtureInvocation(
        hostileRecord({ origin: "http://127.0.0.1:12345", capability: "0".repeat(64) }, kind),
      ),
    ).toThrow(/^Claude fixture invocation invalid\.$/u);
    const results = [
      inspectClaudeContainerBoundary(badIdentity, records.image, records.container, CONTAINER_ID),
      inspectClaudeContainerBoundary(
        identity,
        hostileRecord(records.image, kind),
        records.container,
        CONTAINER_ID,
      ),
      inspectClaudeContainerBoundary(
        identity,
        records.image,
        hostileRecord(records.container, kind),
        CONTAINER_ID,
      ),
    ];
    for (const result of results) {
      expect(result.status).toBe("rejected");
      expect(Object.keys(result).sort()).toEqual(["reason", "status"]);
      expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
    }
  });

  it("supports null-prototype data records without trusting inherited properties", () => {
    const cleanIdentity = Object.assign(Object.create(null), identity);
    expect(buildClaudeContainerCreateArgs(cleanIdentity)).toEqual(
      buildClaudeContainerCreateArgs(identity),
    );
    const records = inspection();
    records.image.Config = Object.assign(Object.create(null), records.image.Config);
    expect(
      inspectClaudeContainerBoundary(cleanIdentity, records.image, records.container, CONTAINER_ID)
        .status,
    ).toBe("matched");
  });

  it.each(["accessor", "extra property", "symbol", "prototype", "revoked", "reflection"])(
    "rejects %s inside supposedly exact environment arrays",
    (kind) => {
      const records = inspection();
      let env = [`PATH=${PATH_VALUE}`];
      if (kind === "accessor") {
        Object.defineProperty(env, "0", {
          get() {
            throw new Error(PRIVATE_VALUE);
          },
        });
      } else if (kind === "extra property") {
        env.unexpected = PRIVATE_VALUE;
      } else if (kind === "symbol") {
        env[Symbol("fixture")] = PRIVATE_VALUE;
      } else if (kind === "prototype") {
        Object.setPrototypeOf(env, { inherited: true });
      } else if (kind === "revoked") {
        const pair = Proxy.revocable(env, {});
        pair.revoke();
        env = pair.proxy;
      } else {
        env = new Proxy(env, {
          ownKeys() {
            throw new Error(PRIVATE_VALUE);
          },
        });
      }
      records.image.Config.Env = env;
      const result = inspect(records);
      expect(result.status).toBe("rejected");
      expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
    },
  );
});

describe("Claude empty-parent invocation contract", () => {
  const options = { origin: "http://127.0.0.1:12345", capability: "0".repeat(64) };

  it("builds exactly one fixed marker call with project hooks and no broad permission bypass", () => {
    const result = buildClaudeFixtureInvocation(options);
    expect(result.executable).toBe("/opt/claude/claude");
    expect(result.cwd).toBe("/work/repository");
    expect(result.args).toEqual([
      "-p",
      "Perform the single fixed AgentHawk fixture tool call, then stop.",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "Bash",
      "--allowedTools",
      "Bash(/opt/agenthawk/fixture-marker)",
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--max-turns",
      "2",
      "--model",
      "claude-sonnet-4-6",
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--mcp-config",
      "/work/empty-mcp.json",
      "--disable-slash-commands",
    ]);
    expect(result.args).not.toContain("--bare");
    expect(result.args).not.toContain("--dangerously-skip-permissions");
    expect(result.env).toEqual({
      PATH: PATH_VALUE,
      HOME: "/work/home",
      TMPDIR: "/tmp",
      LANG: "C.UTF-8",
      SHELL: "/bin/bash",
      CLAUDE_CONFIG_DIR: "/work/home/.claude",
      ANTHROPIC_BASE_URL: options.origin,
      ANTHROPIC_API_KEY: options.capability,
      API_TIMEOUT_MS: "5000",
      BASH_DEFAULT_TIMEOUT_MS: "5000",
      BASH_MAX_TIMEOUT_MS: "5000",
      CLAUDE_CODE_SHELL: "/bin/bash",
      CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
      CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: "1",
      DISABLE_UPDATES: "1",
      DISABLE_AUTOUPDATER: "1",
      DISABLE_ERROR_REPORTING: "1",
      DISABLE_TELEMETRY: "1",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_TERMINAL_PROMPT: "0",
    });
  });

  it.each(["http://127.0.0.1:1", "http://127.0.0.1:65535"])(
    "accepts exact loopback port boundary %s",
    (origin) => {
      expect(buildClaudeFixtureInvocation({ ...options, origin }).env.ANTHROPIC_BASE_URL).toBe(
        origin,
      );
    },
  );

  it.each(
    [
      undefined,
      null,
      [],
      false,
      {},
      { origin: options.origin },
      { capability: options.capability },
      { ...options, command: "echo injected" },
      { ...options, env: {} },
      ...[
        "http://localhost:12345",
        "https://127.0.0.1:12345",
        "http://127.0.0.2:12345",
        "http://[::1]:12345",
        "http://127.0.0.1:0",
        "http://127.0.0.1:65536",
        "http://127.0.0.1:0123",
        "http://127.0.0.1:12345/",
        "http://127.0.0.1:12345/path",
        "http://127.0.0.1:12345?x",
        "http://user@127.0.0.1:12345",
        "http://127.0.0.1:12345\n",
        12345,
      ].map((origin) => ({ ...options, origin })),
      ...[
        undefined,
        null,
        123,
        "",
        "a".repeat(63),
        "a".repeat(65),
        "A".repeat(64),
        `${"a".repeat(64)}\n`,
        PRIVATE_VALUE,
      ].map((capability) => ({ ...options, capability })),
    ].map((input) => ({ input })),
  )("rejects invalid or injectable invocation options %j without echoing values", ({ input }) => {
    expect(() => buildClaudeFixtureInvocation(input)).toThrow(
      /^Claude fixture invocation invalid\.$/u,
    );
  });

  it("rejects inherited origin/capability with unrelated own fields", () => {
    const input = Object.assign(Object.create(options), { unrelated: 1, another: 2 });
    expect(() => buildClaudeFixtureInvocation(input)).toThrow();
  });

  it("does not inherit parent secrets, dynamic-loader variables, or alternate host configuration", () => {
    for (const name of [
      "ANTHROPIC_AUTH_TOKEN",
      "AWS_SECRET_ACCESS_KEY",
      "LD_PRELOAD",
      "NODE_OPTIONS",
      "HTTPS_PROXY",
      "BASH_ENV",
      "CLAUDE_CODE_USE_BEDROCK",
      "CLAUDE_CODE_USE_VERTEX",
    ]) {
      vi.stubEnv(name, PRIVATE_VALUE);
    }
    const result = buildClaudeFixtureInvocation(options);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
    expect(result.env).not.toHaveProperty("LD_PRELOAD");
    expect(result.env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  });

  it("freezes detached vectors and environment instead of retaining caller mutation", () => {
    const input = { ...options };
    const result = buildClaudeFixtureInvocation(input);
    input.origin = "http://fixture.invalid";
    input.capability = PRIVATE_VALUE;
    expect(result.env.ANTHROPIC_BASE_URL).toBe(options.origin);
    expect(result.env.ANTHROPIC_API_KEY).toBe(options.capability);
    expect(Object.isFrozen(result)).toBe(true);
    expect(() => result.args.push("--dangerously-skip-permissions")).toThrow(TypeError);
    expect(() => {
      result.env.LD_PRELOAD = PRIVATE_VALUE;
    }).toThrow(TypeError);
  });
});

describe("Claude descriptor-only input snapshots", () => {
  function changingReads(value: object) {
    const reads = vi.fn((target, key, receiver) => {
      const current = Reflect.get(target, key, receiver);
      return reads.mock.calls.length === 1 ? current : PRIVATE_VALUE;
    });
    return { proxy: new Proxy(value, { get: reads }), reads };
  }

  it("consumes descriptor identity values rather than later proxy property values", () => {
    const { proxy, reads } = changingReads({ ...identity });
    expect(buildClaudeContainerCreateArgs(proxy)).toEqual(buildClaudeContainerCreateArgs(identity));
    const records = inspection();
    expect(
      inspectClaudeContainerBoundary(proxy, records.image, records.container, CONTAINER_ID),
    ).toEqual({ status: "matched", containerId: CONTAINER_ID });
    expect(reads).not.toHaveBeenCalled();
  });

  it("preserves only descriptor origin and capability when a proxy changes subsequent reads", () => {
    const options = { origin: "http://127.0.0.1:12345", capability: "0".repeat(64) };
    const { proxy, reads } = changingReads({ ...options });
    expect(buildClaudeFixtureInvocation(proxy)).toEqual(buildClaudeFixtureInvocation(options));
    expect(reads).not.toHaveBeenCalled();
  });

  it.each([
    "image",
    "image.Config",
    "image.Config.Env",
    "image.Config.Healthcheck",
    "image.Config.Healthcheck.Test",
    "container",
    "container.Args",
    "container.State",
    "container.Config",
    "container.Config.Env",
    "container.HostConfig",
    "container.HostConfig.Tmpfs",
    "container.HostConfig.CapDrop",
    "container.HostConfig.SecurityOpt",
    "container.HostConfig.MaskedPaths",
    "container.HostConfig.ReadonlyPaths",
    "container.Mounts",
    "container.NetworkSettings",
    "container.NetworkSettings.Networks",
    "container.NetworkSettings.Networks.none",
  ])("uses only own data descriptors at %s", (path) => {
    const records = inspection();
    const segments = path.split(".");
    const last = segments.pop();
    let target = records;
    for (const segment of segments) target = target[segment];
    const { proxy, reads } = changingReads(target[last]);
    target[last] = proxy;
    expect(inspect(records)).toEqual({ status: "matched", containerId: CONTAINER_ID });
    expect(reads).not.toHaveBeenCalled();
  });

  it.each([
    [10, "matched"],
    [11, "rejected"],
  ] as const)(
    "bounds nested depth when the informational payload contains %s child edges",
    (edges, status) => {
      const records = inspection();
      // Image starts at depth 0; Config and Information occupy depths 1 and 2.
      let value = {};
      for (let edge = 0; edge < edges; edge += 1) value = { child: value };
      records.image.Config.Information = value;
      expect(inspect(records).status).toBe(status);
    },
  );

  it.each([
    [227, "matched"],
    [228, "rejected"],
  ] as const)(
    "bounds total snapshot nodes at exactly 4096 with a final row of %s scalar values",
    (tail, status) => {
      const records = inspection();
      // The literal image fixture contains 12 nodes; payload adds one outer array,
      // sixteen row arrays, fifteen times 256 scalar values, and the tail row.
      records.image.Config.Information = [
        ...Array.from({ length: 15 }, () => Array.from({ length: 256 }, () => "x")),
        Array.from({ length: tail }, () => "x"),
      ];
      expect(inspect(records).status).toBe(status);
    },
  );

  it.each([
    ["oversized string", () => "x".repeat(8_193)],
    ["oversized array", () => Array.from({ length: 257 }, () => "x")],
    [
      "oversized object",
      () => Object.fromEntries(Array.from({ length: 129 }, (_, index) => [`entry-${index}`, "x"])),
    ],
    ["non-finite NaN", () => Number.NaN],
    ["non-finite infinity", () => Number.POSITIVE_INFINITY],
    ["non-finite negative infinity", () => Number.NEGATIVE_INFINITY],
    ["bigint", () => 1n],
    ["symbol value", () => Symbol("fixture")],
    ["function value", () => () => PRIVATE_VALUE],
    ["custom prototype", () => Object.create({ hidden: true })],
    ["symbol property", () => ({ [Symbol("fixture")]: "x" })],
    [
      "hidden property",
      () => Object.defineProperty({}, "hidden", { value: PRIVATE_VALUE, enumerable: false }),
    ],
    [
      "accessor property",
      () =>
        Object.defineProperty({}, "value", {
          get() {
            throw new Error(PRIVATE_VALUE);
          },
          enumerable: true,
        }),
    ],
    ["sparse array", () => new Array(2)],
    [
      "hidden array index",
      () => Object.defineProperty(["x"], "0", { value: "x", enumerable: false }),
    ],
    [
      "excess aggregate nodes",
      () => Array.from({ length: 17 }, () => Array.from({ length: 256 }, () => "x")),
    ],
    [
      "excess depth",
      () => {
        let value = {};
        for (let depth = 0; depth < 13; depth += 1) value = { child: value };
        return value;
      },
    ],
    [
      "object cycle",
      () => {
        const value = {};
        value.self = value;
        return value;
      },
    ],
    [
      "array cycle",
      () => {
        const value = [];
        value.push(value);
        return value;
      },
    ],
  ])(
    "rejects %s even in informational data that policy otherwise ignores",
    (_name, createValue) => {
      const records = inspection();
      records.image.Config.Information = createValue();
      const result = inspect(records);
      expect(result.status).toBe("rejected");
      expect(Object.keys(result).sort()).toEqual(["reason", "status"]);
      expect(JSON.stringify(result)).not.toContain(PRIVATE_VALUE);
    },
  );

  it.each([
    ["exact string length", () => "x".repeat(8_192)],
    ["exact array length", () => Array.from({ length: 256 }, () => "x")],
    [
      "exact object field count",
      () => Object.fromEntries(Array.from({ length: 128 }, (_, index) => [`entry-${index}`, "x"])),
    ],
    [
      "bounded aggregate nodes",
      () => Array.from({ length: 8 }, () => Array.from({ length: 256 }, () => "x")),
    ],
    [
      "bounded nested depth",
      () => {
        let value = {};
        for (let depth = 0; depth < 6; depth += 1) value = { child: value };
        return value;
      },
    ],
    ["undefined informational value", () => undefined],
    ["finite numbers", () => [0, -1, 1.5, Number.MAX_VALUE]],
  ])("accepts %s without reporting raw informational data", (_name, createValue) => {
    const records = inspection();
    records.image.Config.Information = createValue();
    expect(inspect(records)).toEqual({ status: "matched", containerId: CONTAINER_ID });
  });
});
