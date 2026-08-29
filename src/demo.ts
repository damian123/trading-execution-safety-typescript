import { SequencedOrderBook } from "./marketDataBook.js";
import { OrderJournal } from "./orderJournal.js";

const book = new SequencedOrderBook("ETH-PERP");
book.applySnapshot({
  symbol: "ETH-PERP",
  sequence: 100,
  receivedAtMs: 1_000,
  bids: [
    { price: 300_000n, quantity: 50n },
    { price: 299_900n, quantity: 80n },
  ],
  asks: [
    { price: 300_100n, quantity: 45n },
    { price: 300_200n, quantity: 90n },
  ],
});

const appliedDelta = book.applyDelta({
  symbol: "ETH-PERP",
  previousSequence: 100,
  sequence: 101,
  receivedAtMs: 1_010,
  bids: [{ price: 300_000n, quantity: 60n }],
  asks: [{ price: 300_100n, quantity: 40n }],
});
const liveView = book.tradableView(1_015, 50);
const gap = book.applyDelta({
  symbol: "ETH-PERP",
  previousSequence: 102,
  sequence: 103,
  receivedAtMs: 1_020,
  bids: [{ price: 300_000n, quantity: 55n }],
  asks: [],
});
const blockedView = book.tradableView(1_021, 50);

const journal = new OrderJournal();
const intent = {
  clientOrderId: "hedge-42-child-1",
  economicIntentId: "hedge-42",
  symbol: "ETH-PERP",
  side: "SELL" as const,
  quantity: 100n,
  limitPrice: 299_800n,
};
journal.recordIntent(intent);
journal.markSubmissionStarted(intent.clientOrderId);
journal.markOutcomeUnknown(intent.clientOrderId, "connection closed after write");

let blindRetryBlocked = false;
try {
  journal.markSubmissionStarted(intent.clientOrderId);
} catch {
  blindRetryBlocked = true;
}

journal.authorizeRetryAfterReconciliation(
  intent.clientOrderId,
  {
    submissionAttempt: 1,
    checkedAtMs: 1_100,
    openOrders: "ABSENT",
    executions: "ABSENT",
    positionEffect: "ABSENT",
    detail: "client ID absent from authoritative venue and position queries",
  },
);
journal.markSubmissionStarted(intent.clientOrderId);
journal.acknowledge(intent.clientOrderId, "venue-9001");
journal.recordFill(intent.clientOrderId, {
  executionId: "fill-1",
  quantity: 40n,
  price: 299_950n,
});
const duplicateFill = journal.recordFill(intent.clientOrderId, {
  executionId: "fill-1",
  quantity: 40n,
  price: 299_950n,
});
journal.recordFill(intent.clientOrderId, {
  executionId: "fill-2",
  quantity: 60n,
  price: 299_900n,
});

const output = {
  marketData: {
    appliedDelta,
    liveView,
    gap,
    blockedView,
  },
  execution: {
    blindRetryBlocked,
    duplicateFillIgnored: duplicateFill.duplicate,
    finalOrder: journal.getOrder(intent.clientOrderId),
    auditTrail: journal.auditTrail(),
  },
};

console.log(
  JSON.stringify(output, (_, value: unknown) =>
    typeof value === "bigint" ? value.toString() : value,
  2),
);
