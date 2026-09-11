import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import * as production from "./fixture-image-base.mjs";
import { imageBaseMetadataFixture } from "./fixtures/image-base-metadata.mjs";

const { fixtureImageBaseInputs, verifyFixtureImageBase } = production;
const MANIFEST_DIGEST = "sha256:9137a20e25879e0b557227b57e3ee4e9af4bde29eb3db66134cd1723e84f830b";
const CONFIG_DIGEST = "sha256:aa09691f441f07a6d1f076f25470751bff882a4ba88274f3d7f9fa5af542f0ce";
const FLAGS = {
  layersVerified: false,
  imagePrepared: false,
  executed: false,
  isolated: false,
  portableRuntime: false,
  nativeSupport: false,
};
const REJECTED = {
  schemaVersion: 1,
  status: "rejected",
  reason: "metadata_rejected",
  ...FLAGS,
};
const MATCHED = {
  schemaVersion: 1,
  status: "matched_metadata",
  manifestDigest: MANIFEST_DIGEST,
  configDigest: CONFIG_DIGEST,
  declaredLayerCount: 8,
  declaredCompressedBytes: 409_613_156,
  ...FLAGS,
};
const PRIVATE = "fixture-private-input-must-not-appear";
const LAYERS = [
  ["abf56b2f87242de589f03ea56779358079c07c4c099bd1e454d083538eb6666d", 48_497_362],
  ["08457856946d74c8aede7d750e185d1e479a79b8123d1b805182a580d224a6e2", 24_056_247],
  ["8cab6ce149c24516f80b26a762b6b9aaebcaf4fbe51d4c6844af7d7dbc372f2d", 64_413_065],
  ["01a6a9ffe665b63ea18491fedb646423413ae3fdefcf7776ee25a2eaff8a673e", 211_662_335],
  ["1252dbc77c173ad14ada4b3011a358999485a2468f5a881b8da6b18295f4c1e1", 3_327],
  ["fc43bb6c3dac23ba1c5d43e9f7557ddba1efabe98f8447d50defe5b307109172", 59_729_700],
  ["753c789c519899755b1a7d932c7063079f3eee959f27f9680a1f65159f5c2be1", 1_250_673],
  ["e5a74028d13202c370e3ff67d121de73d28ab38a9c35ad9bc91fb40f43883522", 447],
] as const;
const DIFF_IDS = [
  "cd482426e5675a31e31f2bddad58815b83b309a587bf56b46a308586d9fd6eb5",
  "ffc8aa3c6d1eee538ec70f1c9d749b8bebe8f016bfd4b16ee45c623c9cffa402",
  "74a032b83597c9456f0d3bc320e33b56a52127ce0027d313a80e31a32ab99a42",
  "3ae67b6c3bdf10cd6600d5cf69601a33d304b74372b690fd736562f67d3a5f41",
  "491a4b8c316a73dbfd8d1abe2130d70284801ce8255206f900037604a931e18d",
  "fbfe4a3372927cee81452ee2d3d853b3be07ad478a74b074a6941b11afaad5e8",
  "30f8742377fe325048abf083d2c3f3735e5f72a1ed038dc01bccf9bbd0316db4",
  "f6a9135a676c69f7066d1c4ac8803ddf6dc4eb696c8b60d95ae22b3cb3c82303",
];
type Document = Record<string, unknown>;

function digest(bytes: Uint8Array) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}
function json(bytes: Buffer): Document {
  return JSON.parse(bytes.toString("utf8")) as Document;
}
function mutateJson(bytes: Buffer, mutate: (document: Document) => void) {
  const document = json(bytes);
  mutate(document);
  return Buffer.from(JSON.stringify(document));
}
function accepted() {
  const fixture = imageBaseMetadataFixture();
  return verifyFixtureImageBase(fixture.manifestBytes, fixture.configBytes);
}
function rejects(manifest: unknown, config: unknown) {
  const result = verifyFixtureImageBase(manifest, config);
  expect(result).toEqual(REJECTED);
  expect(Object.isFrozen(result)).toBe(true);
  expect(fixtureImageBaseInputs(result)).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain(PRIVATE);
}

