import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyFixtureImageBase } from "./fixture-image-base.mjs";
import { fixtureImageLayerPlan, IMAGE_METADATA } from "./fixture-image-layer-policy.mjs";
import { imageBaseMetadataFixture } from "./fixtures/image-base-metadata.mjs";

describe("fixed layer descriptors require genuine exact-wire metadata", () => {
  it("binds metadata pins and all eight ordered descriptors to original fixture bytes", () => {
    const fixture = imageBaseMetadataFixture();
    const base = verifyFixtureImageBase(fixture.manifestBytes, fixture.configBytes);
    for (const [name, bytes] of [
      ["manifest", fixture.manifestBytes],
      ["config", fixture.configBytes],
    ] as const) {
      expect(IMAGE_METADATA[name]).toEqual({
        size: bytes.length,
        digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      });
      expect(Object.isFrozen(IMAGE_METADATA[name])).toBe(true);
    }
    expect(Object.isFrozen(IMAGE_METADATA)).toBe(true);
    const plan = fixtureImageLayerPlan(base);
    expect(plan).toHaveLength(8);
    expect(plan).toEqual(
      JSON.parse(fixture.manifestBytes.toString()).layers.map(
        (entry: { digest: string; size: number }) => ({
          digest: entry.digest,
          size: entry.size,
          file: `${entry.digest.slice(7)}.blob`,
        }),
      ),
    );
    expect(plan?.reduce((sum, entry) => sum + entry.size, 0)).toBe(409613156);
    expect(Math.max(...(plan ?? []).map((entry) => entry.size))).toBe(211662335);
    expect(plan?.every((entry) => Object.isFrozen(entry))).toBe(true);
    expect(Object.isFrozen(plan)).toBe(true);
    expect(fixtureImageLayerPlan(base)).not.toBe(plan);
    fixture.manifestBytes.fill(0);
    fixture.configBytes.fill(0);
    expect(fixtureImageLayerPlan(base)).toEqual(plan);
  });
  it("rejects public summaries, rejected metadata, proxies and hostile caller properties without inspection", () => {
    const fixture = imageBaseMetadataFixture();
    const base = verifyFixtureImageBase(fixture.manifestBytes, fixture.configBytes);
    const revocable = Proxy.revocable({}, {});
    revocable.revoke();
    for (const input of [
      undefined,
      null,
      1,
      "metadata",
      {},
      { ...base },
      JSON.parse(JSON.stringify(base)),
      new Proxy(base, {}),
      revocable.proxy,
      verifyFixtureImageBase(Buffer.alloc(0), Buffer.alloc(0)),
      Object.create(base),
      Object.defineProperty({}, "layers", {
        get() {
          throw new Error("must not inspect");
        },
      }),
    ]) {
      expect(fixtureImageLayerPlan(input)).toBeUndefined();
    }
  });
});
