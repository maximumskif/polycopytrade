// Child process for tests/apiCache.test.ts's env-var / cross-process checks
// (K1, 2026-09-24). Runs the REAL src/api/client.ts cache wiring -- config
// read from env, default cache file -- which the in-process tests can't,
// because client.ts deliberately disables the default cache under the test
// runner. global fetch is replaced BEFORE client.ts loads, so its captured
// fetchImpl is still "the global fetch" and the cache isn't bypassed as a
// stubbed-test fetch would be. Prints the number of network fetches made.

const FINALIZED_MARKET = {
  id: "1",
  conditionId: "0xabc",
  question: "q",
  slug: "s",
  outcomes: '["Yes","No"]',
  outcomePrices: '["1","0"]',
  clobTokenIds: '["tok-yes","tok-no"]',
  closed: true,
  umaResolutionStatus: "resolved",
};

let fetches = 0;
globalThis.fetch = (async () => {
  fetches++;
  return new Response(JSON.stringify([FINALIZED_MARKET]), { status: 200 });
}) as typeof fetch;

async function main() {
  const { getMarketByConditionId, getApiCacheStats } = await import("../../src/api/client");
  const calls = Number(process.argv[2] ?? 2);
  for (let i = 0; i < calls; i++) await getMarketByConditionId("0xabc", true);
  console.log(JSON.stringify({ fetches, stats: getApiCacheStats() }));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