describe("fixed image base metadata preflight", () => {
  it("verifies the two original wire documents without granting image or execution authority", () => {
    expect(Object.keys(production).sort()).toEqual([
      "fixtureImageBaseInputs",
      "verifyFixtureImageBase",
    ]);
    const fixture = imageBaseMetadataFixture();
    expect(fixture.manifestBytes.length).toBe(2493);
    expect(fixture.configBytes.length).toBe(6717);
    expect(digest(fixture.manifestBytes)).toBe(MANIFEST_DIGEST);
    expect(digest(fixture.configBytes)).toBe(CONFIG_DIGEST);
    const result = verifyFixtureImageBase(fixture.manifestBytes, fixture.configBytes);
    expect(result).toEqual(MATCHED);
    expect(Object.isFrozen(result)).toBe(true);
    expect(accepted()).toEqual(result);
  });

  it("returns fresh fixtures and copies instead of exposing stored or caller-owned bytes", () => {
    const fixture = imageBaseMetadataFixture();
    const original = imageBaseMetadataFixture();
    const result = verifyFixtureImageBase(fixture.manifestBytes, fixture.configBytes);
    const first = fixtureImageBaseInputs(result);
    const second = fixtureImageBaseInputs(result);
    if (!first || !second) throw new Error("missing verified metadata fixture");
    expect(Object.isFrozen(first)).toBe(true);
    expect(first).not.toBe(second);
    expect(first.manifestBytes).not.toBe(second.manifestBytes);
    expect(first.configBytes).not.toBe(second.configBytes);
    expect(first).toEqual(original);
    fixture.manifestBytes.fill(0);
    fixture.configBytes.fill(1);
    first.manifestBytes.fill(2);
    first.configBytes.fill(3);
    expect(second).toEqual(original);
    expect(fixtureImageBaseInputs(result)).toEqual(original);
    expect(imageBaseMetadataFixture()).toEqual(original);
    expect(result).toEqual(MATCHED);
    expect(Reflect.set(first, "manifestBytes", Buffer.alloc(0))).toBe(false);
    expect(Reflect.set(result, "imagePrepared", true)).toBe(false);
  });

  it("independently binds the original manifest to the configuration and ordered declared layers", () => {
    const fixture = imageBaseMetadataFixture();
    const manifest = json(fixture.manifestBytes);
    expect(Object.keys(manifest).sort()).toEqual([
      "annotations",
      "config",
      "layers",
      "mediaType",
      "schemaVersion",
    ]);
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.mediaType).toBe("application/vnd.oci.image.manifest.v1+json");
    expect(manifest.config).toEqual({
      mediaType: "application/vnd.oci.image.config.v1+json",
      digest: digest(fixture.configBytes),
      size: fixture.configBytes.length,
    });
    expect(manifest.layers).toEqual(
      LAYERS.map(([hash, size]) => ({
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        digest: `sha256:${hash}`,
        size,
      })),
    );
    expect(LAYERS.reduce((total, [, size]) => total + size, 0)).toBe(409_613_156);
    expect(manifest.annotations).toEqual({
      "com.docker.official-images.bashbrew.arch": "amd64",
      "org.opencontainers.image.base.digest":
        "sha256:c8e8f3d6e647f782059d933878e9a0de6889cec350149a770d51d1baa245a60e",
      "org.opencontainers.image.base.name": "buildpack-deps:bookworm",
      "org.opencontainers.image.created": "2026-08-27T17:02:11Z",
      "org.opencontainers.image.revision": "c4eb0858f5c522521768d5b6dc1d9f1631d4854d",
      "org.opencontainers.image.source":
        "https://github.com/nodejs/docker-node.git#c4eb0858f5c522521768d5b6dc1d9f1631d4854d:24/bookworm",
      "org.opencontainers.image.url": "https://hub.docker.com/_/node",
      "org.opencontainers.image.version": "24",
    });
    // These are declared references, not measured compressed or extracted layers.
    expect(new Set(LAYERS.map(([hash]) => hash)).size).toBe(8);
  });

  it("independently verifies the closed base defaults, platform and ordered diff IDs", () => {
    const config = json(imageBaseMetadataFixture().configBytes);
    expect(Object.keys(config).sort()).toEqual([
      "architecture",
      "config",
      "created",
      "history",
      "os",
      "rootfs",
    ]);
    expect(config.architecture).toBe("amd64");
    expect(config.os).toBe("linux");
    expect(config.created).toBe("2026-08-27T17:02:40.495628348Z");
    expect(config.config).toEqual({
      Env: [
        "PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
        "NODE_VERSION=24.20.0",
        "YARN_VERSION=1.22.22",
      ],
      Entrypoint: ["docker-entrypoint.sh"],
      Cmd: ["node"],
    });
    expect(config.rootfs).toEqual({
      type: "layers",
      diff_ids: DIFF_IDS.map((hash) => `sha256:${hash}`),
    });
    expect(new Set(DIFF_IDS).size).toBe(8);
    expect(DIFF_IDS).not.toEqual(LAYERS.map(([hash]) => hash));
    const history = config.history as Document[];
    expect(history).toHaveLength(12);
    expect(history.filter((entry) => entry.empty_layer !== true)).toHaveLength(8);
    for (const entry of history) {
      expect(
        Object.keys(entry).every((key) =>
          ["created", "created_by", "comment", "empty_layer"].includes(key),
        ),
      ).toBe(true);
      expect(typeof entry.created_by).toBe("string");
    }
    // History is inert upstream metadata, not a script or an execution recipe.
  });

  it("copies exact intrinsic Uint8Array views and only their addressed subranges", () => {
    const fixture = imageBaseMetadataFixture();
    const pad = (bytes: Buffer) => {
      const backing = new Uint8Array(bytes.length + 17);
      backing.fill(255);
      backing.set(bytes, 7);
      return new Uint8Array(backing.buffer, 7, bytes.length);
    };
    const manifest = pad(fixture.manifestBytes);
    const config = pad(fixture.configBytes);
    const result = verifyFixtureImageBase(manifest, config);
    expect(result).toEqual(MATCHED);
    manifest.fill(0);
    config.fill(0);
    expect(fixtureImageBaseInputs(result)).toEqual(fixture);
  });

  it("ignores shadowed byte-view properties and copy methods without invoking caller code", () => {
    const fixture = imageBaseMetadataFixture();
    const getter = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    for (const bytes of [fixture.manifestBytes, fixture.configBytes]) {
      for (const key of [
        "length",
        "byteLength",
        "byteOffset",
        "buffer",
        "constructor",
        "slice",
        "subarray",
        "copy",
        "set",
        "valueOf",
        "toString",
        Symbol.iterator,
        Symbol.toPrimitive,
        Symbol.toStringTag,
      ])
        Object.defineProperty(bytes, key, { get: getter });
    }
    expect(verifyFixtureImageBase(fixture.manifestBytes, fixture.configBytes)).toEqual(MATCHED);
    expect(getter).not.toHaveBeenCalled();
  });

  it.each(["manifestBytes", "configBytes"] as const)(
    "rejects changed %s raw bytes, including grammar-equivalent documents",
    (key) => {
      const fixture = imageBaseMetadataFixture();
      const bytes = fixture[key];
      const bitFlip = Buffer.from(bytes);
      const midpoint = Math.floor(bitFlip.length / 2);
      bitFlip[midpoint] = bitFlip.readUInt8(midpoint) ^ 1;
      const variants = [
        Buffer.alloc(0),
        bytes.subarray(1),
        bytes.subarray(0, -1),
        Buffer.concat([bytes, Buffer.from("\n")]),
        Buffer.concat([Buffer.from(" "), bytes]),
        Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), bytes]),
        bitFlip,
        Buffer.alloc(bytes.length),
        Buffer.from(JSON.stringify(json(bytes), null, 3)),
        Buffer.from(bytes.toString("utf8"), "utf16le"),
        Buffer.from(`{${PRIVATE}`),
        Buffer.from(`{"duplicate":1,"duplicate":2,${bytes.toString("utf8").slice(1)}`),
      ];
      for (const changed of variants) {
        const input = { ...fixture, [key]: changed };
        rejects(input.manifestBytes, input.configBytes);
      }
    },
  );

  it("rejects reversed inputs, partial verification and caller-selected alternate pins", () => {
    const fixture = imageBaseMetadataFixture();
    rejects(fixture.configBytes, fixture.manifestBytes);
    rejects(fixture.manifestBytes, undefined);
    rejects(undefined, fixture.configBytes);
    rejects(fixture.manifestBytes, fixture.manifestBytes);
    rejects(fixture.configBytes, fixture.configBytes);
    const changed = Buffer.from(fixture.manifestBytes);
    changed[0] = 0;
    expect(
      Reflect.apply(verifyFixtureImageBase, undefined, [
        changed,
        fixture.configBytes,
        {
          manifestDigest: digest(changed),
          configDigest: CONFIG_DIGEST,
          allowUnknown: true,
        },
      ]),
    ).toEqual(REJECTED);
  });

  it.each(["manifestBytes", "configBytes"] as const)(
    "rejects hostile, shared, detached and non-intrinsic %s inputs with fixed redaction",
    (key) => {
      const fixture = imageBaseMetadataFixture();
      const bytes = fixture[key];
      const shared = new SharedArrayBuffer(bytes.length);
      new Uint8Array(shared).set(bytes);
      const disguisedShared = new SharedArrayBuffer(bytes.length);
      const disguisedSharedView = new Uint8Array(disguisedShared);
      const disguisedSharedBuffer = Buffer.from(disguisedShared);
      disguisedSharedView.set(bytes);
      Object.setPrototypeOf(disguisedShared, ArrayBuffer.prototype);
      const detached = new Uint8Array(bytes);
      structuredClone(detached.buffer, { transfer: [detached.buffer] });
      class Subclass extends Uint8Array {}
      const subclass = new Subclass(bytes);
      const disguisedClamped = new Uint8ClampedArray(bytes);
      Object.setPrototypeOf(disguisedClamped, Uint8Array.prototype);
      const disguisedSigned = new Int8Array(bytes);
      Object.setPrototypeOf(disguisedSigned, Buffer.prototype);
      const changedPrototype = Buffer.from(bytes);
      Object.setPrototypeOf(changedPrototype, Object.create(Buffer.prototype));
      const throwingProxy = new Proxy(bytes, {
        get() {
          throw new Error(PRIVATE);
        },
        getPrototypeOf() {
          throw new Error(PRIVATE);
        },
        ownKeys() {
          throw new Error(PRIVATE);
        },
      });
      const revoked = Proxy.revocable(bytes, {});
      revoked.revoke();
      const getter = vi.fn(() => {
        throw new Error(PRIVATE);
      });
      const impostor = Object.create(null) as Document;
      for (const field of ["length", "byteLength", "buffer", Symbol.iterator])
        Object.defineProperty(impostor, field, { get: getter });
      const variants: unknown[] = [
        null,
        undefined,
        false,
        1,
        1n,
        Symbol(PRIVATE),
        PRIVATE,
        Array.from(bytes),
        json(bytes),
        bytes.buffer,
        new DataView(new Uint8Array(bytes).buffer),
        new Int8Array(bytes),
        new Uint16Array(bytes.length),
        new Uint8Array(shared),
        Buffer.from(shared),
        detached,
        subclass,
        changedPrototype,
        disguisedClamped,
        disguisedSigned,
        disguisedSharedView,
        disguisedSharedBuffer,
        new Proxy(bytes, {}),
        throwingProxy,
        revoked.proxy,
        impostor,
        runInNewContext("new Uint8Array(length)", { length: bytes.length }),
        Buffer.alloc(1_000_001),
      ];
      for (const changed of variants) {
        const input = { ...fixture, [key]: changed };
        rejects(input.manifestBytes, input.configBytes);
      }
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it("does not grant capability access to summaries, clones, proxies or failed results", () => {
    const result = accepted();
    const revoked = Proxy.revocable(result, {});
    revoked.revoke();
    const getter = vi.fn(() => {
      throw new Error(PRIVATE);
    });
    const impostor = Object.defineProperty({}, "status", { get: getter });
    for (const value of [
      null,
      undefined,
      false,
      0,
      1n,
      Symbol(PRIVATE),
      PRIVATE,
      [],
      { ...result },
      JSON.parse(JSON.stringify(result)),
      structuredClone(result),
      Object.create(result),
      new Proxy(result, {}),
      revoked.proxy,
      new Proxy(
        {},
        {
          get() {
            throw new Error(PRIVATE);
          },
        },
      ),
      impostor,
      verifyFixtureImageBase(undefined, undefined),
    ])
      expect(fixtureImageBaseInputs(value)).toBeUndefined();
    expect(getter).not.toHaveBeenCalled();
    expect(fixtureImageBaseInputs(result)).toEqual(imageBaseMetadataFixture());
  });

  it("rejects changed descriptor bindings, extensions, platforms and base execution defaults", () => {
    const fixture = imageBaseMetadataFixture();
    const manifestChanges: Array<(document: Document) => void> = [
      (document) => {
        document.schemaVersion = 1;
      },
      (document) => {
        document.mediaType = "application/vnd.oci.image.index.v1+json";
      },
      (document) => {
        document.artifactType = "application/example";
      },
      (document) => {
        document.manifests = [];
      },
      (document) => {
        document.subject = document.config;
      },
      (document) => {
        document.layers = (document.layers as unknown[]).toReversed();
      },
      (document) => {
        document.layers = (document.layers as unknown[]).slice(1);
      },
      (document) => {
        (document.config as Document).digest = MANIFEST_DIGEST;
      },
      (document) => {
        (document.config as Document).size = 6716;
      },
      (document) => {
        (document.config as Document).mediaType = "application/octet-stream";
      },
      (document) => {
        (document.config as Document).urls = ["https://example.invalid/private"];
      },
      (document) => {
        (document.config as Document).data = fixture.configBytes.toString("base64");
      },
    ];
    for (const change of manifestChanges)
      rejects(mutateJson(fixture.manifestBytes, change), fixture.configBytes);
    for (const [field, value] of [
      ["architecture", "arm64"],
      ["os", "windows"],
      ["variant", "v8"],
      ["os.features", ["win32k"]],
      ["rootfs", { type: "layers", diff_ids: [] }],
    ] as const)
      rejects(
        fixture.manifestBytes,
        mutateJson(fixture.configBytes, (document) => {
          document[field] = value;
        }),
      );
    for (const [field, value] of [
      ["Env", ["PATH=/tmp", "NODE_OPTIONS=--require=private", "LD_PRELOAD=private"]],
      ["Env", ["PATH=/usr/bin", "PATH=/tmp"]],
      ["Entrypoint", ["/bin/sh"]],
      ["Cmd", ["-c", PRIVATE]],
      ["User", "root"],
      ["WorkingDir", "/private"],
      ["Shell", ["/bin/sh"]],
      ["ArgsEscaped", true],
      ["ExposedPorts", { "80/tcp": {} }],
      ["Volumes", null],
      ["Volumes", {}],
      ["Volumes", { "/private": {} }],
      ["OnBuild", null],
      ["OnBuild", []],
      ["OnBuild", ["RUN private"]],
      ["Healthcheck", { Test: ["NONE"] }],
      ["StopSignal", "SIGKILL"],
    ] as const)
      rejects(
        fixture.manifestBytes,
        mutateJson(fixture.configBytes, (document) => {
          (document.config as Document)[field] = value;
        }),
      );
  });
});
