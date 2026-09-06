// General-purpose indicators, adapted from the classic TradingView/technical-
// analysis toolkit (moving averages, RSI, Bollinger Bands, volume z-scores)
// for Polymarket's specific price behavior: every series is bounded [0,1]
// and pins to a hard 0-or-1 resolution at expiry, so "trend continuation"
// style indicators (Supertrend, MACD momentum) don't transfer well — there's
// no persistent trend to ride, just convergence to a binary outcome. What
// DOES transfer:
//
// - Volume-anomaly detection: 0x_exit's whole edge (retail piling onto a
//   longshot rung drags the "boring" rung's price down) is literally a
//   volume-spike phenomenon. A z-score on volume is the general form of the
//   ladder scanner's fixed 5-45c price band — it should catch the same
//   pattern in categories where price shape differs (weather, sports)
//   instead of hardcoding "5-45c" as if it were universal.
// - Mean-reversion bands (Bollinger-style) on a rung's own recent price
//   history: useful mid-cycle, before a market starts converging to its
//   resolution (the last ~10-20% of a window behaves like a coin snapping
//   to a magnet, not noise around a mean — bands should not be trusted late).
// - RSI-style extremity: same caveat — informative mid-cycle, meaningless
//   near expiry.
//
// None of this replaces the backtest in backtestLadder.ts; these are
// candidate SIGNALS for Phase 2 (paper trading) to test, not validated
// edges on their own.

export interface PricePoint {
  t: number;
  p: number;
}

export function sma(values: number[], period: number): (number | null)[] {
  return values.map((_, i) => {
    if (i < period - 1) return null;
    const window = values.slice(i - period + 1, i + 1);
    return window.reduce((a, b) => a + b, 0) / period;
  });
}

export function stddev(values: number[], period: number): (number | null)[] {
  const means = sma(values, period);
  return values.map((_, i) => {
    const mean = means[i];
    if (mean === null) return null;
    const window = values.slice(i - period + 1, i + 1);
    const variance = window.reduce((a, b) => a + (b - mean) ** 2, 0) / period;
    return Math.sqrt(variance);
  });
}

// Bollinger-style bands on price. Only meaningful outside the "last 15% of
// the window converging to resolution" zone — see file header.
export function bollingerBands(prices: number[], period = 20, numStdDev = 2) {
  const mean = sma(prices, period);
  const sd = stddev(prices, period);
  return prices.map((_, i) => {
    if (mean[i] === null || sd[i] === null) return null;
    return { mid: mean[i]!, upper: mean[i]! + numStdDev * sd[i]!, lower: mean[i]! - numStdDev * sd[i]! };
  });
}

// Wilder's RSI, standard formula, applied to a price series bounded [0,1]
// instead of an unbounded asset price — same math, different intuition:
// high RSI here means "this rung has been getting more expensive fast",
// not "overbought" in the traditional continuation sense.
export function rsi(prices: number[], period = 14): (number | null)[] {
  const out: (number | null)[] = new Array(prices.length).fill(null);
  if (prices.length <= period) return out;

  let gainSum = 0;
  let lossSum = 0;
  for (let i = 1; i <= period; i++) {
    const change = prices[i] - prices[i - 1];
    if (change > 0) gainSum += change;
    else lossSum -= change;
  }
  let avgGain = gainSum / period;
  let avgLoss = lossSum / period;
  out[period] = rsiFromAverages(avgGain, avgLoss);

  for (let i = period + 1; i < prices.length; i++) {
    const change = prices[i] - prices[i - 1];
    const gain = change > 0 ? change : 0;
    const loss = change < 0 ? -change : 0;
    avgGain = (avgGain * (period - 1) + gain) / period;
    avgLoss = (avgLoss * (period - 1) + loss) / period;
    out[i] = rsiFromAverages(avgGain, avgLoss);
  }
  return out;
}

function rsiFromAverages(avgGain: number, avgLoss: number): number {
  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

// Volume z-score: how many standard deviations is this market's volume
// above its own recent baseline. This is the generalizable form of "retail
// is piling into the longshot rung right now" — usable in any category
// (crypto ladders, weather ladders, sports props), not just the 5-45c BTC/
// WTI band that happens to work for the specific pattern 0x_exit described.
export function volumeZScore(volumes: number[], period = 10): (number | null)[] {
  const means = sma(volumes, period);
  const sds = stddev(volumes, period);
  return volumes.map((v, i) => {
    if (means[i] === null || sds[i] === null || sds[i] === 0) return null;
    return (v - means[i]!) / sds[i]!;
  });
}
