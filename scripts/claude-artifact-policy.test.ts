import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import * as policyModule from "./claude-artifact-policy.mjs";

const {
  CLAUDE_ARTIFACT_POLICY: policy,
  verifyClaudeManifest,
  verifyClaudeGpgStatus,
} = policyModule;
const FINGERPRINT = "31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE";
const CREATED = 1787440734;
const NOW = Date.parse("2026-09-05T03:00:00Z");
const PRIVATE_TEXT = "fixture-private-sentinel-not-for-output";
const manifest = readFileSync(new URL("./fixtures/claude-2.1.241-manifest.txt", import.meta.url));
const validFields = [
  FINGERPRINT,
  "2026-08-22",
  String(CREATED),
  "0",
  "4",
  "0",
  "1",
  "10",
  "00",
  FINGERPRINT,
];
const good = `GOODSIG ${FINGERPRINT.slice(-16)} Claude Code Release Signing`;
const valid = `VALIDSIG ${validFields.join(" ")}`;
const minimal = ["NEWSIG", good, valid];
const observed = [
  "NEWSIG",
  `KEY_CONSIDERED ${FINGERPRINT} 0`,
  `SIG_ID Zml4dHVyZS1vbmx5LXNpZ25hdHVyZS1pZA 2026-08-22 ${CREATED}`,
  `KEY_CONSIDERED ${FINGERPRINT} 0`,
  good,
  valid,
  `KEY_CONSIDERED ${FINGERPRINT} 0`,
  "TRUST_UNDEFINED 0 pgp",
];

function status(lines = minimal, newline = "\n") {
  return Buffer.from(`${lines.map((line) => `[GNUPG:] ${line}`).join(newline)}${newline}`);
}

function replaceValid(index: number, replacement: string) {
  const fields = [...validFields];
  fields[index] = replacement;
  return status(["NEWSIG", good, `VALIDSIG ${fields.join(" ")}`]);
}

describe("fixed Claude artifact policy", () => {
  it("exports only fixed pins and two pure boolean validators", () => {
    expect(Object.keys(policyModule).sort()).toEqual([
      "CLAUDE_ARTIFACT_POLICY",
      "verifyClaudeGpgStatus",
      "verifyClaudeManifest",
    ]);
    expect(Object.keys(policy)).toEqual([
      "version",
      "platform",
      "signingFingerprint",
      "manifest",
      "signature",
      "key",
      "dearmoredKey",
      "binary",
    ]);
    expect(policy.version).toBe("2.1.241");
    expect(policy.platform).toBe("linux-x64");
    expect(policy.signingFingerprint).toBe(FINGERPRINT);
  });

  const records = [
    [
      "manifest",
      "manifest.json",
      "https://downloads.claude.ai/claude-code-releases/2.1.241/manifest.json",
      1923,
      "8e2c930ddd0034b799f83212f5b1ccf6314a43e4a3eb9cd476c4751ffc1a8a66",
    ],
    [
      "signature",
      "manifest.json.sig",
      "https://downloads.claude.ai/claude-code-releases/2.1.241/manifest.json.sig",
      833,
      "35a2a7b723913aaa2f078347888ba7c0d47eb6572a0549f168af0f811061fbfe",
    ],
    [
      "key",
      "claude-code.asc",
      "https://downloads.claude.ai/keys/claude-code.asc",
      1688,
      "bd70a5e4a268002704024ceba7f8446024114e94f3f0bdd11c23a9e592be81c6",
    ],
    [
      "dearmoredKey",
      "public-key.gpg",
      undefined,
      1188,
      "0e122272125dd4bed96be0034cd95c84e9db07b4cf9bcddbe7c3ae01f3580646",
    ],
    [
      "binary",
      "claude",
      "https://downloads.claude.ai/claude-code-releases/2.1.241/linux-x64/claude",
      342636848,
      "0771bd866cff82b76581fc0499f6529e1a36845078f144f8c81dccb3bc7037b8",
    ],
  ] as const;

  it.each(records)("pins the exact %s input", (name, file, url, size, sha256) => {
    expect(policy[name]).toStrictEqual({ file, ...(url ? { url } : {}), size, sha256 });
    expect(Object.isFrozen(policy[name])).toBe(true);
  });

  it("freezes every policy field against mutation or new overrides", () => {
    expect(Object.isFrozen(policy)).toBe(true);
    expect(Reflect.set(policy, "version", "latest")).toBe(false);
    expect(Reflect.defineProperty(policy, "skipVerification", { value: true })).toBe(false);
    for (const [name] of records) {
      expect(Reflect.set(policy[name], "sha256", "0".repeat(64))).toBe(false);
      expect(Reflect.deleteProperty(policy[name], "size")).toBe(false);
    }
    expect(verifyClaudeManifest(manifest)).toBe(true);
  });
});

