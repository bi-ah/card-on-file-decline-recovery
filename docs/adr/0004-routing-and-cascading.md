# ADR 0004: Deterministic routing and narrow cascading

Status: accepted, 16 Nov 2026

## Context
Routing a card to a domestic acquirer that accepts its network token raises approval and
lowers cost. Sending a decline to another PSP can recover a generic or acquirer-side failure.
For insufficient funds, risk or hard declines it only adds attempts and fees.

## Decision
- The router (`src/core/router.ts`) orders PSPs by:
  1. capability: accepts this brand's network token in this region, else the card-number
     fallback;
  2. domestic acquiring for the BIN's region;
  3. measured approval rate;
  4. cost, including the cross-border surcharge.
- A retry may go to the next capable PSP only after a generic, processing,
  issuer-unavailable or acquirer-side decline, at most twice per renewal. When a PSP does
  not answer, the next capable PSP gets the same token at once.
- Insufficient funds, risk and hard declines are never cascaded (guardrail 3). Unit tests
  and the whole-night audit check this.

## Consequences
- In simulated nights, roughly a quarter to a third of recoveries come through another PSP,
  mostly after the PSP outage and generic declines.
- Approval rates per PSP are fixed in the simulator. In production they would come from
  the ledger.
