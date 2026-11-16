// Operator chat. Llama 3.3 on Workers AI answers by calling read-only tools over the
// ledger. It explains; it never decides, schedules, routes or computes money. Every
// figure it can quote is computed and formatted here, in code.

import { ruleById, SOURCES } from "../core/rules";
import { simLabel } from "../core/time";
import { PATH_LABELS, pct, usd } from "./format";
import type { LedgerApi } from "./ledger-do";
import type { RunSummary } from "../ledger/logic";

type LedgerStub = LedgerApi;

export const TOOLS = [
  {
    name: "get_run_summary",
    description: "Headline figures for the night: renewals, declines, recovered revenue, recovery paths, retries, prevention, and the naive and legacy comparisons. All figures are preformatted.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "breakdown_declines",
    description: "Count declined renewals grouped by one dimension. Use by='classification' for why renewals failed (the network rule that matched the first decline), 'code' for raw response codes, 'path' for how they were recovered or stopped, 'psp', 'brand', 'region' or 'outcome'.",
    parameters: {
      type: "object",
      properties: { by: { type: "string", enum: ["classification", "code", "path", "psp", "brand", "region", "outcome"] } },
      required: ["by"],
    },
  },
  {
    name: "list_incidents",
    description: "PSP and issuer outages detected in the ledger during the night, with how many attempts they affected.",
    parameters: { type: "object", properties: {}, required: [] },
  },
  {
    name: "find_payments",
    description: "Find up to 10 declined renewals by filters, for examples. Codes are the first decline's response code (for example 54 for expired card).",
    parameters: {
      type: "object",
      properties: {
        status: { type: "string", enum: ["recovering", "recovered", "failed", "cancelled"] },
        path: { type: "string", enum: Object.keys(PATH_LABELS) },
        code: { type: "string" },
        brand: { type: "string", enum: ["visa", "mastercard"] },
        psp: { type: "string", enum: ["psp-us", "psp-eu", "psp-uk", "psp-apac"] },
      },
      required: [],
    },
  },
  {
    name: "get_payment_timeline",
    description: "Every attempt, decision (with the rules applied) and event for one payment, in order.",
    parameters: { type: "object", properties: { payment_id: { type: "string" } }, required: ["payment_id"] },
  },
  {
    name: "explain_rule",
    description: "The text, source and confidence of a rule id such as visa.cat2.funds or mastercard.mac.26.",
    parameters: { type: "object", properties: { rule_id: { type: "string" } }, required: ["rule_id"] },
  },
] as const;

type ToolName = (typeof TOOLS)[number]["name"];
const TOOL_NAMES = new Set<string>(TOOLS.map((t) => t.name));

const SYSTEM_PROMPT = `You are the operations assistant for a subscription merchant's card-on-file decline recovery platform.
A deterministic rules engine made every decision from public Visa and Mastercard rules. You only explain what happened.
Rules:
- Always call a tool before answering a question about the data. Quote figures exactly as the tools return them; never calculate, estimate or round figures yourself.
- Never recommend retrying a card, changing a schedule or moving money; you have no tools that change anything.
- Mention rule ids when explaining why something happened.
- All PSPs, issuers, cards and customers are simulated and fictional.
- Answer in short plain sentences or "- " bullets, under 180 words.`;

