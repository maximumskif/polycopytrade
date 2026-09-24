// Wallets we're studying, grouped by strategy archetype (see README "Trader
// archetypes"). Archetypes below are PROVISIONAL — assigned from public X
// posts / the Polymarket monthly profit leaderboard, before we'd looked at
// any real trade history. Phase 1 backtesting against actual /activity data
// is what confirms or corrects them (e.g. "whale-conviction" already looks
// too narrow for Djdjdjekekek, who also trades LoL esports markets).
//
// IMPORTANT: a Polymarket profile URL slug like
// "@0x898ca742...da39-1782562025853" is NOT the wallet to query — that's a
// display identifier. The real address (`proxyWallet`, the one that actually
// holds funds/positions) has to be resolved via
// gamma-api.polymarket.com/public-search?q=<slug-or-username>&search_profiles=true.
// See resolveProxyWallet() in src/api/client.ts.

export interface TrackedWallet {
  address: string;
  label: string;
  archetype:
    | "ladder-harvester" // mechanical, sells the "boring" side of price-ladder markets
    | "whale-conviction" // few, very large, high-conviction bets, not sports-dominant
    | "live-sports-whale" // few, very large bets concentrated in live sports/esports — README's "Trader archetypes" table found two wallets (0xE30E7, Djdjdjekekek) manually corrected into this bucket from "sniper"/"whale-conviction" respectively; added as its own archetype 2026-09-15 since neither prior label fit and this project's own real fill-clustering analysis already established it as a real, distinct pattern
    | "sniper" // very few trades, very high profit/volume ratio
    | "sports-scalper" // high-frequency micro-edge across many games
    | "sports-systematic" // moderate-frequency, consistent small edges in one sport
    | "one-shot-bet" // entire visible trading history is one concentrated event/window — high win rate is not repeatable skill, see Phase 1c in README
    | "unclassified"; // added but not yet run through walletStats/walletBacktest — don't trust a guessed label, see lesson in README
  source: string;
  // Pages of /activity (500 fills each, offset-capped by the API at 5000 =
  // 10 pages) to pull before backtesting. Default 4 (~2000 fills) is enough
  // for most wallets; the 6 all-time-leaderboard wallets below need the full
  // 10 because their near-100% win rate at 4 pages was a look-ahead artifact
  // — see README Phase 1c.
  historyPages?: number;
  // Unix seconds to start the forward history pull from, instead of the
  // wallet's first-ever fill. For high-volume wallets whose full history
  // can't reach the present within `historyPages` (item 41) -- scores stay
  // reproducible because the anchor is pinned here, not "now minus N".
  historyStart?: number;
}

