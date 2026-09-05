// Development-only, conditional observation summary. This module neither collects
// evidence nor authenticates assertions. A later trusted, isolated driver must
// measure every field; passing a fabricated record proves no host behavior.
const VERSION = "2.1.241";
const BINARY_SIZE = 342636848;
const BINARY_SHA256 = "0771bd866cff82b76581fc0499f6529e1a36845078f144f8c81dccb3bc7037b8";
const TARGET = "claude-2.1.241-linux-x64-container";
const RUN_FIELDS = ["exitCode", "exchange", "clientResult", "marker", "denial"];

function result(status, reason) {
  return Object.freeze({
    schemaVersion: "1",
    target: TARGET,
    status,
    reason,
    nativeSupport: false,
  });
}

// Snapshot only a closed, shallow data record. No getters, toJSON, coercion, or
// recursive traversal of input values. Null-prototype JSON-like records work too.
function record(value, fields) {
  if (value === null || typeof value !== "object") return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return undefined;
  const keys = Reflect.ownKeys(value);
  if (keys.length !== fields.length || keys.some((key) => !fields.includes(key))) return undefined;
  const snapshot = Object.create(null);
  for (const field of fields) {
    const descriptor = Object.getOwnPropertyDescriptor(value, field);
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value")) return undefined;
    snapshot[field] = descriptor.value;
  }
  return snapshot;
}

function token(value, allowed) {
  return typeof value === "string" && value.length <= 64 && allowed.includes(value);
}

function exitCode(value) {
  return (
    value === null ||
    (typeof value === "number" &&
      Number.isInteger(value) &&
      !Object.is(value, -0) &&
      value >= 0 &&
      value <= 255)
  );
}

function run(value) {
  const snapshot = record(value, RUN_FIELDS);
  if (
    !snapshot ||
    !exitCode(snapshot.exitCode) ||
    !token(snapshot.exchange, ["complete", "incomplete", "unproven", "failed"]) ||
    !token(snapshot.clientResult, ["reported_result", "reported_error", "unproven", "failed"]) ||
    !token(snapshot.marker, ["created", "absent", "unproven", "failed"]) ||
    !token(snapshot.denial, ["absent", "agenthawk_emergency", "unproven", "failed"])
  ) {
    return undefined;
  }
  return snapshot;
}

/**
 * Reduce trusted measurements, not vendor text, into a fixed redacted result.
 *
 * Closed input records: artifact, containment, positive, negative, lifecycle,
 * cleanup. Artifact strings accept only the exact pin, "unproven", or "mismatch";
 * its size is the exact pinned integer or null (not measured). Containment accepts
 * "verified", "unproven", or "failed". Run records require exitCode (0..255 or
 * null), exchange (complete/incomplete), clientResult (reported_result/error),
 * marker (created/absent), and denial (absent/agenthawk_emergency); each run string
 * also accepts "unproven" or "failed". Lifecycle requires install="installed",
 * status="ready", remove="removed", each also accepting "unproven" or "failed".
 * Cleanup requires processes="quiescent" (or running) and container="removed"
 * (or present), each also accepting "unproven" or "failed".
 *
 * All fields are mandatory. Unknown fields/values/types invalidate the record;
 * declared failures and incomplete measurements never yield "observed". This
 * function does not establish signature validity, containment, hook activation,
 * or cleanup independently. Even "observed" is conditional, not native support.
 *
 * @param {unknown} value
 */
export function summarizeClaudeHostEvidence(value) {
  try {
    const input = record(value, [
      "artifact",
      "containment",
      "positive",
      "negative",
      "lifecycle",
      "cleanup",
    ]);
    if (!input) return result("invalid", "invalid_evidence");
    const artifact = record(input.artifact, ["version", "size", "sha256"]);
    const positive = run(input.positive);
    const negative = run(input.negative);
    const lifecycle = record(input.lifecycle, ["install", "status", "remove"]);
    const cleanup = record(input.cleanup, ["processes", "container"]);
    if (
      !artifact ||
      !token(artifact.version, [VERSION, "unproven", "mismatch"]) ||
      !(artifact.size === BINARY_SIZE || artifact.size === null) ||
      !token(artifact.sha256, [BINARY_SHA256, "unproven", "mismatch"]) ||
      !token(input.containment, ["verified", "unproven", "failed"]) ||
      !positive ||
      !negative ||
      !lifecycle ||
      !token(lifecycle.install, ["installed", "unproven", "failed"]) ||
      !token(lifecycle.status, ["ready", "unproven", "failed"]) ||
      !token(lifecycle.remove, ["removed", "unproven", "failed"]) ||
      !cleanup ||
      !token(cleanup.processes, ["quiescent", "running", "unproven", "failed"]) ||
      !token(cleanup.container, ["removed", "present", "unproven", "failed"])
    ) {
      return result("invalid", "invalid_evidence");
    }
    if (
      artifact.version !== VERSION ||
      artifact.size !== BINARY_SIZE ||
      artifact.sha256 !== BINARY_SHA256
    ) {
      return result("incomplete", "artifact_unverified");
    }
    if (input.containment !== "verified") return result("incomplete", "containment_unverified");
    if (
      positive.exitCode !== 0 ||
      positive.exchange !== "complete" ||
      positive.clientResult !== "reported_result" ||
      positive.marker !== "created" ||
      positive.denial !== "absent"
    ) {
      return result("incomplete", "positive_unproven");
    }
    if (
      negative.exitCode !== 0 ||
      negative.exchange !== "complete" ||
      negative.clientResult !== "reported_error" ||
      negative.marker !== "absent" ||
      negative.denial !== "agenthawk_emergency"
    ) {
      return result("incomplete", "negative_unproven");
    }
    if (
      lifecycle.install !== "installed" ||
      lifecycle.status !== "ready" ||
      lifecycle.remove !== "removed"
    ) {
      return result("incomplete", "lifecycle_unproven");
    }
    if (cleanup.processes !== "quiescent" || cleanup.container !== "removed") {
      return result("incomplete", "cleanup_unconfirmed");
    }
    return result("observed", "conditional_observation");
  } catch {
    // Reflection can throw for hostile/revoked proxies. Never expose their cause.
    return result("invalid", "invalid_evidence");
  }
}
