# Network rules and merchant policy

The rules engine reads every rule from configuration in
[`src/core/rules.ts`](../src/core/rules.ts). Each rule has an id, a source and a confidence.
Where public sources disagree, the configuration uses the reading that cannot incur a fee.
The merchant policy is kept separate from the network rules.

These are readings of public material, prepared for a simulation. They are not legal or
scheme advice. Check them against the current network rules before using them with real
payments.

## Sources

| Id | Source |
|---|---|
| `visa-core-rules` | [Visa Core Rules and Visa Product and Service Rules (public edition)](https://usa.visa.com/dam/VCOM/download/about-visa/visa-rules-public.pdf): reattempt rules |
| `visa-reattempt-program` | Visa decline response code categories 1 to 4 and excessive reattempt fees, as summarised in Visa merchant and acquirer guidance (2020 to 2021) |
| `mc-tpr` | [Mastercard Transaction Processing Rules](https://www.mastercard.us/content/dam/public/mastercardcom/na/global-site/documents/transaction-processing-rules.pdf): Merchant Advice Codes and reattempts |
| `mc-mac-program` | Mastercard Merchant Advice Code and excessive authorization attempt programmes, as summarised in acquirer guidance |
| `merchant-policy` | This merchant's own dunning policy, not a network rule |

**Confidence:**
- **High:** the rule is stated plainly and consistently in public material.
- **Medium:** the rule is widely published, but the exact numbers or scope vary by source or region.
- **Low:** sources disagree on what the code means.

## Visa

| Rule id | Codes | Treatment | Confidence |
|---|---|---|---|
| `visa.cat1.pickup_special` | 07 | Category 1. Stop with no outreach | High |
| `visa.cat1.lost_stolen` | 04, 41, 43 | Category 1. Never retry this card. Refresh the credential (token lifecycle or updater); if a replacement card exists, charge it, otherwise ask the customer | High |
| `visa.cat1.account` | 46, 14 | Category 1. Updater, then the customer | High |
| `visa.cat1.no_issuer_not_permitted` | 15, 57 | Category 1. Ask the customer for another card, no updater | High |
| `visa.cat1.invalid_transaction` | 12 | Category 1. Stop and alert operations | High |
| `visa.cat1.revoked` | R0, R1, R3 | Category 1. Stop and cancel the subscription, no dunning | High |
| `visa.cat2.funds` | 51, 61, 65 | Category 2. Retry on the next payday, same PSP, never cascaded | High |
| `visa.cat2.unavailable` | 19, 91, 96 | Category 2. Backoff of 1 h, 4 h, then 1 day; another capable PSP allowed | High |
| `visa.cat2.later` | 03, 59, 62, 75, 78, 86, 93, N3, N4, 5C, 9G | Category 2. Retry after 1, 2, then 3 days, same PSP (risk is never cascaded) | High |
| `visa.cat3.data` | 54, 55, 63, 6P, 82, N7 | Category 3. Fix the credential first, then retry | High |
| `visa.cat4.generic` | 05 and any unlisted code | Category 4. Retry later; another capable PSP allowed | Medium |

The per-code handling within Category 1 is merchant policy, decided on 16 Nov 2026. The
network rule itself is "never reattempt the same credential".

## Mastercard

A Merchant Advice Code (MAC) overrides the response code.

| Rule id | MAC | Treatment | Confidence |
|---|---|---|---|
| `mastercard.mac.01` | 01 | Updated information needed: account updater, then the customer | High |
| `mastercard.mac.02` | 02 | Try again later: retry after 1, 2, then 3 days, same PSP | High |
| `mastercard.mac.03` | 03 | Do not try again: never retry this card; ask the customer for another | High |
| `mastercard.mac.21` | 21 | Payment cancelled: stop and cancel the subscription, no dunning | High |
| `mastercard.mac.24` to `.30` | 24 to 30 | Retry after 1 h, 24 h, 2, 4, 6, 8 or 10 days, same PSP | Medium |
| `mastercard.mac.40_42` | 40, 41, 42 | Never retry: stop and tell the customer | Low (meanings differ by source) |

When there is no MAC:

| Rule id | Codes | Treatment | Confidence |
|---|---|---|---|
| `mastercard.hard.lost_stolen` | 04, 41, 43 | Hard decline. Never retry this card: updater, else the customer | High |
| `mastercard.hard.account` | 14, 54 | Hard decline. Fix the credential, then the customer | High |
| `mastercard.hard.no_issuer` | 15 | Hard decline. Ask the customer for another card | High |
| `mastercard.not_permitted` | 57 | Ask the customer for another card | Medium |
| `mastercard.invalid_transaction` | 12 | Stop and alert operations | Medium |
| `mastercard.funds` | 51, 61, 65 | Next payday, same PSP | Medium |
| `mastercard.unavailable` | 91, 92, 96 | Short backoff; another capable PSP allowed | Medium |
| `mastercard.risk` | 59, 63 | Retry later, same PSP | Medium |
| `mastercard.generic` | 05 and unlisted | Retry later; another capable PSP allowed | Medium |

**Mastercard 54 (expired card)** is a hard decline. Here it means "never retry the same
credential", so the engine refreshes the credential rather than stopping.

## Acquirer side

| Rule id | Signal | Treatment | Confidence |
|---|---|---|---|
| `merchant.acquirer_outage` | `PSP_UNAVAILABLE` (the PSP did not answer) | Fail over now to the next capable PSP with the same token; otherwise wait 1 h | High |

## Attempt limits

The limits are counted per card lineage (the original card and its replacements) and
merchant, across all PSPs, with the original attempt included. The ledger re-checks them
atomically when it reserves each attempt.

| Rule id | Limit | Confidence | Note |
|---|---|---|---|
| `visa.limit.30d` | 15 attempts in 30 days | Medium | Sources differ on per card or per card and merchant. Counting across all PSPs is the stricter reading |
| `mastercard.limit.24h` | 7 attempts in 24 hours | Medium | Conservative reading |
| `mastercard.limit.30d` | 35 attempts in 30 days | Medium | Conservative reading |

A card the customer enters through the update link starts a new lineage.

## Cascading (sending a retry to another PSP)

A retry may go to another capable PSP only for:
- generic declines (Visa Category 4, Mastercard generic);
- processing errors and issuer unavailable (19, 91, 92, 96);
- acquirer-side failures (`PSP_UNAVAILABLE`).

The engine never sends insufficient funds, risk or hard declines to another PSP
(guardrail 3). The tests check this for single decisions and across whole nights.

## Merchant policy

| Rule id | Policy |
|---|---|
| `policy.max_retries` | At most 6 merchant retries per renewal |
| `policy.dunning_window` | 21 days from the first decline |
| `policy.customer_window` | 7 days for the customer to enter a new card |
| `policy.max_alt_psp` | At most 2 retries through another PSP |
| `policy.customer_card` | A card the customer enters is charged at once as a customer-initiated payment, outside the retry budget, and gets a new network transaction ID |

**Paydays** are the 1st, 15th and 25th and the last day of the month; retries are made at
08:00 UTC, at least 12 hours after the decline.
