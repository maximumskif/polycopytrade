// Daily sharp-line snapshot for the paper market-making test (item 76,
// 2026-09-29). Item 74 found Polymarket's sports asks sit at Pinnacle's
// fair price plus a spread -- no taker edge -- so the remaining sports idea
// is the MAKER side: rest bids below Pinnacle fair value and let takers
// fill them. This script records, once a day, every upcoming game's
// Pinnacle de-vigged fair probabilities next to the matched Polymarket
// moneyline token(s) and book; `npm run mm-paper-eval` later replays the
// real Polymarket trade tape against hypothetical resting bids.
//
// The Odds API (free tier, 500 credits/month): one h2h call per sport in
// the `eu` region = 1 credit and covers every upcoming game; the `eu`
// region carries Pinnacle. Rows WITHOUT a Pinnacle line are dropped --
// item 74 found the Betfair-exchange fallback full of empty-book 1/2, 1/3
// placeholders. Key: ODDS_API_KEY in .env.
//
// Sports with no Polymarket game in the next 8 days cost nothing (the
// odds call is skipped), so off-season leagues can stay listed.
//
// Matching: Polymarket game events have slugs "<league>-<a>-<b>-<date>"
// and markets with sportsMarketType=moneyline -- one 2-outcome market
// (US sports, basketball, hockey) or three Yes/No markets (soccer: team A,
// draw, team B). Teams match on name tokens (>= half of the shorter name)
// and start time (+/- 12h).
//
// Usage: npm run odds-snapshot -- [--sports=a,b,...] [--out=data/mm-paper/snapshots.jsonl]

import "dotenv/config";
import { z } from "zod";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { fetchRaw } from "../api/client";
import { validateSchema } from "../utils/validateSchema";

const GAMMA_API = "https://gamma-api.polymarket.com";
const ODDS_API = "https://api.the-odds-api.com/v4";

// Odds API sport key -> Polymarket game-slug prefix. Chosen from item 74's
// survey of leagues with Polymarket moneylines; ~12 credits/day.
export const SPORTS: Record<string, string> = {
  americanfootball_nfl: "nfl",
  americanfootball_ncaaf: "cfb",
  icehockey_nhl: "nhl",
  basketball_nba: "nba",
  baseball_mlb: "mlb",
  soccer_epl: "epl",
  soccer_spain_la_liga: "lal",
  soccer_italy_serie_a: "sea",
  soccer_germany_bundesliga: "bun",
  soccer_france_ligue_one: "fl1",
  soccer_usa_mls: "mls",
  basketball_euroleague: "euroleague",
  soccer_uefa_nations_league: "unl",
  icehockey_sweden_hockey_league: "shl",
  mma_mixed_martial_arts: "ufc",
  soccer_england_league1: "el1",
  soccer_brazil_serie_b: "bra2",
  soccer_argentina_primera_division: "arg",
  baseball_kbo: "kbo",
};
// Stop spending once the monthly quota gets this low.
export const MIN_CREDITS = 20;

const OddsGameSchema = z.object({
  id: z.string(),
  commence_time: z.string(),
  home_team: z.string(),
  away_team: z.string(),
  bookmakers: z.array(
    z.object({
      key: z.string(),
      markets: z.array(z.object({ key: z.string(), outcomes: z.array(z.object({ name: z.string(), price: z.number() })) })),
    })
  ),
});
type OddsGame = z.infer<typeof OddsGameSchema>;

const PmMarketSchema = z.looseObject({
  conditionId: z.string(),
  question: z.string().optional(),
  groupItemTitle: z.string().optional(),
  outcomes: z.string().optional(),
  clobTokenIds: z.string().optional(),
  sportsMarketType: z.string().nullable().optional(),
  gameStartTime: z.string().nullable().optional(),
  bestBid: z.number().nullable().optional(),
  bestAsk: z.number().nullable().optional(),
  acceptingOrders: z.boolean().optional(),
});
const PmEventSchema = z.looseObject({
  slug: z.string(),
  title: z.string().optional(),
  markets: z.array(PmMarketSchema).nullable().optional(),
});
type PmEvent = z.infer<typeof PmEventSchema>;

