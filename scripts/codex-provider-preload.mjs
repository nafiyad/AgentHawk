const rawFixtureUrl = process.env.AGENTHAWK_CODEX_PROVIDER_FIXTURE_URL;

function fixtureUrl(raw) {
  const parsed = new URL(raw);
  if (
    parsed.protocol !== "http:" ||
    !["127.0.0.1", "[::1]"].includes(parsed.hostname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    throw new Error("AgentHawk provider fixture must be an uncredentialed loopback HTTP URL.");
  }
  return parsed;
}

if (!rawFixtureUrl) {
  throw new Error("AgentHawk provider fixture URL is required.");
}

const fixture = fixtureUrl(rawFixtureUrl);
const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const requested = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  let routed;
  if (requested.protocol === "https:" && requested.hostname === "registry.npmjs.org") {
    routed = new URL(`npm${requested.pathname}${requested.search}`, fixture);
  } else if (requested.protocol === "https:" && requested.hostname === "api.osv.dev") {
    routed = new URL(`osv${requested.pathname}${requested.search}`, fixture);
  } else {
    throw new Error("AgentHawk matrix fixture refused an unexpected network destination.");
  }
  return await originalFetch(routed, init);
};
