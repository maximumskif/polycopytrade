// Counts outbound HTTP requests per host by wrapping globalThis.fetch.
// Must be imported BEFORE src/api/client.ts: the client captures `fetch`
// when it loads. The wrapper stays === globalThis.fetch, so the client
// doesn't mistake it for a test stub (its cache/limiter stay live).
// Counts real network calls only: API-cache hits never reach fetch.

export const requestCounts = new Map<string, number>();

const realFetch = globalThis.fetch;
globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  const host = new URL(url).host;
  requestCounts.set(host, (requestCounts.get(host) ?? 0) + 1);
  return realFetch(input, init);
}) as typeof fetch;

export function totalRequests(): number {
  let n = 0;
  for (const c of requestCounts.values()) n += c;
  return n;
}
