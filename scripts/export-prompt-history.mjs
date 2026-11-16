// Turn a Claude Code session transcript (.jsonl) into a readable Markdown prompt history.
//
//   node scripts/export-prompt-history.mjs <session.jsonl> <out.md> [--from "<text>"] [--prompts <prompts.md>]
//
// Keeps: the prompts, word for word; the assistant's replies; one line per tool call (what
// was run or edited). Drops: tool outputs, the model's private reasoning, and notes the app
// injects (<system-reminder> blocks, task notifications, file-change and status notes).
// Prompts lose only those injected blocks and the app's <pasted_content> wrapper tags.
// In replies and tool lines, local paths are shortened and email addresses and Cloudflare
// account ids are masked. With --from, everything before the first prompt containing that
// text is left out, and the output says so. With --prompts, the prompts alone are also
// written, numbered, to a second file.
//
// --skip "<text>" (repeatable): leave out the prompt containing that text and everything
// after it (replies, tool calls) until the next prompt that is kept.
// --redact <rules.json>: a list of {"pattern": "<regex>", "flags": "gi", "replace": "<text>",
// "in": ["prompts", "replies", "tools"]}. A tool line that matches a rule with "replace": null
// is dropped. Keep the rules file outside the repository when the patterns themselves are
// private. Review the output before sharing.

import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const from = opt("--from");
const promptsOut = opt("--prompts");
const redactFile = opt("--redact");
const skips = args.flatMap((a, i) => (a === "--skip" ? [args[i + 1]] : []));
const optIdx = new Set(args.flatMap((a, i) => (["--from", "--prompts", "--redact", "--skip"].includes(a) ? [i, i + 1] : [])));
const [input, output = "prompt-history.md"] = args.filter((_, i) => !optIdx.has(i));
const rules = redactFile ? JSON.parse(readFileSync(redactFile, "utf8")) : [];
const redact = (text, where) => {
  let t = text;
  for (const r of rules) {
    if (!(r.in ?? ["prompts", "replies", "tools"]).includes(where)) continue;
    const re = new RegExp(r.pattern, r.flags ?? "g");
    if (r.replace === null) {
      if (re.test(t)) return null;
    } else t = t.replace(re, r.replace);
  }
  return t;
};
let skipping = false;
if (!input) {
  console.error('usage: node scripts/export-prompt-history.mjs <session.jsonl> <out.md> [--from "<text>"] [--prompts <prompts.md>]');
  process.exit(1);
}

const HOME = homedir().replaceAll("\\", "/");
const SKIP_TOOLS = /^(mcp__ccd_|ToolSearch$|mcp__visualize__|TaskStop$)/;

/** For prompts: remove only what the app injects; keep every word the user wrote. */
const stripInjected = (s) =>
  String(s ?? "")
    .replace(/<system-reminder[^>]*>[\s\S]*?<\/system-reminder[^>]*>/g, "")
    .replace(/<task-notification>[\s\S]*?<\/task-notification>/g, "")
    .replace(/<\/?pasted_content[^>]*>/g, "")
    .trim();

/** For replies and tool lines. */
const clean = (s) =>
  stripInjected(s)
    .replace(/^Note: .* changed on disk since you last read it\.[\s\S]*?(?=\n\n[^ \d]|$)/gm, "")
    .replace(/^The user hasn't heard from you in a while.*$/gm, "")
    .replaceAll("\\", "/")
    .replaceAll(HOME, "~")
    .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, (m) => (/@(anthropic\.com|example\.com)$/.test(m) ? m : "[email]"))
    .replace(/\b[0-9a-f]{32}\b/g, "[account-id]")
    .trim();

