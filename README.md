# Card-on-File Decline Recovery

Recovers declined card-on-file subscription renewals on Cloudflare Workers, Workflows, a
SQLite-backed Durable Object and Workers AI.

**Who decides:** a deterministic rules engine makes every decision from public Visa and
Mastercard rules. Llama 3.3 only explains the decisions, through read-only tools.

**Live demo:** https://ba-cofdr.bilalahmed-78.workers.dev

Everything outside the merchant platform is **simulated** and fictional: the vault provider,
token service, account updater, PSPs, issuers, BINs and customers.

## The problem

A subscription merchant charges stored cards on every renewal: merchant-initiated
card-on-file transactions. Every night a share of renewals is declined. Revenue that is
never recovered is involuntary churn: the customer did not choose to leave.

With cards stored as one PSP's tokens, six things go wrong:
1. **Stale cards:** the merchant learns about a reissued card only when a renewal fails.
2. **Lock-in:** no failover, and no route to a better acquirer.
3. **Cross-border acquiring:** cards from other countries get lower approval at higher cost.
4. **Blind retries:** dunning retries every decline on days 1, 3, 5 and 7, including codes
   the networks say must never be retried.
5. **Fees:** those retries incur excessive-retry fees and break the attempt limits.
6. **No explanation:** nobody can say why a renewal failed or what was done about it.

### Problem workflow

Today, with one PSP and blind retries. The red blocks mark where money is lost.

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant M as Merchant billing
    participant P as Single PSP
    participant N as Card network
    participant I as Issuer

    Note over C,P: Sign-up
    C->>P: Enters card on the PSP's payment page
    P-->>M: PSP token (usable only at this PSP)

    Note over N,I: Months later the issuer reissues the card<br/>(new expiry, or new number after loss or theft)
    I->>N: Card reissued
    N-->>P: Update reaches the PSP's account updater, or not

    Note over M,I: Renewal night
    M->>P: Charge PSP token (MIT, recurring)
    alt Card from a country the PSP has no domestic acquiring in
        P->>N: Cross-border authorisation
    else Domestic card
        P->>N: Domestic authorisation
    end
    N->>I: Authorisation request
    I-->>N: Decline (for example 54 expired card, 51 insufficient funds, 05 do not honour)
    N-->>P: Response code, plus a Merchant Advice Code for Mastercard
    P-->>M: Response code and MAC only, no card data

    rect rgba(220, 38, 38, 0.15)
        Note over M,P: LOSS 1, stale card: the merchant learns about the reissue only now
        Note over P,N: LOSS 2, cross-border: lower approval and a higher fee on every attempt
    end

    loop Days 1, 3, 5 and 7, same PSP, every code
        M->>P: Retry the same token
        P->>N: Authorisation, including codes marked never retry
        N->>I: Authorisation request
        I-->>N: Decline again
        N-->>P: Decline
        P-->>M: Decline
    end

    rect rgba(220, 38, 38, 0.15)
        Note over P,N: LOSS 3, fees: excessive-retry fees passed on to the merchant
        Note over M,P: LOSS 4, lock-in: a PSP incident fails every renewal with no failover
    end

    M->>C: Generic "payment failed" email
    rect rgba(220, 38, 38, 0.15)
        Note over C,M: LOSS 5, involuntary churn: the customer leaves without choosing to,<br/>and nobody can say why the renewal failed or what was done
    end
