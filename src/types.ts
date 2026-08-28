export type Side = "BUY" | "SELL";

export interface PriceLevel {
  readonly price: bigint;
  readonly quantity: bigint;
}

export interface BookSnapshot {
  readonly symbol: string;
  readonly sequence: number;
  readonly receivedAtMs: number;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
}

export interface BookDelta {
  readonly symbol: string;
  readonly previousSequence: number;
  readonly sequence: number;
  readonly receivedAtMs: number;
  readonly bids: readonly PriceLevel[];
  readonly asks: readonly PriceLevel[];
}

export type BookState = "EMPTY" | "LIVE" | "STALE";

export type DeltaResult =
  | { readonly kind: "APPLIED"; readonly sequence: number }
  | { readonly kind: "IGNORED_OLD"; readonly sequence: number }
  | { readonly kind: "NOT_LIVE"; readonly state: BookState }
  | {
      readonly kind: "GAP";
      readonly expectedPreviousSequence: number;
      readonly actualPreviousSequence: number;
    }
  | { readonly kind: "INVALID_BOOK"; readonly reason: string };

export type TradableView =
  | {
      readonly tradable: true;
      readonly symbol: string;
      readonly sequence: number;
      readonly bestBid: PriceLevel;
      readonly bestAsk: PriceLevel;
      readonly ageMs: number;
    }
  | {
      readonly tradable: false;
      readonly symbol: string;
      readonly reason: "EMPTY" | "STALE" | "AGE_EXCEEDED";
      readonly ageMs?: number;
    };

export interface OrderIntentInput {
  readonly clientOrderId: string;
  readonly economicIntentId: string;
  readonly symbol: string;
  readonly side: Side;
  readonly quantity: bigint;
  readonly limitPrice: bigint;
}

export type OrderStatus =
  | "INTENT_RECORDED"
  | "SUBMITTING"
  | "UNKNOWN"
  | "ACKNOWLEDGED"
  | "PARTIALLY_FILLED"
  | "FILLED"
  | "REJECTED";

export interface Fill {
  readonly executionId: string;
  readonly quantity: bigint;
  readonly price: bigint;
}

export interface OrderRecord extends OrderIntentInput {
  readonly status: OrderStatus;
  readonly attemptCount: number;
  readonly venueOrderId?: string;
  readonly filledQuantity: bigint;
  readonly fills: readonly Fill[];
}

export interface AuditEvent {
  readonly ordinal: number;
  readonly clientOrderId: string;
  readonly type:
    | "INTENT_RECORDED"
    | "INTENT_DEDUPLICATED"
    | "SUBMISSION_STARTED"
    | "OUTCOME_UNKNOWN"
    | "RETRY_AUTHORIZED"
    | "ACKNOWLEDGED"
    | "REJECTED"
    | "FILL_RECORDED"
    | "FILL_DEDUPLICATED";
  readonly detail: string;
}
