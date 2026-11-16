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