```

[`docs/DESIGN.md`](docs/DESIGN.md) also has the trust boundaries and the rules engine's decision flowchart.

## Architecture (D4)

- **Vault and tokens:** merchant-owned network tokens (the merchant's own token requestor
  ID) in a provider-hosted PCI DSS vault, with a card-number fallback. The merchant platform
  holds only vault references, BIN, last four and expiry, so it stays out of PCI scope.
- **Prevention before billing:** token lifecycle updates and the account updater. Every
  renewal is sent as a merchant-initiated recurring transaction with the original network
  transaction ID.
- **Router:** picks the PSP for each transaction by capability (token, else card number),
  domestic acquiring, approval rate and cost. It fails over when a PSP is down.
- **Rules engine:** decides each decline from Visa categories, Mastercard Merchant Advice
  Codes and attempt limits, plus merchant policy. The possible decisions are a timed retry
  (same PSP, or another PSP for generic, processing, issuer-unavailable and acquirer-side
  declines), fix the credential, ask the customer, or stop.
- **Workflows:** one instance per failed renewal, sleeping on a compressed clock
  (1 simulated day = 3 s live).
- **Ledger:** one SQLite Durable Object holding payments, attempts, decisions, events and
  chat. Attempts are reserved before the PSP call and recorded after it, and the limits are
  re-checked atomically.
- **Operator page and chat:** one "Run a night" button, live progress (phases, simulated
  clock, activity feed), summary, incidents, payments, a per-payment timeline with the rule
  behind every decision, a chat that shows the tools each answer used, a usage guide and this
  overview.

### Architecture diagram

```mermaid
flowchart LR
    Customer(["Customer"])
    Operator(["Operator"])

    subgraph VAULT["Vault provider (PCI DSS) · simulated"]
        Form["Hosted card form"]
        Vault[("Network tokens<br/>card-number fallback")]
    end

    subgraph CF["Merchant platform on Cloudflare (out of PCI scope)"]
        Page["Operator page<br/>static assets"]
        API["Worker API<br/>router · rules engine"]
        WF["Workflows<br/>one instance per failed renewal<br/>step.sleep on a compressed clock"]
        Ledger[("Ledger<br/>SQLite Durable Object")]
        AI["Workers AI · Llama 3.3<br/>read-only tools: explains only"]
    end

    subgraph NET["Payment ecosystem · simulated"]
        PSP["PSPs<br/>psp-us · psp-eu · psp-uk · psp-apac"]
        TS["Token service and<br/>account updater"]
        Iss["Issuers"]
    end

    Customer -- "card details" --> Form --> Vault
    Vault -- "vault reference, BIN, last four, expiry" --> API
    API -- "charge: vault reference, PSP, MIT, NTID" --> Vault
    Vault -- "token + cryptogram, or card-number fallback" --> PSP --> Iss
    TS -- "lifecycle updates, updater results" --> Vault
    PSP -- "result, response code, MAC" --> API
    API -- "one Workflow per decline" --> WF
    WF -- "decide · reserve · record (idempotent)" --> Ledger
    API --> Ledger
    Operator --> Page --> API
    API -- "questions" --> AI
    AI -- "read-only queries" --> Ledger
```

### Solution sequence

Onboarding, prevention before billing, renewal, decline and each recovery path, with every actor.

```mermaid
sequenceDiagram
    autonumber
    actor C as Customer
    participant M as Merchant platform
    participant V as Vault provider (PCI DSS)
    participant P as PSPs (psp-us, psp-eu, psp-uk, psp-apac)
    participant T as Token service and account updater
    participant I as Issuer

    rect rgba(37, 99, 235, 0.10)
        Note over C,I: Onboarding
        C->>V: Card details in the vault's hosted card form
        V->>T: Provision a network token under the merchant's TRID
        alt Card can be tokenised
            T-->>V: Network token
        else Card cannot be tokenised
            T-->>V: Not eligible, keep the PAN as fallback
        end
        V-->>M: Vault reference, BIN, last four, expiry, credential type
        M->>M: Router picks a PSP (capability, domestic, approval, cost)
        M->>V: First payment (CIT) through the chosen PSP
        V->>P: Network token and cryptogram, or PAN fallback
        P->>I: Authorisation via the card network
        I-->>P: Approved, network transaction ID (NTID)
        P-->>M: Approved, NTID stored for every renewal
    end

    rect rgba(22, 163, 74, 0.10)
        Note over C,I: Prevention before billing
        I->>T: Card reissued (new expiry or new number)
        T-->>V: Token lifecycle update (token unchanged, details refreshed)
        V-->>M: Credential updated (new expiry, last four)
        M->>V: Before the renewal: account updater check for untokenised cards
        V->>T: Account updater inquiry
        T-->>V: New PAN or expiry, closed account, or no change
        V-->>M: Updated credential or closed-account flag
    end

    rect rgba(37, 99, 235, 0.10)
        Note over C,I: Renewal
        M->>M: Router picks a PSP for this card
        M->>V: Charge: vault reference, PSP, amount, MIT recurring, NTID
        V->>P: Network token (or PAN fallback), MIT flag, NTID
        P->>I: Authorisation via the card network
        alt Approved
            I-->>P: Approved
            P-->>M: Approved, recorded in the ledger
        else PSP down
            P--xM: Timeout or outage
            M->>V: Same token to the next capable PSP
        else Declined
            I-->>P: Decline: response code, plus MAC for Mastercard
            P-->>M: Decline recorded in the ledger
        end
    end

    rect rgba(234, 179, 8, 0.12)
        Note over C,I: Decline: the rules engine decides, one Workflow per failed renewal
        M->>M: Rules engine: network rules, MAC override, limits, merchant policy
        alt Timed retry
            M->>M: Sleep until payday, the MAC wait, or outage backoff
            M->>V: Retry through the same PSP, or the next capable PSP for<br/>generic, processing, issuer-unavailable and acquirer-side declines
            V->>P: Same credential, MIT, NTID
            P->>I: Authorisation
            I-->>P: Approved or declined (back to the rules engine)
            P-->>M: Result recorded
        else Fix the credential, then retry
            M->>V: Refresh the credential
            V->>T: Token lifecycle refresh or account updater inquiry
            T-->>V: New expiry or replacement card
            V-->>M: Credential fixed
            M->>V: Retry with the fixed credential
            V->>P: Charge
            P->>I: Authorisation
            I-->>P: Result
            P-->>M: Result recorded
        else Ask the customer
            M->>C: Clear message and an update link to the hosted form
            C->>V: New card details in the hosted form (within 7 days)
            V-->>M: New vault reference
            M->>V: Charge the new credential
            V->>P: Charge
            P->>I: Authorisation
            I-->>P: Result
            P-->>M: Result recorded
        else Stop
            M->>M: Stop: revoked, fraud, never-retry code, limit or dunning window exhausted
            M->>C: Clear message on why the renewal failed and what happens next
        end
    end
