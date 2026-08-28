# ADR 0001: Invalid market data and unknown order outcomes are explicit states

Status: accepted for this synthetic demonstration

## Context

A missing market-data increment can make a locally maintained order book incorrect. A venue timeout after an order write can mean the venue accepted the order even though the client did not receive an acknowledgement. Treating either condition as ordinary success or ordinary failure can create unintended exposure.

## Decision

- A sequence gap or crossed book latches the order book `STALE`.
- No tradable view is returned until a new valid snapshot is installed.
- An order whose submission result cannot be proved becomes `UNKNOWN`.
- The same economic intent cannot be submitted again while it is `UNKNOWN`.
- A retry becomes possible only after recorded reconciliation evidence moves the original intent back to an eligible state.
- Fills are accepted during `SUBMITTING` or `UNKNOWN` because private-stream evidence can arrive before an acknowledgement.
- Execution IDs deduplicate fill replay.

## Consequences

The system may pause rather than trade through an uncertain condition. That is intentional. Recovery requires authoritative external evidence, and every state change is preserved in an audit trail. A production implementation would persist the journal transactionally, define venue-specific proof requirements, fence competing senders, and bind operator authorization to access control.
