import type {
  BookDelta,
  BookSnapshot,
  BookState,
  DeltaResult,
  PriceLevel,
  TradableView,
} from "./types.js";

function requireInteger(value: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative safe integer`);
  }
}

function applyLevels(
  target: Map<bigint, bigint>,
  levels: readonly PriceLevel[],
  allowDelete: boolean,
): void {
  const seen = new Set<bigint>();
  for (const level of levels) {
    if (level.price <= 0n) {
      throw new Error("price must be positive");
    }
    if (level.quantity < 0n || (!allowDelete && level.quantity === 0n)) {
      throw new Error("snapshot quantity must be positive; delta quantity may be zero");
    }
    if (seen.has(level.price)) {
      throw new Error(`duplicate price level ${level.price.toString()}`);
    }
    seen.add(level.price);
    if (level.quantity === 0n) {
      target.delete(level.price);
    } else {
      target.set(level.price, level.quantity);
    }
  }
}

function maxPrice(levels: Map<bigint, bigint>): bigint | undefined {
  let best: bigint | undefined;
  for (const price of levels.keys()) {
    if (best === undefined || price > best) best = price;
  }
  return best;
}

function minPrice(levels: Map<bigint, bigint>): bigint | undefined {
  let best: bigint | undefined;
  for (const price of levels.keys()) {
    if (best === undefined || price < best) best = price;
  }
  return best;
}

function invalidBookReason(
  bids: Map<bigint, bigint>,
  asks: Map<bigint, bigint>,
): string | undefined {
  const bid = maxPrice(bids);
  const ask = minPrice(asks);
  if (bid === undefined || ask === undefined) return "both sides must contain liquidity";
  if (bid >= ask) return "best bid must be below best ask";
  return undefined;
}

export class SequencedOrderBook {
  readonly symbol: string;
  private bids = new Map<bigint, bigint>();
  private asks = new Map<bigint, bigint>();
  private state: BookState = "EMPTY";
  private sequence: number | undefined;
  private receivedAtMs: number | undefined;

  constructor(symbol: string) {
    if (symbol.trim() === "") throw new Error("symbol is required");
    this.symbol = symbol;
  }

  applySnapshot(snapshot: BookSnapshot): void {
    this.requireSymbol(snapshot.symbol);
    requireInteger(snapshot.sequence, "snapshot sequence");
    requireInteger(snapshot.receivedAtMs, "snapshot receive time");

    const bids = new Map<bigint, bigint>();
    const asks = new Map<bigint, bigint>();
    applyLevels(bids, snapshot.bids, false);
    applyLevels(asks, snapshot.asks, false);
    const reason = invalidBookReason(bids, asks);
    if (reason !== undefined) throw new Error(`invalid snapshot: ${reason}`);

    this.bids = bids;
    this.asks = asks;
    this.sequence = snapshot.sequence;
    this.receivedAtMs = snapshot.receivedAtMs;
    this.state = "LIVE";
  }

  applyDelta(delta: BookDelta): DeltaResult {
    this.requireSymbol(delta.symbol);
    requireInteger(delta.previousSequence, "delta previous sequence");
    requireInteger(delta.sequence, "delta sequence");
    requireInteger(delta.receivedAtMs, "delta receive time");

    if (this.state !== "LIVE" || this.sequence === undefined) {
      return { kind: "NOT_LIVE", state: this.state };
    }
    if (delta.sequence <= this.sequence) {
      return { kind: "IGNORED_OLD", sequence: delta.sequence };
    }
    if (
      delta.previousSequence !== this.sequence ||
      delta.sequence !== this.sequence + 1
    ) {
      const result: DeltaResult = {
        kind: "GAP",
        expectedPreviousSequence: this.sequence,
        actualPreviousSequence: delta.previousSequence,
      };
      this.state = "STALE";
      return result;
    }

    const bids = new Map(this.bids);
    const asks = new Map(this.asks);
    try {
      applyLevels(bids, delta.bids, true);
      applyLevels(asks, delta.asks, true);
    } catch (error) {
      this.state = "STALE";
      return {
        kind: "INVALID_BOOK",
        reason: error instanceof Error ? error.message : "invalid level",
      };
    }
    const reason = invalidBookReason(bids, asks);
    if (reason !== undefined) {
      this.state = "STALE";
      return { kind: "INVALID_BOOK", reason };
    }

    this.bids = bids;
    this.asks = asks;
    this.sequence = delta.sequence;
    this.receivedAtMs = delta.receivedAtMs;
    return { kind: "APPLIED", sequence: delta.sequence };
  }

  tradableView(nowMs: number, maximumAgeMs: number): TradableView {
    requireInteger(nowMs, "current time");
    requireInteger(maximumAgeMs, "maximum age");
    if (this.state === "EMPTY" || this.sequence === undefined || this.receivedAtMs === undefined) {
      return { tradable: false, symbol: this.symbol, reason: "EMPTY" };
    }
    if (this.state === "STALE") {
      return { tradable: false, symbol: this.symbol, reason: "STALE" };
    }
    const ageMs = Math.max(0, nowMs - this.receivedAtMs);
    if (ageMs > maximumAgeMs) {
      return { tradable: false, symbol: this.symbol, reason: "AGE_EXCEEDED", ageMs };
    }
    const bid = maxPrice(this.bids);
    const ask = minPrice(this.asks);
    if (bid === undefined || ask === undefined) {
      throw new Error("live book invariant violated");
    }
    return {
      tradable: true,
      symbol: this.symbol,
      sequence: this.sequence,
      bestBid: { price: bid, quantity: this.bids.get(bid) ?? 0n },
      bestAsk: { price: ask, quantity: this.asks.get(ask) ?? 0n },
      ageMs,
    };
  }

  getState(): BookState {
    return this.state;
  }

  private requireSymbol(symbol: string): void {
    if (symbol !== this.symbol) {
      throw new Error(`expected ${this.symbol}, received ${symbol}`);
    }
  }
}
