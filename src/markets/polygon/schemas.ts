// Zod schemas for the Etherscan API V2 (unified multichain, chainid=137 for
// Polygon PoS) responses this project reads. Polygonscan's own standalone
// API was deprecated 2025-08-15 in favor of this unified API — see
// client.ts's file header.
//
// CONFIRMED LIVE 2026-09-15 (Track G.20) against a real tracked wallet
// (0x1b20a00709dfe648afd26b326394b5e031f83ab0): both `tokentx` (fixture:
// tests/fixtures/polygon-tokentx.sample.json) and
// `proxy&action=eth_getTransactionReceipt` (fixture:
// tests/fixtures/polygon-receipt.sample.json) responses match every field
// below exactly, no adjustment needed after the first live pull. This is
// the same "verify against a real response before trusting it" bar
// src/api/schemas.ts holds itself to — NOT the looser, doc-sourced-only
// bar src/markets/solana/schemas.ts is still working under.

import { z } from "zod";

// ---------------------------------------------------------------------
// module=account&action=tokentx (ERC-20 transfer events by address)
// ---------------------------------------------------------------------

export const TokenTransferSchema = z
  .object({
    blockNumber: z.string(),
    timeStamp: z.string(),
    hash: z.string(),
    from: z.string(),
    contractAddress: z.string(),
    to: z.string(),
    value: z.string(),
    tokenName: z.string(),
    tokenSymbol: z.string(),
    tokenDecimal: z.string(),
    functionName: z.string().optional(),
  })
  .passthrough();
export type TokenTransfer = z.infer<typeof TokenTransferSchema>;

// Etherscan's account-module endpoints return `status`/`message` alongside
// `result` — CONFIRMED LIVE 2026-09-15 (not the array-shaped guess this
// comment originally made before testing against several tracked wallets
// with zero transfers): a real "no transactions found" response comes back
// as status="0", message≈"No transactions found", and **`result` is the
// message STRING again, not an empty array** — a real Etherscan quirk, not
// an HTTP error. client.ts's getTokenTransfers checks `status` before
// trusting `result` as an array; this schema accepts either shape so
// validation itself doesn't throw on the empty case.
export const TokenTxResponseSchema = z.object({
  status: z.string(),
  message: z.string(),
  result: z.union([z.array(TokenTransferSchema), z.string()]),
});

// ---------------------------------------------------------------------
// module=proxy&action=eth_getTransactionReceipt (raw JSON-RPC passthrough)
// ---------------------------------------------------------------------
// Deliberately loose (.passthrough(), only the fields this project's log
// decoder actually reads are named) — this is a raw JSON-RPC receipt, the
// same "don't overfit a schema to one example" discipline
// src/markets/solana/schemas.ts uses for genuinely unconfirmed shapes,
// except here the fields named ARE confirmed live, just not exhaustive.

export const LogSchema = z
  .object({
    address: z.string(),
    topics: z.array(z.string()),
    data: z.string(),
    transactionHash: z.string(),
    logIndex: z.string(),
  })
  .passthrough();
export type EvmLog = z.infer<typeof LogSchema>;

export const TransactionReceiptSchema = z
  .object({
    from: z.string(),
    logs: z.array(LogSchema),
  })
  .passthrough();

// eth_getTransactionReceipt for an unmined/unknown hash returns
// `result: null`, not an error — confirmed by Etherscan's own JSON-RPC
// proxy convention (standard Ethereum JSON-RPC behavior, not separately
// tested against a real null case this pass).
export const TransactionReceiptEnvelopeSchema = z.object({
  jsonrpc: z.string(),
  result: TransactionReceiptSchema.nullable(),
});
