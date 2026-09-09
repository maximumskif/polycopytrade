// Extracted 2026-09-08 (code-review finding): src/markets/solana/client.ts
// had copied this exact zod-wrap-and-rethrow pattern from src/api/client.ts
// rather than sharing it. Nothing about "parse with a schema, rethrow with
// context and a `cause` link on failure" is Polymarket- or Solana-specific.
export function validateSchema<T>(schema: { parse: (data: unknown) => T }, data: unknown, context: string): T {
  try {
    return schema.parse(data);
  } catch (err) {
    throw new Error(`Response validation failed for ${context}: ${(err as Error).message}`, { cause: err });
  }
}
