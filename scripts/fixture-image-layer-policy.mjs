import { fixtureImageBaseInputs } from "./fixture-image-base.mjs";

export const IMAGE_METADATA = Object.freeze({
  manifest: Object.freeze({
    digest: "sha256:9137a20e25879e0b557227b57e3ee4e9af4bde29eb3db66134cd1723e84f830b",
    size: 2493,
  }),
  config: Object.freeze({
    digest: "sha256:aa09691f441f07a6d1f076f25470751bff882a4ba88274f3d7f9fa5af542f0ce",
    size: 6717,
  }),
});

/** @typedef {Readonly<{digest: string, size: number, file: string}>} ImageLayer */

/**
 * Only ADR 0024's private copied-byte capability yields this fixed layer plan.
 * The complete wire pin already binds JSON syntax and all descriptor fields.
 * Neither the caller's public summary nor a receipt supplies descriptors.
 * @param {unknown} baseResult
 * @returns {ReadonlyArray<ImageLayer> | undefined}
 */
export function fixtureImageLayerPlan(baseResult) {
  const inputs = fixtureImageBaseInputs(baseResult);
  if (!inputs) return undefined;
  const manifest = /** @type {{layers: Array<{digest: string, size: number}>}} */ (
    JSON.parse(inputs.manifestBytes.toString("utf8"))
  );
  return Object.freeze(
    manifest.layers.map(({ digest, size }) =>
      Object.freeze({ digest, size, file: `${digest.slice(7)}.blob` }),
    ),
  );
}
