# ADR 0003: Merchant-owned network tokens in a provider-hosted vault (D4)

Status: accepted, 16 Nov 2026

## Context
With a PSP's own token, the merchant is locked to one PSP. Its account updater is a black
box, and there is no failover or domestic routing.

## Decision
- The customer enters the card in a hosted form run by a PCI DSS vault provider. The vault
  provisions a network token under the merchant's own token requestor ID. The merchant
  owns the token and can send it through any capable PSP.
- The vault keeps the card number and uses it only as a fallback: for cards that cannot be
  tokenised, or for a PSP that does not accept that brand's tokens in that region.
- The merchant platform stores only a vault reference, BIN, last four, expiry and token
  metadata, so it stays out of PCI scope. The audit fails a run if a 13 to 19 digit number
  appears anywhere in the ledger.
- Prevention before billing: the networks push token lifecycle updates, and the account
  updater covers untokenised cards. Every renewal is a merchant-initiated recurring
  transaction carrying the network transaction ID of the first payment.

## Consequences
- In this build the vault, token service and updater are simulated (ADR 0006).
- A card the customer enters through the update link starts a new card lineage. It is
  charged as a customer-initiated payment and gets a new network transaction ID.
