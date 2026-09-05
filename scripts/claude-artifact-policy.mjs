import { createHash } from "node:crypto";

// Development-only pins authenticated during ADR 0020 research. Preparation must
// verify them again; these constants neither execute nor authorize an artifact.
const RELEASE = "https://downloads.claude.ai/claude-code-releases/2.1.241";
const FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";

export const CLAUDE_ARTIFACT_POLICY = Object.freeze({
  version: "2.1.241",
  platform: "linux-x64",
  signingFingerprint: FINGERPRINT,
  manifest: Object.freeze({
    file: "manifest.json",
    url: `${RELEASE}/manifest.json`,
    size: 1923,
    sha256: "8e2c930ddd0034b799f83212f5b1ccf6314a43e4a3eb9cd476c4751ffc1a8a66",
  }),
  signature: Object.freeze({
    file: "manifest.json.sig",
    url: `${RELEASE}/manifest.json.sig`,
    size: 833,
    sha256: "35a2a7b723913aaa2f078347888ba7c0d47eb6572a0549f168af0f811061fbfe",
  }),
  key: Object.freeze({
    file: "claude-code.asc",
    url: "https://downloads.claude.ai/keys/claude-code.asc",
    size: 1688,
    sha256: "bd70a5e4a268002704024ceba7f8446024114e94f3f0bdd11c23a9e592be81c6",
  }),
  dearmoredKey: Object.freeze({
    file: "public-key.gpg",
    size: 1188,
    sha256: "0e122272125dd4bed96be0034cd95c84e9db07b4cf9bcddbe7c3ae01f3580646",
  }),
  binary: Object.freeze({
    file: "claude",
    url: `${RELEASE}/linux-x64/claude`,
    size: 342636848,
    sha256: "0771bd866cff82b76581fc0499f6529e1a36845078f144f8c81dccb3bc7037b8",
  }),
});

const MAX_STATUS_BYTES = 64 * 1024;
const MAX_STATUS_LINES = 64;
const MAX_STATUS_LINE = 1024;
const MAX_TIME_MS = 253402300799999; // Last millisecond in a four-digit ISO year.
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const byteLengthOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength").get;
const bufferOf = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer").get;

// Read intrinsic typed-array fields, never caller getters/iterators/coercions.
// Copy once so decoding and hashing consume the same bounded, unshared bytes.
function snapshotBytes(value, maximum) {
  if (!ArrayBuffer.isView(value)) return undefined;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Uint8Array.prototype && prototype !== Buffer.prototype) return undefined;
  const length = byteLengthOf.call(value);
  if (length === 0 || length > maximum) return undefined;
  if (!(bufferOf.call(value) instanceof ArrayBuffer)) return undefined;
  const copy = Buffer.alloc(length);
  Uint8Array.prototype.set.call(copy, value);
  return copy;
}

/** Accept only the reviewed complete manifest bytes and their selected target. */
export function verifyClaudeManifest(bytes) {
  const snapshot = snapshotBytes(bytes, CLAUDE_ARTIFACT_POLICY.manifest.size);
  if (!snapshot || snapshot.length !== CLAUDE_ARTIFACT_POLICY.manifest.size) return false;
  if (
    createHash("sha256").update(snapshot).digest("hex") !== CLAUDE_ARTIFACT_POLICY.manifest.sha256
  ) {
    return false;
  }
  // Hash equality above pins the complete, already reviewed UTF-8/JSON grammar.
  // The tuple also guards against accidentally inconsistent compiled target pins.
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(snapshot));
  const platform = manifest.platforms[CLAUDE_ARTIFACT_POLICY.platform];
  return (
    JSON.stringify([manifest.version, platform.binary, platform.size, platform.checksum]) ===
    JSON.stringify([
      CLAUDE_ARTIFACT_POLICY.version,
      CLAUDE_ARTIFACT_POLICY.binary.file,
      CLAUDE_ARTIFACT_POLICY.binary.size,
      CLAUDE_ARTIFACT_POLICY.binary.sha256,
    ])
  );
}

function timestamp(value) {
  return /^(?:0|[1-9][0-9]{0,11})$/.test(value) && Number(value) <= 253402300799;
}