describe("exact Claude manifest bytes", () => {
  it("accepts the pinned public manifest, not a fabricated metadata assertion", () => {
    expect(manifest.length).toBe(1923);
    expect(createHash("sha256").update(manifest).digest("hex")).toBe(policy.manifest.sha256);
    expect(verifyClaudeManifest(manifest)).toBe(true);
    expect(verifyClaudeManifest(new Uint8Array(manifest))).toBe(true);
    expect(verifyClaudeManifest(JSON.parse(manifest.toString("utf8")))).toBe(false);
  });

  it("accepts exact bounded views without hashing unrelated backing-buffer bytes", () => {
    const surrounding = Buffer.concat([Buffer.from(PRIVATE_TEXT), manifest, Buffer.from("tail")]);
    expect(
      verifyClaudeManifest(surrounding.subarray(PRIVATE_TEXT.length, PRIVATE_TEXT.length + 1923)),
    ).toBe(true);
  });

  it.each([
    ["version", "2.1.241", "2.1.242"],
    ["platform", '"linux-x64":', '"linux-xxx":'],
    ["binary", '"binary": "claude"', '"binary": "clauXX"'],
    ["size", "342636848", "342636849"],
    ["checksum", policy.binary.sha256, "0".repeat(64)],
    ["unselected platform", "325055632", "325055633"],
    ["whitespace", '  "version"', '\t "version"'],
    ["malformed JSON", '"version"', '"version:'],
  ])("rejects same-length %s mutation", (_name, before, after) => {
    const changed = Buffer.from(manifest.toString("utf8").replace(before, after));
    expect(changed.length).toBe(1923);
    expect(verifyClaudeManifest(changed)).toBe(false);
  });

  it.each([
    ["truncated", manifest.subarray(0, -1)],
    ["appended", Buffer.concat([manifest, Buffer.from("\n")])],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), manifest])],
    ["CRLF", Buffer.from(manifest.toString("utf8").replaceAll("\n", "\r\n"))],
    ["reformatted", Buffer.from(JSON.stringify(JSON.parse(manifest.toString("utf8"))))],
    ["empty", Buffer.alloc(0)],
    ["invalid UTF-8", Buffer.alloc(1923, 0xff)],
    ["oversized", Buffer.alloc(1924)],
  ])("rejects %s bytes", (_name, bytes) => {
    expect(verifyClaudeManifest(bytes)).toBe(false);
  });
});

describe("byte-input boundary shared by both validators", () => {
  it.each([
    ["undefined", undefined],
    ["null", null],
    ["string", PRIVATE_TEXT],
    ["number", 1923],
    ["boolean", false],
    ["object", { length: 1923 }],
    ["array", [...manifest]],
    ["array buffer", new ArrayBuffer(1923)],
    ["data view", new DataView(new ArrayBuffer(1923))],
    ["wide typed array", new Uint16Array(1923)],
    ["unsigned clamped", new Uint8ClampedArray(1923)],
    ["shared buffer", new Uint8Array(new SharedArrayBuffer(1923))],
  ])("rejects %s without coercing it", (_name, input) => {
    expect(verifyClaudeManifest(input)).toBe(false);
    expect(verifyClaudeGpgStatus(input, 0, NOW)).toBe(false);
  });

  it("does not call getter, iterator, coercion, or proxy traps", () => {
    const trap = vi.fn(() => {
      throw new Error(PRIVATE_TEXT);
    });
    const input = {
      get byteLength() {
        return trap();
      },
      [Symbol.iterator]: trap,
      toString: trap,
    };
    const proxy = new Proxy(new Uint8Array(manifest), { getPrototypeOf: trap, get: trap });
    const revoked = Proxy.revocable(new Uint8Array(manifest), {});
    revoked.revoke();
    for (const bytes of [input, proxy, revoked.proxy]) {
      expect(verifyClaudeManifest(bytes)).toBe(false);
      expect(verifyClaudeGpgStatus(bytes, 0, NOW)).toBe(false);
    }
    expect(trap).not.toHaveBeenCalled();
  });

  it("uses typed-array intrinsic lengths and buffer, not shadowing accessors", () => {
    const bytes = new Uint8Array(manifest);
    const trap = vi.fn(() => {
      throw new Error(PRIVATE_TEXT);
    });
    for (const property of ["buffer", "byteLength", "byteOffset", "length", Symbol.iterator]) {
      Object.defineProperty(bytes, property, { get: trap });
    }
    expect(verifyClaudeManifest(bytes)).toBe(true);
    expect(trap).not.toHaveBeenCalled();
  });

  it("rejects detached buffers and custom typed-array prototypes", () => {
    const detached = new Uint8Array(manifest);
    structuredClone(detached, { transfer: [detached.buffer] });
    expect(verifyClaudeManifest(detached)).toBe(false);
    class CustomBytes extends Uint8Array {}
    expect(verifyClaudeManifest(new CustomBytes(manifest))).toBe(false);
  });
});

