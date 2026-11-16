# ADR 0005: Idempotency everywhere and atomic limit counting

Status: accepted, 16 Nov 2026

## Context
Workflow steps can be retried, and an API call can be repeated. A duplicate charge or an
uncounted attempt would break the network limits.

## Decision
- One Workflow instance per failed renewal, with the deterministic id `<run>-<payment>`.
  Starting recovery twice creates no new instances.
- Every ledger method is keyed by (payment, step) and returns the stored result when called
  again. This covers decisions, reservations, PSP results, credential refreshes, customer
  outreach and finishing.
- Each attempt is reserved in the ledger before the PSP call and recorded after it. The
  reservation re-checks every guardrail in one Durable Object call: the credential is not
  blocked, the network limits for the card lineage across all PSPs, the retry budget, the
  alternative-PSP budget and the dunning window. A Durable Object runs one call at a time,
  so the check and the insert are atomic.
- The ledger runs on SQLite. The same `LedgerLogic` code runs in the Durable Object and in
  Node tests (node:sqlite).

## Consequences
- The invariant tests run whole nights through the real ledger code.
- The functional tests check that every reserved attempt was recorded and that a repeated
  recover call adds nothing.
- A recover call interrupted mid-way, for example by a restart, can simply be repeated; this
  happened during local testing and the repeat completed the night.
