import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { approvalValidationReportSchema } from "@agenthawk/core";
import { describe, expect, it, vi } from "vitest";
import { verifyApprovalFile } from "../src/approvals.js";

const checkedAt = new Date("2026-08-21T15:00:00.000Z");
const records = [
  {
    ecosystem: "npm",
    name: "z-package",
    version: "1.0.0",
    approvedBy: "github:maintainer",
    approvedAt: "2026-08-21T15:00:00Z",
    expiresAt: "2026-09-21T15:00:00Z",
    reason: "Source and release reviewed.",
  },
  {
    ecosystem: "npm",
    name: "a-package",
    version: "2.0.0-beta.1",
    approvedBy: "github:maintainer",
    approvedAt: "2026-07-01T00:00:00.000Z",
    expiresAt: "2026-08-21T15:00:00.000Z",
    reason: "Prerelease reviewed.",
  },
  {
    ecosystem: "npm",
    name: "future-package",
    version: "3.0.0",
    approvedBy: "github:maintainer",
    approvedAt: "2026-09-01T00:00:00.000Z",
    expiresAt: "2026-10-01T00:00:00.000Z",
    reason: "Planned release review.",
  },
];

describe("approvals verify", () => {
  it("returns bounded time-state metadata without applying or disclosing approvals", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network must not be used");
    });
    vi.stubGlobal("fetch", fetchSpy);
    try {
      const result = await verifyApprovalFile(
        "C:/private/approvals.yml",
        { format: "json" },
        {
          now: () => checkedAt,
          readApprovals: async () => ({ version: 1, approvals: records }),
        },
      );
      const report = approvalValidationReportSchema.parse(JSON.parse(result.output));
      expect(result.exitCode).toBe(0);
      expect(report).toMatchObject({
        approvalCount: 3,
        timeEligibleCount: 1,
        expiredCount: 1,
        notYetEffectiveCount: 1,
        checkedAt: checkedAt.toISOString(),
      });
      expect(result.output).not.toContain("C:/private");
      expect(result.output).not.toContain("z-package");
      expect(result.output).not.toContain("maintainer");
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("uses a semantic digest independent of record order and timestamp precision", async () => {
    const first = await verifyApprovalFile(
      "first",
      { format: "json" },
      {
        now: () => checkedAt,
        readApprovals: async () => ({ version: 1, approvals: records }),
      },
    );
    const equivalent = records.toReversed().map((record) => ({
      ...record,
      approvedAt: new Date(record.approvedAt).toISOString(),
      expiresAt: new Date(record.expiresAt).toISOString(),
    }));
    const second = await verifyApprovalFile(
      "second",
      { format: "json" },
      {
        now: () => checkedAt,
        readApprovals: async () => ({ version: 1, approvals: equivalent }),
      },
    );
    expect(JSON.parse(first.output).approvalDigest).toBe(JSON.parse(second.output).approvalDigest);
  });

  it("renders only aggregate metadata in terminal output", async () => {
    const result = await verifyApprovalFile(
      "private.yml",
      { format: "terminal" },
      {
        now: () => checkedAt,
        readApprovals: async () => ({ version: 1, approvals: records }),
      },
    );
    expect(result.output).toContain("Approvals: valid");
    expect(result.output).toContain("No approval was applied.");
    expect(result.output).toContain("No provider was contacted.");
    expect(result.output).not.toContain("private.yml");
    expect(result.output).not.toContain("a-package");
  });

  it("loads the exact 256 KiB boundary and rejects hostile file input", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-approvals-verify-"));
    try {
      const exact = join(directory, "exact.yml");
      const prefix = "version: 1\napprovals: []\n#";
      await writeFile(exact, `${prefix}${"x".repeat(256 * 1_024 - prefix.length)}`, "utf8");
      expect(
        (await verifyApprovalFile(exact, { format: "json" }, { now: () => checkedAt })).exitCode,
      ).toBe(0);

      for (const [name, contents] of [
        ["duplicate.yml", Buffer.from("version: 1\napprovals: []\napprovals: []\n")],
        ["alias.yml", Buffer.from("version: 1\napprovals: &a []\ncopy: *a\n")],
        ["utf8.yml", Buffer.from([0xff, 0xfe])],
        ["large.yml", Buffer.alloc(256 * 1_024 + 1, 0x20)],
      ] as const) {
        const path = join(directory, name);
        await writeFile(path, contents);
        expect(
          (await verifyApprovalFile(path, { format: "json" }, { now: () => checkedAt })).exitCode,
        ).toBe(2);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("rejects final and parent symlinks plus missing and non-regular paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "agenthawk-approvals-link-"));
    try {
      const realDirectory = join(directory, "real");
      const target = join(directory, "target.yml");
      await mkdir(realDirectory);
      await writeFile(target, "version: 1\napprovals: []\n", "utf8");
      const finalLink = join(directory, "final.yml");
      await symlink(target, finalLink, "file");
      const parentLink = join(directory, "linked-parent");
      await symlink(realDirectory, parentLink, process.platform === "win32" ? "junction" : "dir");
      await writeFile(join(realDirectory, "approvals.yml"), "version: 1\napprovals: []\n", "utf8");

      for (const path of [
        finalLink,
        join(parentLink, "approvals.yml"),
        directory,
        join(directory, "missing.yml"),
      ]) {
        expect(
          (await verifyApprovalFile(path, { format: "json" }, { now: () => checkedAt })).exitCode,
        ).toBe(2);
      }
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  });

  it("redacts schema and unexpected clock diagnostics", async () => {
    const invalid = await verifyApprovalFile(
      "secret.yml",
      { format: "json" },
      {
        readApprovals: async () => ({ version: 1, approvals: [{ bypass: true }] }),
      },
    );
    const internal = await verifyApprovalFile(
      "secret.yml",
      { format: "json" },
      {
        now: () => new Date(Number.NaN),
        readApprovals: async () => ({ version: 1, approvals: [] }),
      },
    );
    expect(invalid.exitCode).toBe(2);
    expect(invalid.output).not.toContain("bypass");
    expect(internal.exitCode).toBe(4);
    expect(internal.output).not.toContain("clock");
  });
});
