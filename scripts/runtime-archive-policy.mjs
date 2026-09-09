import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

// Development-only ADR 0021 pins. Equality is neither publisher authentication
// nor permission to extract, install, execute, or claim a portable runtime.
export const RUNTIME_ARCHIVE_POLICY = Object.freeze({
  commander: Object.freeze({
    version: "15.0.0",
    license: "MIT",
    integrity:
      "sha512-z67u4ZhzCL/Tydu1lJARtEZYWbWaN7oYLHbsuzocr6y4N6WZAagG3RQ4FW61V1/0+jImpj293XfrcYnd1qxtPg==",
    compressedBytes: 52736,
    tarBytes: 218112,
    files: 12,
    fileBytes: 207368,
    largestFile: 87647,
    main: "./index.js",
    type: "module",
    requiredFiles: Object.freeze(["index.js", "typings/index.d.ts"]),
  }),
  semver: Object.freeze({
    version: "7.8.5",
    license: "ISC",
    integrity:
      "sha512-Y7/KDsb8LjooZpwaqGyulO6DQlksgCncchHGk+sZIY4SBvUocMBEFH5Ur1fI4dV+Jvl0w6cjvucaIi40puRioA==",
    compressedBytes: 29399,
    tarBytes: 144384,
    files: 53,
    fileBytes: 101065,
    largestFile: 25669,
    main: "index.js",
    type: undefined,
    requiredFiles: Object.freeze(["index.js", "bin/semver.js"]),
  }),
  yaml: Object.freeze({
    version: "2.9.0",
    license: "ISC",
    integrity:
      "sha512-2AvhNX3mb8zd6Zy7INTtSpl1F15HW6Wnqj0srWlkKLcpYl/gMIMJiyuGq2KeI2YFxUPjdlB+3Lc10seMLtL4cA==",
    compressedBytes: 112086,
    tarBytes: 862720,
    files: 233,
    fileBytes: 685953,
    largestFile: 35551,
    main: "./dist/index.js",
    type: "commonjs",
    requiredFiles: Object.freeze([
      "dist/index.js",
      "dist/index.d.ts",
      "browser/index.js",
      "dist/util.js",
      "browser/dist/util.js",
      "bin.mjs",
    ]),
  }),
  zod: Object.freeze({
    version: "4.4.3",
    license: "MIT",
    integrity:
      "sha512-ytENFjIJFl2UwYglde2jchW2Hwm4GJFLDiSXWdTrJQBIN9Fcyp7n4DhxJEiWNAJMV1/BqWfW/kkg71UDcHJyTQ==",
    compressedBytes: 759588,
    tarBytes: 5140480,
    files: 718,
    fileBytes: 4558122,
    largestFile: 160328,
    main: "./index.cjs",
    type: "module",
    requiredFiles: Object.freeze(["index.cjs", "index.js", "index.d.cts", "src/index.ts"]),
  }),
});

const typedArray = Object.getPrototypeOf(Uint8Array.prototype);
const byteLength = Object.getOwnPropertyDescriptor(typedArray, "byteLength").get;
const backingBuffer = Object.getOwnPropertyDescriptor(typedArray, "buffer").get;
const verifiedEntries = new WeakMap();
const FAILURE = Object.freeze({
  status: "rejected",
  executed: false,
  portableRuntime: false,
  nativeSupport: false,
});

function snapshot(value, maximum) {
  if (!ArrayBuffer.isView(value) || Object.getPrototypeOf(value) !== Buffer.prototype)
    return undefined;
  const size = byteLength.call(value);
  if (size === 0 || size > maximum || !(backingBuffer.call(value) instanceof ArrayBuffer))
    return undefined;
  const result = Buffer.alloc(size);
  Uint8Array.prototype.set.call(result, value);
  return result;
}

function selectPolicy(name) {
  return typeof name === "string" && Object.hasOwn(RUNTIME_ARCHIVE_POLICY, name)
    ? RUNTIME_ARCHIVE_POLICY[name]
    : undefined;
}

function reject() {
  throw new Error("runtime_archive_rejected");
}

function zero(bytes) {
  return bytes.every((value) => value === 0);
}

function textField(bytes) {
  const end = bytes.indexOf(0);
  const text = end === -1 ? bytes : bytes.subarray(0, end);
  if ((end !== -1 && !zero(bytes.subarray(end))) || text.some((value) => value < 32 || value > 126))
    reject();
  return text.toString("ascii");
}

function octal(bytes) {
  // Base-256, signs, empty fields and embedded padding are outside this subset.
  const text = bytes.toString("latin1");
  if (!/^[0-7]+[\0 ]*$/.test(text)) reject();
  const value = Number.parseInt(text, 8);
  if (!Number.isSafeInteger(value)) reject();
  return value;
}

