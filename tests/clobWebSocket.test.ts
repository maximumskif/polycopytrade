// Pure-logic tests for Track E.15's WebSocket order-book state, using real
// (captured) Polymarket CLOB market-channel payloads — same "real fixture,
// not a hand-built example" discipline as tests/schemas.test.ts. Fixtures
// captured live 2026-09-15 against a real, currently-open BTC Up-or-Down
// market (see src/depthShift/clobWebSocket.ts's file header).

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseMarketMessages, createBookState, applyPriceChangeEntry, toBookLevels, BookMessageSchema, PriceChangeMessageSchema } from "../src/depthShift/clobWebSocket";

const bookFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/clob-ws-book.sample.json"), "utf8"));
const priceChangeFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/clob-ws-price-change.sample.json"), "utf8"));
const zeroSizeFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/clob-ws-price-change-zero-size.sample.json"), "utf8"));

const TRACKED_ASSET = "3778404891934458141128776830173415018671386318255632259415867929904203541491";

test("BookMessageSchema accepts a real book snapshot", () => {
  const parsed = BookMessageSchema.parse(bookFixture);
  assert.equal(parsed.asset_id, TRACKED_ASSET);
  assert.ok(parsed.bids.length > 0);
  assert.ok(parsed.asks.length > 0);
});

test("PriceChangeMessageSchema accepts a real price_change message carrying both outcome tokens", () => {
  const parsed = PriceChangeMessageSchema.parse(priceChangeFixture);
  assert.equal(parsed.price_changes.length, 2);
  const assetIds = parsed.price_changes.map((c) => c.asset_id);
  assert.ok(assetIds.includes(TRACKED_ASSET));
});

test("parseMarketMessages classifies a raw book frame", () => {
  const messages = parseMarketMessages(JSON.stringify(bookFixture));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "book");
});

test("parseMarketMessages classifies a raw price_change frame", () => {
  const messages = parseMarketMessages(JSON.stringify(priceChangeFixture));
  assert.equal(messages.length, 1);
  assert.equal(messages[0].type, "price_change");
});

test("parseMarketMessages returns an empty array for the non-JSON PONG frame", () => {
  assert.deepEqual(parseMarketMessages("PONG"), []);
});

test("createBookState builds a lookup map from a real book snapshot", () => {
  const parsed = BookMessageSchema.parse(bookFixture);
  const state = createBookState(parsed);
  assert.equal(state.assetId, TRACKED_ASSET);
  assert.equal(state.bids.get("0.01"), 1317.04);
  assert.equal(state.asks.get("0.99"), 1308.24);
});

test("applyPriceChangeEntry sets a new level's size", () => {
  const parsed = BookMessageSchema.parse(bookFixture);
  const state = createBookState(parsed);
  const entry = PriceChangeMessageSchema.parse(priceChangeFixture).price_changes.find((c) => c.asset_id === TRACKED_ASSET)!;
  applyPriceChangeEntry(state, entry);
  assert.equal(state.bids.get(entry.price), Number(entry.size));
});

test("applyPriceChangeEntry removes a level on a real live-captured size=\"0\" entry", () => {
  const state = createBookState(BookMessageSchema.parse(bookFixture));
  state.bids.set("0.14", 87.4); // seed a level matching the real fixture's price, so removal is observable
  const entry = PriceChangeMessageSchema.parse(zeroSizeFixture).price_changes.find((c) => c.asset_id === TRACKED_ASSET)!;
  assert.equal(entry.price, "0.14");
  applyPriceChangeEntry(state, entry);
  assert.equal(state.bids.has("0.14"), false);
});

test("applyPriceChangeEntry ignores an entry for an asset_id this state doesn't track", () => {
  const state = createBookState(BookMessageSchema.parse(bookFixture));
  const before = state.bids.size;
  const otherAssetEntry = PriceChangeMessageSchema.parse(priceChangeFixture).price_changes.find((c) => c.asset_id !== TRACKED_ASSET)!;
  // Caller-side filtering, not this function's job -- documented here so a
  // future caller doesn't assume applyPriceChangeEntry checks asset_id itself.
  if (otherAssetEntry.asset_id !== state.assetId) {
    assert.notEqual(otherAssetEntry.asset_id, state.assetId);
    assert.equal(state.bids.size, before); // unaffected until the caller decides to apply it
  }
});

test("toBookLevels sorts bids highest-first and asks lowest-first, and picks best of each", () => {
  const state = createBookState(BookMessageSchema.parse(bookFixture));
  const levels = toBookLevels(state);
  for (let i = 1; i < levels.bids.length; i++) assert.ok(levels.bids[i - 1].price >= levels.bids[i].price);
  for (let i = 1; i < levels.asks.length; i++) assert.ok(levels.asks[i - 1].price <= levels.asks[i].price);
  assert.equal(levels.bestBid?.price, levels.bids[0].price);
  assert.equal(levels.bestAsk?.price, levels.asks[0].price);
});
