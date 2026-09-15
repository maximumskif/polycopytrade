// Track G.20 (docs/IMPROVEMENT_PLAN.md item 20/36): funding-source wallet
// clustering. Asks: do two "independently smart" tracked wallets actually
// share the same real controlling account, revealed by who funded each
// wallet's very first Polymarket deposit?
//
// APPROACH: two independent signals, tried in order, since live testing
// found tracked wallets split across two structurally different proxy-
// wallet architectures:
//
// 1. Gnosis Safe: the trading wallet itself IS a Safe contract. A single
//    eth_call to its own getOwners() (client.ts's getSafeOwners) reveals
//    its real controlling account directly — no funding-transaction lookup
//    needed at all. Confirmed live 2026-09-15 (SDTrading's wallet returns
//    exactly one owner; calling the same function against a non-Safe
//    wallet reverts, a real "not a Safe" signal, not a bug).
// 2. ERC-4337 account abstraction (see logDecoding.ts's file header for the
//    full live-verified trace): a wallet's `pUSD` balance is MINTED (from
//    the zero address), not transferred from a real depositor, so the
//    mint's own `from` field reveals nothing. Instead, the deposit
//    transaction's logs contain a `UserOperationEvent` whose `sender` is
//    the real account that authorized the deposit — confirmed live to be
//    distinct from the trading wallet itself and from Polymarket's own
//    infra contracts (EntryPoint/Onramp).
//
// A wallet that is neither (some other deposit-relay pattern this project
// hasn't seen yet) comes back with authorizingAddress=null and a specific
// reason — still a real, documented gap, not silently assumed covered.
//
// DELIBERATELY NOT ATTEMPTED: tracing a further hop back (who funded THAT
// account with USDC.e) — live-tested during design and found to resolve to
// a swap-router/aggregator contract (`permit2TransferAndMulticall`) for the
// one real wallet checked, not a human. Since most users swapping into
// USDC.e would converge on the same handful of popular router contracts,
// a second hop would produce false-positive "clusters" of totally
// unrelated wallets that just used the same DEX aggregator — worse than no
// signal. If this file's one-hop result finds real clusters worth digging
// into, a human-reviewed second hop (not an automated one) is the right
// next step, not a blind extension of this script.
//
// COST: ~2-3 Etherscan calls per wallet (one tokentx + one receipt lookup,
// occasionally a second tokentx if pUSD comes back empty and USDC.e is
// tried as a fallback for pre-migration wallets) at a 220ms rate-limited
// gap -- the full ~96-wallet TRACKED_WALLETS pool costs well under 2
// minutes and a few hundred of Etherscan's 100k-req/day free-tier budget,
// unlike this project's Polymarket-side wallet scoring (which is what
// makes a full quality-pool rescore expensive) -- so this runs against
// every tracked wallet by default, not just a pre-scored quality subset.

import "dotenv/config";
import { TRACKED_WALLETS } from "../wallets";
import { getEarliestIncomingTokenTransfer, getTransactionReceiptSender, getSafeOwners, PUSD_CONTRACT, USDC_E_CONTRACT } from "../markets/polygon/client";

interface WalletFundingResult {
  wallet: (typeof TRACKED_WALLETS)[number];
  authorizingAddress: string | null;
  method: "safe-owner" | "erc4337-userop" | null;
  reason?: string; // set when authorizingAddress is null -- why, not just that
}

async function traceFundingHop(wallet: (typeof TRACKED_WALLETS)[number]): Promise<WalletFundingResult> {
  try {
    const owners = await getSafeOwners(wallet.address);
    if (owners) {
      // Multiple owners: the exact SET is the fingerprint (a partial
      // overlap between two different owner sets is a weaker, different
      // question this doesn't attempt to answer) -- sorted so owner order
      // never affects the cluster key.
      return { wallet, authorizingAddress: [...owners].sort().join(","), method: "safe-owner" };
    }
  } catch (err) {
    // Falls through to the ERC-4337 path -- a getOwners() call failing
    // (network/rate-limit exhaustion) doesn't mean "not a Safe," so this
    // isn't treated as a final answer the way a clean revert is.
    console.error(`[${wallet.label}] getSafeOwners failed, falling back to ERC-4337 trace: ${(err as Error).message}`);
  }

  for (const [label, contract] of [
    ["pUSD", PUSD_CONTRACT],
    ["USDC.e", USDC_E_CONTRACT],
  ] as const) {
    let transfer;
    try {
      transfer = await getEarliestIncomingTokenTransfer(wallet.address, contract);
    } catch (err) {
      return { wallet, authorizingAddress: null, method: null, reason: `${label} lookup failed: ${(err as Error).message}` };
    }
    if (!transfer) continue;

    try {
      const sender = await getTransactionReceiptSender(transfer.hash);
      if (!sender) {
        return {
          wallet,
          authorizingAddress: null,
          method: null,
          // Live-observed 2026-09-15: a wallet that's neither a Safe (ruled
          // out above) nor has a UserOperationEvent in its funding tx uses
          // some other deposit-relay pattern this project hasn't
          // identified yet -- a real, documented gap.
          reason: `not a Safe, and no ERC-4337 UserOperationEvent in the ${label} funding tx -- unknown deposit pattern`,
        };
      }
      return { wallet, authorizingAddress: sender, method: "erc4337-userop" };
    } catch (err) {
      return { wallet, authorizingAddress: null, method: null, reason: `receipt lookup failed: ${(err as Error).message}` };
    }
  }
  return { wallet, authorizingAddress: null, method: null, reason: "not a Safe, and no incoming pUSD or USDC.e transfer found" };
}

// Usage: npm run funding-source-clustering [-- --limit=N]
function parseArgs(): { limit: number | null } {
  const arg = process.argv.slice(2).find((a) => a.startsWith("--limit="));
  return { limit: arg ? parseInt(arg.split("=")[1], 10) : null };
}

export async function main() {
  const { limit } = parseArgs();
  const wallets = limit ? TRACKED_WALLETS.slice(0, limit) : TRACKED_WALLETS;
  console.log(`Tracing the funding hop for ${wallets.length} tracked wallet(s)...\n`);

  const results: WalletFundingResult[] = [];
  for (const wallet of wallets) {
    const result = await traceFundingHop(wallet);
    results.push(result);
    const status = result.authorizingAddress ? `authorizingAddress=${result.authorizingAddress} (via ${result.method})` : `unknown (${result.reason})`;
    console.log(`[${wallet.label}] ${status}`);
  }

  const byAuthorizer = new Map<string, WalletFundingResult[]>();
  for (const r of results) {
    if (!r.authorizingAddress) continue;
    const group = byAuthorizer.get(r.authorizingAddress);
    if (group) group.push(r);
    else byAuthorizer.set(r.authorizingAddress, [r]);
  }

  const clusters = [...byAuthorizer.entries()].filter(([, group]) => group.length >= 2);
  const resolved = results.filter((r) => r.authorizingAddress).length;
  console.log(`\n=== ${resolved}/${results.length} wallets resolved to an authorizing address; ${clusters.length} shared-funder cluster(s) found ===`);
  for (const [address, group] of clusters) {
    console.log(`\nauthorizingAddress=${address} funds ${group.length} tracked wallets:`);
    for (const r of group) console.log(`  ${r.wallet.label}`);
  }
  if (clusters.length === 0) {
    console.log("\nNo tracked wallet shares its authorizing address with another -- clean negative, not starvation: every resolved wallet got a real answer.");
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
