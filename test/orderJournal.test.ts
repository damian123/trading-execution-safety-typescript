import { describe, expect, it } from "vitest";
import { OrderJournal } from "../src/orderJournal.js";
import type {
  OrderIntentInput,
  RetryReconciliationEvidence,
} from "../src/types.js";

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

  it("does not confuse delimiter-containing intent fields", () => {
    const journal = new OrderJournal();
    journal.recordIntent({
      ...intent,
      economicIntentId: "hedge|ETH",
      symbol: "PERP",
    });
    expect(() =>
      journal.recordIntent({
        ...intent,
        economicIntentId: "hedge",
        symbol: "ETH|PERP",
      }),
    ).toThrow("different payload");
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
      journal.authorizeRetryAfterReconciliation(
        intent.clientOrderId,
        "arbitrary assertion" as unknown as RetryReconciliationEvidence,
      ),
    ).toThrow("structured reconciliation evidence");
    expect(() =>
      journal.authorizeRetryAfterReconciliation(intent.clientOrderId, {
        submissionAttempt: 2,
        checkedAtMs: 1_100,
        openOrders: "ABSENT",
        executions: "ABSENT",
        positionEffect: "ABSENT",
        detail: "authoritative checks completed",
      }),
    ).toThrow("current submission attempt");
    journal.authorizeRetryAfterReconciliation(
      intent.clientOrderId,
      {
        submissionAttempt: 1,
        checkedAtMs: 1_100,
        openOrders: "ABSENT",
        executions: "ABSENT",
        positionEffect: "ABSENT",
        detail: "absent from orders, executions, and position delta",
      },
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

  it("accepts exact fill replay after FILLED and rejects conflicting execution reuse", () => {
    const journal = new OrderJournal();
    journal.recordIntent(intent);
    journal.markSubmissionStarted(intent.clientOrderId);
    journal.recordFill(intent.clientOrderId, {
      executionId: "exec-complete",
      quantity: 100n,
      price: 300_000n,
    });

    expect(
      journal.recordFill(intent.clientOrderId, {
        executionId: "exec-complete",
        quantity: 100n,
        price: 300_000n,
      }),
    ).toMatchObject({ duplicate: true, order: { status: "FILLED", filledQuantity: 100n } });
    expect(() =>
      journal.recordFill(intent.clientOrderId, {
        executionId: "exec-complete",
        quantity: 99n,
        price: 300_000n,
      }),
    ).toThrow("different fill payload");
    expect(() =>
      journal.recordFill(intent.clientOrderId, {
        executionId: "exec-complete",
        quantity: 100n,
        price: 300_001n,
      }),
    ).toThrow("different fill payload");
    expect(journal.getOrder(intent.clientOrderId)).toMatchObject({
      status: "FILLED",
      filledQuantity: 100n,
      fills: [{ executionId: "exec-complete", quantity: 100n, price: 300_000n }],
    });
  });

  it("keeps the first venue order ID immutable across acknowledgement replay", () => {
    const journal = new OrderJournal();
    journal.recordIntent(intent);
    journal.markSubmissionStarted(intent.clientOrderId);
    journal.acknowledge(intent.clientOrderId, "venue-1");

    expect(journal.acknowledge(intent.clientOrderId, "venue-1")).toMatchObject({
      status: "ACKNOWLEDGED",
      venueOrderId: "venue-1",
    });
    expect(() => journal.acknowledge(intent.clientOrderId, "venue-2")).toThrow(
      "cannot be replaced",
    );
    expect(journal.getOrder(intent.clientOrderId).venueOrderId).toBe("venue-1");
  });
});
