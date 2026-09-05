import { describe, expect, it, vi } from "vitest";

import * as evidenceModule from "./claude-host-evidence.mjs";

const { summarizeClaudeHostEvidence } = evidenceModule;
const PRIVATE_TEXT = "fixture-private-sentinel-do-not-retain";
const TARGET = "claude-2.1.241-linux-x64-container";
type RecordValue = Record<string, unknown>;

function measurements(): RecordValue {
  return {
    artifact: {
      version: "2.1.241",
      size: 342636848,
      sha256: "0771bd866cff82b76581fc0499f6529e1a36845078f144f8c81dccb3bc7037b8",
    },
    containment: "verified",
    positive: {
      exitCode: 0,
      exchange: "complete",
      clientResult: "reported_result",
      marker: "created",
      denial: "absent",
    },
    negative: {
      exitCode: 0,
      exchange: "complete",
      clientResult: "reported_error",
      marker: "absent",
      denial: "agenthawk_emergency",
    },
    lifecycle: { install: "installed", status: "ready", remove: "removed" },
    cleanup: { processes: "quiescent", container: "removed" },
  };
}

function summary(status: string, reason: string) {
  return { schemaVersion: "1", target: TARGET, status, reason, nativeSupport: false };
}

function section(input: RecordValue, key: string): RecordValue {
  return key === "root" ? input : (input[key] as RecordValue);
}

const sections = ["root", "artifact", "positive", "negative", "lifecycle", "cleanup"];
const fields = sections.flatMap((key) =>
  Object.keys(section(measurements(), key)).map((field) => [key, field] as const),
);
const leaves = fields.filter(([key, field]) => key !== "root" || field === "containment");

function expectInvalid(value: unknown) {
  expect(summarizeClaudeHostEvidence(value)).toStrictEqual(summary("invalid", "invalid_evidence"));
}

