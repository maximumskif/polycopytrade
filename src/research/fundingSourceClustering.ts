// Track G.20 (docs/IMPROVEMENT_PLAN.md item 20/36): funding-source wallet
// clustering. Asks: do two "independently smart" tracked wallets actually
// share the same real controlling account, revealed by who funded each
// wallet's very first Polymarket deposit?
//
// APPROACH (see src/markets/polygon/logDecoding.ts's file header for the
// full live-verified trace this is built on): a wallet's `pUSD` balance is
// MINTED (from the zero address), not transferred from a real depositor —
// so the mint's own `from` field reveals nothing. Instead, the deposit
// transaction's logs contain an ERC-4337 `UserOperationEvent` whose
// `sender` is the real account that authorized the deposit — a per-user
// address, confirmed live to be distinct from the trading wallet itself and
// from Polymarket's own infra contracts (EntryPoint/Onramp). That `sender`
// is this file's ONE clustering signal.
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
import { getEarliestIncomingTokenTransfer, getTransactionReceiptSender, PUSD_CONTRACT, USDC_E_CONTRACT } from "../markets/polygon/client";

interface WalletFundingResult {
  wallet: (typeof TRACKED_WALLETS)[number];
  authorizingAddress: string | null;
  fundingToken: "pUSD" | "USDC.e" | null;
  fundingTxHash: string | null;
  reason?: string; // set when authorizingAddress is null -- why, not just that
}

async function traceFundingHop(wallet: (typeof TRACKED_WALLETS)[number]): Promise<WalletFundingResult> {
  for (const [label, contract] of [
    ["pUSD", PUSD_CONTRACT],
    ["USDC.e", USDC_E_CONTRACT],
  ] as const) {
    let transfer;
    try {
      transfer = await getEarliestIncomingTokenTransfer(wallet.address, contract);
    } catch (err) {
      return { wallet, authorizingAddress: null, fundingToken: null, fundingTxHash: null, reason: `${label} lookup failed: ${(err as Error).message}` };
    }
    if (!transfer) continue;

    try {
      const sender = await getTransactionReceiptSender(transfer.hash);
      if (!sender) {
        return {
          wallet,
          authorizingAddress: null,
          fundingToken: label,
          fundingTxHash: transfer.hash,
          // Live-observed 2026-09-15 across the first several tracked
          // wallets: most funding transactions do NOT contain a
          // UserOperationEvent at all -- e.g. SDTrading's funding tx calls
          // Gnosis Safe's `execTransaction`, a completely different
          // deposit-relay pattern from ERC-4337, not just an older
          // EntryPoint version. This decoder only handles the ERC-4337
          // case (see logDecoding.ts) -- a real, majority-sized gap, not a
          // rare edge case. Extending to Safe (and any other pattern found)
          // is real follow-up work, not assumed away.
          reason: "no ERC-4337 UserOperationEvent in the funding tx (may be a Gnosis Safe execTransaction or another non-AA deposit path -- see fundingSourceClustering.ts known gap)",
        };
      }
      return { wallet, authorizingAddress: sender, fundingToken: label, fundingTxHash: transfer.hash };
    } catch (err) {
      return { wallet, authorizingAddress: null, fundingToken: label, fundingTxHash: transfer.hash, reason: `receipt lookup failed: ${(err as Error).message}` };
    }
  }
  return { wallet, authorizingAddress: null, fundingToken: null, fundingTxHash: null, reason: "no incoming pUSD or USDC.e transfer found" };
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
    const status = result.authorizingAddress ? `authorizingAddress=${result.authorizingAddress} (via ${result.fundingToken})` : `unknown (${result.reason})`;
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