async function runTool(ledger: LedgerStub, runId: string, name: ToolName, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "get_run_summary": {
      const s = (await ledger.summary(runId)) as RunSummary | null;
      if (!s) return { error: "run not found" };
      const paths = Object.entries(s.byPath)
        .sort((a, b) => b[1].count - a[1].count)
        .map(([k, v]) => `${PATH_LABELS[k] ?? k}: ${v.count} renewals, ${usd(v.cents)}`);
      return {
        renewals: s.renewals,
        approved_first_time: s.approvedFirstTime,
        declined: `${s.declined} renewals worth ${usd(s.declinedCents)}`,
        recovered: `${s.recovered} renewals worth ${usd(s.recoveredCents)} (${pct(s.recoveryRateByAmount)} of declined revenue)`,
        still_in_progress: s.inProgress,
        recovery_paths: paths,
        merchant_retries: s.retries,
        retries_via_another_psp: s.altPspRetries,
        customers_asked_to_update_card: s.customersAsked,
        prevented_before_billing: `${s.prevention.tokenLifecycle} by network token lifecycle updates, ${s.prevention.accountUpdater} by the account updater`,
        first_attempt_credentials: `${s.credentialTypes.networkToken} network token, ${s.credentialTypes.panFallback} card-number fallback`,
        naive_schedule_same_declines: `days 1, 3, 5, 7 on the same PSP would have recovered ${usd(s.naive.recoveredCents)} with ${s.naive.retries} retries and ${s.naive.neverRetryViolations} retries of never-retry codes`,
        legacy_single_psp: `one PSP with its own token: ${s.legacy.declines} declines, ${usd(s.legacy.recoveredCents)} recovered, ${s.legacy.neverRetryViolations} never-retry violations`,
        guardrail_violations: s.violations === null ? "audit runs when the night completes" : s.violations,
      };
    }
    case "breakdown_declines": {
      const by = String(args.by ?? "classification") as "classification" | "code" | "path" | "psp" | "brand" | "region" | "outcome";
      const rows = await ledger.breakdown(runId, by);
      const total = rows.reduce((n, r) => n + r.count, 0) || 1;
      return rows.slice(0, 15).map((r) => {
        const rule = by === "classification" ? ruleById(r.key) : undefined;
        return { [by]: r.key, ...(rule ? { meaning: rule.label } : {}), ...(by === "path" ? { meaning: PATH_LABELS[r.key] ?? r.key } : {}), renewals: r.count, share: pct(r.count / total), amount: usd(r.cents ?? 0) };
      });
    }
    case "list_incidents": {
      const list = await ledger.incidents(runId);
      if (list.length === 0) return { incidents: "none detected" };
      return list.map((i) => ({ kind: i.kind, subject: i.subject, from: simLabel(i.from), to: simLabel(i.to), affected_attempts: i.affected, payments_later_recovered: i.recovered, text: i.text }));
    }
    case "find_payments": {
      const f: Record<string, string> = {};
      for (const k of ["status", "path", "code", "brand", "psp"]) if (typeof args[k] === "string" && args[k]) f[k] = String(args[k]);
      const { total, rows } = await ledger.listPayments(runId, { ...f, limit: 10 });
      return {
        total_matching: total,
        examples: rows.map((p) => ({ payment_id: p.id, brand: p.brand, region: p.region, amount: usd(p.amount_cents), first_decline: `${p.first_code}${p.first_mac ? ` / MAC ${p.first_mac}` : ""}`, outcome: PATH_LABELS[p.path ?? "in_progress"] ?? p.path, status: p.status })),
      };
    }
    case "get_payment_timeline": {
      const t = await ledger.timeline(String(args.payment_id ?? ""));
      if (!t) return { error: "payment not found" };
      return {
        payment: { id: t.payment.id, brand: t.payment.brand, region: t.payment.region, amount: usd(t.payment.amount_cents), status: t.payment.status, outcome: PATH_LABELS[t.payment.path ?? "in_progress"] ?? t.payment.path },
        attempts: t.attempts.map((a) => `${simLabel(a.at)}: ${a.psp}, ${a.credential_type}, ${a.customer_initiated ? "customer-initiated" : "merchant-initiated"}: ${a.status}${a.code ? ` ${a.code}` : ""}${a.mac ? ` MAC ${a.mac}` : ""}`),
        decisions: t.decisions.map((d) => `${simLabel(d.at)}: ${d.action}${d.psp ? ` via ${d.psp}` : ""}: ${d.reason} [rules: ${(JSON.parse(d.rule_ids) as string[]).join(", ")}]`),
        events: t.events.map((e) => `${simLabel(e.at)}: ${e.type}`),
      };
    }
    case "explain_rule": {
      const r = ruleById(String(args.rule_id ?? ""));
      if (!r) return { error: "unknown rule id" };
      const src = SOURCES.find((s) => s.id === r.source);
      return { id: r.id, rule: r.label, source: src?.title, url: src?.url, confidence: r.confidence, note: "note" in r ? r.note : undefined };
    }
  }
}

type Message =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string; tool_calls?: unknown[] }
  | { role: "tool"; content: string; name: string; tool_call_id?: string };