describe("Claude host evidence conditional reducer", () => {
  it("exports only a pure reducer and never promotes an observation to native support", () => {
    expect(Object.keys(evidenceModule)).toEqual(["summarizeClaudeHostEvidence"]);
    expect(summarizeClaudeHostEvidence(measurements())).toStrictEqual(
      summary("observed", "conditional_observation"),
    );
  });

  const incomplete: [string, string, unknown[], string][] = [
    ["artifact", "version", ["unproven", "mismatch"], "artifact_unverified"],
    ["artifact", "size", [null], "artifact_unverified"],
    ["artifact", "sha256", ["unproven", "mismatch"], "artifact_unverified"],
    ["root", "containment", ["unproven", "failed"], "containment_unverified"],
    ...(["positive", "negative"] as const).flatMap((key) => {
      const reason = `${key}_unproven`;
      return [
        [key, "exitCode", [null, 1, 255], reason],
        [key, "exchange", ["incomplete", "unproven", "failed"], reason],
        [
          key,
          "clientResult",
          [key === "positive" ? "reported_error" : "reported_result", "unproven", "failed"],
          reason,
        ],
        [key, "marker", [key === "positive" ? "absent" : "created", "unproven", "failed"], reason],
        [
          key,
          "denial",
          [key === "positive" ? "agenthawk_emergency" : "absent", "unproven", "failed"],
          reason,
        ],
      ] as [string, string, unknown[], string][];
    }),
    ...["install", "status", "remove"].map(
      (field) =>
        ["lifecycle", field, ["unproven", "failed"], "lifecycle_unproven"] as [
          string,
          string,
          unknown[],
          string,
        ],
    ),
    ["cleanup", "processes", ["running", "unproven", "failed"], "cleanup_unconfirmed"],
    ["cleanup", "container", ["present", "unproven", "failed"], "cleanup_unconfirmed"],
  ];

  it.each(
    incomplete.flatMap(([key, field, values, reason]) =>
      values.map((value) => ({ key, field, value, reason })),
    ),
  )("never observes $key.$field=$value", ({ key, field, value, reason }) => {
    const input = measurements();
    section(input, key)[field] = value;
    expect(summarizeClaudeHostEvidence(input)).toStrictEqual(summary("incomplete", reason));
  });

  it("requires both a denial signal and independent marker absence", () => {
    for (const denial of ["absent", "unproven", "failed"]) {
      const input = measurements();
      section(input, "negative").denial = denial;
      expect(summarizeClaudeHostEvidence(input).status).toBe("incomplete");
    }
    const input = measurements();
    section(input, "negative").marker = "created";
    expect(summarizeClaudeHostEvidence(input).status).toBe("incomplete");
  });

  it("requires all positive signals rather than accepting an independently created marker alone", () => {
    const input = measurements();
    Object.assign(section(input, "positive"), {
      exitCode: 1,
      exchange: "failed",
      denial: "unproven",
    });
    expect(summarizeClaudeHostEvidence(input)).toStrictEqual(
      summary("incomplete", "positive_unproven"),
    );
  });

  it("validates the entire schema before reporting the first fixed incomplete reason", () => {
    const input = measurements();
    section(input, "artifact").version = "unproven";
    section(input, "cleanup").processes = PRIVATE_TEXT;
    expectInvalid(input);
    section(input, "cleanup").processes = "running";
    expect(summarizeClaudeHostEvidence(input)).toStrictEqual(
      summary("incomplete", "artifact_unverified"),
    );
  });

  it.each(fields)("rejects missing %s.%s", (key, field) => {
    const input = measurements();
    delete section(input, key)[field];
    expectInvalid(input);
  });

  it.each(fields)("rejects accessors at %s.%s without invoking them", (key, field) => {
    const input = measurements();
    const getter = vi.fn(() => {
      throw new Error(PRIVATE_TEXT);
    });
    Object.defineProperty(section(input, key), field, { get: getter, enumerable: true });
    expectInvalid(input);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(fields)("rejects non-enumerable %s.%s", (key, field) => {
    const input = measurements();
    Object.defineProperty(section(input, key), field, { enumerable: false });
    expectInvalid(input);
  });

  it.each(sections)("rejects unexpected string, symbol, and hidden keys at %s", (key) => {
    for (const extra of [PRIVATE_TEXT, "__proto__", Symbol(PRIVATE_TEXT)]) {
      for (const enumerable of [true, false]) {
        const input = measurements();
        Object.defineProperty(section(input, key), extra, { value: PRIVATE_TEXT, enumerable });
        expectInvalid(input);
      }
    }
  });

  it.each(sections)("rejects non-data record types at %s", (key) => {
    for (const invalid of [null, undefined, 0, true, "", [], new Map(), new Date(), () => {}]) {
      const input = measurements();
      if (key === "root") expectInvalid(invalid);
      else {
        input[key] = invalid;
        expectInvalid(input);
      }
    }
  });

  it.each(sections)("rejects custom prototypes and inherited measurements at %s", (key) => {
    const input = measurements();
    Object.setPrototypeOf(section(input, key), { secret: PRIVATE_TEXT });
    expectInvalid(input);
    const inherited = measurements();
    const value = Object.create(section(inherited, key));
    if (key === "root") expectInvalid(value);
    else {
      inherited[key] = value;
      expectInvalid(inherited);
    }
  });

  it.each(leaves)("does not disclose, coerce, or traverse invalid %s.%s", (key, field) => {
    const coercion = vi.fn(() => {
      throw new Error(PRIVATE_TEXT);
    });
    const cycle: RecordValue = { secret: PRIVATE_TEXT };
    cycle.self = cycle;
    for (const value of [
      PRIVATE_TEXT,
      PRIVATE_TEXT.repeat(2048),
      new String(PRIVATE_TEXT),
      { toString: coercion, toJSON: coercion, [Symbol.toPrimitive]: coercion },
      cycle,
      [PRIVATE_TEXT],
      Symbol(PRIVATE_TEXT),
      undefined,
      true,
    ]) {
      const input = measurements();
      section(input, key)[field] = value;
      expectInvalid(input);
      expect(JSON.stringify(summarizeClaudeHostEvidence(input))).not.toContain(PRIVATE_TEXT);
    }
    expect(coercion).not.toHaveBeenCalled();
  });

  it.each(["positive", "negative"])("rejects noncanonical exit codes in %s", (key) => {
    for (const value of [-0, -1, 256, 0.5, Number.NaN, Number.POSITIVE_INFINITY, "0", 0n]) {
      const input = measurements();
      section(input, key).exitCode = value;
      expectInvalid(input);
    }
  });

  it("rejects wrong binaries, platforms, versions, checksum representations, and archive hashes", () => {
    for (const [field, value] of [
      ["version", "2.1.242"],
      ["version", "2.1.241-linux-x64"],
      ["size", 342636847],
      ["size", "342636848"],
      ["sha256", "0".repeat(64)],
      ["sha256", "0771BD866CFF82B76581FC0499F6529E1A36845078F144F8C81DCCB3BC7037B8"],
      ["sha256", "c49a05922a787c33478067a5164002932235f6611948523b55ae1fbdb303ac1f"],
      ["sha256", "c171011648d71b96a0956469a46315a4c826ccba7e20854ae62aa5c776d6a794"],
    ] as const) {
      const input = measurements();
      section(input, "artifact")[field] = value;
      expectInvalid(input);
    }
  });

  it.each(sections)("contains reflection exceptions at %s without disclosing causes", (key) => {
    for (const trap of ["getPrototypeOf", "ownKeys", "getOwnPropertyDescriptor"]) {
      const input = measurements();
      const value = new Proxy(section(input, key), {
        [trap]: () => {
          throw new Error(PRIVATE_TEXT);
        },
      });
      if (key === "root") expectInvalid(value);
      else {
        input[key] = value;
        expectInvalid(input);
      }
    }
  });

  it("contains revoked proxies without throwing", () => {
    const { proxy, revoke } = Proxy.revocable(measurements(), {});
    revoke();
    expectInvalid(proxy);
  });

  it("handles a missing property descriptor reported during reflection", () => {
    const input = new Proxy(measurements(), { getOwnPropertyDescriptor: () => undefined });
    expectInvalid(input);
  });

  it("accepts frozen/null-prototype records and does not retain mutable input", () => {
    const input = measurements();
    for (const key of sections) {
      const current = section(input, key);
      Object.setPrototypeOf(current, null);
      Object.freeze(current);
    }
    const before = JSON.stringify(input);
    const output = summarizeClaudeHostEvidence(input);
    expect(output).toStrictEqual(summary("observed", "conditional_observation"));
    expect(JSON.stringify(input)).toBe(before);
    const mutable = measurements();
    const original = summarizeClaudeHostEvidence(mutable);
    section(mutable, "negative").marker = "created";
    expect(original.status).toBe("observed");
    expect(summarizeClaudeHostEvidence(mutable).status).toBe("incomplete");
  });

  it("freezes every possible result and cannot contaminate later calls", () => {
    const incomplete = measurements();
    incomplete.containment = "unproven";
    for (const input of [measurements(), incomplete, undefined]) {
      const output = summarizeClaudeHostEvidence(input);
      expect(Object.isFrozen(output)).toBe(true);
      expect(Reflect.set(output, "nativeSupport", true)).toBe(false);
      expect(Reflect.set(output, "secret", PRIVATE_TEXT)).toBe(false);
      expect(Reflect.deleteProperty(output, "status")).toBe(false);
      expect(output.nativeSupport).toBe(false);
    }
    expect(summarizeClaudeHostEvidence(measurements())).toStrictEqual(
      summary("observed", "conditional_observation"),
    );
  });
});