function filePath(name, prefix) {
  const joined = prefix ? `${prefix}/${name}` : name;
  const parts = joined.split("/");
  if (joined.length > 255 || parts.length > 16 || parts.shift() !== "package" || parts.length === 0)
    reject();
  for (const part of parts) {
    if (
      !/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(part) ||
      part.endsWith(".") ||
      /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(part) ||
      /^(?:node_modules|credentials|id_rsa|id_ed25519)$/i.test(part)
    )
      reject();
  }
  return parts.join("/");
}

function record(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function equalEntry(value, expected) {
  if (!record(expected)) return value === expected;
  return (
    record(value) &&
    JSON.stringify(Object.keys(value)) === JSON.stringify(Object.keys(expected)) &&
    Object.entries(expected).every(
      ([key, child]) => Object.hasOwn(value, key) && value[key] === child,
    )
  );
}

function validateEntrypoints(manifest, name) {
  // Only the already reviewed root selectors. The full archive hash separately
  // binds every subpath/condition, and all declared targets are checked below.
  const expected = {
    commander: { root: { types: "./typings/index.d.ts", default: "./index.js" } },
    semver: { bin: { semver: "bin/semver.js" } },
    yaml: {
      root: { types: "./dist/index.d.ts", node: "./dist/index.js", default: "./browser/index.js" },
      bin: "./bin.mjs",
    },
    zod: {
      root: {
        "@zod/source": "./src/index.ts",
        types: "./index.d.cts",
        import: "./index.js",
        require: "./index.cjs",
      },
      module: "./index.js",
    },
  }[name];
  if (!equalEntry(manifest.bin, expected.bin) || manifest.module !== expected.module) reject();
  if (expected.root) {
    if (!record(manifest.exports) || !equalEntry(manifest.exports["."], expected.root)) reject();
  } else if (Object.hasOwn(manifest, "exports")) reject();
}

function validateManifest(bytes, name, policy) {
  if (!bytes || bytes.length === 0 || bytes.length > 65536) reject();
  const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (
    !record(manifest) ||
    manifest.name !== name ||
    manifest.version !== policy.version ||
    manifest.license !== policy.license ||
    manifest.main !== policy.main ||
    manifest.type !== policy.type
  )
    reject();
  // Deliberately require absence, matching these exact reviewed manifests.
  for (const key of [
    "dependencies",
    "optionalDependencies",
    "peerDependencies",
    "bundledDependencies",
    "bundleDependencies",
  ]) {
    if (Object.hasOwn(manifest, key)) reject();
  }
  if (Object.hasOwn(manifest, "scripts")) {
    if (!record(manifest.scripts)) reject();
    for (const [key, value] of Object.entries(manifest.scripts)) {
      if (
        typeof value !== "string" ||
        [
          "preinstall",
          "install",
          "postinstall",
          "prepublish",
          "preprepare",
          "prepare",
          "postprepare",
          "prepack",
          "postpack",
        ].includes(key)
      )
        reject();
    }
  }
  validateEntrypoints(manifest, name);
  return manifest;
}

// Inspect manifest export targets as data only: no resolution or imports. For
// wildcard exports require the literal prefix directory to contain files.
function checkExportTargets(value, paths, depth = 0) {
  if (depth > 12) reject();
  if (typeof value === "string") {
    if (!value.startsWith("./")) reject();
    const target = value.slice(2);
    if (target.endsWith("/*") && !target.slice(0, -2).includes("*")) {
      filePath(`package/${target.slice(0, -2)}`, "");
      if (![...paths].some((path) => path.startsWith(target.slice(0, -1)))) reject();
    } else if (!paths.has(filePath(`package/${target}`, ""))) reject();
  } else if (record(value)) {
    for (const child of Object.values(value)) checkExportTargets(child, paths, depth + 1);
  } else reject();
}

function inspect(name, tar, policy, integrity, entries) {
  if (tar.length < 1536 || tar.length % 512 !== 0) reject();
  const files = [];
  const paths = new Set();
  const spellings = new Map();
  const directories = new Set();
  let fileBytes = 0;
  let largestFile = 0;
  let manifestBytes;
  let licensePresent = false;
  let offset = 0;
  while (offset < tar.length) {
    const header = tar.subarray(offset, offset + 512);
    if (zero(header)) {
      // The reviewed archives have exactly two complete zero end records.
      if (offset + 1024 !== tar.length || !zero(tar.subarray(offset))) reject();
      break;
    }
    if (files.length >= policy.files) reject();
    let checksum = 0;
    for (let index = 0; index < 512; index++)
      checksum += index >= 148 && index < 156 ? 32 : header[index];
    if (checksum !== octal(header.subarray(148, 156))) reject();
    if (
      header.subarray(257, 263).toString("latin1") !== "ustar\0" ||
      header[263] !== 48 ||
      header[264] !== 48
    )
      reject();
    const mode = octal(header.subarray(100, 108));
    if ((mode !== 0o644 && mode !== 0o755) || (header[156] !== 0 && header[156] !== 48)) reject();
    // npm's reviewed headers leave optional owner IDs entirely NUL-filled.
    // Missing ownership is ignored, not an authority or a numeric zero alias.
    for (const start of [108, 116]) {
      const owner = header.subarray(start, start + 8);
      if (!zero(owner)) octal(owner);
    }
    octal(header.subarray(136, 148));
    if (
      !zero(header.subarray(157, 257)) ||
      octal(header.subarray(329, 337)) !== 0 ||
      octal(header.subarray(337, 345)) !== 0 ||
      !zero(header.subarray(500))
    )
      reject();
    textField(header.subarray(265, 297));
    textField(header.subarray(297, 329));
    const path = filePath(textField(header.subarray(0, 100)), textField(header.subarray(345, 500)));
    const lower = path.toLowerCase();
    if (paths.has(path) || directories.has(lower)) reject();
    const components = path.split("/");
    for (let index = 1; index <= components.length; index++) {
      const spelling = components.slice(0, index).join("/");
      const folded = spelling.toLowerCase();
      if (
        (spellings.has(folded) && spellings.get(folded) !== spelling) ||
        (index < components.length && paths.has(spelling))
      )
        reject();
      spellings.set(folded, spelling);
      if (index < components.length) directories.add(folded);
    }
    paths.add(path);
    const size = octal(header.subarray(124, 136));
    fileBytes += size;
    largestFile = Math.max(largestFile, size);
    if (size > policy.largestFile || fileBytes > policy.fileBytes) reject();
    const start = offset + 512;
    const end = start + size;
    const paddedEnd = start + Math.ceil(size / 512) * 512;
    if (paddedEnd > tar.length - 1024 || !zero(tar.subarray(end, paddedEnd))) reject();
    const data = tar.subarray(start, end);
    entries?.push({ path, data });
    if (path === "package.json") manifestBytes = data;
    if (path === "LICENSE") licensePresent = size > 0 && data.some((value) => value > 32);
    files.push(
      Object.freeze({ path, size, mode, sha256: createHash("sha256").update(data).digest("hex") }),
    );
    offset = paddedEnd;
  }
  if (
    offset === tar.length ||
    !licensePresent ||
    policy.requiredFiles.some((path) => !paths.has(path))
  )
    reject();
  const manifest = validateManifest(manifestBytes, name, policy);
  for (const key of ["exports", "bin", "module", "types"]) {
    if (!Object.hasOwn(manifest, key)) continue;
    if (key === "exports") checkExportTargets(manifest[key], paths);
    else {
      const values =
        key === "bin" && record(manifest.bin) ? Object.values(manifest.bin) : [manifest[key]];
      for (const value of values) {
        if (
          typeof value !== "string" ||
          !paths.has(filePath(`package/${value.startsWith("./") ? value.slice(2) : value}`, ""))
        )
          reject();
      }
    }
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return Object.freeze({
    status: "inventory",
    integrity,
    name,
    version: policy.version,
    license: policy.license,
    tarBytes: tar.length,
    fileBytes,
    largestFile,
    files: Object.freeze(files),
    executed: false,
    portableRuntime: false,
    nativeSupport: false,
  });
}

/** Structural mechanics only; this entrypoint never establishes archive integrity. */
export function inspectRuntimeTar(name, bytes) {
  try {
    const policy = selectPolicy(name);
    if (!policy) return FAILURE;
    const tar = snapshot(bytes, policy.tarBytes);
    return tar ? inspect(name, tar, policy, "not_checked") : FAILURE;
  } catch {
    return FAILURE;
  }
}

/** Original compressed bytes must match the reviewed pin before decoding. */
export function verifyRuntimeArchive(name, bytes) {
  try {
    const policy = selectPolicy(name);
    if (!policy) return FAILURE;
    const archive = snapshot(bytes, policy.compressedBytes);
    if (
      !archive ||
      archive.length !== policy.compressedBytes ||
      `sha512-${createHash("sha512").update(archive).digest("base64")}` !== policy.integrity
    )
      return FAILURE;
    const tar = gunzipSync(archive, { maxOutputLength: policy.tarBytes });
    if (tar.length !== policy.tarBytes) return FAILURE;
    const entries = [];
    const result = inspect(name, tar, policy, "sha512_pin_matched", entries);
    if (
      result.files.length !== policy.files ||
      result.fileBytes !== policy.fileBytes ||
      result.largestFile !== policy.largestFile
    )
      return FAILURE;
    verifiedEntries.set(result, entries);
    return result;
  } catch {
    return FAILURE;
  }
}

/** Entry bytes are available only from this process's completely verified inventory. */
export function runtimeArchiveFiles(inventory) {
  const entries = verifiedEntries.get(inventory);
  return entries?.map(({ path, data }) => ({ path, data: Buffer.from(data) }));
}