const STOP = new Set([
  "fc",
  "afc",
  "cf",
  "cd",
  "sc",
  "ac",
  "ca",
  "club",
  "de",
  "the",
  "ud",
  "sd",
  "rc",
  "if",
  "hc",
  "bk",
  "ik",
  "hk",
  "and",
]);
export function nameTokens(s: string): Set<string> {
  const ascii = s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();
  return new Set((ascii.match(/[a-z0-9]+/g) ?? []).filter((w) => w.length > 1 && !STOP.has(w)));
}
export function nameSim(a: string, b: string): number {
  const A = nameTokens(a);
  const B = nameTokens(b);
  let hit = 0;
  for (const w of A) if (B.has(w)) hit++;
  return hit / Math.max(1, Math.min(A.size, B.size));
}

// Proportional de-vig of one bookmaker's h2h prices; null if absent.
export function fairProbs(game: OddsGame, book: string): Record<string, number> | null {
  const h2h = game.bookmakers.find((b) => b.key === book)?.markets.find((m) => m.key === "h2h");
  if (!h2h || h2h.outcomes.length < 2) return null;
  const inv = h2h.outcomes.map((o) => [o.name, 1 / o.price] as const);
  const total = inv.reduce((s, [, v]) => s + v, 0);
  return Object.fromEntries(inv.map(([k, v]) => [k, v / total]));
}

// One quotable side: the token we would rest a bid on, and its fair value.
export interface Side {
  label: string; // Polymarket outcome / market title
  conditionId: string;
  tokenId: string;
  fair: number;
  pmBid: number | null;
  pmAsk: number | null;
}

// Polymarket moneyline sides of one game event, with bid/ask per token.
export function pmSides(event: PmEvent): { label: string; conditionId: string; tokenId: string; bid: number | null; ask: number | null }[] {
  const ml = (event.markets ?? []).filter((m) => m.sportsMarketType === "moneyline" && m.acceptingOrders);
  if (ml.length === 1) {
    const m = ml[0];
    const outs: string[] = JSON.parse(m.outcomes ?? "[]");
    const toks: string[] = JSON.parse(m.clobTokenIds ?? "[]");
    if (outs.length !== 2 || toks.length !== 2 || outs[0] === "Yes") return [];
    const bid = m.bestBid ?? null;
    const ask = m.bestAsk ?? null;
    return [
      { label: outs[0], conditionId: m.conditionId, tokenId: toks[0], bid, ask },
      {
        label: outs[1],
        conditionId: m.conditionId,
        tokenId: toks[1],
        bid: ask === null ? null : 1 - ask,
        ask: bid === null ? null : 1 - bid,
      },
    ];
  }
  return ml.flatMap((m) => {
    const toks: string[] = JSON.parse(m.clobTokenIds ?? "[]");
    if (toks.length !== 2) return [];
    return [
      {
        label: m.groupItemTitle || m.question || m.conditionId,
        conditionId: m.conditionId,
        tokenId: toks[0],
        bid: m.bestBid ?? null,
        ask: m.bestAsk ?? null,
      },
    ];
  });
}

// Match a Polymarket game to an odds game and attach Pinnacle fair values.
export function matchSides(event: PmEvent, games: OddsGame[]): { game: OddsGame; sides: Side[] } | null {
  const sides = pmSides(event);
  const teams = sides.filter((s) => !/draw/i.test(s.label));
  if (teams.length !== 2) return null;
  const start = (event.markets ?? []).find((m) => m.gameStartTime)?.gameStartTime;
  const startMs = start ? Date.parse(start.replace(" ", "T").replace(/\+00$/, "Z")) : NaN;
  let best: { score: number; game: OddsGame } | null = null;
  for (const g of games) {
    if (Number.isFinite(startMs) && Math.abs(Date.parse(g.commence_time) - startMs) > 12 * 3600_000) continue;
    const s1 = Math.max(nameSim(teams[0].label, g.home_team), nameSim(teams[0].label, g.away_team));
    const s2 = Math.max(nameSim(teams[1].label, g.home_team), nameSim(teams[1].label, g.away_team));
    if (s1 >= 0.5 && s2 >= 0.5 && (!best || s1 + s2 > best.score)) best = { score: s1 + s2, game: g };
  }
  if (!best) return null;
  const fair = fairProbs(best.game, "pinnacle");
  if (!fair) return null;
  const out: Side[] = [];
  for (const s of sides) {
    const key = /draw/i.test(s.label)
      ? Object.keys(fair).find((k) => k.toLowerCase() === "draw")
      : Object.keys(fair).find((k) => k.toLowerCase() !== "draw" && nameSim(s.label, k) >= 0.5);
    if (!key) return null; // a side we can't price -> skip the whole game
    out.push({ label: s.label, conditionId: s.conditionId, tokenId: s.tokenId, fair: fair[key], pmBid: s.bid, pmAsk: s.ask });
  }
  return { game: best.game, sides: out };
}

