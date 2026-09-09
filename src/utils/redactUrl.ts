// Extracted 2026-09-08 (code-review finding): src/markets/solana/client.ts
// had copied this byte-for-byte from src/api/client.ts rather than sharing
// it -- worth sharing specifically here (unlike requestJson's retry loop,
// see that file's comment on why THAT stays duplicated for now) because a
// missed secret-shaped param name in the regex is a real credential-leak
// risk, and the Solana client's two providers put API keys directly in
// query strings (Helius's `api-key`), making this load-bearing there from
// day one rather than the defensive-for-later guard it originally was for
// Polymarket (whose current endpoints are all public/unauthenticated).
export function redactUrl(url: string): string {
  const u = new URL(url);
  for (const key of [...u.searchParams.keys()]) {
    if (/key|secret|passphrase|token|password/i.test(key)) u.searchParams.set(key, "***");
  }
  return u.toString();
}
