import { describe, expect, it } from "vitest";
import { OrderJournal } from "../src/orderJournal.js";
import type { OrderIntentInput } from "../src/types.js";

const intent: OrderIntentInput = {
  clientOrderId: "client-1",
  economicIntentId: "hedge-1",
  symbol: "ETH-PERP",
  side: "SELL",
  quantity: 100n,
  limitPrice: 300_000n,
};

describe("OrderJournal", () => {
  it("deduplicates an identical persisted intent", () => {
    const journal = new OrderJournal();
    expect(journal.recordIntent(intent).created).toBe(true);
    expect(journal.recordIntent(intent).created).toBe(false);
    expect(journal.auditTrail().map((event) => event.type)).toEqual([
      "INTENT_RECORDED",
      "INTENT_DEDUPLICATED",
    ]);
  });

  it("rejects client IDs reused with changed economics", () => {
    const journal = new OrderJournal();
    journal.recordIntent(intent);
    expect(() => journal.recordIntent({ ...intent, quantity: 101n })).toThrow(
      "different payload",
    );
  });

  it("prevents two client orders from representing one economic intent", () => {
    const journal = new OrderJournal();
    journal.recordIntent(intent);
    expect(() =>
      journal.recordIntent({ ...intent, clientOrderId: "client-2" }),
    ).toThrow("already represented");
  });

  it("blocks blind retry after an unknown submission outcome", () => {
    const journal = new OrderJournal();
    journal.recordIntent(intent);
    journal.markSubmissionStarted(intent.clientOrderId);
    journal.markOutcomeUnknown(intent.clientOrderId, "socket closed after write");
    expect(() => journal.markSubmissionStarted(intent.clientOrderId)).toThrow(
      "cannot submit an order in UNKNOWN state",
    );
  });

  it("allows retry only after recorded reconciliation evidence", () => {
    const journal = new OrderJournal();
    journal.recordIntent(intent);
    journal.markSubmissionStarted(intent.clientOrderId);
    journal.markOutcomeUnknown(intent.clientOrderId, "timeout");
    expect(() =>
      journal.authorizeRetryAfterReconciliation(intent.clientOrderId, ""),
    ).toThrow("evidence is required");
    journal.authorizeRetryAfterReconciliation(
      intent.clientOrderId,
      "absent from orders, executions, and position delta",
    );
    expect(journal.markSubmissionStarted(intent.clientOrderId)).toMatchObject({
      status: "SUBMITTING",
      attemptCount: 2,
    });
  });

  it("accepts a fill arriving before the acknowledgement and deduplicates replay", () => {
    const journal = new OrderJournal();
    journal.recordIntent(intent);
    journal.markSubmissionStarted(intent.clientOrderId);
    const first = journal.recordFill(intent.clientOrderId, {
      executionId: "exec-1",
      quantity: 40n,
      price: 299_950n,
    });
    expect(first.order).toMatchObject({
      status: "PARTIALLY_FILLED",
      filledQuantity: 40n,
    });
    expect(journal.acknowledge(intent.clientOrderId, "venue-late-ack")).toMatchObject({
      status: "PARTIALLY_FILLED",
      venueOrderId: "venue-late-ack",
      filledQuantity: 40n,
    });
    const duplicate = journal.recordFill(intent.clientOrderId, {
      executionId: "exec-1",
      quantity: 40n,
      price: 299_950n,
    });
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.order.filledQuantity).toBe(40n);
  });

  it("completes on exact total quantity and rejects overfills without mutation", () => {
    const journal = new OrderJournal();
    journal.recordIntent(intent);
    journal.markSubmissionStarted(intent.clientOrderId);
    journal.acknowledge(intent.clientOrderId, "venue-1");
    journal.recordFill(intent.clientOrderId, {
      executionId: "exec-1",
      quantity: 60n,
      price: 300_000n,
    });
    expect(() =>
      journal.recordFill(intent.clientOrderId, {
        executionId: "exec-too-large",
        quantity: 41n,
        price: 299_900n,
      }),
    ).toThrow("exceeds remaining");
    expect(journal.getOrder(intent.clientOrderId).filledQuantity).toBe(60n);
    expect(
      journal.recordFill(intent.clientOrderId, {
        executionId: "exec-2",
        quantity: 40n,
        price: 299_900n,
      }).order,
    ).toMatchObject({ status: "FILLED", filledQuantity: 100n });
  });
});