export interface SnapshotRow {
  ts: number;
  sport: string;
  eventSlug: string;
  title?: string;
  commenceTime: string;
  sides: Side[];
}

async function oddsFor(sport: string, key: string): Promise<{ games: OddsGame[]; remaining: string | null }> {
  const res = await fetch(`${ODDS_API}/sports/${sport}/odds?apiKey=${key}&regions=eu&markets=h2h&oddsFormat=decimal`);
  if (!res.ok) throw new Error(`odds ${sport}: ${res.status} ${await res.text()}`);
  return {
    games: validateSchema(z.array(OddsGameSchema), await res.json(), `odds ${sport}`),
    remaining: res.headers.get("x-requests-remaining"),
  };
}

async function pmGameEvents(days: number): Promise<PmEvent[]> {
  const now = new Date();
  const seen = new Map<string, PmEvent>();
  for (const tag of ["sports", "soccer", "hockey", "basketball", "football", "baseball"]) {
    for (let offset = 0; offset < 2000; offset += 100) {
      const qs = new URLSearchParams({
        closed: "false",
        active: "true",
        limit: "100",
        offset: String(offset),
        tag_slug: tag,
        end_date_min: now.toISOString(),
        end_date_max: new Date(now.getTime() + days * 86400_000).toISOString(),
      });
      let page: PmEvent[];
      try {
        page = validateSchema(z.array(PmEventSchema), await fetchRaw(`${GAMMA_API}/events?${qs.toString()}`), `GET /events (${tag})`);
      } catch {
        break;
      }
      for (const e of page) if (/^[a-z0-9]+-[a-z0-9]+-[a-z0-9]+-\d{4}-\d{2}-\d{2}/.test(e.slug)) seen.set(e.slug, e);
      if (page.length < 100) break;
    }
  }
  return [...seen.values()];
}

export async function main() {
  const argv = process.argv.slice(2);
  const get = (n: string) => argv.find((a) => a.startsWith(`--${n}=`))?.split("=")[1];
  const key = process.env.ODDS_API_KEY;
  if (!key) throw new Error("ODDS_API_KEY missing from .env");
  const sports = get("sports")?.split(",") ?? Object.keys(SPORTS);
  const out = get("out") ?? "data/mm-paper/snapshots.jsonl";
  mkdirSync(dirname(out), { recursive: true });
  const events = await pmGameEvents(8);
  const ts = Math.floor(Date.now() / 1000);
  let remaining: string | null = null;
  let totalRows = 0;
  for (const sport of sports) {
    const prefix = SPORTS[sport];
    if (!prefix) throw new Error(`unknown sport ${sport}`);
    const pm = events.filter((e) => e.slug.startsWith(`${prefix}-`));
    if (pm.length === 0) {
      console.log(`  ${sport}: no Polymarket games -- skipped (no credit spent)`);
      continue;
    }
    if (remaining !== null && Number(remaining) < MIN_CREDITS) {
      console.log(`  ${sport}: only ${remaining} odds credits left -- stopping`);
      break;
    }
    let games: OddsGame[];
    try {
      ({ games, remaining } = await oddsFor(sport, key));
    } catch (err) {
      console.error(`  ${sport}: ${(err as Error).message}`);
      continue;
    }
    let rows = 0;
    for (const e of pm) {
      const m = matchSides(e, games);
      if (!m) continue;
      const row: SnapshotRow = { ts, sport, eventSlug: e.slug, title: e.title, commenceTime: m.game.commence_time, sides: m.sides };
      appendFileSync(out, JSON.stringify(row) + "\n");
      rows++;
    }
    totalRows += rows;
    console.log(`  ${sport}: ${pm.length} Polymarket games, ${games.length} odds games, ${rows} matched with a Pinnacle line`);
  }
  console.log(`Summary: ${totalRows} games snapshotted to ${out}; odds credits remaining ${remaining ?? "?"}`);
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
