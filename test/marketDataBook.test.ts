import { describe, expect, it } from "vitest";
import { SequencedOrderBook } from "../src/marketDataBook.js";

function snapshot(book: SequencedOrderBook): void {
  book.applySnapshot({
    symbol: "BTC-PERP",
    sequence: 10,
    receivedAtMs: 1_000,
    bids: [{ price: 100_000n, quantity: 5n }],
    asks: [{ price: 100_100n, quantity: 6n }],
  });
}

describe("SequencedOrderBook", () => {
  it("publishes a tradable view after a valid snapshot and delta", () => {
    const book = new SequencedOrderBook("BTC-PERP");
    snapshot(book);
    expect(
      book.applyDelta({
        symbol: "BTC-PERP",
        previousSequence: 10,
        sequence: 11,
        receivedAtMs: 1_010,
        bids: [{ price: 100_000n, quantity: 7n }],
        asks: [{ price: 100_100n, quantity: 4n }],
      }),
    ).toEqual({ kind: "APPLIED", sequence: 11 });
    expect(book.tradableView(1_020, 50)).toEqual({
      tradable: true,
      symbol: "BTC-PERP",
      sequence: 11,
      bestBid: { price: 100_000n, quantity: 7n },
      bestAsk: { price: 100_100n, quantity: 4n },
      ageMs: 10,
    });
  });

  it("ignores duplicate or regressing deltas", () => {
    const book = new SequencedOrderBook("BTC-PERP");
    snapshot(book);
    expect(
      book.applyDelta({
        symbol: "BTC-PERP",
        previousSequence: 9,
        sequence: 10,
        receivedAtMs: 1_100,
        bids: [{ price: 100_000n, quantity: 99n }],
        asks: [],
      }),
    ).toEqual({ kind: "IGNORED_OLD", sequence: 10 });
    expect(book.tradableView(1_001, 50)).toMatchObject({
      tradable: true,
      bestBid: { quantity: 5n },
    });
  });

  it("latches stale on a sequence gap and blocks trading", () => {
    const book = new SequencedOrderBook("BTC-PERP");
    snapshot(book);
    expect(
      book.applyDelta({
        symbol: "BTC-PERP",
        previousSequence: 11,
        sequence: 12,
        receivedAtMs: 1_010,
        bids: [],
        asks: [],
      }),
    ).toEqual({
      kind: "GAP",
      expectedPreviousSequence: 10,
      actualPreviousSequence: 11,
    });
    expect(book.getState()).toBe("STALE");
    expect(book.tradableView(1_011, 50)).toEqual({
      tradable: false,
      symbol: "BTC-PERP",
      reason: "STALE",
    });
  });

  it("requires a fresh snapshot to recover from a gap", () => {
    const book = new SequencedOrderBook("BTC-PERP");
    snapshot(book);
    book.applyDelta({
      symbol: "BTC-PERP",
      previousSequence: 12,
      sequence: 13,
      receivedAtMs: 1_010,
      bids: [],
      asks: [],
    });
    expect(
      book.applyDelta({
        symbol: "BTC-PERP",
        previousSequence: 13,
        sequence: 14,
        receivedAtMs: 1_020,
        bids: [],
        asks: [],
      }),
    ).toEqual({ kind: "NOT_LIVE", state: "STALE" });
    book.applySnapshot({
      symbol: "BTC-PERP",
      sequence: 20,
      receivedAtMs: 1_030,
      bids: [{ price: 99_900n, quantity: 10n }],
      asks: [{ price: 100_000n, quantity: 10n }],
    });
    expect(book.getState()).toBe("LIVE");
  });

  it("blocks an otherwise valid book when its receive age exceeds the limit", () => {
    const book = new SequencedOrderBook("BTC-PERP");
    snapshot(book);
    expect(book.tradableView(1_101, 100)).toEqual({
      tradable: false,
      symbol: "BTC-PERP",
      reason: "AGE_EXCEEDED",
      ageMs: 101,
    });
  });

  it("blocks a receive timestamp that is in the future", () => {
    const book = new SequencedOrderBook("BTC-PERP");
    snapshot(book);
    expect(book.tradableView(999, 100)).toEqual({
      tradable: false,
      symbol: "BTC-PERP",
      reason: "FUTURE_TIMESTAMP",
    });
  });

  it("rejects crossed snapshots and latches stale on crossed deltas", () => {
    const invalid = new SequencedOrderBook("BTC-PERP");
    expect(() =>
      invalid.applySnapshot({
        symbol: "BTC-PERP",
        sequence: 1,
        receivedAtMs: 1,
        bids: [{ price: 101n, quantity: 1n }],
        asks: [{ price: 100n, quantity: 1n }],
      }),
    ).toThrow("best bid must be below best ask");

    const book = new SequencedOrderBook("BTC-PERP");
    snapshot(book);
    expect(
      book.applyDelta({
        symbol: "BTC-PERP",
        previousSequence: 10,
        sequence: 11,
        receivedAtMs: 1_010,
        bids: [{ price: 100_200n, quantity: 1n }],
        asks: [],
      }),
    ).toEqual({ kind: "INVALID_BOOK", reason: "best bid must be below best ask" });
    expect(book.getState()).toBe("STALE");
  });
});