function validSignature(fields, nowMs) {
  if (fields.length !== 10) return false;
  const [signer, date, created, expires, version, reserved, algorithm, hash, kind, primary] =
    fields;
  if (
    signer !== FINGERPRINT ||
    primary !== FINGERPRINT ||
    version !== "4" ||
    reserved !== "0" ||
    algorithm !== "1" ||
    hash !== "10" ||
    kind !== "00"
  ) {
    return false;
  }
  if (!timestamp(created) || !timestamp(expires)) return false;
  const createdMs = Number(created) * 1000;
  if (createdMs > nowMs || new Date(createdMs).toISOString().slice(0, 10) !== date) return false;
  return expires === "0" || Number(expires) * 1000 > nowMs;
}

/**
 * Check one trusted GPG invocation's bounded machine-status stdout after closure.
 * This parser does no cryptography itself. The caller must bind that process to
 * the pinned key/signature/manifest, check stderr bounds, and confirm quiescence.
 * Unknown status records fail closed intentionally, unlike a general GPG client.
 */
export function verifyClaudeGpgStatus(stdoutBytes, exitCode, nowMs) {
  if (
    exitCode !== 0 ||
    Object.is(exitCode, -0) ||
    !Number.isSafeInteger(nowMs) ||
    nowMs < 0 ||
    Object.is(nowMs, -0) ||
    nowMs > MAX_TIME_MS
  ) {
    return false;
  }
  const snapshot = snapshotBytes(stdoutBytes, MAX_STATUS_BYTES);
  if (!snapshot) return false;
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(snapshot);
  } catch {
    return false;
  }
  if (!text.endsWith("\n") || /[^\x20-\x7e\r\n]/.test(text)) return false;
  const normalized = text.replaceAll("\r\n", "\n");
  if (normalized.includes("\r")) return false;
  const lines = normalized.slice(0, -1).split("\n");
  if (lines.length > MAX_STATUS_LINES) return false;
  let stage = 0;
  let considered = 0;
  let trusted = false;
  let signature;
  let signatureId;
  for (const line of lines) {
    if (line.length > MAX_STATUS_LINE || !line.startsWith("[GNUPG:] ")) return false;
    const record = line.slice(9);
    const [tag, ...fields] = record.split(" ");
    if (tag === "NEWSIG") {
      if (stage !== 0 || fields.length !== 0) return false;
      stage = 1;
    } else if (stage === 0) {
      return false;
    } else if (tag === "KEY_CONSIDERED") {
      if (fields.length !== 2 || fields[0] !== FINGERPRINT || fields[1] !== "0") return false;
      if (++considered > 16) return false;
    } else if (tag === "SIG_ID") {
      if (
        signatureId ||
        fields.length !== 3 ||
        !/^[A-Za-z0-9+/]{1,128}={0,2}$/.test(fields[0]) ||
        !timestamp(fields[2])
      ) {
        return false;
      }
      signatureId = fields;
    } else if (tag === "GOODSIG") {
      const identity = record.slice(8);
      const separator = identity.indexOf(" ");
      const key = identity.slice(0, separator);
      const username = identity.slice(separator + 1);
      if (
        stage !== 1 ||
        separator === -1 ||
        (key !== FINGERPRINT.slice(-16) && key !== FINGERPRINT) ||
        username.length === 0 ||
        username.length > 512
      ) {
        return false;
      }
      stage = 2;
    } else if (tag === "VALIDSIG") {
      if (stage !== 2 || !validSignature(fields, nowMs)) return false;
      signature = fields;
      stage = 3;
    } else if (tag === "TRUST_UNDEFINED") {
      if (
        stage !== 3 ||
        trusted ||
        (record !== "TRUST_UNDEFINED 0" && record !== "TRUST_UNDEFINED 0 pgp")
      ) {
        return false;
      }
      trusted = true;
    } else {
      // This includes all adverse statuses, even after a valid-looking prefix.
      return false;
    }
  }
  if (stage !== 3) return false;
  return !signatureId || (signatureId[1] === signature[1] && signatureId[2] === signature[2]);
}
