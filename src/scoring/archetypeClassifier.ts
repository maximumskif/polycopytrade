// Derives a wallet's trading-strategy archetype from its real backtested
// behavior, rather than trusting the labels in wallets.ts — which are
// explicitly documented there as "PROVISIONAL — assigned from public X
// posts / the leaderboard, before we'd looked at any real trade history."
// 76 of 96 tracked wallets currently carry the placeholder
// "unclassified" archetype, and even the 20 that don't were never
// confirmed against actual activity. This is that confirmation pass, done
// once as reusable code instead of an ad-hoc read per wallet.
//
// CRITICAL, found via live validation against 0xE30E7 (2026-09-15): data-api's
// /activity is one row per FILL, not per decision (walletStats.ts's header
// comment names this exact gotcha, and README's "Trader archetypes" table
// exists specifically because it bit this project once already — 0xE30E7 was
// originally mislabeled "sniper" from raw fill stats before fill-clustering
// revealed 11 real orders averaging $54,987). A wallet's real order can
// fragment into dozens of same-instant fills, which (a) inflates trial/fill
// counts, (b) shrinks apparent avg stake per "trial", and (c) crushes the
// raw fill-to-fill gap toward zero — silently misrouting a whale into
// "sports-scalper" purely from order-book fragmentation, not real trading
// frequency. So every count/size/frequency-sensitive rule below runs on
// CLUSTERED ORDERS (src/research/walletStats.ts's clusterFills, same
// same-market+outcome+side/<=120s-gap definition already used for the
// project's own manual archetype corrections), not raw trials or raw
// activity rows. Event/market-grouped fields (distinctEvents, distinctMarkets,
// roi, concentrationTopEventShare) are sums/set-cardinalities and are NOT
// fragmentation-sensitive, so those still come straight off WalletScore.
//
// Dominant-category share is computed per DISTINCT EVENT, not per fill/order,
// for the same reason docs/AUDIT.md §7 already treats event-grouping as the
// non-negotiable independence unit elsewhere in this project.
//
// Thresholds below are heuristic starting points (same status as
// walletScore.ts's `squash()` scale constants) — not tuned against the full
// wallet pool yet. Each rule's `reasons` output says exactly which numbers
// triggered the match, so a human can sanity-check or retune them against
// confirmed cases rather than trusting a black box.

import { clusterFills } from "../research/walletStats";
import type { Activity } from "../api/client";
import type { TrackedWallet } from "../wallets";
import type { BacktestTrial, WalletScore } from "../domain/types";

export type Archetype = TrackedWallet["archetype"];

export interface ArchetypeClassification {
  archetype: Archetype;
  confidence: number; // 0-1 heuristic strength, not a statistical probability
  reasons: string[];
}

// Ladder-harvester: many markets sharing one real event (e.g. every rung of
// one month's WTI/BTC price ladder) — distinctMarkets/distinctEvents ratio
// is exactly the sample-inflation signal docs/AUDIT.md §7 already tracks,
// repurposed here as a positive identifier instead of a correction. Not
// order-count-sensitive (distinctMarkets/distinctEvents are conditionId/
// eventKey set cardinalities), so this stays off WalletScore directly.
const LADDER_MIN_MARKETS_PER_EVENT = 2.5;

// Whale-conviction / live-sports-whale: few, large, real ORDERS.
const WHALE_MAX_ORDERS = 15;
const WHALE_MIN_TOP_EVENT_SHARE = 0.4;
const WHALE_MIN_AVG_ORDER_STAKE_USDC = 200;

// Sniper: few real orders, high profit/volume ratio, not concentrated in one
// bet (that's what distinguishes it from whale-conviction above).
const SNIPER_MAX_ORDERS = 15;
const SNIPER_MIN_ROI = 0.5;

// sports-scalper / sports-systematic: frequency measured between real
// ORDERS, not raw fills — a fragmented big order can show sub-second GAPS
// BETWEEN ITS OWN FILLS without the wallet trading frequently at all.
const ORDER_HIGH_FREQUENCY_MIN_ORDERS = 30;
const ORDER_HIGH_FREQUENCY_MEDIAN_GAP_SECONDS = 6 * 3600; // "high-frequency within hours," per README's swisstony finding
const SYSTEMATIC_MIN_ORDERS = 20; // matches statistics.ts's own MIN_SAMPLE_SIZE

const DOMINANT_CATEGORY_MIN_SHARE = 0.5;

