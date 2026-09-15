// New capability for the "small edge, high win rate, compound the
// bankroll" strategy question (docs/IMPROVEMENT_PLAN.md's favorite-
// harvesting track, 2026-09-15) -- every other backtest in this project
// measures AGGREGATE stats (flat stake per trial, order-independent). None
// of them simulate a growing/shrinking bankroll across a sequence of real
// bets, which is the actual mechanism "small wins compound" describes.
// This is that missing piece: pure, order-dependent, restakes a fraction of
// CURRENT bankroll after every bet instead of a fixed dollar amount.
//
// Deliberately conservative by default: fractional Kelly, not full Kelly.
// Full Kelly-optimal sizing is famously too aggressive for real capital
// (correct on average, catastrophic swings along the way) -- this project's
// own existing discipline already prefers a bootstrap-CI LOWER BOUND over a
// raw point estimate for exactly this reason (computeQualityScore's
// roiLowerBound). Same idea here: size off a conservative win-probability
// estimate, not the raw observed win rate, and scale Kelly itself down by a
// caller-chosen multiplier (0.25 = "quarter Kelly" is a common
// real-world-practitioner default, not this project's own finding).

// Fraction of bankroll Kelly's criterion says to stake on a single bet at
// price `price` (cost per $1 of payout) given true win probability `pWin`.
// b = net profit per $1 staked on a win = (1/price - 1); f* = pWin - (1-pWin)/b.
// Returns 0 (never a negative stake) when the edge is zero or negative, or
// price is out of (0,1) range (already-resolved / invalid).
export function kellyFraction(pWin: number, price: number): number {
  if (price <= 0 || price >= 1) return 0;
  const b = 1 / price - 1;
  if (b <= 0) return 0;
  const f = pWin - (1 - pWin) / b;
  return Math.max(0, f);
}

// Wilson score interval lower bound for a binomial proportion -- standard,
// closed-form (no resampling needed, unlike statistics.ts's bootstrap CI,
// which is for the correlated-by-event ROI case; a plain win/loss count
// across independent bets doesn't need that machinery). Used to turn a
// raw observed win rate into a CONSERVATIVE estimate for bet sizing --
// same "don't size off the raw point estimate" discipline as
// computeQualityScore's roiLowerBound.
export function wilsonLowerBound(wins: number, n: number, z = 1.96): number {
  if (n === 0) return 0;
  const p = wins / n;
  const z2 = z * z;
  const denominator = 1 + z2 / n;
  const center = p + z2 / (2 * n);
  const margin = z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n));
  return Math.max(0, (center - margin) / denominator);
}

export interface BankrollBet {
  won: boolean;
  price: number; // entry price paid, in (0, 1)
}

export interface BankrollSimOptions {
  startingBankroll?: number; // default 1000
  pWinEstimate: number; // conservative win-probability estimate driving sizing -- caller's job to pick a lower-bound, not the raw observed rate
  kellyFractionMultiplier?: number; // default 0.25 (quarter Kelly)
  maxStakeFraction?: number; // hard cap per bet regardless of Kelly's own suggestion, default 0.1 (10% of current bankroll)
}

export interface BankrollSimResult {
  startingBankroll: number;
  finalBankroll: number;
  multiple: number; // finalBankroll / startingBankroll
  peakBankroll: number;
  maxDrawdownPct: number; // peak-to-trough fraction of the peak, 0-1
  betsPlaced: number; // bets that actually staked > 0 (a zero/negative Kelly edge skips the bet, not force it)
  wins: number;
  busted: boolean; // bankroll hit 0 before the sequence finished
  bankrollCurve: number[]; // bankroll after each bet in order, starting value first
}

// `trialsInOrder` must already be chronologically ordered by the caller
// (this function does not sort -- order IS the input, sequential
// compounding only means anything in a fixed time order).
export function simulateBankroll(trialsInOrder: BankrollBet[], opts: BankrollSimOptions): BankrollSimResult {
  const startingBankroll = opts.startingBankroll ?? 1000;
  const kellyMult = opts.kellyFractionMultiplier ?? 0.25;
  const maxStakeFraction = opts.maxStakeFraction ?? 0.1;

  let bankroll = startingBankroll;
  let peak = startingBankroll;
  let maxDrawdownPct = 0;
  let wins = 0;
  let betsPlaced = 0;
  let busted = false;
  const bankrollCurve = [bankroll];

  for (const bet of trialsInOrder) {
    if (busted) break;
    const stakeFraction = Math.min(kellyFraction(opts.pWinEstimate, bet.price) * kellyMult, maxStakeFraction);
    if (stakeFraction <= 0) {
      bankrollCurve.push(bankroll); // no edge (per this sizing rule) -- skip, not force a bet
      continue;
    }
    const stake = bankroll * stakeFraction;
    const shares = stake / bet.price;
    bankroll += bet.won ? shares - stake : -stake;
    betsPlaced++;
    if (bet.won) wins++;

    peak = Math.max(peak, bankroll);
    if (peak > 0) maxDrawdownPct = Math.max(maxDrawdownPct, (peak - bankroll) / peak);
    bankrollCurve.push(bankroll);

    if (bankroll <= 0) {
      bankroll = 0;
      busted = true;
      bankrollCurve[bankrollCurve.length - 1] = 0;
    }
  }

  return {
    startingBankroll,
    finalBankroll: bankroll,
    multiple: bankroll / startingBankroll,
    peakBankroll: peak,
    maxDrawdownPct,
    betsPlaced,
    wins,
    busted,
    bankrollCurve,
  };
}