interface ToolCall {
  id: string;
  name: ToolName;
  arguments: Record<string, unknown>;
}

export async function answer(
  ai: Ai,
  model: string,
  ledger: LedgerStub,
  runId: string,
  history: Array<{ role: string; content: string }>,
  userText: string,
): Promise<{ answer: string; tools: Array<{ name: string; args: Record<string, unknown> }> }> {
  const messages: Message[] = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history.slice(-6).map((h) => ({ role: h.role === "assistant" ? ("assistant" as const) : ("user" as const), content: h.content })),
    { role: "user", content: userText },
  ];
  const used: Array<{ name: string; args: Record<string, unknown> }> = [];
  for (let round = 0; round < 3; round++) {
    const res = (await ai.run(model as never, { messages, tools: TOOLS as never, max_tokens: 700, temperature: 0.1 } as never)) as unknown;
    const calls = extractToolCalls(res);
    if (calls.length === 0) {
      const text = textOf(res);
      if (used.length === 0 && round === 0) {
        // The model must ground its answer in the ledger: fall back to the summary tool once.
        const fallback: ToolCall = { id: "call_summary", name: "get_run_summary", arguments: {} };
        await callTools(ledger, runId, [fallback], messages, used);
        continue;
      }
      return { answer: text || "I could not produce an answer.", tools: used };
    }
    await callTools(ledger, runId, calls, messages, used);
  }
  const final = (await ai.run(model as never, { messages, max_tokens: 700, temperature: 0.1 } as never)) as unknown;
  return { answer: textOf(final) || "I could not produce an answer.", tools: used };
}

async function callTools(ledger: LedgerStub, runId: string, calls: ToolCall[], messages: Message[], used: Array<{ name: string; args: Record<string, unknown> }>): Promise<void> {
  messages.push({ role: "assistant", content: "", tool_calls: calls.map((c) => ({ id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments) } })) });
  for (const c of calls.slice(0, 4)) {
    used.push({ name: c.name, args: c.arguments });
    const result = await runTool(ledger, runId, c.name, c.arguments);
    messages.push({ role: "tool", name: c.name, tool_call_id: c.id, content: JSON.stringify(result).slice(0, 6000) });
  }
}

/**
 * Workers AI returns tool calls as `tool_calls: [{name, arguments}]`, sometimes in the
 * OpenAI shape, and Llama sometimes writes the call as JSON text. Accept all three.
 */
export function extractToolCalls(res: unknown): ToolCall[] {
  const out: ToolCall[] = [];
  const r = res as { tool_calls?: unknown[]; response?: unknown; choices?: Array<{ message?: { tool_calls?: unknown[] } }> };
  const raw = r?.tool_calls ?? r?.choices?.[0]?.message?.tool_calls ?? [];
  for (const [i, item] of (raw as Array<Record<string, unknown>>).entries()) {
    const fn = (item.function as Record<string, unknown> | undefined) ?? item;
    const name = String(fn.name ?? "");
    if (TOOL_NAMES.has(name)) out.push({ id: String(item.id ?? `call_${i}`), name: name as ToolName, arguments: parseArgs(fn.arguments ?? fn.parameters) });
  }
  if (out.length === 0 && typeof r?.response === "string") {
    const text = r.response.trim();
    if (text.startsWith("{") && text.endsWith("}")) {
      try {
        const j = JSON.parse(text) as Record<string, unknown>;
        if (TOOL_NAMES.has(String(j.name))) out.push({ id: "call_text", name: j.name as ToolName, arguments: parseArgs(j.arguments ?? j.parameters) });
      } catch {
        /* not a tool call */
      }
    }
  }
  return out;
}

function parseArgs(a: unknown): Record<string, unknown> {
  if (typeof a === "string") {
    try {
      const j = JSON.parse(a);
      return j && typeof j === "object" ? (j as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return a && typeof a === "object" ? (a as Record<string, unknown>) : {};
}

function textOf(res: unknown): string {
  const r = res as { response?: unknown; choices?: Array<{ message?: { content?: string } }> };
  if (typeof r?.response === "string") return r.response.trim();
  if (r?.response && typeof r.response === "object") return JSON.stringify(r.response);
  return r?.choices?.[0]?.message?.content?.trim() ?? "";
}
