# Prompt history

The prompts given to Claude Code to design and build this project, in order. Each is saved as
it was sent; only line-wrap artifacts (words joined where a line break was lost) are fixed.

## Prompt 1: the problem

> I want to build a project for card-on-file subscription billing. Here is the problem.
>
> A subscription merchant charges its customers' stored cards on every renewal. These are
> merchant-initiated card-on-file transactions. A share of renewals is declined every night,
> and the revenue lost when they are never recovered is involuntary churn: the customer did
> not choose to leave.
>
> Today the merchant stores cards as tokens at a single PSP. That causes six problems:
>
> 1. *Stale cards.* Issuers reissue cards (new expiry, new number after loss or theft). The
>    PSP's account updater is a black box, so the merchant learns about it only when a renewal
>    fails.
> 2. *Lock-in.* The PSP token works only at that PSP. There is no failover when the PSP has
>    an incident, and no way to route a card to a better acquirer.
> 3. *Cross-border acquiring.* Cards from countries the PSP does not acquire in domestically
>    go cross-border: lower approval and higher cost.
> 4. *Blind retries.* On a decline the merchant gets a response code and, for Mastercard, a
>    Merchant Advice Code, but no card data. Its dunning retries everything on days 1, 3, 5 and
>    7 on the same route, including codes the networks say must never be retried.
> 5. *Fees.* Visa and Mastercard charge excessive-retry fees and cap attempts per card and
>    merchant. Blind retries break those rules.
> 6. *No explanation.* Nobody can say why a renewal failed or what was done about it, and the
>    customer gets a generic "payment failed" email.

## Prompt 2: the solution

> Here is the solution I want, in detail.
>
> *Target architecture (D4): merchant-owned network tokens in a provider-hosted vault.*
>
> The customer enters the card in a hosted card form run by a PCI DSS vault provider. The vault
> provisions a *network token under the merchant's own token requestor ID*, so the merchant owns
> the token and is not locked to any PSP. The vault keeps the card number only as a fallback for
> cards that cannot be tokenised. The merchant platform receives only a vault reference, BIN,
> last four and expiry, so it stays *out of PCI scope*.
>
> > *Prevention before billing:* the networks push token lifecycle updates (new expiry,
> > replacement card) to the vault; the account updater covers cards without a token; every
> > renewal is sent as a merchant-initiated recurring transaction carrying the network
> > transaction ID of the customer's first payment.
> >
> > *Routing:* a deterministic router picks the PSP per transaction by (1) capability: does this
> > PSP accept this brand's network tokens in this region, else fall back to the card number;
> > (2) domestic acquiring from the BIN's issuing country; (3) measured approval rate; (4) cost.
> > If a PSP is down, the next capable PSP gets the same token.
> >
> > *Recovery:* a deterministic rules engine decides what to do with each decline, from public
> > Visa and Mastercard rules only:
> >
> > - Visa categories: 1 never retry (04, 07, 12, 14, 15, 41, 43, 46, 57, R0, R1, R3); 2 retry
> >   later (03, 19, 51, 59, 61, 62, 65, 75, 78, 86, 91, 93, 96, N3, N4, 5C, 9G); 3 fix the data
> >   first (54, 55, 63, 6P, 82, N7); 4 generic (05 and unlisted).
> > - Mastercard Merchant Advice Codes override the response code: 01 updater; 02 later; 03 and
> >   21 never; 24 to 30 retry after 1 h, 24 h, 2, 4, 6, 8, 10 days; 40, 41, 42 never.
> >   Mastercard hard declines without a MAC: 04, 14, 15, 41, 43, 54.
> > - Limits counted per card lineage and merchant across all PSPs, original included: Visa 15
> >   in 30 days, Mastercard 7 in 24 hours and 35 in 30 days (the conservative readings; sources
> >   disagree). All configurable, every rule with its source.
> > - Paths: timed retry (payday for insufficient funds, the MAC wait, backoff for outages)
> >   through the same PSP or, only for generic, processing, issuer-unavailable and acquirer-side
> >   declines, the next capable PSP; fix the credential (token lifecycle or updater) then retry;
> >   ask the customer with an update link to the hosted form; or stop (revoked, fraud,
> >   never-retry codes, budget or dunning window exhausted).
> > - Merchant policy separate from network rules: at most 6 retries per renewal, a 21-day
> >   dunning window, 7 days for the customer to respond, at most 2 retries via another PSP.
> >
> > *Explanation:* an operator asks in chat, for example "Why did 300 renewals fail last night?"
> > or "What did you do with the expired cards?". Llama 3.3 on Workers AI answers by calling
> > read-only tools over the ledger. It explains; it never decides.
>
> *What to build now on Cloudflare.* The merchant platform: router, rules engine, Workflows,
> ledger and chat. The vault provider, token service, account updater, PSPs and issuers are
> *simulated* with seeded, deterministic simulators, clearly labelled, with fictional PSPs
> (`psp-us`, `psp-eu`, `psp-uk`, `psp-apac`), BINs and issuers. Each payment carries an explicit
> credential type (network token, card-number fallback) and the merchant-initiated flag and
> network transaction ID.
>
> *Cloudflare components:* a TypeScript Worker; one Workflow instance per failed renewal with
> `step.sleep` on a compressed clock (one simulated day = a few seconds, configurable); a
> SQLite-backed Durable Object as the ledger (payments, attempts, decisions, events, chat
> history); Workers AI with function calling; static assets for one operator page.
