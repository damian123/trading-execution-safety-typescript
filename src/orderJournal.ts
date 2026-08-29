import type {
  AuditEvent,
  Fill,
  OrderIntentInput,
  OrderRecord,
  OrderStatus,
  RetryReconciliationEvidence,
} from "./types.js";

interface MutableOrder extends OrderIntentInput {
  status: OrderStatus;
  attemptCount: number;
  venueOrderId?: string;
  filledQuantity: bigint;
  fills: Map<string, Fill>;
}

function intentFingerprint(input: OrderIntentInput): string {
  return JSON.stringify([
    input.clientOrderId,
    input.economicIntentId,
    input.symbol,
    input.side,
    input.quantity.toString(),
    input.limitPrice.toString(),
  ]);
}

function assertIntent(input: OrderIntentInput): void {
  if (input.clientOrderId.trim() === "") throw new Error("client order ID is required");
  if (input.economicIntentId.trim() === "") throw new Error("economic intent ID is required");
  if (input.symbol.trim() === "") throw new Error("symbol is required");
  if (input.quantity <= 0n) throw new Error("quantity must be positive");
  if (input.limitPrice <= 0n) throw new Error("limit price must be positive");
}

export class OrderJournal {
  private readonly orders = new Map<string, MutableOrder>();
  private readonly fingerprints = new Map<string, string>();
  private readonly clientByEconomicIntent = new Map<string, string>();
  private readonly audit: AuditEvent[] = [];

  recordIntent(input: OrderIntentInput): { created: boolean; order: OrderRecord } {
    assertIntent(input);
    const fingerprint = intentFingerprint(input);
    const existing = this.orders.get(input.clientOrderId);
    if (existing !== undefined) {
      if (this.fingerprints.get(input.clientOrderId) !== fingerprint) {
        throw new Error("client order ID was reused with a different payload");
      }
      this.append(input.clientOrderId, "INTENT_DEDUPLICATED", "same payload");
      return { created: false, order: this.copy(existing) };
    }

    const existingClient = this.clientByEconomicIntent.get(input.economicIntentId);
    if (existingClient !== undefined) {
      throw new Error(
        `economic intent ${input.economicIntentId} is already represented by ${existingClient}`,
      );
    }

    const order: MutableOrder = {
      ...input,
      status: "INTENT_RECORDED",
      attemptCount: 0,
      filledQuantity: 0n,
      fills: new Map(),
    };
    this.orders.set(input.clientOrderId, order);
    this.fingerprints.set(input.clientOrderId, fingerprint);
    this.clientByEconomicIntent.set(input.economicIntentId, input.clientOrderId);
    this.append(input.clientOrderId, "INTENT_RECORDED", "durable intent created");
    return { created: true, order: this.copy(order) };
  }

  markSubmissionStarted(clientOrderId: string): OrderRecord {
    const order = this.requireOrder(clientOrderId);
    if (order.status !== "INTENT_RECORDED") {
      throw new Error(`cannot submit an order in ${order.status} state`);
    }
    order.status = "SUBMITTING";
    order.attemptCount += 1;
    this.append(clientOrderId, "SUBMISSION_STARTED", `attempt ${order.attemptCount}`);
    return this.copy(order);
  }

  markOutcomeUnknown(clientOrderId: string, reason: string): OrderRecord {
    const order = this.requireOrder(clientOrderId);
    if (order.status !== "SUBMITTING") {
      throw new Error(`cannot mark ${order.status} as an unknown submission outcome`);
    }
    if (reason.trim() === "") throw new Error("unknown-outcome reason is required");
    order.status = "UNKNOWN";
    this.append(clientOrderId, "OUTCOME_UNKNOWN", reason);
    return this.copy(order);
  }

  authorizeRetryAfterReconciliation(
    clientOrderId: string,
    evidence: RetryReconciliationEvidence,
  ): OrderRecord {
    const order = this.requireOrder(clientOrderId);
    if (order.status !== "UNKNOWN") {
      throw new Error(`retry reconciliation requires UNKNOWN state, received ${order.status}`);
    }
    this.assertRetryEvidence(order, evidence);
    order.status = "INTENT_RECORDED";
    this.append(clientOrderId, "RETRY_AUTHORIZED", JSON.stringify(evidence));
    return this.copy(order);
  }

  acknowledge(clientOrderId: string, venueOrderId: string): OrderRecord {
    const order = this.requireOrder(clientOrderId);
    if (venueOrderId.trim() === "") throw new Error("venue order ID is required");
    if (
      order.status !== "SUBMITTING" &&
      order.status !== "UNKNOWN" &&
      order.status !== "ACKNOWLEDGED" &&
      order.status !== "PARTIALLY_FILLED" &&
      order.status !== "FILLED"
    ) {
      throw new Error(`cannot acknowledge an order in ${order.status} state`);
    }
    if (order.venueOrderId !== undefined && order.venueOrderId !== venueOrderId) {
      throw new Error("venue order ID cannot be replaced after acknowledgement");
    }
    if (order.status === "SUBMITTING" || order.status === "UNKNOWN") {
      order.status = "ACKNOWLEDGED";
    }
    order.venueOrderId = venueOrderId;
    this.append(clientOrderId, "ACKNOWLEDGED", venueOrderId);
    return this.copy(order);
  }