export const TRACKED_WALLETS: TrackedWallet[] = [
  {
    address: "0x72a0d79b4325638bc2bcfc9a2b8a380c2d81c059",
    label: "0x_exit's featured wallet",
    archetype: "ladder-harvester",
    source: "https://x.com/0x_exit/status/2086940839834444084",
    // Phase 1e: Phase 1d's 10-page (5000-fill) pull only reached this
    // wallet's first ~12 days of history and still showed a 62.1%
    // win/+33.8% net edge, the best in the whole project. Raised past 10 to
    // see if that holds over more history before treating it as confirmed.
    historyPages: 40,
  },
  {
    address: "0xe30e74595517de48f1fb19f4553dd3d9f1e96b87",
    label: "0xE30E7... (leaderboard #3)",
    // Was "sniper" here but README's own "Trader archetypes" table already
    // documents the real correction from fill-clustering analysis: 11 real
    // orders (after clustering), avg $54,987, live Challenger-level tennis —
    // this field was just never updated to match. Fixed 2026-09-15.
    archetype: "live-sports-whale",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x16bb9951a36fce71e2ef57890b786145e0ba8492",
    label: "SDTrading (leaderboard #8)",
    archetype: "sports-systematic",
    source: "https://polymarket.com/@sdtrading",
  },
  {
    address: "0x6d20c35f65d9899b6d6b74f8466e824580f9a165",
    label: "Djdjdjekekek (leaderboard #1)",
    // Was "whale-conviction" here but README's own "Trader archetypes" table
    // already documents the real correction: 30 real orders, avg $79,597,
    // live tennis + LoL esports (not macro) — this field was just never
    // updated to match. Fixed 2026-09-15.
    archetype: "live-sports-whale",
    source: "https://polymarket.com/@djdjdjekekek",
  },
  {
    address: "0x204f72f35326db932158cba6adff0b9a1da95e14",
    label: "swisstony (monthly #2 / all-time #1)",
    archetype: "sports-scalper",
    source: "https://polymarket.com/@swisstony",
  },

  // Added from the ALL-TIME profit leaderboard (polymarket.com/leaderboard/overall/all/profit)
  // to find durable, high-win-rate strategies rather than a single good month.
  // Addresses came directly from the leaderboard's profile links
  // (polymarket.com/profile/0x...), NOT from fuzzy username search — for
  // Theo4 and Fredi9999 specifically, public-search's closest match was a
  // DIFFERENT, similarly-named account (e.g. "theo43", "RepTrum63" for
  // RepTrump) with no exact hit. Always prefer a direct leaderboard/profile
  // link over guessing from search results when names are this close.
  {
    address: "0x56687bf447db6ffa42ffe2204a05edaa20f55839",
    label: "Theo4 (all-time #2, +$22.05M/$43.07M vol, 51% profit/volume)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x1f2dd6d473f3e824cd2f8a89d9c69fb96f6ad0cf",
    label: "Fredi9999 (all-time #3, +$16.62M/$76.62M vol, 22% profit/volume)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0xed64a7bf029040aa331abc87902434d815ef217d",
    label: "fishalive (all-time #7, +$9.06M/$13.28M vol, 68% profit/volume — highest efficiency in top 20)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x96cfcb0c30942cfcd1cdf76c7d408794d66b1acb",
    label: "mintblade (all-time #6, +$9.24M/$17.76M vol, 52% profit/volume)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x3f87d51f27ba6e19ec52aaeebb68559a839c742c",
    label: "GRIMDRIP (all-time #13, +$7.60M/$13.60M vol, 56% profit/volume)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x863134d00841b2e200492805a01e1e2f5defaa53",
    label: "RepTrump (all-time #14, +$7.53M/$13.98M vol, 54% profit/volume — name suggests politics focus)",
    archetype: "one-shot-bet",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
    historyPages: 10,
  },
  {
    address: "0x6a72f61820b26b1fe4d956e17b6dc2a1ea3033ee",
    label: "kch123 (all-time #5, +$11.39M/$298.6M vol, 3.8% profit/volume — swisstony-style high volume)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x2005d16a84ceefa912d4e380cd32e7ff827875ea",
    label: "RN1 (all-time #4 AND monthly #7 — durable across both windows)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },

  // Added 2026-08-12: ranks 8-20 of the all-time profit leaderboard not
  // already covered above (ranks 1-7 and 14-15 were already tracked).
  // Backtested under Phase 1d (getActivityFromStart, reproducible) the same
  // day they were added — archetypes below reflect that, see README Phase
  // 1d for the numbers. Most of these confirmed the same one-shot-bet
  // pattern as the original 6: tiny distinct-market counts (1-9), several
  // concentrated in the same Oct-2024 US election window.
  {
    address: "0xbc11a64ab34a03a043fbe80598fa065ee87eeec6",
    label: "frostrizz (all-time #8, +$8.93M)",
    archetype: "one-shot-bet", // 6 distinct markets, 26-day total lifetime
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x78b9ac44a6d7d7a076c14e0ad518b301b63c6b76",
    label: "Len9311238 (all-time #9, +$8.71M)",
    archetype: "one-shot-bet", // 7 markets, 93% politics fills, Oct 2024 election window
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x664ce9fb97ae1bbd538d7381b2f4e92dab16f49c",
    label: "sparklingwater123 (all-time #10, +$8.47M)",
    archetype: "one-shot-bet", // 4 distinct markets, full history in <1 day
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x09b428f7c2b469786286214aa5c90dd9015f7320",
    label: "DEEDDIT (all-time #11, +$8.05M — Phase 1d: 84.6% win but NET NEGATIVE -15.4%, 11 markets, ruled out)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x2c335066fe58fe9237c3d3dc7b275c2a034a0563",
    label:
      "unnamed #12 (all-time #12, +$7.94M — Phase 1d: 60% win, 670 markets (largest sample of any wallet), roughly breakeven -1.6% net, not concentrated but not clearly profitable either)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0xd235973291b2b75ff4070e9c0b01728c520b0f29",
    label: "zxgngl (all-time #13, +$7.81M)",
    archetype: "one-shot-bet", // 2 distinct markets, 99.9% of fills in ONE market
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x5e4c3b5b81171e2ca4ab776ac0d6bba787f9dba2",
    label: "endlessFate (all-time #16, +$7.41M)",
    archetype: "one-shot-bet", // 9 markets, 27-day total lifetime
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0xf0318c32136c2db7fec88b84869aee6a1106c80c",
    label: "BreakTheBank (all-time #17, +$6.72M — Phase 1d: 73 markets but only 30.9% win rate, net -9.2%, ruled out)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x8119010a6e589062aa03583bb3f39ca632d9f887",
    label: "PrincessCaro (all-time #18, +$6.08M)",
    archetype: "one-shot-bet", // 19 markets but 79% politics fills, Oct 2024 election window
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0xe9ad918c7678cd38b12603a762e638a5d1ee7091",
    label: "walletmobile (all-time #19, +$5.94M)",
    archetype: "one-shot-bet", // literally 1 distinct market, 100% of fills
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },
  {
    address: "0x94f199fb7789f1aef7fff6b758d6b375100f4c7a",
    label:
      "KeyTransporter (all-time #20, +$5.71M — Phase 1d: 67.3% win, 15 markets, +45.7% net, reached full 24-day lifetime — borderline, small but not extreme sample)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/profit",
  },

  // Added 2026-08-14: after all 24 above were ruled out or dormant (Phase
  // 2 wallet-scoring, see docs/AUDIT.md), pivoted from the ALL-TIME
  // leaderboard (dominated by one-shot 2024-election bettors sitting
  // dormant for a year+) to the MONTHLY leaderboard instead, on the theory
  // that "profitable in the last 30 days" is a much better filter for
  // CURRENTLY-active traders than "profitable ever." Ranks 1,2,3,8,10 were
  // already tracked (unnamed #12, 0xE30E7, swisstony, SDTrading, RN1) —
  // only new ranks 4-20 added below. All scored the same day against the
  // project's target hit rate (user-specified: 53-55% win rate, not just
  // ">50%") — see each label for the result. Numbers below are from the
  // default 10-page (5000-fill) shallow pull; per this project's
  // established "early-slice bias" lesson (0x_exit, README Phase 1e), none
  // of these are confirmed until re-checked on deeper history.
  {
    address: "0xfe787d2da716d60e8acff57fb87eb13cd4d10319",
    label: "ferrariChampions2026 (monthly #4 — scored: 45.9% win, dormant+high-freq, ROI 4.9% — below hit-rate bar, RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x224a89dbe0db0d6124b335edabd15b3f877da3d5",
    label:
      "wr0ngw4yb3tt0r (monthly #5 — scored: 55.1% win (in target range) but dormant+uncopyable-high-freq, ROI 6.6% — RULED OUT on copyability)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x7ad71d79a3bb90d0a87a06500fa0fe11663842aa",
    label:
      "theowalcott (monthly #6 — scored: 59.7% win, ACTIVE (7.9d), ROI 5.5% — RULED OUT DEFINITIVELY on copyability: medianGapSeconds=0.0, i.e. near-simultaneous/same-block fills, not a borderline high-freq-threshold call)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x5268527977f700f9bf9b6d5cd843859e4e70135d",
    label: "HomeRunHazard (monthly #7 — scored: 45.5% win, dormant+high-freq, ROI 0.7% — below hit-rate bar, RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x13fa4ce1b8a27dd0b7a72db6205a50ee6ff0954c",
    label:
      "betterfasterstronger (monthly #9 — scored: insufficient-sample, events=0 (all activity unresolved/non-trade in the default pull window) — INCONCLUSIVE, not a pass or fail)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x5dab5ed9691fab220535891d9c7f5c28eed322e1",
    label:
      "Weaseloftheweek (monthly #11 — scored: 61.4% win, ACTIVE (1.0d), ROI 9.6%, $535K net — RULED OUT on copyability: medianGapSeconds=1.0, bot-speed execution no realistic follower latency can match, not a borderline call)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x6ac5bb06a9eb05641fd5e82640268b92f3ab4b6e",
    label:
      "Lakersfan111 (monthly #12 — scored: 48.8% win, dormant, ROI 21% — below hit-rate bar despite large 339-event sample, RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0xcd30f4698c6f5f3829893e68e183a8e5ea18f316",
    label: "111111111115 (monthly #13 — scored: 38.9% win, dormant+high-freq, ROI -36.3% — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x79ae097215202b5d01f98e4479fb219102469a4a",
    label:
      "CORGI8 (monthly #14 — scored: 44.1% win, no flags, ACTIVE (0.7d), 312 events, ROI 8.4% — clean/active/large sample but win rate below hit-rate bar, RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x1b20a00709dfe648afd26b326394b5e031f83ab0",
    label:
      "unnamed monthly #15 (+$335,860 — CONFIRMED on deeper history, 2026-08-14: historyPages=20 returned IDENTICAL numbers to the shallow pull — 53.1% win, no flags, 51 events, +35.7% ROI, $881K net — this wallet's entire ~14-day lifetime already fit under the old 5000-fill cap, so unlike 0x_exit this is NOT an early-slice artifact. No decay across its two active weeks (wk0 52.1% win/31.6% ROI -> wk1 68.3% win/81.7% ROI, improving not fading). Edge is concentrated in SPORTS (55.4% win/$668K net/790 trials) vs a much weaker 'other' category (51.9% win/$213K net/1483 trials) — treat as a sports-specific signal. Caveat: bootstrap 95% ROI CI is wide, -11.1% to +76.9%, still can't rule out a negative true edge; wallet joined Polymarket July 2026 so this IS its full track record, not a slice of a longer one. BEST CANDIDATE IN THE PROJECT — first Phase 3 paper-trading candidate, pending a go/no-go decision.)",
    archetype: "sports-systematic",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
    historyPages: 20,
  },
  {
    address: "0x4bff30af91642dc7d2b19a8664378fe55c45fc26",
    label: "Sassy-Bucket (monthly #16 — scored: 26.5% win, dormant+high-freq, ROI -36.9% — RULED OUT, badly negative)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x43372356634781eea88d61bbdd7824cdce958882",
    label: "Anjun (monthly #17 — scored: 59.1% win but dormant 1044 DAYS (~2.9yr) — ancient/irrelevant, RULED OUT despite win rate)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0xe40aaa5ce1dac0b7dc24c9d0284f27e17c3fe4a2",
    label:
      "Mysaria (monthly #18 — scored: 85.4% win but ROI ~0.0% ($-10 net) — extreme win rate is a near-certain-odds tiny-edge grinding pattern, not real profit; also uncopyable-high-freq. RULED OUT on economics despite the win-rate number)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0x03805a13a0b3e058f55f6c6af95389d4f431073d",
    label:
      "donthackme (monthly #19 — scored: 85.3% win but ROI 0.3% ($426 net) — same near-zero-profit-despite-high-win-rate pattern as Mysaria; also dormant+high-freq. RULED OUT on economics)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },
  {
    address: "0xbca08c1bc204a34f2fddbe47b438b9bd42ac9705",
    label:
      "1winstreak1 (monthly #20 — scored: 59.2% win but dormant 93.7 days, ROI 19.3%, $181K net, 222 events — win rate clears bar but stopped trading 3+ months ago, RULED OUT on dormancy)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/monthly/profit",
  },

  // Added 2026-08-16: pulled the WEEKLY leaderboard (currently-hottest
  // traders, an even shorter/fresher window than monthly) for a third
  // sourcing pass after 0x1b20a0... — 10 of the top 20 were already
  // tracked (unnamed #12, 0xE30E7, Sassy-Bucket, wr0ngw4yb3tt0r,
  // 111111111115, Lakersfan111, ferrariChampions2026, RN1, Mysaria,
  // swisstony — all previously ruled out), only the 10 new ones below.
  // Unscored, archetype unknown.
  {
    address: "0x9319a045cdd0c2180e5eb7ad44374383db9a6410",
    label: "sainttroplay (weekly #2 — scored: 100% win but one-shot/highly-concentrated/high-freq, 1 event — RULED OUT, pure noise)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x983eedfbd75803602e4a6e6ea9aab6dc6b9c6748",
    label:
      "3edmond.dantes (weekly #7 — scored: 100% win but one-shot/highly-concentrated/insufficient-sample, 1 event — RULED OUT, pure noise)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x3eb095d871501a1d7a3cb086a22d174b52356a68",
    label: "predictionlegend (weekly #11 — scored: 22.4% win, highly-concentrated+high-freq — RULED OUT, well below hit-rate bar)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x4b341d4612437b6e5b5fbcf98e5b675dbacf48a8",
    label:
      "musholius722 (weekly #12 — scored: 50% win, one-shot/highly-concentrated/insufficient-sample, 2 events — RULED OUT, pure noise)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x2f44fa076c8d2976ac6bea0ddfd9502bad2b93c2",
    label:
      "TennisLove (weekly #13 — scored: 100% win, NO FLAGS, ACTIVE, ROI 49.5%, but only 4 real events — too thin to trust despite the clean flag set. WATCH, not a candidate yet: re-score once it has more history)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0xee00ba338c59557141789b127927a55f5cc5cea1",
    label: "S-Works (weekly #16 — scored: 43.3% win, dormant 682.7 days (~1.9yr) — RULED OUT, below bar and ancient)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x7bc14171ccb0d3e6bac219ec6a76211826e28db4",
    label: "coali10 (weekly #17 — scored: 36.2% win, dormant+high-freq, 32.7% election share — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0xf23c5bc7b547867eb6532920144562718aa49f81",
    label:
      "g42gh6524h5h5 (weekly #18 — scored: 60.7% win, ACTIVE (0.0d), but uncopyable-high-freq (medianGapSeconds=1.0, bot-speed) — win rate clears bar, RULED OUT on copyability, same pattern as theowalcott/Weaseloftheweek)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0xa4b7b1814b0da33f2b61be4939976898aa476008",
    label: "midwicket72 (weekly #19 — scored: 47.2% win, dormant+high-freq — RULED OUT, below bar)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  {
    address: "0x04d5524a0a5af2eca6e39e03defc261d42fe66d8",
    label:
      "WTSA (weekly #20 — scored: 56.0% win, uncopyable-high-freq (medianGapSeconds=1.0), 17 events — win rate near/above bar but bot-speed execution + thin sample, RULED OUT on copyability)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/weekly/profit",
  },
  // Round 4 sourcing (2026-08-17): all-time/volume and weekly/volume boards
  // (a different sort metric than the profit boards already exhausted
  // above) — surfaces high-volume traders, not just high-profit ones.
  {
    address: "0xf201a19b43471261a3c1ba9247335d55270e527e",
    label:
      "unnamed (weekly-volume #18 — scored: 56.8% win, 116 events, ROI 13.2%, $106K net — clears hit-rate bar but dormant 170.6 days — RULED OUT on dormancy)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/week/volume",
  },
  {
    address: "0x5a218c7ad04135830a45c41aaed7294df7809318",
    label:
      "balthazar (weekly-volume #19 — scored: 57.3% win but dormant 234.5 days + uncopyable-high-freq (medianGapSeconds=0.0, bot-speed) — RULED OUT on both dormancy and copyability)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/week/volume",
  },
  {
    address: "0x6480542954b70a674a74bd1a6015dec362dc8dc5",
    label: "tripping (all-time-volume #5 — scored: 1.8% win, dormant, ROI -53.0%, -$12.5K net — RULED OUT, badly negative)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0xa61ef8773ec2e821962306ca87d4b57e39ff0abd",
    label:
      "risk-manager (all-time-volume #6 — scored: 3.2% win, dormant+uncopyable-high-freq, ROI -34.0%, -$6.7K net — RULED OUT, badly negative)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0xe9076a87c5ed90ef16e6fe6529c943baeca0cff6",
    label:
      "suntori (all-time-volume #7 — scored: 34.4% win, ROI -16.7% (-$12.6K net), 1379 events (largest sample this project has seen), dormant 145.5 days — RULED OUT, badly negative despite the huge sample)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0xd218e474776403a330142299f7796e8ba32eb5c9",
    label:
      "cigarettes (all-time-volume #8 — scored: 84.2% win but ROI 0.2% ($945 net) — near-zero-profit-despite-high-win-rate pattern (same as Mysaria/donthackme); also dormant+uncopyable-high-freq — RULED OUT on economics)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0xe90bec87d9ef430f27f9dcfe72c34b76967d5da2",
    label:
      "gmanas (all-time-volume #9 — scored: 53.3% win (clears bar), ROI 16.5%, $860K net, 128 events — but dormant 269.9 days + uncopyable-high-freq (medianGapSeconds=4.0) — RULED OUT on dormancy/copyability despite the win rate)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0x24c8cf69a0e0a17eee21f69d29752bfa32e823e1",
    label:
      "debased (all-time-volume #10 — scored: 54.4% win (clears bar) but ROI -6.0% (-$29.2K net), 263 events, dormant 869 days, medianGapSeconds=802 (human-speed, not bot) — RULED OUT on economics despite the win rate, another confirmation that win rate alone isn't sufficient)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0xc8ab97a9089a9ff7e6ef0688e6e591a066946418",
    label:
      "ArmageddonRewardsBilly (all-time-volume #11 — scored: 53.8% win (clears bar), ROI 6.1%, $23K net, 316 events — but dormant 559.3 days — RULED OUT on dormancy)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0xbddf61af533ff524d27154e589d2d7a81510c684",
    label:
      "Countryside (all-time-volume #12 — scored: 36.5% win (below hit-rate bar), ROI 6.4% net-positive despite low win rate ($161K net, longshot-payout pattern), 86 events, dormant 260.1 days — RULED OUT on win rate)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0x492442eab586f242b53bda933fd5de859c8a3782",
    label:
      "unnamed (all-time-volume #13 — scored: 49.5% win (below bar), ROI -5.8%, -$5.33M net, 381 events, dormant 208.0 days — RULED OUT, badly negative on a huge sample)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0x9d84ce0306f8551e02efef1680475fc0f1dc1344",
    label:
      "ImJustKen (all-time-volume #14 — scored: 56.6% win (clears bar), ROI 7.3%, $65.9K net, 66 events — but dormant 1154.4 DAYS (~3.2yr, ancient) — RULED OUT on dormancy)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0x2663daca3cecf3767ca1c3b126002a8578a8ed1f",
    label:
      "Q96s3kwozynxpau (all-time-volume #15 — scored: 24.8% win (well below bar), ROI 1.5% (near-breakeven, longshot-payout pattern), $581 net, 37 events, dormant 575.0 days — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0x9c667a1d1c1337c6dca9d93241d386e4ed346b66",
    label: "InfiniteCrypt0 (all-time-volume #16 — scored: 0.4% win, ROI -79.6%, dormant, 12 events — RULED OUT, badly negative)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0x2a2c53bd278c04da9962fcf96490e17f3dfb9bc1",
    label:
      "unnamed (all-time-volume #17 — scored: 64.5% win (strongly clears bar), ROI 11.3%, $1.30M net, 115 events — but dormant + uncopyable-high-freq (medianGapSeconds=2.0, bot-speed) — RULED OUT on copyability despite the strong numbers, same pattern as theowalcott/Weaseloftheweek)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0x507e52ef684ca2dd91f90a9d26d149dd3288beae",
    label:
      "GamblingIsAllYouNeed (all-time-volume #18 — scored: 49.7% win (below bar), ROI 3.9%, dormant+uncopyable-high-freq, 135 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0x2d27e4d20f3b8a2ee3bc861d9b83752f338676d8",
    label:
      "interstellaar (all-time-volume #19 — scored: 0.6% win, ROI -47.3%, dormant+highly-concentrated+uncopyable-high-freq, 12 events — RULED OUT, badly negative)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  {
    address: "0xfc25f141ed27bb1787338d2c4e7f51e3a15e1f7f",
    label:
      "-Malfunction (all-time-volume #20 — scored: 35.9% win (below bar), ROI -0.9% (near-breakeven negative), dormant, 174 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/overall/all/volume",
  },
  // User-sourced (2026-08-17): X post (@sopersone) claiming $313 -> $565,115
  // trading Bitcoin/Ethereum Up-or-Down 15-minute markets via order-book
  // depth-shift detection, "never guessed direction," 87,559 trades. Raw
  // /activity confirms this is a real, currently-active wallet — but early
  // inspection already shows two fills at the EXACT SAME timestamp with
  // different tx hashes, tiny $0.008 sizes, on 15-minute markets — the same
  // bot-speed shape this project has repeatedly ruled out on copyability
  // (theowalcott, Weaseloftheweek, unnamed all-time-volume #17).
  {
    address: "0xce25e214d5cfe4f459cf67f08df581885aae7fdc",
    label:
      "sopersone-sourced wallet (X post claim: $313->$565,115, Bitcoin/ETH Up-or-Down 15m markets, 87,559 trades — scored on EARLIEST 5000-fill slice only, historyPages too shallow for an 87K-trade wallet: 47.0% win (below bar), ROI 3.0%, uncopyable-high-freq (medianGapSeconds=0.0, same-timestamp fills confirmed) — RULED OUT on copyability regardless; 'dormant 109.1d' flag is a slice artifact, wallet is confirmed live-trading as of 2026-08-17, not actually dormant)",
    archetype: "unclassified",
    source: "https://x.com/sopersone/status/2089410888373776758",
    historyPages: 10,
  },
  // Added 2026-09-13 (Track E.13 follow-up): a sweep of data-api's 9
  // non-OVERALL leaderboard categories (POLITICS, SPORTS, ESPORTS, CRYPTO,
  // CULTURE, WEATHER, ECONOMICS, TECH, FINANCE) x MONTH/ALL windows, PNL-
  // ordered, via `npm run source-wallets` (src/research/sourceWallets.ts).
  // Top 3 per category by pnl, deduped against every wallet already above,
  // each run through the same scoreWallet() pipeline as everywhere else in
  // this file. 26 of 27 came back RULED OUT, almost all on `dormant`
  // (600+ days since last activity) — confirms category ALL-time
  // leaderboards mostly surface the same one-shot-big-win-then-inactive
  // pattern already ruled out repeatedly on the OVERALL leaderboard above,
  // just segmented by category instead of blended together. Recorded here
  // (including the ruled-out ones) so a future source-wallets rerun's
  // dedupe against TRACKED_WALLETS correctly skips all 27 instead of
  // re-scoring them from scratch. One candidate cleared with zero veto
  // flags — bin8888 below — but on a thin 22-event sample; not added to
  // live paper-trading, that's a separate decision.
  {
    address: "0x885783760858e1bd5dd09a3c3f916cfa251ac270",
    label:
      "BetTom42 (POLITICS all-time #8 — scored: 100% win, dormant+election-only+highly-concentrated+uncopyable-high-freq, ROI 98.6%, 4 events — RULED OUT, classic dormant 2024-election one-shot)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/politics/all/profit",
  },
  {
    address: "0x23786fdad0073692157c6d7dc81f281843a35fcb",
    label:
      "mikatrade77 (POLITICS all-time #9 — scored: 100% win, one-shot+dormant+election-only+highly-concentrated+uncopyable-high-freq, ROI 77.8%, 3 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/politics/all/profit",
  },
  {
    address: "0xd0c042c08f755ff940249f62745e82d356345565",
    label:
      "alexmulti (POLITICS all-time #10 — scored: 99.9% win, dormant+election-only+highly-concentrated+uncopyable-high-freq, ROI 93.5%, 4 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/politics/all/profit",
  },
  {
    address: "0xf2f6af4f27ec2dcf4072095ab804016e14cd5817",
    label: "gopfan2 (WEATHER all-time #1 — scored: 48.0% win, dormant, ROI 17.8%, 114 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/weather/all/profit",
  },
  {
    address: "0x594edb9112f526fa6a80b8f858a6379c8a2c1c11",
    label: "ColdMath (WEATHER all-time #3 — scored: 65.1% win, dormant, ROI 4.8%, 414 events — RULED OUT, near-breakeven)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/weather/all/profit",
  },
  {
    address: "0x75049bd489194be19c45c31ed311e556411c9c69",
    label: "ro0k (TECH all-time #6 — scored: 60.4% win, dormant, ROI 5.3%, 95 events — RULED OUT, near-breakeven)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/tech/all/profit",
  },
  {
    address: "0x17db3fcd93ba12d38382a0cade24b200185c5f6d",
    label:
      "fengdubiying (ESPORTS all-time #4 — scored: 83.6% win, dormant, ROI 27.4%, 86 events — RULED OUT, dormant despite decent numbers)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/esports/all/profit",
  },
  {
    address: "0xed107a85a4585a381e48c7f7ca4144909e7dd2e5",
    label:
      "qmarktea2 (ECONOMICS all-time #2 — scored: 95.2% win, dormant, ROI 3.5%, 171 events — RULED OUT, near-breakeven despite high win rate)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/all/profit",
  },
  {
    address: "0x17559efac103ac7f361be37ec0b93888d4c55aac",
    label: "CamelUp (FINANCE all-time #3 — scored: 54.5% win, dormant, ROI 8.9%, 126 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/finance/all/profit",
  },
  // The one clean survivor of this sweep: no veto flags, active as of
  // 1 day before scoring (2026-09-13) — genuinely live, not dormant. Still
  // Reviewed 2026-09-15 (IMPROVEMENT_PLAN.md item 35) and NOT added to
  // paper trading: wallet-breakdown + classifyArchetypes show the 22
  // "events" are 97% the same directional bet (WTI/Crude Oil price-
  // threshold ladders, same shape as 0x_exit's already-negative-
  // backtested ladder-harvester), profit concentrated in a March-June
  // 2026 run reading as one well-timed macro call, not a repeatable edge.
  {
    address: "0xa80e3fe5e7a445fa047fe6de1e27f9a15217b94b",
    label:
      "bin8888 (FINANCE all-time #2 — 85.9% win, ROI 33.3%, 22 events, netPnl=$492,238 — NOT paper-traded: re-reviewed 2026-09-15, 97% of fills are concentrated WTI/Crude Oil ladder bets, same shape already backtested negative via 0x_exit; still tracked for provenance)",
    archetype: "ladder-harvester",
    source: "https://polymarket.com/leaderboard/finance/all/profit",
  },
  {
    address: "0xf705fa045201391d9632b7f3cde06a5e24453ca7",
    label: "unnamed (CRYPTO all-time #2 — scored: 53.3% win, dormant, ROI 20.9%, 34 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/crypto/all/profit",
  },
  {
    address: "0x3a8aa345d5db7ec5138298c8c4f4540259be7699",
    label:
      "TheReturnOfDarthMaul (ECONOMICS monthly #1, also seen on FINANCE — scored: 79.7% win, dormant, ROI -2.1%, 717 events — RULED OUT, net negative despite high win rate on a well-powered sample)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/month/profit",
  },
  {
    address: "0x6af75d4e4aaf700450efbac3708cce1665810ff1",
    label: "gopfan (WEATHER all-time #4 — scored: 49.4% win, dormant, ROI 8.7%, 228 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/weather/all/profit",
  },
  {
    address: "0xee50a31c3f5a7c77824b12a941a54388a2827ed6",
    label: "0xafEe (TECH all-time #1 — scored: 76.4% win, dormant, ROI 20.2%, 68 events — RULED OUT, dormant despite decent numbers)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/tech/all/profit",
  },
  {
    address: "0x689ae12e11aa489adb3605afd8f39040ff52779e",
    label: "Annica (CULTURE all-time #2 — scored: 51.6% win, dormant, ROI 3.5%, 11 events — RULED OUT, near-breakeven, tiny sample)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/culture/all/profit",
  },
  {
    address: "0x063aeee10fbfd55b6def10da28e87a601e7deb4b",
    label:
      "noovd (CULTURE all-time #4 — scored: 15.8% win, dormant, ROI 14.1%, 67 events — RULED OUT, low win rate rescued by payout odds, not a real signal)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/culture/all/profit",
  },
  {
    address: "0x241f846866c2de4fb67cdb0ca6b963d85e56ef50",
    label:
      "Pestle (ECONOMICS all-time #1 — scored: 8.2% win, dormant, ROI -16.0%, 279 events — RULED OUT, badly negative on a well-powered sample)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/all/profit",
  },
  {
    address: "0xb0c85813a7a4428f1139ff91d3118a92c391fe7f",
    label:
      "bitcoin.gold (seen on POLITICS/CULTURE/TECH/FINANCE, best TECH all-time #4 — scored: 81.7% win, dormant+uncopyable-high-freq, ROI 0.2%, 175 events — RULED OUT, breakeven and bot-speed)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/tech/all/profit",
  },
  {
    address: "0xc2e7800b5af46e6093872b177b7a5e7f0563be51",
    label: "beachboy4 (SPORTS all-time #11 — scored: 46.8% win, dormant+uncopyable-high-freq, ROI -0.2%, 102 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/sports/all/profit",
  },
  {
    address: "0x006cc834cc092684f1b56626e23bedb3835c16ea",
    label:
      "unnamed (SPORTS all-time #14 — scored: 39.5% win, dormant, ROI 19.5%, 382 events — RULED OUT, below hit-rate bar despite positive ROI)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/sports/all/profit",
  },
  {
    address: "0xc257ea7e3a81ca8e16df8935d44d513959fa358e",
    label: "YT-JuicySlots (ESPORTS all-time #7 — scored: 41.9% win, dormant, ROI 3.4%, 93 events — RULED OUT, near-breakeven)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/esports/all/profit",
  },
  {
    address: "0x63ce342161250d705dc0b16df89036c8e5f9ba9a",
    label:
      "0x8dxd (CRYPTO all-time #1 — scored: 48.5% win, dormant+uncopyable-high-freq, ROI 0.3%, 54 events — RULED OUT, breakeven and bot-speed)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/crypto/all/profit",
  },
  {
    address: "0x44c1dfe43260c94ed4f1d00de2e1f80fb113ebc1",
    label:
      "aenews2 (seen on CRYPTO/CULTURE/WEATHER/TECH, best CULTURE all-time #3 — scored: 57.4% win, dormant, ROI -0.2%, 187 events — RULED OUT, breakeven)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/culture/all/profit",
  },
  {
    address: "0xe734e7bf7cfb9e464681f71822f6c2f6be514f0c",
    label: "boyau (FINANCE all-time #1 — scored: 30.7% win, dormant+highly-concentrated, ROI 6.7%, 20 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/finance/all/profit",
  },
  {
    address: "0xdc876e6873772d38716fda7f2452a78d426d7ab6",
    label: "432614799197 (SPORTS all-time #16 — scored: 43.7% win, dormant, ROI -24.9%, 84 events — RULED OUT, badly negative)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/sports/all/profit",
  },
  {
    address: "0xcc500cbcc8b7cf5bd21975ebbea34f21b5644c82",
    label:
      "justdance (CRYPTO all-time #3 — scored: 77.2% win, dormant+uncopyable-high-freq, ROI -24.0%, 43 events — RULED OUT, net negative despite high win rate)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/crypto/all/profit",
  },
  {
    address: "0xa5ea13a81d2b7e8e424b182bdc1db08e756bd96a",
    label: "bossoskil1 (ESPORTS all-time #1 — scored: 28.5% win, dormant, ROI -7.4%, 27 events — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/esports/all/profit",
  },
  // Added 2026-09-24 (IMPROVEMENT_PLAN.md items 40/41): the category-
  // leaderboard broaden pass, ranks 4-6 per category (54 candidates). 22
  // were skipped by the 1-call dormancy pre-check and are NOT recorded here
  // (cheap to re-check, and could become active again). The 32 below were
  // fully scored; most were first rescored shallow because the full
  // from-origin pull ran out of pages before reaching recent activity
  // (sourceWallets.ts truncation check). Shallow screens that cleared the
  // bar were re-scored from a pinned `historyStart` anchor
  // (`npm run confirm-shallow`) before being trusted.
  {
    address: "0x5966db1fe50763c9e3c014d756369bad07e1f804",
    label: "0x5966Db1f… (ESPORTS all-time #12 — shallow screen: 72/100, 89.4% win, ROI 41.4%, 25 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/esports/all/profit",
  },
  {
    address: "0x6011655c4afb76f36dd1b08a137a1ba73466b31e",
    label:
      "HighTempTation (WEATHER all-time #9 — CONFIRMED on pinned-anchor pull (historyStart 2026-06-24, 40 pages, reached present): 74/100 clean, 99.3% win, ROI 9.3%, 2267 events, netPnl=$76.6K, medianGapSeconds=12 — QUALITY WALLET, but a near-certainty favorite harvester: thin per-trade edge, copy delay may erase it)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/weather/all/profit",
    historyPages: 40,
    historyStart: 1782259200, // 2026-06-24 -- see item 41
  },
  {
    address: "0xa278b41b5afda5d18da683eb7f851a7b2dc13369",
    label: "caspar1248 (TECH monthly #1 — shallow screen: 69/100, 52.7% win, ROI 41.4%, 289 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/tech/month/profit",
  },
  {
    address: "0xc9a24fa249cf907c598544a4d46c077c1edf77d3",
    label: "0x7A3f9C2D… (ESPORTS monthly #4 — scored: 68/100, 77.4% win, ROI 48.2%, 11 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/esports/month/profit",
  },
  {
    address: "0x6979b1a23c14e5cf0c6d29310080841d19d4c2a3",
    label: "CryptoVagabond (CULTURE all-time #5 — scored: 67/100, 87.0% win, ROI 1104.8%, 7 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/culture/all/profit",
  },
  {
    address: "0xfea31bc088000ff909be1dfd8d0e3f2c7ef2d227",
    label:
      "ndb1 (SPORTS all-time #18 — CONFIRMED on pinned-anchor pull (historyStart 2026-06-24, 40 pages, reached present): 62/100 clean, 71.9% win, ROI 12.1%, 224 events, netPnl=$1.73M, medianGapSeconds=7 — QUALITY WALLET)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/sports/all/profit",
    historyPages: 40,
    historyStart: 1782259200, // 2026-06-24 -- full-from-origin pull cannot reach the present, see item 41
  },
  {
    address: "0xd570e634aeb745d6501566dba5f81a555cc7e4f8",
    label: "0xd9670ea7… (ESPORTS monthly #2 — scored: 66/100, 65.1% win, ROI 35.6%, 31 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/esports/month/profit",
  },
  {
    address: "0x55be7aa03ecfbe37aa5460db791205f7ac9ddca3",
    label:
      "coinman2 (CRYPTO all-time #5 — shallow 66 clean, but pinned-anchor confirm (40 pages, still truncated): ~20K fills in <3 months, medianGapSeconds=0 — RULED OUT, uncopyable bot-speed)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/crypto/all/profit",
  },
  {
    address: "0x6bab41a0dc40d6dd4c1a915b8c01969479fd1292",
    label: "Dropper (TECH all-time #5 — shallow screen: 63/100, 48.5% win, ROI 7.5%, 41 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/tech/all/profit",
  },
  {
    address: "0x31864feb9d25dee93728c6225ba891530967e9ca",
    label: "johnbaster (ESPORTS all-time #13 — shallow screen: 62/100, 68.2% win, ROI 3.9%, 37 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/esports/all/profit",
  },
  {
    address: "0x8c0b024c17831a0dde038547b7e791ae6a0d7aa5",
    label: "THEHIGHLIFE (ESPORTS all-time #8 — shallow screen: 61/100, 46.2% win, ROI 7.1%, 65 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/esports/all/profit",
  },
  {
    address: "0x32b484581fc5606de9c1e43af4636b6be9bc8b21",
    label:
      "0x32b48458… (FINANCE all-time #8 — shallow 59 clean, but pinned-anchor confirm (40 pages, still truncated): ~20K fills in <3 months, medianGapSeconds=2 — RULED OUT, uncopyable bot-speed)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/finance/all/profit",
  },
  {
    address: "0x34dd4a4b70eaf79a17878f7938263c801d4dfd83",
    label:
      "vito3corleone (SPORTS all-time #19 — scored (full history, reproducible): 57/100 clean, 39.4% win, ROI 47.7%, 13 events, netPnl=$4.70M, 23d since last activity — QUALITY WALLET (thin 13-event sample, low win rate carried by big payouts))",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/sports/all/profit",
  },
  {
    address: "0x111f73e91f85b6fe4de1ddec3de2fe32122e355b",
    label: "Papeasy (CRYPTO monthly #1 — shallow screen: 57/100, 0.0% win, ROI 0.0%, 0 events, insufficient-sample — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/crypto/month/profit",
  },
  {
    address: "0x1058f156b207cafe61d102e97bf6796931d301c1",
    label:
      "TheyAreTakingTheHobitsToIsengard (ECONOMICS monthly #4 — scored: 57/100, 82.4% win, ROI 58.5%, 219 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/month/profit",
  },
  {
    address: "0x0c0e270cf879583d6a0142fc817e05b768d0434e",
    label:
      "The Spirit of Ukraine>UMA (ECONOMICS all-time #8 — shallow screen: 54/100, 100.0% win, ROI 0.7%, 10 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/all/profit",
  },
  {
    address: "0x5ecde7348ea5100af4360dd7a6e0a3fb1d420787",
    label:
      "0xdc3E831cad (TECH monthly #4 — shallow 50 clean (ROI -5.6%), pinned-anchor confirm: only 1 event since 2026-06-24 — RULED OUT, one-shot recent activity)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/tech/month/profit",
  },
  {
    address: "0x0f37cb80dee49d55b5f6d9e595d52591d6371410",
    label: "Hans323 (WEATHER all-time #7 — shallow screen: 50/100, 65.0% win, ROI -2.0%, 138 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/weather/all/profit",
  },
  {
    address: "0x8afa03dd6974e44d00c4d14dcccb00c0ddf6adb6",
    label: "stupid22 (WEATHER monthly #1 — shallow screen: 50/100, 98.4% win, ROI -1.1%, 14 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/weather/month/profit",
  },
  {
    address: "0x4f1d5ae26fc31472966e951af3183308736d8de2",
    label: "e46m3 (TECH monthly #2 — shallow screen: 47/100, 61.9% win, ROI 5.0%, 13 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/tech/month/profit",
  },
  {
    address: "0x8f7a4b414417911e7e9bd738399874792cdbdb40",
    label: "duderr (WEATHER all-time #6 — shallow screen: 47/100, 44.2% win, ROI -3.7%, 85 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/weather/all/profit",
  },
  {
    address: "0x71edffd0d70a1da823ff07a3c6fc81457294d338",
    label: "pako (ECONOMICS all-time #6 — shallow screen: 44/100, 89.7% win, ROI 10.8%, 21 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/all/profit",
  },
  {
    address: "0xb40e89677d59665d5188541ad860450a6e2a7cc9",
    label:
      "Poligarch (WEATHER all-time #5 — shallow screen: 44/100, 43.8% win, ROI 5.4%, 12 events, clean but below qualityScore 50 bar — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/weather/all/profit",
  },
  {
    address: "0xc3ca1a42fd9217b2d02fb05980c1803af462688e",
    label:
      "ThePrinceThatWasPromised (ECONOMICS monthly #5 — scored: 41/100, 88.7% win, ROI 34.4%, 15 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/month/profit",
  },
  {
    address: "0x90ed5bffbffbfc344aa1195572d89719a398b5bc",
    label:
      "failstober (CULTURE all-time #6 — shallow screen: 39/100, 17.8% win, ROI 49.5%, 21 events, clean but below qualityScore 50 bar — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/culture/all/profit",
  },
  {
    address: "0xbaa2bcb5439e985ce4ccf815b4700027d1b92c73",
    label:
      "denizz (POLITICS all-time #15 — shallow screen: 35/100, 12.8% win, ROI 1.5%, 9 events, clean but below qualityScore 50 bar — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/politics/all/profit",
  },
  {
    address: "0x7b02b2bac2a30ed5e40b7094e734f4c3dc2a4991",
    label: "foodenjoyer (ECONOMICS all-time #4 — shallow screen: 35/100, 81.3% win, ROI 16.9%, 4 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/all/profit",
  },
  {
    address: "0x94a428cfa4f84b264e01f70d93d02bc96cb36356",
    label:
      "GCottrell93 (POLITICS all-time #12 — shallow screen: 34/100, 20.3% win, ROI -21.9%, 16 events, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/politics/all/profit",
  },
  {
    address: "0x0feb1bf966bc7f954c2da0293ae2fdc572c5db5d",
    label:
      "CentralCasting (ECONOMICS all-time #7 — shallow screen: 29/100, 23.7% win, ROI 41.9%, 9 events, highly-concentrated, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/economics/all/profit",
  },
  {
    address: "0xd7f85d0eb0fe0732ca38d9107ad0d4d01b1289e4",
    label: "tdrhrhhd (POLITICS all-time #16 — shallow screen: 22/100, 5.7% win, ROI 12.8%, 5 events, election-only — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/politics/all/profit",
  },
  {
    address: "0x349606c1b77f3ba668879cbc9347f15a44cf8fc4",
    label:
      "skk1ch (CULTURE all-time #10 — shallow screen: 16/100, 2.6% win, ROI -96.0%, 9 events, highly-concentrated, uncopyable-high-freq — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/culture/all/profit",
  },
  {
    address: "0xde242261bcd8d4320113f12230da34d705ca25a8",
    label: "PolymaREKT (FINANCE all-time #7 — shallow screen: 8/100, 0.1% win, ROI -95.4%, 17 events, highly-concentrated — RULED OUT)",
    archetype: "unclassified",
    source: "https://polymarket.com/leaderboard/finance/all/profit",
  },
];
