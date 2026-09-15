// Pure, testable event-log decoding for the funding-source-clustering
// research (Track G.20, docs/IMPROVEMENT_PLAN.md). No network calls here —
// see client.ts for the live Etherscan V2 calls that produce the `EvmLog[]`
// this operates on.
//
// WHY THIS EXISTS: a Polymarket wallet's `pUSD` balance is minted
// (`Transfer` from the zero address) via a Collateral Onramp contract, not
// transferred from a real depositor — so reading the mint's own `from`
// field (naive approach) always returns 0x000...000 and reveals nothing.
// Confirmed live 2026-09-15 against 0x1b20a00709dfe648afd26b326394b5e031f83ab0's
// real first pUSD mint (tx 0x34335de3...2be8a96, fixture:
// tests/fixtures/polygon-receipt.sample.json). Polymarket's deposit flow
// runs through ERC-4337 account abstraction (a `handleOps` call on the
// standard EntryPoint v0.7 contract, address 0x4337084d9e255ff0702461cf8895ce9e3b5ff108
// on Polygon), and that same transaction's logs include a
// `UserOperationEvent` whose indexed `sender` field is the actual account
// that authorized/funded the deposit — a real, per-user address, not a
// shared bundler or relayer. That's the fingerprint this file extracts.
//
// CONFIRMED, NOT ASSUMED: verified against the real fixture above that
// `sender` (0x1517e971652da29ee9aeb798d95b215603e73c80) is NOT the trading
// proxy itself and NOT the EntryPoint/Onramp/paymaster infra addresses —
// it's a distinct account, and pulling that same account's own earliest
// USDC.e transfer live showed it came in via a `permit2TransferAndMulticall`
// call from yet another address (0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f)
// — almost certainly a swap-router/aggregator contract, not a human. That
// means a further hop is NOT a reliable entity fingerprint (most users
// swapping into USDC.e would converge on the same handful of popular
// router contracts, producing false-positive "clusters" that mean nothing
// about shared ownership) — see fundingSourceClustering.ts for why only
// the ONE hop this file extracts is used as the clustering signal.
//
// KNOWN GAP: only EntryPoint v0.7's UserOperationEvent topic0 is checked.
// A deposit whose UserOperation went through EntryPoint v0.6 (a different,
// older, still-in-use ERC-4337 contract) would have a different event
// signature and silently fail to decode here, returning null rather than a
// wrong answer — that's the deliberately safe failure mode (see
// findUserOperationSender's doc comment), but it does mean some wallets'
// funding hop may come back "unknown" even when it's technically decodable
// with more work. Not hit yet in the one real wallet tested.

// keccak256("Transfer(address,address,uint256)") — the standard ERC-20
// Transfer event signature, unchanged across every ERC-20 token on any EVM
// chain (not chain- or token-specific).
export const ERC20_TRANSFER_TOPIC0 = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// keccak256("UserOperationEvent(bytes32,address,address,uint256,bool,uint256,uint256)")
// — ERC-4337 EntryPoint v0.7's UserOperationEvent. Confirmed live against
// the real fixture (see file header); NOT verified against EntryPoint v0.6
// (different signature, not implemented — see file header's "known gap").
export const USER_OPERATION_EVENT_TOPIC0 = "0x49628fd1471006c1482da88028e9ce4dbb080b815c9b0344d39e5a8e6ec1419f";

export interface MinimalLog {
  address: string;
  topics: string[];
  data: string;
}

// A 32-byte topic left-pads an address to 32 bytes; the address is the
// low-order 20 bytes (last 40 hex chars).
export function topicToAddress(topic: string): string {
  const hex = topic.startsWith("0x") ? topic.slice(2) : topic;
  return `0x${hex.slice(-40)}`.toLowerCase();
}

export interface DecodedErc20Transfer {
  tokenContract: string;
  from: string;
  to: string;
}

// Returns null (not a throw) for any log that isn't a standard indexed
// ERC-20 Transfer — callers scan a mixed log array and are expected to
// filter, not assume every log matches.
export function decodeErc20Transfer(log: MinimalLog): DecodedErc20Transfer | null {
  if (log.topics[0]?.toLowerCase() !== ERC20_TRANSFER_TOPIC0) return null;
  if (log.topics.length < 3) return null;
  return {
    tokenContract: log.address.toLowerCase(),
    from: topicToAddress(log.topics[1]),
    to: topicToAddress(log.topics[2]),
  };
}

// Scans a transaction's full log array for an ERC-4337 UserOperationEvent
// and returns its `sender` (the account whose operation this was) — the
// funding-source fingerprint this project uses. Returns null (never
// throws) when no such event is present, which callers must treat as
// "funding hop unknown for this wallet," not as an error — a transaction
// with no UserOperationEvent (e.g. a direct, non-account-abstraction
// transfer) is a real, expected case, not a bug.
export function findUserOperationSender(logs: MinimalLog[]): string | null {
  const log = logs.find((l) => l.topics[0]?.toLowerCase() === USER_OPERATION_EVENT_TOPIC0 && l.topics.length >= 3);
  if (!log) return null;
  return topicToAddress(log.topics[2]);
}