function median(xs: number[]): number {
  if (xs.length === 0) return Infinity;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

interface OrderStats {
  orderCount: number;
  avgOrderStakeUsdc: number;
  medianOrderGapSeconds: number;
}

function computeOrderStats(activity: Activity[]): OrderStats {
  const orders = clusterFills(activity.filter((a) => a.type === "TRADE")).sort((a, b) => a.firstTs - b.firstTs);
  const orderCount = orders.length;
  const avgOrderStakeUsdc = orderCount > 0 ? orders.reduce((s, o) => s + o.usdcSize, 0) / orderCount : 0;
  const gaps = orders.slice(1).map((o, i) => o.firstTs - orders[i].firstTs);
  return { orderCount, avgOrderStakeUsdc, medianOrderGapSeconds: median(gaps) };
}

// Weighted by distinct EVENT (one vote per real event, taking whichever
// trial happens to represent it first) rather than by fill/trial count —
// otherwise a single fragmented order in one category could outweigh
// several genuinely distinct events in another.
function dominantCategoryByEvent(trials: BacktestTrial[]): { category: string; share: number } | null {
  const resolved = trials.filter((t) => t.resolved);
  const categoryByEvent = new Map<string, string>();
  for (const t of resolved) {
    if (!categoryByEvent.has(t.eventKey)) categoryByEvent.set(t.eventKey, t.category);
  }
  if (categoryByEvent.size === 0) return null;
  const counts = new Map<string, number>();
  for (const cat of categoryByEvent.values()) counts.set(cat, (counts.get(cat) ?? 0) + 1);
  const [category, n] = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return { category, share: n / categoryByEvent.size };
}

export function classifyArchetype(score: WalletScore, trials: BacktestTrial[], activity: Activity[]): ArchetypeClassification {
  const sr = score.strategyResult;
  const reasons: string[] = [];

  if (sr.trialCount === 0) {
    return { archetype: "unclassified", confidence: 0, reasons: ["no resolved trials to classify from"] };
  }

  // one-shot-bet: reuse the existing "one-shot" veto flag's exact condition
  // (distinctEvents <= 3) instead of re-deriving the same threshold twice.
  // Event-count-based, not fragmentation-sensitive.
  if (score.flags.includes("one-shot")) {
    return {
      archetype: "one-shot-bet",
      confidence: 0.9,
      reasons: [`only ${sr.distinctEvents} distinct event(s) in the entire visible history`],
    };
  }

  const marketsPerEvent = sr.distinctEvents > 0 ? sr.distinctMarkets / sr.distinctEvents : 0;
  if (marketsPerEvent >= LADDER_MIN_MARKETS_PER_EVENT) {
    reasons.push(
      `${marketsPerEvent.toFixed(1)} markets per event (>= ${LADDER_MIN_MARKETS_PER_EVENT}) — many rungs of the same real event`
    );
    return { archetype: "ladder-harvester", confidence: 0.7, reasons };
  }

  const { orderCount, avgOrderStakeUsdc, medianOrderGapSeconds } = computeOrderStats(activity);
  const dominant = dominantCategoryByEvent(trials);
  const isSportsDominant = dominant !== null && dominant.category === "sports" && dominant.share >= DOMINANT_CATEGORY_MIN_SHARE;

  // Few, large real orders, but heavily sports-dominant — distinct from
  // generic whale-conviction (see README's "Trader archetypes" table: two
  // wallets were manually corrected into exactly this bucket from "sniper"
  // and "whale-conviction" respectively, since neither generic label
  // captured "large live-sports/esports bets, not macro/election
  // conviction").
  const looksLikeFewLargeOrders = orderCount > 0 && orderCount <= WHALE_MAX_ORDERS && avgOrderStakeUsdc >= WHALE_MIN_AVG_ORDER_STAKE_USDC;
  if (looksLikeFewLargeOrders && isSportsDominant) {
    reasons.push(
      `${orderCount} real orders (<= ${WHALE_MAX_ORDERS}), avg order stake $${avgOrderStakeUsdc.toFixed(0)}, ${(dominant!.share * 100).toFixed(0)}% sports by event`
    );
    return { archetype: "live-sports-whale", confidence: 0.6, reasons };
  }
  if (looksLikeFewLargeOrders && score.concentrationTopEventShare >= WHALE_MIN_TOP_EVENT_SHARE) {
    reasons.push(
      `${orderCount} real orders (<= ${WHALE_MAX_ORDERS}), ${(score.concentrationTopEventShare * 100).toFixed(0)}% of stake in one event, avg order stake $${avgOrderStakeUsdc.toFixed(0)}`
    );
    return { archetype: "whale-conviction", confidence: 0.6, reasons };
  }

  if (orderCount > 0 && orderCount <= SNIPER_MAX_ORDERS && sr.roi >= SNIPER_MIN_ROI) {
    reasons.push(`${orderCount} real orders (<= ${SNIPER_MAX_ORDERS}), ${(sr.roi * 100).toFixed(0)}% ROI (>= ${SNIPER_MIN_ROI * 100}%)`);
    return { archetype: "sniper", confidence: 0.55, reasons };
  }

  const isHighFrequency = orderCount >= ORDER_HIGH_FREQUENCY_MIN_ORDERS && medianOrderGapSeconds < ORDER_HIGH_FREQUENCY_MEDIAN_GAP_SECONDS;
  if (isSportsDominant && isHighFrequency) {
    reasons.push(
      `${(dominant!.share * 100).toFixed(0)}% sports by event, ${orderCount} real orders, median order gap ${(medianOrderGapSeconds / 3600).toFixed(1)}h (< ${ORDER_HIGH_FREQUENCY_MEDIAN_GAP_SECONDS / 3600}h)`
    );
    return { archetype: "sports-scalper", confidence: 0.65, reasons };
  }

  if (isSportsDominant && orderCount >= SYSTEMATIC_MIN_ORDERS) {
    reasons.push(`${(dominant!.share * 100).toFixed(0)}% sports by event, ${orderCount} real orders at ordinary cadence`);
    return { archetype: "sports-systematic", confidence: 0.6, reasons };
  }

  reasons.push("no archetype pattern cleared its threshold — see docs/IMPROVEMENT_PLAN.md before tightening these rules");
  return { archetype: "unclassified", confidence: 0, reasons };
}