```

```
src/core      rules (configuration), engine, limits, router, time   pure, no I/O
src/sim       SIMULATED vault, token service, updater, PSPs, issuers, customers
src/ledger    ledger logic over SQLite, and the guardrail audit
src/recovery  the recovery loop, shared by the Workflow and the tests
src/worker    Worker API, ledger Durable Object, Workflow, chat
public        operator page
test/unit     decision table (50+ cases), router, limits, simulators, whole-night invariants
test/functional  end-to-end through the API (wrangler dev or the live URL)
```

The guardrails are listed in [`docs/PROMPTS.md`](docs/PROMPTS.md) (prompt 4), and each
decision is in [`docs/adr`](docs/adr). The rules, their sources and confidence are in
[`docs/network-rules.md`](docs/network-rules.md).

## Run it

Requires Node 24 and a Cloudflare account. Workers AI runs remotely, even in dev.

```bash
npm install
```

```bash
npm run typecheck
```

```bash
npm test
```

```bash
npx wrangler dev
```

Functional tests against a running Worker (default `http://localhost:8787`):

```bash
E2E_BASE_URL=http://localhost:8787 npm run test:functional
```

## API

| Method | Path | What it does |
|---|---|---|
| POST | `/api/runs` `{size: "full"\|"ci", start?, seed?, dayMs?}` | Generate a night (2,000 or 350 renewals) and bill it; with `start: true`, also start recovery. One active run at a time (the 409 names it); hourly quotas (the 429 says when they reset) |
| POST | `/api/runs/:id/recover` | Start one Workflow per failed renewal (idempotent). `?restart=1` restarts the ones in progress |
| GET | `/api/runs`, `/api/runs/latest`, `/api/runs/:id` | Runs and the summary, with the naive and legacy comparisons |
| GET | `/api/runs/:id/payments?status=&path=&brand=&psp=&region=&code=&q=` | Declined renewals |
| GET | `/api/payments/:id` | Timeline: attempts, decisions with their rules, events |
| GET | `/api/runs/:id/live?after=` | Live progress: settled, recovered, attempts, and the activity feed since a cursor. The page polls it every second |
| GET | `/api/runs/:id/incidents` | PSP and issuer outages detected in the ledger |
| GET | `/api/runs/:id/export` | The run's ledger rows, which the functional tests audit |
| GET | `/api/runs/:id/workflows` | Workflow instance states for renewals in progress |
| POST | `/api/chat` `{runId, message}` | Operator chat; returns the answer and the tools used |
| GET | `/api/rules` | Every rule with its source and confidence |
| GET | `/api/overview` | This README, shown on the page as the system overview |

**Live updates use polling, not a push channel.** The run's state lives in one Durable
Object, and a cheap aggregate query every second per viewer is simpler than holding
Server-Sent Events or WebSocket connections open. It needs no reconnection logic, and it
works the same under `wrangler dev`. A push channel would only pay off with many concurrent
viewers.

## CI/CD

GitHub Actions (`.github/workflows/ci.yml`):
- **Every push and pull request:** type check and unit tests.
- **On `main`:** deploy with wrangler, then run the functional tests against the live URL.

It needs two repository secrets: `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`.

## Scope and limits

- **Simulated:** every PSP, issuer, card and customer. The recovery figures show how the
  design behaves under the simulator's assumptions; they are not a forecast.
- **Rule readings:** the network rules are readings of public material, each with a
  confidence. Check them against current scheme rules before using them with real payments.
- **Public demo safety:**
  - Hourly quotas apply to generating nights and to chat.
  - Per-IP limits store only a salted hash, never the address.
  - There are no secrets in the repository.
  - Cloudflare resources use the `ba-cofdr` prefix only.

## Prompt history

The prompts that designed and built this project are in [`docs/PROMPTS.md`](docs/PROMPTS.md).
The transcript of the build session is in
[`docs/PROMPT_HISTORY.md`](docs/PROMPT_HISTORY.md).