describe("closed GPG signature status evidence", () => {
  it.each([
    ["minimal", minimal],
    ["observed benign metadata", observed],
    ["no trust model field", [...minimal, "TRUST_UNDEFINED 0"]],
    ["full GOODSIG fingerprint", ["NEWSIG", `GOODSIG ${FINGERPRINT} Signing identity`, valid]],
    [
      "bounded repeated key observations",
      ["NEWSIG", ...Array(16).fill(`KEY_CONSIDERED ${FINGERPRINT} 0`), good, valid],
    ],
    ["maximum identity length", ["NEWSIG", `GOODSIG ${FINGERPRINT} ${"x".repeat(512)}`, valid]],
  ])("accepts %s after successful process closure", (_name, lines) => {
    expect(verifyClaudeGpgStatus(status(lines), 0, NOW)).toBe(true);
    expect(verifyClaudeGpgStatus(new Uint8Array(status(lines)), 0, NOW)).toBe(true);
  });

  it("accepts CRLF framing as well as LF without ignoring standalone CR", () => {
    expect(verifyClaudeGpgStatus(status(observed, "\r\n"), 0, NOW)).toBe(true);
    expect(verifyClaudeGpgStatus(status(observed, "\r"), 0, NOW)).toBe(false);
  });

  it.each([undefined, null, -0, 1, 2, 255, -1, 0.1, "0", false, {}, Number.NaN, Infinity])(
    "rejects unsuccessful or ambiguous process exit %s",
    (exitCode) => {
      expect(verifyClaudeGpgStatus(status(), exitCode, NOW)).toBe(false);
    },
  );

  it.each([
    undefined,
    null,
    -0,
    -1,
    1.1,
    "1788577200000",
    {},
    Number.NaN,
    Infinity,
    Number.MAX_SAFE_INTEGER,
    253402300800000,
  ])("rejects invalid current-time input %s", (nowMs) => {
    expect(verifyClaudeGpgStatus(status(), 0, nowMs)).toBe(false);
  });

  const adverse = [
    "BADSIG",
    "ERRSIG",
    "EXPSIG",
    "EXPKEYSIG",
    "REVKEYSIG",
    "KEYEXPIRED",
    "KEYREVOKED",
    "NO_PUBKEY",
    "ERROR",
    "FAILURE",
    "NODATA",
    "BADARMOR",
    "UNEXPECTED",
    "TRUNCATED",
    "TRUST_NEVER",
    "TRUST_FULLY",
    "TRUST_ULTIMATE",
    "TRUST_MARGINAL",
    "IMPORT_OK",
    "DECRYPTION_OKAY",
    "ASSERT_SIGNER",
    "UNKNOWN_FUTURE_STATUS",
  ];
  it.each(adverse)("never clears %s with subsequent valid-looking records", (tag) => {
    for (const index of [0, 1, 2, 3]) {
      const lines = [...minimal];
      lines.splice(index, 0, `${tag} ${PRIVATE_TEXT}`);
      expect(verifyClaudeGpgStatus(status(lines), 0, NOW)).toBe(false);
    }
  });

  it.each([
    ["missing NEWSIG", [good, valid]],
    ["missing GOODSIG", ["NEWSIG", valid]],
    ["missing VALIDSIG", ["NEWSIG", good]],
    ["no signature", ["NEWSIG"]],
    ["reordered", ["NEWSIG", valid, good]],
    ["multiple signatures", [...minimal, ...minimal]],
    ["duplicate GOODSIG", ["NEWSIG", good, good, valid]],
    ["duplicate VALIDSIG", [...minimal, valid]],
    ["late NEWSIG", [...minimal, "NEWSIG"]],
    ["NEWSIG fields", ["NEWSIG extra", good, valid]],
    ["key before NEWSIG", [`KEY_CONSIDERED ${FINGERPRINT} 0`, ...minimal]],
    ["extra valid fields", ["NEWSIG", good, `${valid} extra`]],
    ["missing valid primary", ["NEWSIG", good, `VALIDSIG ${validFields.slice(0, -1).join(" ")}`]],
    ["missing GOODSIG identity", ["NEWSIG", `GOODSIG ${FINGERPRINT}`, valid]],
    ["empty GOODSIG identity", ["NEWSIG", `GOODSIG ${FINGERPRINT} `, valid]],
    ["false key prefix without separator", ["NEWSIG", `GOODSIG ${FINGERPRINT}X`, valid]],
    ["long GOODSIG identity", ["NEWSIG", `GOODSIG ${FINGERPRINT} ${"x".repeat(513)}`, valid]],
    ["wrong GOODSIG key", ["NEWSIG", `GOODSIG ${"A".repeat(40)} identity`, valid]],
    ["short GOODSIG key", ["NEWSIG", "GOODSIG 1A7ECACE identity", valid]],
    ["lowercase GOODSIG key", ["NEWSIG", `GOODSIG ${FINGERPRINT.toLowerCase()} identity`, valid]],
    ["missing considered flag", ["NEWSIG", `KEY_CONSIDERED ${FINGERPRINT}`, good, valid]],
    ["different considered key", ["NEWSIG", `KEY_CONSIDERED ${"A".repeat(40)} 0`, good, valid]],
    ["unselected considered key", ["NEWSIG", `KEY_CONSIDERED ${FINGERPRINT} 1`, good, valid]],
    ["revoked considered subkeys", ["NEWSIG", `KEY_CONSIDERED ${FINGERPRINT} 2`, good, valid]],
    [
      "excess key observations",
      ["NEWSIG", ...Array(17).fill(`KEY_CONSIDERED ${FINGERPRINT} 0`), good, valid],
    ],
    ["premature trust", ["NEWSIG", "TRUST_UNDEFINED 0 pgp", good, valid]],
    ["repeated trust", [...minimal, "TRUST_UNDEFINED 0", "TRUST_UNDEFINED 0"]],
    ["trust error", [...minimal, "TRUST_UNDEFINED 1 pgp"]],
    ["trust override", [...minimal, "TRUST_UNDEFINED 0 always"]],
    ["trust extra fields", [...minimal, "TRUST_UNDEFINED 0 pgp extra"]],
  ])("rejects %s", (_name, lines) => {
    expect(verifyClaudeGpgStatus(status(lines), 0, NOW)).toBe(false);
  });

  it.each([
    ["signing fingerprint", 0, "A".repeat(40)],
    ["lowercase signing fingerprint", 0, FINGERPRINT.toLowerCase()],
    ["primary fingerprint", 9, "A".repeat(40)],
    ["signature version", 4, "3"],
    ["reserved field", 5, "1"],
    ["key algorithm", 6, "22"],
    ["hash algorithm", 7, "8"],
    ["signature class", 8, "01"],
    ["mismatched date", 1, "2026-08-21"],
    ["impossible date", 1, "2026-02-31"],
    ["noncanonical date", 1, "2026-8-22"],
    ["noncanonical creation", 2, `0${CREATED}`],
    ["negative creation", 2, "-1"],
    ["fractional creation", 2, `${CREATED}.1`],
    ["exponent creation", 2, "1e9"],
    ["creation beyond date range", 2, "253402300800"],
    ["creation too long", 2, "1000000000000"],
    ["empty creation", 2, ""],
    ["invalid expiry", 3, "never"],
    ["negative expiry", 3, "-1"],
    ["noncanonical expiry", 3, "00"],
    ["expired signature", 3, String(CREATED + 1)],
  ] as const)("rejects mismatched %s", (_name, index, replacement) => {
    expect(verifyClaudeGpgStatus(replaceValid(index, replacement), 0, NOW)).toBe(false);
  });

  it("rejects future signature creation and enforces exact time boundaries", () => {
    expect(verifyClaudeGpgStatus(status(), 0, CREATED * 1000 - 1)).toBe(false);
    expect(verifyClaudeGpgStatus(status(), 0, CREATED * 1000)).toBe(true);
    expect(verifyClaudeGpgStatus(status(), 0, 0)).toBe(false);
    expect(verifyClaudeGpgStatus(status(), 0, 253402300799999)).toBe(true);
    const expiry = replaceValid(3, String(NOW / 1000));
    expect(verifyClaudeGpgStatus(expiry, 0, NOW - 1)).toBe(true);
    expect(verifyClaudeGpgStatus(expiry, 0, NOW)).toBe(false);
    expect(verifyClaudeGpgStatus(expiry, 0, NOW + 1)).toBe(false);
  });

  it.each([
    ["missing fields", "SIG_ID Zml4dHVyZQ"],
    ["invalid alphabet", `SIG_ID *** 2026-08-22 ${CREATED}`],
    ["oversized id", `SIG_ID ${"a".repeat(129)} 2026-08-22 ${CREATED}`],
    ["invalid timestamp", "SIG_ID Zml4dHVyZQ 2026-08-22 not-time"],
    ["different date", `SIG_ID Zml4dHVyZQ 2026-08-23 ${CREATED}`],
    ["different timestamp", `SIG_ID Zml4dHVyZQ 2026-08-22 ${CREATED + 1}`],
  ])("rejects signature-id %s", (_name, record) => {
    expect(verifyClaudeGpgStatus(status([...minimal, record]), 0, NOW)).toBe(false);
  });

  it("rejects duplicate signature ids even if identical", () => {
    const id = `SIG_ID Zml4dHVyZQ 2026-08-22 ${CREATED}`;
    expect(verifyClaudeGpgStatus(status([...minimal, id, id]), 0, NOW)).toBe(false);
    expect(verifyClaudeGpgStatus(status([...minimal, id]), 0, NOW)).toBe(true);
  });

  it.each([
    ["empty", Buffer.alloc(0)],
    ["oversized", Buffer.alloc(65537, 0x20)],
    ["missing newline", status().subarray(0, -1)],
    ["blank line", Buffer.concat([status(), Buffer.from("\n")])],
    ["leading blank", Buffer.concat([Buffer.from("\n"), status()])],
    ["unterminated adverse tail", Buffer.concat([status(), Buffer.from("[GNUPG:] BADSIG")])],
    ["wrong prefix", Buffer.from(status().toString("utf8").replace("[GNUPG:]", "[OTHER:]"))],
    ["stderr diagnostic", Buffer.concat([status(), Buffer.from(`gpg: ${PRIVATE_TEXT}\n`)])],
    ["NUL", Buffer.concat([status(), Buffer.from([0])])],
    ["ANSI control", Buffer.concat([status(), Buffer.from("\x1b[31m\n")])],
    ["tab separator", Buffer.from(status().toString("utf8").replace("NEWSIG", "NEWSIG\t"))],
    ["bare CR", Buffer.from(status().toString("utf8").replace("Release", "Release\rSigning"))],
    ["BOM", Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), status()])],
    ["non-ASCII", Buffer.concat([status(), Buffer.from("[GNUPG:] élève\n")])],
    ["invalid UTF-8", Buffer.concat([status(), Buffer.from([0xc3, 0x28, 0x0a])])],
    ["excess lines", status(["NEWSIG", ...Array(64).fill(`KEY_CONSIDERED ${FINGERPRINT} 0`)])],
    ["excess line bytes", status(["NEWSIG", "x".repeat(1025), good, valid])],
  ])("rejects %s framing without disclosing input", (_name, input) => {
    expect(verifyClaudeGpgStatus(input, 0, NOW)).toBe(false);
  });

  it("does not mutate bytes, disclose diagnostics, or retain state between calls", () => {
    const bytes = status(observed);
    const before = Buffer.from(bytes);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(verifyClaudeGpgStatus(bytes, 0, NOW)).toBe(true);
      expect(verifyClaudeGpgStatus(status([...minimal, `ERROR ${PRIVATE_TEXT}`]), 0, NOW)).toBe(
        false,
      );
      expect(verifyClaudeGpgStatus(status(), 0, NOW)).toBe(true);
      expect(verifyClaudeManifest(Buffer.alloc(1923, PRIVATE_TEXT))).toBe(false);
      expect(bytes).toEqual(before);
      expect(log).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      error.mockRestore();
    }
  });
});
