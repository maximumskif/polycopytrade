// Pure-logic tests for Track G.20's funding-source trace, using real
// (captured) Etherscan V2 payloads — same "real fixture, not a hand-built
// example" discipline as tests/schemas.test.ts. Fixtures pulled live
// 2026-09-15 against a real tracked wallet
// (0x1b20a00709dfe648afd26b326394b5e031f83ab0's earliest pUSD deposit and
// that deposit transaction's own receipt) — see
// src/markets/polygon/logDecoding.ts's file header for the full story.

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { TokenTxResponseSchema, TransactionReceiptEnvelopeSchema, EthCallEnvelopeSchema } from "../src/markets/polygon/schemas";
import { decodeErc20Transfer, findUserOperationSender, topicToAddress, ERC20_TRANSFER_TOPIC0 } from "../src/markets/polygon/logDecoding";
import { decodeAddressArrayResult } from "../src/markets/polygon/abiDecoding";

const tokentxFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/polygon-tokentx.sample.json"), "utf8"));
const receiptFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/polygon-receipt.sample.json"), "utf8"));
const safeOwnersFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/polygon-eth-call-safe-owners.sample.json"), "utf8"));
const notSafeFixture = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures/polygon-eth-call-not-safe.sample.json"), "utf8"));

test("TokenTxResponseSchema accepts a real pUSD tokentx response", () => {
  const parsed = TokenTxResponseSchema.parse(tokentxFixture);
  assert.equal(parsed.status, "1");
  assert.equal(parsed.result[0].tokenSymbol, "pUSD");
  // The real first entry is a mint: from the zero address, not a real depositor.
  assert.equal(parsed.result[0].from, "0x0000000000000000000000000000000000000000");
});

test("TransactionReceiptEnvelopeSchema accepts a real eth_getTransactionReceipt response", () => {
  const parsed = TransactionReceiptEnvelopeSchema.parse(receiptFixture);
  assert.ok(parsed.result);
  assert.ok(parsed.result!.logs.length > 0);
});

test("topicToAddress extracts the low-order 20 bytes from a 32-byte topic", () => {
  assert.equal(topicToAddress("0x0000000000000000000000001517e971652da29ee9aeb798d95b215603e73c80"), "0x1517e971652da29ee9aeb798d95b215603e73c80");
});

test("findUserOperationSender finds the real authorizing account in a real deposit transaction's logs", () => {
  const parsed = TransactionReceiptEnvelopeSchema.parse(receiptFixture);
  const sender = findUserOperationSender(parsed.result!.logs);
  // Confirmed live: this is NOT the trading proxy (0x1b20a0...) and NOT
  // any Polymarket infra contract -- a distinct, real authorizing account.
  assert.equal(sender, "0x1517e971652da29ee9aeb798d95b215603e73c80");
});

test("findUserOperationSender returns null when no UserOperationEvent is present", () => {
  assert.equal(findUserOperationSender([]), null);
  assert.equal(findUserOperationSender([{ address: "0xabc", topics: ["0xdeadbeef"], data: "0x" }]), null);
});

test("decodeErc20Transfer decodes the real pUSD mint log from the receipt fixture", () => {
  const parsed = TransactionReceiptEnvelopeSchema.parse(receiptFixture);
  const mintLog = parsed.result!.logs.find((l) => l.topics[0]?.toLowerCase() === ERC20_TRANSFER_TOPIC0 && l.address.toLowerCase() === "0xc011a7e12a19f7b1f670d46f03b03f3342e82dfb");
  assert.ok(mintLog);
  const decoded = decodeErc20Transfer(mintLog!);
  assert.ok(decoded);
  assert.equal(decoded!.from, "0x0000000000000000000000000000000000000000");
  assert.equal(decoded!.to, "0x1b20a00709dfe648afd26b326394b5e031f83ab0");
});

test("decodeErc20Transfer returns null for a non-Transfer log", () => {
  assert.equal(decodeErc20Transfer({ address: "0xabc", topics: ["0xnotatransfer"], data: "0x" }), null);
});

test("EthCallEnvelopeSchema accepts a real successful getOwners() response", () => {
  const parsed = EthCallEnvelopeSchema.parse(safeOwnersFixture);
  assert.ok("result" in parsed);
});

test("EthCallEnvelopeSchema accepts a real revert response from a non-Safe contract", () => {
  const parsed = EthCallEnvelopeSchema.parse(notSafeFixture);
  assert.ok("error" in parsed);
});

test("decodeAddressArrayResult decodes a real single-owner getOwners() result", () => {
  const parsed = EthCallEnvelopeSchema.parse(safeOwnersFixture);
  if (!("result" in parsed)) throw new Error("expected a result, not an error");
  const owners = decodeAddressArrayResult(parsed.result);
  assert.deepEqual(owners, ["0x0a26016918a1ad8e57b899ea9484ce0ac87d5255"]);
});

test("decodeAddressArrayResult decodes a hand-constructed two-owner array (standard ABI encoding, no live 2-owner Safe found to capture)", () => {
  const offset = "0".repeat(62) + "20";
  const length = "0".repeat(63) + "2";
  const owner1 = "0".repeat(24) + "1111111111111111111111111111111111111111";
  const owner2 = "0".repeat(24) + "2222222222222222222222222222222222222222";
  const owners = decodeAddressArrayResult(`0x${offset}${length}${owner1}${owner2}`);
  assert.deepEqual(owners, ["0x1111111111111111111111111111111111111111", "0x2222222222222222222222222222222222222222"]);
});

test("decodeAddressArrayResult returns an empty array for a too-short result", () => {
  assert.deepEqual(decodeAddressArrayResult("0x00"), []);
});