/** Messages the app injects as user turns; they are not prompts. */
const INJECTED = /^(\[?(Request interrupted|Tool loaded)|\[SYSTEM NOTIFICATION|Caveat:|<command-|<local-command|Note: .* changed on disk|The user hasn't heard from you)/;

function describeTool(name, input = {}) {
  const short = (s, n = 140) => {
    const t = clean(s).replace(/\s+/g, " ");
    return t.length > n ? `${t.slice(0, n)}…` : t;
  };
  switch (name) {
    case "Bash":
    case "PowerShell":
      return `${name}: ${short(input.description || input.command)}`;
    case "Write":
    case "Edit":
    case "Read":
      return `${name}: ${short(input.file_path)}`;
    case "WebFetch":
      return `WebFetch: ${input.url}`;
    case "WebSearch":
      return `WebSearch: ${short(input.query)}`;
    case "Grep":
    case "Glob":
      return `${name}: ${short(input.pattern)}`;
    case "Agent":
      return `Agent: ${short(input.description)}`;
    default:
      if (name.startsWith("mcp__Claude_Browser__")) return `Browser: ${name.replace("mcp__Claude_Browser__", "")}`;
      if (name.startsWith("mcp__")) return name.split("__").pop();
      return name;
  }
}

const out = [
  "# Prompt history",
  "",
  "Exported from the Claude Code session that designed and built this repository, with `scripts/export-prompt-history.mjs`. Prompts are copied as sent, except where noted below. Tool outputs and the model's private reasoning are omitted; each tool call is listed on one line.",
  "",
];
if (from) out.push("Earlier turns in the same session, unrelated to this project, are excluded; the history starts at the first prompt about this project.", "");
const scopeNote = out.length;
if (skips.length || rules.length) out.push("Turns and passages about work outside this project's scope are left out.", "");
let promptsRedacted = 0;

let started = !from;
const prompts = [];
let pendingTools = [];
const flushTools = () => {
  if (pendingTools.length) {
    out.push("<details><summary>Tool calls (" + pendingTools.length + ")</summary>", "", ...pendingTools.map((t) => `- ${t}`), "", "</details>", "");
    pendingTools = [];
  }
};
const addPrompt = (raw, queued) => {
  skipping = skips.some((s) => raw.includes(s));
  if (skipping) {
    pendingTools = [];
    return;
  }
  const text = redact(raw, "prompts") ?? "";
  if (text !== raw) promptsRedacted++;
  flushTools();
  prompts.push({ text, queued });
  out.push(queued ? "## Prompt (sent while the assistant was working)" : "## Prompt", "", text, "");
};

for (const line of readFileSync(input, "utf8").split("\n")) {
  if (!line.trim()) continue;
  let entry;
  try {
    entry = JSON.parse(line);
  } catch {
    continue;
  }
  if (entry.isSidechain || entry.isMeta) continue;
  // Messages typed while the assistant was working are stored as queued commands.
  const queued = entry.type === "attachment" && entry.attachment?.type === "queued_command" && entry.attachment.origin?.kind === "human";
  if (queued) {
    const raw = String(entry.attachment.prompt ?? "");
    if (!started && from && raw.includes(from)) started = true;
    const text = stripInjected(raw);
    if (started && text && !INJECTED.test(text)) addPrompt(text, true);
    continue;
  }
  const msg = entry.message;
  if (!msg) continue;

  if (entry.type === "user") {
    const parts = typeof msg.content === "string" ? [{ type: "text", text: msg.content }] : msg.content ?? [];
    const raw = parts.filter((p) => p.type === "text").map((p) => String(p.text ?? "")).join("\n\n");
    if (!started && from && raw.includes(from)) started = true;
    if (!started) continue;
    const text = stripInjected(raw);
    if (text && !INJECTED.test(text)) addPrompt(text, false);
  } else if (entry.type === "assistant") {
    if (!started || skipping) continue;
    for (const part of msg.content ?? []) {
      if (part.type === "text" && clean(part.text)) {
        const text = (redact(clean(part.text), "replies") ?? "").trim();
        if (!text) continue;
        flushTools();
        out.push(text, "");
      } else if (part.type === "tool_use" && !SKIP_TOOLS.test(part.name)) {
        const line = redact(describeTool(part.name, part.input), "tools");
        if (line) pendingTools.push(line);
      }
    }
  }
}
flushTools();

if (!started) {
  console.error(`marker not found: ${from}`);
  process.exit(1);
}
if (promptsRedacted) {
  out[scopeNote] = `Turns and passages about work outside this project's scope are left out: in replies and tool lines, and in ${promptsRedacted === 1 ? "one prompt" : `${promptsRedacted} prompts`}. Every other word of the prompts is as sent.`;
}
writeFileSync(output, out.join("\n"));
console.log(`Wrote ${output}${promptsRedacted ? ` (${promptsRedacted} prompt(s) redacted)` : ""}`);
if (promptsOut) {
  const lines = prompts.flatMap((p, i) => [`## Prompt ${i + 1}${p.queued ? " (sent while the assistant was working)" : ""}`, "", p.text, ""]);
  writeFileSync(promptsOut, lines.join("\n"));
  console.log(`Wrote ${promptsOut} (${prompts.length} prompts)`);
}
