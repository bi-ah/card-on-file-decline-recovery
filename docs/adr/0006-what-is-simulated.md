# ADR 0006: What is simulated, and how

Status: accepted, 16 Nov 2026

## Decision
- **Real** (built on Cloudflare): the router, the rules engine, Workflows, the ledger
  Durable Object, the operator chat on Workers AI, and the operator page.
- **Simulated** (seeded and deterministic, labelled in code, the API and the page): the
  vault provider and hosted form, the token service and account updater, the PSPs
  (`psp-us`, `psp-eu`, `psp-uk`, `psp-apac`), the issuers, the BINs, the customers.
  None of them are real institutions.
- Every simulated result depends only on its inputs (seed, card, time, PSP, credential
  version), never on call order. Concurrent Workflows therefore see the same results as
  the in-process tests.
- Each night has one PSP outage window and one issuer outage. Paydays are the 1st, 15th
  and 25th and the last day of the month. 30% of customers respond to the update link.
- Simulator state is kept in its own tables (`sim_nights`, `sim_cards`). Only the
  simulator calls read them; merchant decisions never do.
- Comparisons are computed in code against the same simulators:
  - the naive schedule (days 1, 3, 5 and 7, same PSP, every code) on the same declines;
  - the legacy setup (one PSP's own token, black-box updater, cross-border for non-US
    cards).

## Consequences
- The recovery figures show how the design behaves under these assumptions. They are not
  a forecast of real approval rates.
