// Development-only launch specification. This module never starts a process.
import { FIXTURE_MARKER_COMMAND, FIXTURE_MODEL } from "./claude-messages-fixture.mjs";

const PATH = "/usr/local/bin:/usr/bin:/bin";
const NAME = /^agenthawk-claude-[a-f0-9]{32}$/u;
const IMAGE = /^sha256:[a-f0-9]{64}$/u;
const ID = /^[a-f0-9]{64}$/u;
const labels = Object.freeze({ "org.agenthawk.fixture": "claude-2.1.241" });
const tmpfs = Object.freeze({
  "/work": "rw,nosuid,nodev,size=64m,mode=0700,uid=10001,gid=10001",
  "/tmp": "rw,noexec,nosuid,nodev,size=64m,mode=1777",
});
const entryArgs = Object.freeze([
  "-i",
  `PATH=${PATH}`,
  "HOME=/work/home",
  "TMPDIR=/tmp",
  "/usr/local/bin/node",
  "/opt/agenthawk/verify-claude-host.mjs",
]);

function object(value) {
  // Export boundaries supply only detached, frozen data snapshots.
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function exact(value, expected) {
  if (Array.isArray(expected)) {
    return (
      Array.isArray(value) &&
      value.length === expected.length &&
      expected.every((item, index) => exact(value[index], item))
    );
  }
  if (object(expected)) {
    return (
      object(value) &&
      Object.keys(value).length === Object.keys(expected).length &&
      Object.entries(expected).every(
        ([key, item]) => Object.hasOwn(value, key) && exact(value[key], item),
      )
    );
  }
  return value === expected;
}

function validIdentity(value) {
  return (
    object(value) &&
    Object.keys(value).length === 2 &&
    Object.hasOwn(value, "imageId") &&
    Object.hasOwn(value, "name") &&
    typeof value.imageId === "string" &&
    IMAGE.test(value.imageId) &&
    typeof value.name === "string" &&
    NAME.test(value.name)
  );
}

/** An immutable vector, not evidence that Docker has applied these settings. */
function containerCreateArgs(identity) {
  if (!validIdentity(identity)) throw new Error("Claude container identity invalid.");
  return Object.freeze([
    "create",
    "--pull",
    "never",
    "--name",
    identity.name,
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
    `PATH=${PATH}`,
    "--label",
    "org.agenthawk.fixture=claude-2.1.241",
    "--tmpfs",
    `/work:${tmpfs["/work"]}`,
    "--tmpfs",
    `/tmp:${tmpfs["/tmp"]}`,
    "--entrypoint",
    "/usr/bin/env",
    identity.imageId,
    ...entryArgs,
  ]);
}

// A closed HostConfig profile: unknown fields are rejected until reviewed against
// the daemon API. Null and empty collections are not interchangeable here.
const hostConfig = Object.freeze({
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
  Tmpfs: tmpfs,
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
});

/**
 * Accept only a created, never-started container matching the closed profile.
 * Caller must obtain these records independently from its trusted Docker daemon,
 * bound reads, and use the returned ID for start. No isolation is established by
 * supplying fabricated JSON. Daemon/kernel/image trust remains a prerequisite.
 */
function inspectBoundary(identity, image, container, expectedContainerId) {
  const reject = (reason) => Object.freeze({ status: "rejected", reason });
  if (
    !validIdentity(identity) ||
    typeof expectedContainerId !== "string" ||
    !ID.test(expectedContainerId)
  )
    return reject("identity_invalid");
  if (
    !object(image) ||
    image.Id !== identity.imageId ||
    image.Os !== "linux" ||
    image.Architecture !== "amd64" ||
    !object(image.Config) ||
    !exact(image.Config.Env, [`PATH=${PATH}`]) ||
    image.Config.Volumes !== null ||
    image.Config.OnBuild !== null ||
    !exact(image.Config.Healthcheck, { Test: ["NONE"] })
  )
    return reject("image_profile_mismatch");
  if (
    !object(container) ||
    container.Id !== expectedContainerId ||
    container.Image !== identity.imageId ||
    container.Name !== `/${identity.name}` ||
    container.Path !== "/usr/bin/env" ||
    !exact(container.Args, entryArgs) ||
    !object(container.State) ||
    container.State.Status !== "created" ||
    container.State.Running !== false ||
    container.State.Paused !== false ||
    container.State.Restarting !== false ||
    container.State.Dead !== false ||
    container.State.OOMKilled !== false ||
    container.State.Pid !== 0 ||
    container.State.ExitCode !== 0 ||
    container.State.Error !== "" ||
    container.RestartCount !== 0 ||
    container.State.StartedAt !== "0001-01-01T00:00:00Z" ||
    container.State.FinishedAt !== "0001-01-01T00:00:00Z"
  )
    return reject("container_identity_or_state_mismatch");
  const config = container.Config;
  if (
    !object(config) ||
    config.Image !== identity.imageId ||
    config.Hostname !== "agenthawk-fixture" ||
    config.Domainname !== "" ||
    config.User !== "10001:10001" ||
    config.WorkingDir !== "/work" ||
    !exact(config.Entrypoint, ["/usr/bin/env"]) ||
    !exact(config.Cmd, entryArgs) ||
    !exact(config.Env, [`PATH=${PATH}`]) ||
    !exact(config.Labels, labels) ||
    config.Volumes !== null ||
    config.ExposedPorts !== undefined ||
    config.Tty !== false ||
    config.OpenStdin !== false ||
    config.StdinOnce !== false ||
    config.AttachStdin !== false ||
    config.AttachStdout !== true ||
    config.AttachStderr !== true ||
    config.StopTimeout !== 5 ||
    config.StopSignal !== "SIGTERM" ||
    config.OnBuild !== null ||
    !exact(config.Healthcheck, { Test: ["NONE"] })
  )
    return reject("container_config_mismatch");
  if (!exact(container.HostConfig, hostConfig)) return reject("host_config_mismatch");
  if (
    !exact(container.Mounts, []) ||
    !object(container.NetworkSettings) ||
    !exact(container.NetworkSettings.Ports, {}) ||
    !object(container.NetworkSettings.Networks) ||
    Object.keys(container.NetworkSettings.Networks).length !== 1 ||
    !object(container.NetworkSettings.Networks.none)
  )
    return reject("mount_or_network_mismatch");
  const network = container.NetworkSettings.Networks.none;
  if (
    network.IPAddress !== "" ||
    network.Gateway !== "" ||
    network.GlobalIPv6Address !== "" ||
    network.IPv6Gateway !== "" ||
    network.MacAddress !== "" ||
    network.IPPrefixLen !== 0 ||
    network.GlobalIPv6PrefixLen !== 0 ||
    network.IPAMConfig !== null ||
    network.Links !== null ||
    network.Aliases !== null ||
    network.DriverOpts !== null
  )
    return reject("mount_or_network_mismatch");
  return Object.freeze({ status: "matched", containerId: container.Id });
}

/** Empty-parent launch environment for a later driver; never reads process.env. */
function fixtureInvocation(options) {
  if (
    !object(options) ||
    Object.keys(options).length !== 2 ||
    !Object.hasOwn(options, "origin") ||
    !Object.hasOwn(options, "capability") ||
    typeof options.origin !== "string" ||
    !/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(options.origin) ||
    Number(options.origin.split(":").at(-1)) > 65_535 ||
    typeof options.capability !== "string" ||
    !/^[a-f0-9]{64}$/u.test(options.capability)
  )
    throw new Error("Claude fixture invocation invalid.");
  return Object.freeze({
    executable: "/opt/claude/claude",
    cwd: "/work/repository",
    args: Object.freeze([
      "-p",
      "Perform the single fixed AgentHawk fixture tool call, then stop.",
      "--output-format",
      "stream-json",
      "--verbose",
      "--tools",
      "Bash",
      "--allowedTools",
      `Bash(${FIXTURE_MARKER_COMMAND})`,
      "--permission-mode",
      "dontAsk",
      "--no-session-persistence",
      "--max-turns",
      "2",
      "--model",
      FIXTURE_MODEL,
      "--setting-sources",
      "project,local",
      "--strict-mcp-config",
      "--mcp-config",
      "/work/empty-mcp.json",
      "--disable-slash-commands",
    ]),
    env: Object.freeze({
      PATH,
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
    }),
  });
}

// Capture descriptor values exactly once; ordinary reads of a Proxy can differ
// from the data it exposed during validation. Bound copies before traversing and
// never invoke getters, get traps, coercion or serialization of supplied values.
function snapshot(input) {
  let nodes = 0;
  function copy(value, depth) {
    if (++nodes > 4096 || depth > 12) throw new Error("snapshot_invalid");
    if (value === null || value === undefined || typeof value === "boolean") return value;
    if (typeof value === "string" && value.length <= 8192) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new Error("snapshot_invalid");
    const array = Array.isArray(value);
    const prototype = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) {
      throw new Error("snapshot_invalid");
    }
    const keys = Reflect.ownKeys(value);
    if (
      keys.length > (array ? 257 : 128) ||
      keys.some((key) => typeof key !== "string" || key.length > 8192)
    ) {
      throw new Error("snapshot_invalid");
    }
    const descriptors = Object.create(null);
    for (const key of keys) descriptors[key] = Object.getOwnPropertyDescriptor(value, key);
    if (array) {
      const length = descriptors.length?.value;
      if (
        !Number.isSafeInteger(length) ||
        length < 0 ||
        length > 256 ||
        keys.length !== length + 1
      ) {
        throw new Error("snapshot_invalid");
      }
      const output = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
          throw new Error("snapshot_invalid");
        }
        output.push(copy(descriptor.value, depth + 1));
      }
      return Object.freeze(output);
    }
    const output = Object.create(null);
    for (const key of keys) {
      const descriptor = descriptors[key];
      if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) {
        throw new Error("snapshot_invalid");
      }
      output[key] = copy(descriptor.value, depth + 1);
    }
    return Object.freeze(output);
  }
  return copy(input, 0);
}

// Reflection of a hostile/revoked proxy may throw. Never forward its exception.
export function buildClaudeContainerCreateArgs(identity) {
  try {
    return containerCreateArgs(snapshot(identity));
  } catch {
    throw new Error("Claude container identity invalid.");
  }
}

export function inspectClaudeContainerBoundary(identity, image, container, expectedContainerId) {
  try {
    return inspectBoundary(
      snapshot(identity),
      snapshot(image),
      snapshot(container),
      snapshot(expectedContainerId),
    );
  } catch {
    return Object.freeze({ status: "rejected", reason: "inspection_invalid" });
  }
}

export function buildClaudeFixtureInvocation(options) {
  try {
    return fixtureInvocation(snapshot(options));
  } catch {
    throw new Error("Claude fixture invocation invalid.");
  }
}