  reject(clientOrderId: string, reason: string): OrderRecord {
    const order = this.requireOrder(clientOrderId);
    if (order.status !== "SUBMITTING" && order.status !== "UNKNOWN") {
      throw new Error(`cannot reject an order in ${order.status} state`);
    }
    if (reason.trim() === "") throw new Error("rejection reason is required");
    order.status = "REJECTED";
    this.append(clientOrderId, "REJECTED", reason);
    return this.copy(order);
  }

  recordFill(clientOrderId: string, fill: Fill): { duplicate: boolean; order: OrderRecord } {
    const order = this.requireOrder(clientOrderId);
    if (fill.executionId.trim() === "") throw new Error("execution ID is required");
    if (fill.quantity <= 0n) throw new Error("fill quantity must be positive");
    if (fill.price <= 0n) throw new Error("fill price must be positive");
    const existingFill = order.fills.get(fill.executionId);
    if (existingFill !== undefined) {
      if (existingFill.quantity !== fill.quantity || existingFill.price !== fill.price) {
        throw new Error("execution ID was replayed with a different fill payload");
      }
      this.append(clientOrderId, "FILL_DEDUPLICATED", fill.executionId);
      return { duplicate: true, order: this.copy(order) };
    }
    if (
      order.status !== "SUBMITTING" &&
      order.status !== "UNKNOWN" &&
      order.status !== "ACKNOWLEDGED" &&
      order.status !== "PARTIALLY_FILLED"
    ) {
      throw new Error(`cannot fill an order in ${order.status} state`);
    }
    if (order.filledQuantity + fill.quantity > order.quantity) {
      throw new Error("fill exceeds remaining order quantity");
    }

    order.fills.set(fill.executionId, { ...fill });
    order.filledQuantity += fill.quantity;
    order.status = order.filledQuantity === order.quantity ? "FILLED" : "PARTIALLY_FILLED";
    this.append(
      clientOrderId,
      "FILL_RECORDED",
      `${fill.executionId}:${fill.quantity.toString()}@${fill.price.toString()}`,
    );
    return { duplicate: false, order: this.copy(order) };
  }

  getOrder(clientOrderId: string): OrderRecord {
    return this.copy(this.requireOrder(clientOrderId));
  }

  auditTrail(): readonly AuditEvent[] {
    return this.audit.map((event) => ({ ...event }));
  }

  private requireOrder(clientOrderId: string): MutableOrder {
    const order = this.orders.get(clientOrderId);
    if (order === undefined) throw new Error(`unknown client order ID ${clientOrderId}`);
    return order;
  }

  private copy(order: MutableOrder): OrderRecord {
    const base = {
      clientOrderId: order.clientOrderId,
      economicIntentId: order.economicIntentId,
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      limitPrice: order.limitPrice,
      status: order.status,
      attemptCount: order.attemptCount,
      filledQuantity: order.filledQuantity,
      fills: [...order.fills.values()].map((fill) => ({ ...fill })),
    };
    return order.venueOrderId === undefined
      ? base
      : { ...base, venueOrderId: order.venueOrderId };
  }

  private assertRetryEvidence(
    order: MutableOrder,
    evidence: RetryReconciliationEvidence,
  ): void {
    if (typeof evidence !== "object" || evidence === null) {
      throw new Error("structured reconciliation evidence is required");
    }
    if (
      !Number.isSafeInteger(evidence.submissionAttempt) ||
      evidence.submissionAttempt <= 0 ||
      evidence.submissionAttempt !== order.attemptCount
    ) {
      throw new Error("reconciliation evidence must identify the current submission attempt");
    }
    if (!Number.isSafeInteger(evidence.checkedAtMs) || evidence.checkedAtMs < 0) {
      throw new Error("reconciliation check time must be a non-negative safe integer");
    }
    if (
      evidence.openOrders !== "ABSENT" ||
      evidence.executions !== "ABSENT" ||
      evidence.positionEffect !== "ABSENT"
    ) {
      throw new Error("reconciliation must prove orders, executions, and position effect absent");
    }
    if (typeof evidence.detail !== "string" || evidence.detail.trim() === "") {
      throw new Error("reconciliation evidence detail is required");
    }
  }

  private append(
    clientOrderId: string,
    type: AuditEvent["type"],
    detail: string,
  ): void {
    this.audit.push({
      ordinal: this.audit.length + 1,
      clientOrderId,
      type,
      detail,
    });
  }
}
