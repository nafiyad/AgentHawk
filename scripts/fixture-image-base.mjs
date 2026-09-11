import { createHash } from "node:crypto";

const FLAGS = Object.freeze({
  layersVerified: false,
  imagePrepared: false,
  executed: false,
  isolated: false,
  portableRuntime: false,
  nativeSupport: false,
});
const MANIFEST_SIZE = 2493;
const MANIFEST_DIGEST = "sha256:9137a20e25879e0b557227b57e3ee4e9af4bde29eb3db66134cd1723e84f830b";
const CONFIG_SIZE = 6717;
const CONFIG_DIGEST = "sha256:aa09691f441f07a6d1f076f25470751bff882a4ba88274f3d7f9fa5af542f0ce";
const REJECTED = Object.freeze({
  schemaVersion: 1,
  status: "rejected",
  reason: "metadata_rejected",
  ...FLAGS,
});

/** @typedef {{manifestBytes: Buffer, configBytes: Buffer}} MetadataInputs */
/** @type {WeakMap<object, MetadataInputs>} */
const matchedInputs = new WeakMap();
const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = /** @type {(this: Uint8Array) => number} */ (
  /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(typedArray, "byteLength")).get
);
const backingBuffer = /** @type {(this: Uint8Array) => ArrayBufferLike} */ (
  /** @type {PropertyDescriptor} */ (Object.getOwnPropertyDescriptor(typedArray, "buffer")).get
);
const elementType = /** @type {(this: Uint8Array) => string | undefined} */ (
  /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(typedArray, Symbol.toStringTag)
  ).get
);
const arrayBufferLength = /** @type {(this: ArrayBuffer) => number} */ (
  /** @type {PropertyDescriptor} */ (
    Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")
  ).get
);
const copyBytes = Uint8Array.prototype.set;

/** @param {unknown} value @param {number} expectedSize @param {string} expectedDigest */
function snapshot(value, expectedSize, expectedDigest) {
  if (
    !ArrayBuffer.isView(value) ||
    ![Buffer.prototype, Uint8Array.prototype].includes(Object.getPrototypeOf(value))
  )
    throw new Error("metadata_rejected");
  const input = /** @type {Uint8Array} */ (value);
  if (elementType.call(input) !== "Uint8Array" || byteLength.call(input) !== expectedSize)
    throw new Error("metadata_rejected");
  // Intrinsic branding rejects SharedArrayBuffer even with a forged prototype.
  arrayBufferLength.call(/** @type {ArrayBuffer} */ (backingBuffer.call(input)));
  const bytes = Buffer.alloc(expectedSize);
  // Intrinsic typed-array copying never invokes caller iteration or byte getters.
  copyBytes.call(bytes, input);
  if (`sha256:${createHash("sha256").update(bytes).digest("hex")}` !== expectedDigest)
    throw new Error("metadata_rejected");
  return bytes;
}

/**
 * Match two reviewed exact-wire metadata documents. Complete pins bind syntax,
 * descriptors and base defaults; this is not a general OCI parser or image test.
 * @param {unknown} manifestBytes
 * @param {unknown} configBytes
 */
export function verifyFixtureImageBase(manifestBytes, configBytes) {
  try {
    const manifest = snapshot(manifestBytes, MANIFEST_SIZE, MANIFEST_DIGEST);
    const config = snapshot(configBytes, CONFIG_SIZE, CONFIG_DIGEST);
    const result = Object.freeze({
      schemaVersion: 1,
      status: "matched_metadata",
      manifestDigest: MANIFEST_DIGEST,
      configDigest: CONFIG_DIGEST,
      declaredLayerCount: 8,
      declaredCompressedBytes: 409613156,
      ...FLAGS,
    });
    // Only both copied documents matching the compiled pins can mint evidence.
    matchedInputs.set(result, { manifestBytes: manifest, configBytes: config });
    return result;
  } catch {
    return REJECTED;
  }
}

/**
 * Copied metadata evidence only. This does not authorize preparation or launch.
 * WeakMap lookup does not inspect caller properties, proxies or serialized fields.
 * @param {unknown} result
 * @returns {Readonly<MetadataInputs> | undefined}
 */
export function fixtureImageBaseInputs(result) {
  const inputs = matchedInputs.get(/** @type {object} */ (result));
  if (!inputs) return undefined;
  return Object.freeze({
    manifestBytes: Buffer.from(inputs.manifestBytes),
    configBytes: Buffer.from(inputs.configBytes),
  });
}
