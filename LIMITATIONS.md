# Limitations

This is a safety core for local book integrity and uncertain order submission. It is not a trading system.

## Not included

- Live exchange connectivity, market-data sessions, or order routing.
- A matching engine, smart order router, or strategy.
- Authenticated operator actions, fenced multi-process ownership, or a durable transactional journal.
- Venue-specific sequence, session, or recovery protocols.
- Decimal scaling by instrument; prices and quantities are integer domain values.

No real market data, accounts, keys, or client information is used.

## Production gaps

A production version would persist the journal transactionally, define venue-specific proof that an order is absent, fence competing senders, bind operator actions to access control, and emit traces around `UNKNOWN` recovery. This repository stops at the state machine those pieces would have to obey.
