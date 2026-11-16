# ADR 0002: Network rules as configuration, each with a source and confidence

Status: accepted, 16 Nov 2026

## Context
Visa and Mastercard publish decline categories, Merchant Advice Codes and attempt limits.
Public summaries disagree on some numbers and scopes, and the rules change over time.

## Decision
- Every rule lives in `src/core/rules.ts` as data, with an id, a treatment, a source and a
  confidence (high, medium or low). `docs/network-rules.md` explains each one.
- A Mastercard MAC overrides the response code. Visa codes map to categories 1 to 4.
  Unlisted codes are generic.
- Where sources disagree, the reading that cannot incur a fee is used. For example, limits
  are counted per card lineage across all PSPs, original attempt included.
- Merchant policy (retry budget, dunning window, customer window, alternative-PSP budget,
  paydays) is kept separate from the network rules.
- Every decision records the rule ids that produced it. The timeline shows each rule's
  label, source and confidence.

## Consequences
- Changing a rule is a configuration change, covered by the decision table tests.
- Low-confidence rules (MAC 40 to 42) are marked as such. They need checking against the
  current scheme rules before use with real payments.
