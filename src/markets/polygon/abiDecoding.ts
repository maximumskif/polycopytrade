// Minimal, purpose-built ABI return-value decoding — just enough to read
// an `address[]` result from `eth_call`, not a general ABI library (this
// project has no other on-chain read that needs one; pulling in a full ABI
// decoder for one function would be a heavier dependency than the problem
// warrants). Standard Solidity ABI encoding for a dynamic array return
// value (a spec, not something that needs live verification the way a
// provider's own API shape does): a 32-byte offset word, then a 32-byte
// length word at that offset, then `length` right-aligned 32-byte address
// words.

export function decodeAddressArrayResult(hex: string): string[] {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  if (clean.length < 128) return []; // too short to hold even offset+length -- not the expected shape
  const length = parseInt(clean.slice(64, 128), 16);
  const addresses: string[] = [];
  for (let i = 0; i < length; i++) {
    const wordStart = 128 + i * 64;
    const word = clean.slice(wordStart, wordStart + 64);
    if (word.length < 64) break; // truncated -- fewer words than the declared length, don't fabricate an address
    addresses.push(`0x${word.slice(-40)}`.toLowerCase());
  }
  return addresses;
}
