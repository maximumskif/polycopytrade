// Engine tests use a mocked fetch (same seam as tests/apiClient.test.ts) so
// market resolution doesn't hit the live API. The scenario is designed to
// show hold-to-resolution and mirror-exit genuinely diverging: the wallet
// buys 10 shares, sells half early at a worse price than the eventual
// resolution, then never touches the rest. Hold-to-resolution ignores the
// sell entirely; mirror-exit should show a smaller, more accurate P&L.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { __setFetchImplForTests, __resetFetchImplForTests } from "../src/api/client";
import { buildTrials, defaultBacktestConfig } from "../src/backtesting/engine";
import type { Activity } from "../src/api/schemas";

afterEach(() => {
  __resetFetchImplForTests();
});

function fakeResponse(body: unknown): Response {
  return { status: 200, ok: true, statusText: "OK", json: async () => body } as unknown as Response;
}

const resolvedYesMarket = {
  id: "m1",
  conditionId: "c1",
  question: "q",
  slug: "s",
  outcomes: '["Yes","No"]',
  outcomePrices: '["1","0"]',
  endDate: "2026-01-01",
  closed: true,
};

function mockMarketLookup() {
  __setFetchImplForTests(async () => fakeResponse([resolvedYesMarket]));
}

function fill(overrides: Partial<Activity>): Activity {
  return {
    timestamp: 0,
    conditionId: "c1",
    type: "TRADE",
    size: 0,
    usdcSize: 0,
    price: 0,
    side: "BUY",
    outcome: "Yes",
    title: "t",
    slug: "s",
    eventSlug: "e1",
    proxyWallet: "0xw",
    transactionHash: "tx",
    ...overrides,
  };
}

test("hold-to-resolution treats every BUY as an independent trial, ignoring sells", async () => {
  mockMarketLookup();
  const activity = [
    fill({ timestamp: 100, transactionHash: "tx1", side: "BUY", size: 10, usdcSize: 4, price: 0.4 }),
    fill({ timestamp: 150, transactionHash: "tx2", side: "SELL", size: 5, usdcSize: 3, price: 0.6 }),
  ];
  const config = defaultBacktestConfig({ resolutionTreatment: "hold-to-resolution", datasetCutoff: 1000 });
  const trials = await buildTrials("0xw", activity, config);

  assert.equal(trials.length, 1, "only the BUY becomes a trial; the SELL is ignored entirely");
  assert.equal(trials[0].won, true);
  assert.ok(Math.abs(trials[0].netReturn - 6) < 1e-9, "10 shares @ $1 payout - $4 staked = $6");
});

test("mirror-exit reflects the wallet's actual entry+exit, netting to a smaller P&L", async () => {
  mockMarketLookup();
  const activity = [
    fill({ timestamp: 100, transactionHash: "tx1", side: "BUY", size: 10, usdcSize: 4, price: 0.4 }),
    fill({ timestamp: 150, transactionHash: "tx2", side: "SELL", size: 5, usdcSize: 3, price: 0.6 }),
  ];
  const config = defaultBacktestConfig({ resolutionTreatment: "mirror-exit", datasetCutoff: 1000 });
  const trials = await buildTrials("0xw", activity, config);

  assert.equal(trials.length, 1);
  // Sold 5 @ 0.6 (cost 0.4) -> realized 5*0.2=1. Remaining 5 held to
  // resolution (Yes wins, settles at $1) -> 5*(1-0.4)=3. Total 4, not the
  // naive 6 a hold-to-resolution read of the same BUY would report.
  assert.ok(Math.abs(trials[0].netReturn - 4) < 1e-9, `expected netReturn ~4, got ${trials[0].netReturn}`);
});

test("dataset cutoff excludes fills after the frozen boundary", async () => {
  mockMarketLookup();
  const activity = [
    fill({ timestamp: 100, transactionHash: "tx1", side: "BUY", size: 10, usdcSize: 4, price: 0.4 }),
    fill({ timestamp: 2000, transactionHash: "tx2", side: "BUY", size: 10, usdcSize: 4, price: 0.4 }),
  ];
  const config = defaultBacktestConfig({ resolutionTreatment: "hold-to-resolution", datasetCutoff: 1000 });
  const trials = await buildTrials("0xw", activity, config);
  assert.equal(trials.length, 1, "the fill after the cutoff should not appear in the trial set");
});
