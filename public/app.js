// Operator page for the Card-on-File Decline Recovery demo.
// Vanilla ES module, no build step. All server text is escaped before it is inserted as HTML;
// the one exception is the README in the System Overview, which is our own repository content.

const REPO = 'https://github.com/bi-ah/card-on-file-decline-recovery';
const RAW = 'https://raw.githubusercontent.com/bi-ah/card-on-file-decline-recovery/main';
const MARKED_URL = 'https://cdn.jsdelivr.net/npm/marked@12.0.2/lib/marked.esm.js';
const MERMAID_URL = 'https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.esm.min.mjs';

const LIMIT = 50;
const LIVE_MS = 1000; // /live polling while a run is active
const FULL_MS = 3000; // summary, incidents and payments refresh while active
const TIMELINE_MS = 2000; // open timeline refresh while that payment is recovering
const RUNS_MS = 15000; // run list refresh, so the Run button knows about other runs
const STALL_MS = 30000;
const MAX_FEED = 50;
const RETRY_DAYS = 21;
const MAX_DAYS = 28;
const FULL_RENEWALS = 2000;
const BILLING_TEXT = `Billing ${FULL_RENEWALS.toLocaleString('en-US')} renewals…`;
const THEME_KEY = 'cofdr-theme';
const HOWTO_KEY = 'cofdr-howto-seen';

const PATH_LABELS = {
  timed_retry: 'Timed retry, same PSP',
  another_psp: 'Another PSP',
  credential_refreshed: 'Credential refreshed',
  customer_updated_card: 'Customer updated card',
  exhausted: 'Exhausted',
  cancelled: 'Cancelled (revoked)',
  stopped: 'Stopped (never retry)',
  stopped_silent: 'Stopped, no outreach',
  alert_ops: 'Operations alerted',
  in_progress: 'In progress',
};

const PATH_TONE = {
  timed_retry: 'good',
  another_psp: 'good',
  credential_refreshed: 'good',
  customer_updated_card: 'good',
  exhausted: 'bad',
  cancelled: 'neutral',
  stopped: 'neutral',
  stopped_silent: 'neutral',
  alert_ops: 'bad',
  in_progress: 'warn',
};

const STATUS_TONE = {
  approved: 'good',
  recovered: 'good',
  completed: 'good',
  declined: 'bad',
  failed: 'bad',
  cancelled: 'neutral',
  abandoned: 'neutral',
  generated: 'neutral',
  recovering: 'warn',
  in_progress: 'warn',
};

const KIND_LABELS = { attempt: 'Attempt', decision: 'Decision', event: 'Event' };
const INCIDENT_LABELS = { psp_outage: 'PSP outage', issuer_outage: 'Issuer outage' };
const BRAND_LABELS = { visa: 'Visa', mastercard: 'Mastercard' };
const CREDENTIAL_LABELS = { network_token: 'Network token', pan_fallback: 'Card-number fallback' };
const ACTIVITY_KINDS = { approved: 'approved', declined: 'declined', credential: 'credential update', customer: 'customer', stopped: 'stopped' };

const PHASES = ['billing', 'recovering', 'auditing', 'completed'];
const PHASE_LABELS = {
  billing: 'Billing the night',
  recovering: 'Recovering',
  auditing: 'Auditing',
  completed: 'Completed',
  abandoned: 'Abandoned',
};

// Plain-word glossary. `tip` is the one-line tooltip; `text` is shown in the How to use panel.
const GLOSSARY = {
  mac: {
    term: 'MAC (Mastercard Merchant Advice Code)',
    short: 'a MAC',
    tip: 'Mastercard Merchant Advice Code: advice on whether and when the merchant may retry.',
    text: 'A code Mastercard adds to some declines to advise the merchant. For example, 01 means get the new card details first, 02 means try again later, and 03 or 21 mean do not retry this card.',
  },
  ntid: {
    term: 'NTID (network transaction ID)',
    short: 'an NTID',
    tip: 'Network transaction ID: links each renewal to the subscription the customer agreed to.',
    text: "The ID the card network gave the customer's first payment. Sending it with every renewal tells the issuer the charge belongs to a subscription the customer agreed to.",
  },
  token: {
    term: 'Network token',
    short: 'a network token',
    tip: 'A stand-in for the card number from Visa or Mastercard; it keeps working when the card is reissued.',
    text: 'A stand-in for the card number, issued by Visa or Mastercard for this merchant. When the bank reissues the card, the token keeps working, so fewer renewals fail.',
  },
  fallback: {
    term: 'Card-number fallback',
    short: 'card-number fallback',
    tip: 'Charging the stored card number when the network token cannot be used.',
    text: 'Charging the stored card number instead of the token, for example when a PSP cannot use network tokens.',
  },
  cascade: {
    term: 'Cascade (retry through another PSP)',
    short: 'a cascade',
    tip: 'Retrying a declined charge through a different PSP; allowed only for some decline types.',
    text: 'Retrying a declined charge through a different payment service provider (PSP). It is allowed only for declines that are not about the card itself: generic, processing, issuer-unavailable and acquirer-side declines.',
  },
  visa: {
    term: 'Visa decline categories 1–4',
    short: 'a Visa decline category',
    tip: 'Visa groups decline codes: 1 never retry, 2 retry later, 3 fix the data first, 4 generic.',
    text: 'Visa groups decline codes into four categories. 1: the issuer will never approve, so never retry. 2: the issuer cannot approve now, so retry later within limits. 3: the data needs fixing (for example the expiry date) before any retry. 4: generic codes, retried within limits.',
  },
  dunning: {
    term: 'Dunning window',
    short: 'the dunning window',
    tip: 'The period in which the merchant keeps trying to collect and asks the customer to update the card.',
    text: 'The period in which the merchant keeps trying to collect a failed renewal and asks the customer to update the card. In this demo retries run for up to 21 simulated days, and customers who were asked have until day 28 to reply.',
  },
};

const ABBR = {
  NTID: 'Network transaction ID',
  MAC: 'Mastercard Merchant Advice Code',
  MIT: 'Merchant-initiated transaction',
};

const state = {
  runs: [],
  showTest: false,
  runId: null, // always a string
  run: null,
  summary: null,
  gen: 0, // bumps on every run selection; stale responses are dropped
  lastStatus: null,
  watching: false, // this run was seen active in this session
  creating: false, // POST /api/runs in flight
  startingRecovery: false, // POST /api/runs/:id/recover in flight

  live: null,
  cursor: 0,
  clockOffset: 0, // serverNow - local now
  lastLiveAt: 0,
  lastProgressAt: 0,
  progressKey: '',
  liveTimer: null,
  liveBusy: null, // gen of the /live request in flight
  liveError: '',
  lastFullAt: 0,
  fullBusy: null,
  feed: [],
  announcedPhase: undefined,
  lastDecile: null,
  prevTiles: null,

  paymentsSeq: 0,
  offset: 0,
  total: 0,
  rowSigs: new Map(),

  timelineSeq: 0,
  tlId: null,
  tlSig: '',
  tlTimer: null,

  chatPending: false,
};

/* ---------- Small helpers ---------- */

const $ = (sel) => document.querySelector(sel);
const enc = encodeURIComponent;

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[c]);
}

const moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
const dateFmt = new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' });
const shortFmt = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clockFmt = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const fmtMoney = (cents) => (isNum(cents) ? moneyFmt.format(cents / 100) : '–');
const fmtInt = (n) => (isNum(n) ? n.toLocaleString('en-US') : '–');
const fmtPct = (ratio) => (isNum(ratio) ? `${(ratio * 100).toFixed(1)}%` : '–');
const fmtTime = (ms) => (isNum(ms) && ms > 0 ? dateFmt.format(new Date(ms)) : '–');
const fmtShort = (ms) => (isNum(ms) && ms > 0 ? shortFmt.format(new Date(ms)) : '–');
const fmtClock = (ms) => (isNum(ms) && ms > 0 ? clockFmt.format(new Date(ms)) : 'later');
const yesNo = (b) => (b ? 'Yes' : 'No');
const humanize = (s) => String(s ?? '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const pathLabel = (p) => (p ? PATH_LABELS[p] || humanize(p) : '–');
const credentialLabel = (c) => CREDENTIAL_LABELS[c] || (c ? humanize(c) : '–');
const brandLabel = (b) => BRAND_LABELS[b] || (b ? humanize(b) : '–');
const isActiveStatus = (s) => s === 'generated' || s === 'recovering';

function fmtDuration(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ${s % 60} s`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}

function badge(status, text) {
  const tone = STATUS_TONE[status] || 'neutral';
  return `<span class="badge badge-${tone}">${esc(text ?? humanize(status || 'unknown'))}</span>`;
}

function safeUrl(url) {
  try {
    const u = new URL(String(url), location.href);
    return u.protocol === 'https:' || u.protocol === 'http:' ? u.href : null;
  } catch {
    return null;
  }
}

// Adds tooltips to known abbreviations. Only ever called on already-escaped text.
function glossify(escaped) {
  return escaped.replace(/\b(NTID|MAC|MIT)\b/g, (m) => `<abbr title="${ABBR[m]}">${m}</abbr>`);
}

function helpBtn(key) {
  const g = GLOSSARY[key];
  if (!g) return '';
  return `<button type="button" class="help" data-glossary="${key}" title="${esc(g.tip)}" aria-label="What is ${esc(g.short)}? Opens the glossary">?</button>`;
}

function setText(el, text, flashOnChange = false) {
  if (!el || el.textContent === text) return;
  const had = el.textContent && el.textContent !== '–';
  el.textContent = text;
  if (flashOnChange && had) flash(el);
}

function flash(el) {
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
  el.addEventListener('animationend', () => el.classList.remove('flash'), { once: true });
}

function announce(text) {
  const el = $('#announcer');
  el.textContent = '';
  setTimeout(() => { el.textContent = text; }, 60);
}

function readStorage(key) {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStorage(key, value) {
  try { localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

/* ---------- API ---------- */

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data || {};
  }
}

function describeError(status, message) {
  const detail = message ? ` ${message}${/[.!?]$/.test(message) ? '' : '.'}` : '';
  if (status === 409) return `A run is already in progress (409).${detail}`;
  if (status === 429) return `Usage quota reached (429).${detail}`;
  if (status === 404) return `Not found (404).${detail}`;
  return message ? `${message} (HTTP ${status})` : `Request failed (HTTP ${status}).`;
}

async function api(path, { method = 'GET', body } = {}) {
  const init = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'Could not reach the API. Check your connection and try again.');
  }
  let data = null;
  const text = await res.text();
  if (text) {
    try { data = JSON.parse(text); } catch { data = null; }
  }
  if (!res.ok) {
    const msg = data && typeof data.error === 'string' ? data.error : '';
    throw new ApiError(res.status, describeError(res.status, msg), data);
  }
  return data ?? {};
}

/* ---------- Global error and messages ---------- */

let errorRetry = null;

function showError(message, retry) {
  $('#app-error-text').textContent = message;
  errorRetry = typeof retry === 'function' ? retry : null;
  $('#app-error-retry').hidden = !errorRetry;
  $('#app-error').hidden = false;
}

function clearError() {
  $('#app-error').hidden = true;
  $('#app-error-text').textContent = '';
  errorRetry = null;
}

function setRunMessage(text, tone = 'info') {
  const box = $('#run-message');
  $('#run-message-text').textContent = text || '';
  box.classList.toggle('is-warn', tone === 'warn');
  box.hidden = !text;
}

/* ---------- Run list and selection ---------- */

function readHashRun() {
  const params = new URLSearchParams(location.hash.replace(/^#/, ''));
  return params.get('run');
}

function writeHashRun(id) {
  const next = `#run=${enc(id)}`;
  if (location.hash !== next) history.replaceState(null, '', next);
}

function findRun(id) {
  return state.runs.find((r) => String(r.id) === String(id)) || null;
}

// The id as the server gave it (number or string), for request bodies.
function rawRunId() {
  const r = findRun(state.runId) || state.run;
  return r ? r.id : state.runId;
}

const byCreated = (a, b) => (b.createdAt || 0) - (a.createdAt || 0);

function runOptionText(r) {
  const parts = [fmtShort(r.createdAt)];
  if (isNum(r.renewals)) parts.push(`${fmtInt(r.renewals)} renewals`);
  if (r.status) parts.push(r.status);
  if (r.label === 'ci') parts.push('test run');
  return parts.join(' · ');
}

function visibleRuns() {
  return state.runs.filter((r) => state.showTest || r.label !== 'ci' || String(r.id) === state.runId);
}

function runListKey() {
  return visibleRuns().map((r) => r.id).join(',');
}

function renderRunSelect() {
  const sel = $('#run-select');
  const list = visibleRuns();
  const hidden = state.runs.length - list.length;
  $('#show-test-text').textContent = hidden > 0 ? `Show test runs (${hidden})` : 'Show test runs';
  state.runListKey = runListKey();
  if (!list.length) {
    sel.innerHTML = `<option value="">${state.runs.length ? 'Only test runs so far' : 'No runs yet'}</option>`;
    sel.disabled = true;
    return;
  }
  sel.innerHTML = list
    .map((r) => `<option value="${esc(r.id)}">${esc(runOptionText(r))}</option>`)
    .join('');
  sel.disabled = false;
  if (state.runId) sel.value = state.runId;
}

// Updates option texts in place when the list itself did not change, so an open dropdown is not disturbed.
function syncRunSelect() {
  if (runListKey() !== state.runListKey) {
    renderRunSelect();
    return;
  }
  const options = [...$('#run-select').options];
  for (const r of visibleRuns()) {
    const opt = options.find((o) => o.value === String(r.id));
    if (opt) opt.textContent = runOptionText(r);
  }
}

function upsertRun(run) {
  if (!run) return;
  const idx = state.runs.findIndex((r) => String(r.id) === String(run.id));
  if (idx === -1) {
    state.runs.push(run);
    state.runs.sort(byCreated);
  } else {
    state.runs[idx] = run;
  }
  syncRunSelect();
}

async function refreshRuns() {
  try {
    const data = await api('/api/runs');
    const runs = Array.isArray(data.runs) ? data.runs : [];
    // The selected run's freshest state comes from its own polling.
    if (state.run) {
      const idx = runs.findIndex((r) => String(r.id) === state.runId);
      if (idx === -1) runs.push(state.run);
      else runs[idx] = state.run;
    }
    state.runs = runs.sort(byCreated);
    syncRunSelect();
    updateControls();
    return true;
  } catch {
    return false;
  }
}

function selectRun(id, { watch = false } = {}) {
  state.runId = String(id);
  state.gen += 1;
  state.run = findRun(id);
  state.summary = null;
  state.lastStatus = null;
  state.watching = watch;
  state.offset = 0;
  state.rowSigs = new Map();
  state.prevTiles = null;
  resetLive();
  // After "Run a night" the billing phase was already shown, so the next phase is announced.
  state.announcedPhase = watch ? 'billing' : undefined;
  writeHashRun(state.runId);
  syncRunSelect();
  $('#run-select').value = state.runId;
  $('#done-banner').hidden = true;
  updateControls();
  renderSummaryLoading();
  renderProgressCard();
  loadRun();
  loadIncidents();
  loadPayments();
  loadChat();
}

function activeRun() {
  if (state.run && isActiveStatus(state.run.status)) return state.run;
  return state.runs.find((r) => isActiveStatus(r.status)) || null;
}

function updateControls() {
  const run = state.run;
  const status = run ? run.status : null;
  const active = activeRun();

  const btnRun = $('#btn-run');
  btnRun.disabled = state.creating || state.startingRecovery || !!active;
  let hint = '';
  if (state.creating) hint = BILLING_TEXT;
  else if (active) hint = active.status === 'generated' ? 'A night is running… (billed, recovery not started)' : 'A night is running…';
  $('#run-hint').textContent = hint;
  $('#btn-show-active').hidden = !active || String(active.id) === state.runId || state.creating;

  const btnStart = $('#btn-start');
  btnStart.hidden = status !== 'generated';
  btnStart.disabled = state.startingRecovery || state.creating;
  btnStart.textContent = state.startingRecovery ? 'Starting recovery…' : 'Start recovery';

  const chip = $('#run-status');
  if (status) {
    chip.hidden = false;
    chip.className = `badge badge-${STATUS_TONE[status] || 'neutral'}`;
    chip.textContent = humanize(status);
  } else {
    chip.hidden = true;
  }

  const chatDisabled = !state.runId || state.chatPending;
  $('#chat-input').disabled = !state.runId;
  const send = $('#chat-send');
  send.disabled = chatDisabled;
  send.textContent = state.chatPending ? 'Waiting…' : 'Send';
  send.setAttribute('aria-busy', String(state.chatPending));
  document.querySelectorAll('.suggestions .chip').forEach((b) => { b.disabled = chatDisabled; });
  $('#chat-running').hidden = !(run && isActiveStatus(status));
}

/* ---------- Run detail ---------- */

async function loadRun({ quiet = false } = {}) {
  const gen = state.gen;
  try {
    const data = await api(`/api/runs/${enc(state.runId)}`);
    if (gen !== state.gen) return;
    applyRun(data);
  } catch (e) {
    if (gen !== state.gen || quiet) return;
    $('#tiles').innerHTML = `<div class="tile tile-wide"><dt>Summary</dt><dd class="tile-sub">${esc(e.message)} <button type="button" class="link" data-retry="run">Retry</button></dd></div>`;
    $('#compare-body').innerHTML = '<tr><td colspan="4" class="muted">No data.</td></tr>';
    $('#paths').innerHTML = '<p class="muted">No data.</p>';
  }
}

function applyRun(data) {
  if (!data || !data.run) return;
  state.summary = data.summary || null;
  if (data.simulatedLabel) $('#sim-label').textContent = data.simulatedLabel;
  setRun(data.run);
  renderSummary();
  renderProgressCard();
}

function setRun(run) {
  state.run = run;
  upsertRun(run);
  noteStatus(run.status);
}

// Single place that reacts to the selected run's status changing.
function noteStatus(status) {
  const prev = state.lastStatus;
  state.lastStatus = status;
  if (isActiveStatus(status)) {
    state.watching = true;
    startLive(0);
  } else {
    stopLive();
  }
  if (prev && prev !== status && isActiveStatus(prev) && !isActiveStatus(status)) onRunFinished(status);
  updateControls();
}

async function onRunFinished(status) {
  const gen = state.gen;
  stopLive();
  state.lastFullAt = Date.now();
  await Promise.all([loadRun({ quiet: true }), loadIncidents({ quiet: true }), loadPayments({ quiet: true }), refreshRuns()]);
  if (gen !== state.gen) return;
  renderProgressCard();
  if (status === 'completed' && state.watching) showCompletion();
  else if (status === 'abandoned') announce('The night was abandoned.');
}

function showCompletion() {
  const s = state.summary || {};
  const v = s.violations;
  const violations = isNum(v) ? `${fmtInt(v)} guardrail violation${v === 1 ? '' : 's'}` : 'guardrail audit pending';
  const text = `Night complete: recovered ${fmtMoney(s.recoveredCents)} of ${fmtMoney(s.declinedCents)} (${fmtPct(s.recoveryRateByAmount)}) · ${fmtInt(s.retries)} retries · ${violations}`;
  $('#done-text').textContent = text;
  $('#done-banner').hidden = false;
  announce(text);
}

/* ---------- Live progress (polling) ---------- */

function resetLive() {
  stopLive();
  state.live = null;
  state.cursor = 0;
  state.lastLiveAt = 0;
  state.lastProgressAt = 0;
  state.progressKey = '';
  state.liveError = '';
  state.lastFullAt = Date.now();
  state.feed = [];
  state.announcedPhase = undefined;
  state.lastDecile = null;
  $('#pc-feed').innerHTML = '';
}

function startLive(delay = LIVE_MS) {
  if (document.hidden || state.liveTimer || state.liveBusy === state.gen) return;
  if (!state.run || !isActiveStatus(state.run.status)) return;
  const gen = state.gen;
  state.liveTimer = setTimeout(() => pollLive(gen), delay);
}

function stopLive() {
  clearTimeout(state.liveTimer);
  state.liveTimer = null;
}

async function pollLive(gen) {
  state.liveTimer = null;
  if (gen !== state.gen) return;
  state.liveBusy = gen;
  let failed = false;
  try {
    const data = await api(`/api/runs/${enc(state.runId)}/live?after=${enc(state.cursor)}`);
    if (gen !== state.gen) return;
    state.liveError = '';
    applyLive(data);
  } catch (e) {
    if (gen !== state.gen) return;
    failed = true;
    state.liveError = `Live updates interrupted: ${e.message} Retrying…`;
    renderProgressCard();
  } finally {
    if (state.liveBusy === gen) state.liveBusy = null;
  }
  if (gen !== state.gen || !state.run || !isActiveStatus(state.run.status)) return;
  if (Date.now() - state.lastFullAt >= FULL_MS) refreshAll();
  startLive(failed ? LIVE_MS * 3 : LIVE_MS);
}

async function refreshAll() {
  if (state.fullBusy === state.gen) return;
  const gen = state.gen;
  state.fullBusy = gen;
  state.lastFullAt = Date.now();
  try {
    await Promise.all([loadRun({ quiet: true }), loadIncidents({ quiet: true }), loadPayments({ quiet: true })]);
  } finally {
    if (state.fullBusy === gen) state.fullBusy = null;
  }
}

function applyLive(data) {
  const now = Date.now();
  state.live = data;
  if (isNum(data.serverNow)) state.clockOffset = data.serverNow - now;
  state.lastLiveAt = now;
  const key = `${data.cursor}:${data.settled}`;
  if (key !== state.progressKey) {
    state.progressKey = key;
    state.lastProgressAt = now;
  }
  if (isNum(data.cursor)) state.cursor = Math.max(state.cursor, data.cursor);
  addActivity(data.activity);

  if (isNum(data.declined) && isNum(data.settled)) {
    const decile = data.declined > 0 ? Math.floor((data.settled / data.declined) * 10) : 10;
    if (state.lastDecile !== null && decile > state.lastDecile && decile < 10) {
      announce(`${decile * 10}% of declined renewals settled`);
    }
    state.lastDecile = decile;
  }

  if (data.run) setRun(data.run);
  renderProgressCard();
}

function addActivity(items) {
  if (!Array.isArray(items) || !items.length) return;
  const known = new Set(state.feed.map((a) => a.id));
  const fresh = items.filter((a) => a && !known.has(a.id)).sort((a, b) => b.id - a.id);
  if (!fresh.length) return;
  const firstFill = state.feed.length === 0;
  state.feed = [...fresh, ...state.feed].slice(0, MAX_FEED);

  // Prepend instead of re-rendering, so focus on an older item is kept.
  const list = $('#pc-feed');
  list.querySelector('.feed-empty')?.remove();
  list.insertAdjacentHTML('afterbegin', fresh.map(feedItem).join(''));
  while (list.children.length > MAX_FEED) list.lastElementChild.remove();
  if (!firstFill) {
    for (let i = 0; i < fresh.length && i < list.children.length; i += 1) flash(list.children[i]);
  }
}

function feedItem(a) {
  const kind = ACTIVITY_KINDS[a.kind] ? a.kind : 'stopped';
  const pid = String(a.paymentId ?? '');
  return `<li>
    <span class="marker marker-${kind}" aria-hidden="true"></span>
    <span><button type="button" class="link mono" data-open="${esc(pid)}" aria-label="Open timeline for payment ${esc(pid)}">${esc(pid)}</button>
    · <span class="feed-when">${esc(a.atLabel || '')}</span> — ${glossify(esc(a.text))}<span class="sr-only"> (${esc(ACTIVITY_KINDS[kind])})</span></span>
  </li>`;
}

function currentPhase() {
  if (state.creating) return 'billing';
  const run = state.run;
  if (!run || !run.status) return null;
  if (run.status === 'generated') return 'billing';
  if (run.status === 'recovering') {
    const inProgress = state.live ? state.live.inProgress : state.summary?.inProgress;
    return inProgress === 0 ? 'auditing' : 'recovering';
  }
  if (run.status === 'completed') return 'completed';
  if (run.status === 'abandoned') return 'abandoned';
  return null;
}

function progressNumbers() {
  const live = state.live;
  const s = state.summary;
  const declined = live ? live.declined : s ? s.declined : state.run?.declines;
  const inProgress = live ? live.inProgress : s?.inProgress;
  let settled = live ? live.settled : null;
  if (!isNum(settled) && isNum(declined) && isNum(inProgress)) settled = declined - inProgress;
  if (!isNum(settled) && state.run?.status === 'completed') settled = declined;
  const recoveredCents = live ? live.recoveredCents : s?.recoveredCents;
  return { declined, settled, recoveredCents };
}

function renderSteps(phase) {
  const idx = PHASES.indexOf(phase);
  document.querySelectorAll('#pc-steps li').forEach((li, i) => {
    const done = idx > i || (phase === 'completed' && i === idx);
    const current = i === idx;
    li.classList.toggle('is-done', done);
    li.classList.toggle('is-current', current);
    li.classList.toggle('is-final', current && phase === 'completed');
    if (current) li.setAttribute('aria-current', 'step');
    else li.removeAttribute('aria-current');
    li.querySelector('.step-state').textContent = done ? ' (done)' : current ? ' (current)' : '';
  });
}

function renderProgressCard() {
  const card = $('#progress-card');
  const run = state.run;
  const phase = currentPhase();
  if (!phase) {
    card.hidden = true;
    return;
  }
  card.hidden = false;
  const creating = state.creating;
  const status = creating ? 'creating' : run.status;
  const active = creating || isActiveStatus(status);
  card.classList.toggle('is-compact', !active);

  const titles = {
    creating: 'Starting a night',
    generated: 'Night billed — recovery not started',
    recovering: 'Night in progress',
    completed: 'Night completed',
    abandoned: 'Night abandoned',
  };
  $('#pc-h').textContent = titles[status] || 'Night';
  const phaseBadge = $('#pc-phase');
  phaseBadge.textContent = PHASE_LABELS[phase] || humanize(phase);
  phaseBadge.className = `badge badge-${phase === 'completed' ? 'good' : phase === 'abandoned' ? 'neutral' : 'warn'}`;
  renderSteps(phase);

  if (state.announcedPhase !== phase) {
    if (state.announcedPhase !== undefined && state.watching && phase !== 'completed') {
      announce(`Phase: ${PHASE_LABELS[phase] || phase}`);
    }
    state.announcedPhase = phase;
  }

  $('#pc-billing').hidden = !creating;
  $('#pc-billing-text').textContent = BILLING_TEXT;

  const { declined, settled, recoveredCents } = progressNumbers();
  const ratio = isNum(declined) && isNum(settled) ? (declined > 0 ? settled / declined : 1) : null;
  const pct = isNum(ratio) ? Math.round(ratio * 100) : 0;

  const summary = $('#pc-summary');
  if (creating) {
    summary.hidden = true;
  } else if (status === 'generated') {
    summary.hidden = false;
    summary.textContent = `Billed ${fmtInt(run.renewals)} renewals; ${fmtInt(run.declines)} were declined. Recovery has not started yet: press Start recovery.`;
  } else if (!active) {
    const took = isNum(run.startedAt) && isNum(run.completedAt) ? ` · took ${fmtDuration(run.completedAt - run.startedAt)}` : '';
    summary.hidden = false;
    summary.textContent = `${fmtInt(settled)} of ${fmtInt(declined)} declined renewals settled · ${fmtMoney(recoveredCents)} recovered${took}`;
  } else {
    summary.hidden = true;
  }

  const showBar = !creating && status !== 'generated' && isNum(ratio);
  $('#pc-bar-box').hidden = !showBar;
  if (showBar) {
    const bar = $('#pc-bar');
    bar.setAttribute('aria-valuenow', String(pct));
    bar.setAttribute('aria-valuetext', `${fmtInt(settled)} of ${fmtInt(declined)} declined renewals settled (${pct}%)`);
    $('#pc-bar-fill').style.width = `${(ratio * 100).toFixed(2)}%`;
    $('#pc-bar-text').textContent = `${fmtInt(settled)} of ${fmtInt(declined)} declined renewals settled`;
    setText($('#pc-pct'), `${pct}%`);
  }

  const showStats = status === 'recovering';
  $('#pc-stats').hidden = !showStats;
  if (showStats) setText($('#pc-recovered'), fmtMoney(recoveredCents), true);

  const err = $('#pc-error');
  err.textContent = active ? state.liveError : '';
  err.hidden = !err.textContent;

  const feedBox = $('#pc-feed-box');
  feedBox.hidden = !(status === 'recovering' || state.feed.length);
  if (!feedBox.hidden && !state.feed.length && !$('#pc-feed').children.length) {
    $('#pc-feed').innerHTML = '<li class="feed-empty">Waiting for the first retries and messages…</li>';
  }

  renderClock();
}

// Time-dependent parts of the progress card; runs every second between polls.
function renderClock() {
  const card = $('#progress-card');
  if (card.hidden) return;
  const run = state.run;
  const now = Date.now();
  const upd = $('#pc-updated');
  const stall = $('#pc-stall');

  if (state.creating || !run) {
    upd.textContent = '';
    stall.hidden = true;
    return;
  }
  if (isActiveStatus(run.status)) {
    const ago = now - state.lastLiveAt;
    upd.textContent = !state.lastLiveAt ? 'Connecting…' : ago < 2000 ? 'Updated just now' : `Updated ${Math.round(ago / 1000)} s ago`;
  } else {
    upd.textContent = run.completedAt ? `Finished ${fmtTime(run.completedAt)}` : '';
  }

  if (run.status !== 'recovering' || !isNum(run.startedAt)) {
    stall.hidden = true;
    return;
  }
  // The simulated clock is the furthest point the ledger has reached, not wall time:
  // Workflow steps add real latency, so a night runs a little behind its nominal speed.
  const serverNow = now + state.clockOffset;
  const elapsed = Math.max(0, serverNow - run.startedAt);
  const simNow = state.live && isNum(state.live.simNow) ? state.live.simNow : 0;
  const day = Math.min(MAX_DAYS, Math.max(1, 1 + Math.floor(simNow / 1440)));
  setText($('#pc-clock'), day <= RETRY_DAYS ? `Day ${day} of ${RETRY_DAYS}` : `Day ${day} · waiting for customer replies`);
  setText($('#pc-elapsed'), fmtDuration(elapsed));
  const rate = elapsed > 5000 && simNow > 0 ? simNow / elapsed : 0; // simulated minutes per real ms
  const left = rate > 0 ? Math.max(0, (MAX_DAYS * 1440 - simNow) / rate) : null;
  setText($('#pc-left'), left === null ? 'estimating…' : left > 0 ? `about ${fmtDuration(left)} left at most` : 'finishing up');

  stall.hidden = !(state.lastProgressAt && now - state.lastProgressAt >= STALL_MS);
}

/* ---------- Summary ---------- */

function renderSummaryLoading() {
  $('#tiles').innerHTML = '<div class="tile tile-wide"><dt>Summary</dt><dd class="tile-sub">Loading…</dd></div>';
  $('#run-meta').textContent = '';
  $('#compare-body').innerHTML = '<tr><td colspan="4" class="muted">Loading…</td></tr>';
  $('#paths').innerHTML = '<p class="muted">Loading…</p>';
}

function tile({ key, label, value, sub, tone, help }) {
  return `<div class="tile${tone ? ` tile-${tone}` : ''}" data-key="${esc(key)}">
    <dt><span class="tile-label">${esc(label)}${help ? helpBtn(help) : ''}</span></dt>
    <dd class="tile-value">${esc(value)}</dd>
    ${sub ? `<dd class="tile-sub">${esc(sub)}</dd>` : ''}
  </div>`;
}

function renderSummary() {
  const run = state.run;
  const s = state.summary;
  if (!run) return;

  const meta = [
    run.nightDate ? `Night of ${run.nightDate}` : null,
    run.seed != null ? `seed ${run.seed}` : null,
    `created ${fmtTime(run.createdAt)}`,
    run.completedAt ? `completed ${fmtTime(run.completedAt)}` : null,
  ].filter(Boolean);
  $('#run-meta').textContent = meta.join(' · ');

  if (!s) {
    $('#tiles').innerHTML = '<div class="tile tile-wide"><dt>Summary</dt><dd class="tile-sub">No summary for this run yet.</dd></div>';
    $('#compare-body').innerHTML = '<tr><td colspan="4" class="muted">No data yet.</td></tr>';
    $('#paths').innerHTML = '<p class="muted">No data yet.</p>';
    return;
  }

  const prevention = s.prevention || {};
  const prevented = (prevention.tokenLifecycle || 0) + (prevention.accountUpdater || 0);
  const creds = s.credentialTypes || {};

  let violations;
  if (s.violations === null || s.violations === undefined) {
    violations = { value: '–', sub: 'Checked once recovery finishes' };
  } else if (s.violations === 0) {
    violations = { value: '0', sub: 'No scheme rule broken', tone: 'good' };
  } else {
    violations = { value: fmtInt(s.violations), sub: 'Rules broken: review timelines', tone: 'bad' };
  }

  const tiles = [
    { key: 'renewals', label: 'Renewals', help: 'token', value: fmtInt(s.renewals),
      sub: `${fmtInt(s.approvedFirstTime)} approved first time · ${fmtInt(creds.networkToken)} token, ${fmtInt(creds.panFallback)} card-number` },
    { key: 'declined', label: 'Declined', value: fmtInt(s.declined), sub: `${fmtMoney(s.declinedCents)} declined` },
    { key: 'recovered', label: 'Recovered', value: fmtMoney(s.recoveredCents),
      sub: `${fmtPct(s.recoveryRateByAmount)} of declined $ · ${fmtInt(s.recovered)} renewals`, tone: s.recoveredCents > 0 ? 'good' : null },
    { key: 'retries', label: 'Retries', help: 'cascade', value: fmtInt(s.retries), sub: `${fmtInt(s.altPspRetries)} via another PSP` },
    { key: 'asked', label: 'Customers asked', help: 'dunning', value: fmtInt(s.customersAsked), sub: 'Asked to update their card' },
    { key: 'prevented', label: 'Prevented before billing', value: fmtInt(prevented),
      sub: `${fmtInt(prevention.tokenLifecycle || 0)} token lifecycle · ${fmtInt(prevention.accountUpdater || 0)} account updater` },
    { key: 'violations', label: 'Guardrail violations', ...violations },
  ];

  $('#tiles').innerHTML = tiles.map(tile).join('');

  // Highlight tiles whose value changed since the last refresh of this run.
  const next = {};
  for (const t of tiles) next[t.key] = `${t.value}|${t.sub}`;
  if (state.prevTiles) {
    for (const t of tiles) {
      if (state.prevTiles[t.key] !== undefined && state.prevTiles[t.key] !== next[t.key]) {
        const el = $(`#tiles [data-key="${t.key}"]`);
        if (el) flash(el);
      }
    }
  }
  state.prevTiles = next;

  renderCompare();
  renderPaths();
}

function violationCell(n) {
  if (n === null || n === undefined) return '<td class="num muted">–</td>';
  const tone = n === 0 ? 'good' : 'bad';
  return `<td class="num"><span class="badge badge-${tone}">${esc(fmtInt(n))}</span></td>`;
}

function renderCompare() {
  const s = state.summary;
  const naive = s.naive || {};
  const legacy = s.legacy || {};
  const moneyCell = (cents, count) =>
    `<td class="num">${esc(fmtMoney(cents))}<span class="sub">${esc(fmtInt(count))} renewals</span></td>`;
  $('#compare-body').innerHTML = `
    <tr>
      <th scope="row">Declined renewals</th>
      <td class="num">${esc(fmtInt(s.declined))}</td>
      <td class="num">${esc(fmtInt(naive.declines))}</td>
      <td class="num">${esc(fmtInt(legacy.declines))}</td>
    </tr>
    <tr>
      <th scope="row">Recovered</th>
      ${moneyCell(s.recoveredCents, s.recovered)}
      ${moneyCell(naive.recoveredCents, naive.recovered)}
      ${moneyCell(legacy.recoveredCents, legacy.recovered)}
    </tr>
    <tr>
      <th scope="row">Retries</th>
      <td class="num">${esc(fmtInt(s.retries))}</td>
      <td class="num">${esc(fmtInt(naive.retries))}</td>
      <td class="num">${esc(fmtInt(legacy.retries))}</td>
    </tr>
    <tr>
      <th scope="row">Never-retry violations ${helpBtn('visa')}</th>
      ${violationCell(s.violations)}
      ${violationCell(naive.neverRetryViolations)}
      ${violationCell(legacy.neverRetryViolations)}
    </tr>`;
}

function renderPaths() {
  const by = state.summary.byPath || {};
  const keys = [...Object.keys(PATH_LABELS), ...Object.keys(by).filter((k) => !PATH_LABELS[k])]
    .filter((k) => by[k] && by[k].count > 0);
  const total = keys.reduce((n, k) => n + by[k].count, 0);
  if (!total) {
    $('#paths').innerHTML = '<p class="muted">No declined renewals have a path yet.</p>';
    return;
  }
  $('#paths').innerHTML = `<ul class="paths">${keys.map((k) => {
    const { count, cents } = by[k];
    const share = count / total;
    const tone = PATH_TONE[k] || 'neutral';
    return `<li class="path-row">
      <span class="path-label">${esc(pathLabel(k))}</span>
      <span class="path-track" aria-hidden="true"><span class="path-fill fill-${tone}" style="width:${(share * 100).toFixed(2)}%"></span></span>
      <span class="path-num">${esc(fmtInt(count))} <span class="sub-inline">· ${esc(fmtMoney(cents))} · ${esc(fmtPct(share))}</span></span>
    </li>`;
  }).join('')}</ul>`;
}

/* ---------- Incidents ---------- */

async function loadIncidents({ quiet = false } = {}) {
  if (!state.runId) return;
  const gen = state.gen;
  const box = $('#incidents');
  if (!quiet || box.dataset.run !== state.runId) {
    box.innerHTML = '<p class="muted">Loading…</p>';
    incidentsHtml = '';
  }
  box.dataset.run = state.runId;
  try {
    const data = await api(`/api/runs/${enc(state.runId)}/incidents`);
    if (gen !== state.gen) return;
    renderIncidents(data.incidents || []);
  } catch (e) {
    if (gen !== state.gen || (quiet && box.querySelector('.incidents, .empty'))) return;
    box.innerHTML = `<p class="inline-error">${esc(e.message)}</p><button type="button" class="btn btn-small" data-retry="incidents">Retry</button>`;
    incidentsHtml = '';
  }
}

let incidentsHtml = ''; // last rendered list, so an unchanged refresh leaves the DOM alone

function renderIncidents(list) {
  const box = $('#incidents');
  let html;
  if (!list.length) {
    html = '<p class="empty">No incidents detected for this run. Incidents are flagged when declines cluster on one PSP or one issuer.</p>';
  } else {
    html = `<ul class="incidents">${list.map((i) => `
    <li class="incident">
      <div class="incident-head">
        <span class="badge badge-warn">${esc(INCIDENT_LABELS[i.kind] || humanize(i.kind))}</span>
        <strong>${esc(i.subject)}</strong>
        <span class="muted small">${esc(i.fromLabel)}–${esc(i.toLabel)}</span>
      </div>
      <p class="incident-stats small">Affected <strong>${esc(fmtInt(i.affected))}</strong> · Recovered <strong>${esc(fmtInt(i.recovered))}</strong></p>
      ${i.text ? `<p class="incident-text">${glossify(esc(i.text))}</p>` : ''}
    </li>`).join('')}</ul>`;
  }
  if (incidentsHtml === html) return; // unchanged: keep the DOM (and focus) as it is
  incidentsHtml = html;
  box.innerHTML = html;
}

/* ---------- Payments table ---------- */

function filterParams() {
  const params = new URLSearchParams();
  for (const [key, value] of new FormData($('#filters'))) {
    const v = String(value).trim();
    if (v) params.set(key, v);
  }
  params.set('limit', String(LIMIT));
  params.set('offset', String(state.offset));
  return params;
}

async function loadPayments({ quiet = false } = {}) {
  if (!state.runId) return;
  const seq = ++state.paymentsSeq;
  const gen = state.gen;
  const body = $('#payments-body');
  if (!quiet) body.setAttribute('aria-busy', 'true');
  if (!quiet && !body.querySelector('tr[data-id]')) {
    body.innerHTML = '<tr><td colspan="11" class="muted">Loading…</td></tr>';
  }
  try {
    const data = await api(`/api/runs/${enc(state.runId)}/payments?${filterParams()}`);
    if (seq !== state.paymentsSeq || gen !== state.gen) return;
    state.total = data.total || 0;
    const rows = data.rows || [];
    // The current page can empty out while statuses change; step back to the last page.
    if (!rows.length && state.offset > 0 && state.total > 0) {
      state.offset = Math.floor((state.total - 1) / LIMIT) * LIMIT;
      loadPayments({ quiet });
      return;
    }
    renderPayments(rows, quiet);
  } catch (e) {
    if (seq !== state.paymentsSeq || gen !== state.gen) return;
    if (quiet && body.querySelector('tr[data-id]')) {
      $('#pager-text').textContent = `${pagerText(body.querySelectorAll('tr[data-id]').length)} · could not refresh, retrying`;
      return;
    }
    body.innerHTML = `<tr><td colspan="11"><p class="inline-error">${esc(e.message)}</p><button type="button" class="btn btn-small" data-retry="payments">Retry</button></td></tr>`;
    state.total = 0;
    state.rowSigs = new Map();
    renderPager(0);
  } finally {
    if (seq === state.paymentsSeq) body.removeAttribute('aria-busy');
  }
}

function rowCells(p) {
  const mac = p.firstMac ? `<span class="sub"><abbr title="${ABBR.MAC}">MAC</abbr> ${esc(p.firstMac)}</span>` : '';
  const alt = p.altRetries ? `<span class="sub">${esc(fmtInt(p.altRetries))} via another PSP</span>` : '';
  return `<th scope="row"><span class="pay-id mono">${esc(p.id)}</span></th>
    <td>${esc(brandLabel(p.brand))}</td>
    <td>${esc(p.region)}</td>
    <td class="mono nowrap">${esc(p.bin)} •••• ${esc(p.last4)}</td>
    <td>${esc(credentialLabel(p.credentialType))}</td>
    <td class="num">${esc(fmtMoney(p.amountCents))}</td>
    <td class="mono">${esc(p.firstCode)}${mac}</td>
    <td class="mono">${esc(p.firstPsp)}</td>
    <td>${esc(pathLabel(p.path))}</td>
    <td>${badge(p.status)}</td>
    <td class="num">${esc(fmtInt(p.retries))}${alt}</td>`;
}

function paymentRow(p) {
  return `<tr data-id="${esc(p.id)}" tabindex="0" aria-describedby="row-hint">${rowCells(p)}</tr>`;
}

function renderPayments(rows, quiet) {
  const body = $('#payments-body');
  const prev = state.rowSigs;
  const next = new Map(rows.map((p) => [String(p.id), JSON.stringify(p)]));
  state.rowSigs = next;

  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="11" class="empty">No declined renewals match these filters.</td></tr>';
    renderPager(0);
    return;
  }

  const existing = [...body.querySelectorAll('tr[data-id]')];
  const sameRows = existing.length === rows.length && existing.every((tr, i) => tr.dataset.id === String(rows[i].id));

  if (sameRows) {
    // Same rows in the same order: update only the changed ones, keeping focus and scroll.
    rows.forEach((p, i) => {
      const id = String(p.id);
      if (prev.get(id) !== next.get(id)) {
        existing[i].innerHTML = rowCells(p);
        if (quiet && prev.has(id)) flash(existing[i]);
      }
    });
  } else {
    const focusedId = document.activeElement?.closest?.('#payments-body tr[data-id]')?.dataset.id;
    body.innerHTML = rows.map(paymentRow).join('');
    if (quiet) {
      for (const tr of body.querySelectorAll('tr[data-id]')) {
        const id = tr.dataset.id;
        if (prev.has(id) && prev.get(id) !== next.get(id)) flash(tr);
      }
    }
    if (focusedId) {
      const tr = [...body.querySelectorAll('tr[data-id]')].find((r) => r.dataset.id === focusedId);
      (tr || $('#payments-wrap')).focus({ preventScroll: true });
    }
  }
  renderPager(rows.length);
}

function pagerText(count) {
  if (!state.total) return '';
  const from = count ? state.offset + 1 : 0;
  const to = state.offset + count;
  return `Showing ${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(state.total)}`;
}

function renderPager(count) {
  setText($('#pager-text'), pagerText(count));
  $('#page-prev').disabled = state.offset <= 0;
  $('#page-next').disabled = state.offset + count >= state.total;
}

function resetAndLoadPayments() {
  state.offset = 0;
  loadPayments();
}

/* ---------- Dialogs ---------- */

function openDialog(dlg, opener) {
  if (dlg.open) return;
  dlg._opener = opener || document.activeElement;
  dlg.showModal();
}

function closeDialog(dlg) {
  if (dlg.open) dlg.close();
}

function bindDialog(dlg, onClose) {
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeDialog(dlg); // backdrop click: the sheet fills the dialog box
    else if (e.target.closest('[data-close]')) closeDialog(dlg);
  });
  dlg.addEventListener('close', () => {
    const opener = dlg._opener;
    dlg._opener = null;
    const fallback = onClose ? onClose() : null;
    const target = opener && opener.isConnected ? opener : fallback;
    if (target && typeof target.focus === 'function') target.focus();
  });
}

/* ---------- Timeline drawer ---------- */

async function openTimeline(id, opener) {
  const dlg = $('#timeline');
  const seq = ++state.timelineSeq;
  clearTimeout(state.tlTimer);
  state.tlId = String(id);
  state.tlSig = '';
  $('#tl-title').textContent = `Payment ${id}`;
  $('#tl-body').innerHTML = '<p class="muted">Loading timeline…</p>';
  openDialog(dlg, opener);
  await fetchTimeline(seq, true);
}

async function fetchTimeline(seq, first) {
  const body = $('#tl-body');
  try {
    const data = await api(`/api/payments/${enc(state.tlId)}`);
    if (seq !== state.timelineSeq || !$('#timeline').open) return;
    const sig = JSON.stringify(data);
    if (sig !== state.tlSig) {
      state.tlSig = sig;
      renderTimeline(data.payment, data.timeline || [], !first);
    }
    scheduleTimelineRefresh(seq, data.payment?.status);
  } catch (e) {
    if (seq !== state.timelineSeq) return;
    if (first) {
      body.innerHTML = `<p class="inline-error">${esc(e.message)}</p><p><button type="button" class="btn btn-small" data-retry="timeline">Retry</button></p>`;
    } else {
      scheduleTimelineRefresh(seq, 'recovering'); // transient: try again
    }
  }
}

function scheduleTimelineRefresh(seq, status) {
  clearTimeout(state.tlTimer);
  if (status !== 'recovering') return;
  state.tlTimer = setTimeout(() => {
    if (seq !== state.timelineSeq || !$('#timeline').open) return;
    if (document.hidden) scheduleTimelineRefresh(seq, status); // paused while the tab is hidden
    else fetchTimeline(seq, false);
  }, TIMELINE_MS);
}

function metaItem(label, valueHtml, help) {
  return `<div><dt>${esc(label)}${help ? helpBtn(help) : ''}</dt><dd>${valueHtml}</dd></div>`;
}

function paymentFacts(p) {
  const items = [
    metaItem('Status', badge(p.status)),
    metaItem('Path', esc(pathLabel(p.path))),
    metaItem('Amount', esc(fmtMoney(p.amountCents))),
    metaItem('Card', `<span class="mono">${esc(brandLabel(p.brand))} ${esc(p.bin)} •••• ${esc(p.last4)}</span>`),
    metaItem('Expiry', esc(p.expiry || '–')),
    metaItem('Credential', esc(credentialLabel(p.credentialType)), p.credentialType === 'pan_fallback' ? 'fallback' : 'token'),
    metaItem('Region', esc(p.region)),
    metaItem('Customer', `<span class="mono">${esc(p.customerId)}</span>`),
    metaItem('PSP', `<span class="mono">${esc(p.firstPsp)}${p.lastPsp && p.lastPsp !== p.firstPsp ? ` → ${esc(p.lastPsp)}` : ''}</span>`, p.lastPsp && p.lastPsp !== p.firstPsp ? 'cascade' : null),
    metaItem('First code', `<span class="mono">${esc(p.firstCode)}${p.firstMac ? ` · <abbr title="${ABBR.MAC}">MAC</abbr> ${esc(p.firstMac)}` : ''}</span>`, p.brand === 'mastercard' ? 'mac' : 'visa'),
    metaItem('Retries', `${esc(fmtInt(p.retries))}${p.altRetries ? ` (${esc(fmtInt(p.altRetries))} via another PSP)` : ''}`, p.altRetries ? 'cascade' : null),
    metaItem('Customer asked', esc(yesNo(p.customerAsked)), 'dunning'),
  ];
  if (p.outcome) items.push(metaItem('Outcome', esc(humanize(p.outcome))));
  if (p.preventedBy) items.push(metaItem('Prevented by', esc(humanize(p.preventedBy))));
  if (p.finalReason) items.push(metaItem('Final reason', glossify(esc(p.finalReason))));
  return `<dl class="facts">${items.join('')}</dl>`;
}

function confidenceBadge(c) {
  if (c === null || c === undefined || c === '') return '';
  let text;
  let level;
  if (typeof c === 'number') {
    text = c <= 1 ? `${Math.round(c * 100)}%` : String(c);
    const r = c <= 1 ? c : c / 100;
    level = r >= 0.8 ? 'high' : r >= 0.5 ? 'medium' : 'low';
  } else {
    text = String(c);
    level = String(c).toLowerCase();
  }
  const cls = ['high', 'medium', 'low'].includes(level) ? level : 'other';
  return `<span class="conf conf-${cls}">Confidence: ${esc(text)}</span>`;
}

function ruleItem(rule) {
  const url = rule.sourceUrl ? safeUrl(rule.sourceUrl) : null;
  const source = rule.source
    ? (url
      ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(rule.source)}</a>`
      : esc(rule.source))
    : (url ? `<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">Source</a>` : 'No source given');
  return `<li class="rule">
    <p class="rule-label">${glossify(esc(rule.label))}</p>
    <p class="rule-meta small">
      ${rule.id ? `<span class="mono muted">${esc(rule.id)}</span>` : ''}
      <span>Source: ${source}</span>
      ${confidenceBadge(rule.confidence)}
    </p>
  </li>`;
}

function attemptMeta(e) {
  const items = [];
  if (e.status) items.push(metaItem('Result', badge(e.status)));
  if (e.psp) items.push(metaItem('PSP', `<span class="mono">${esc(e.psp)}</span>`));
  if (e.credentialType) items.push(metaItem('Credential', esc(credentialLabel(e.credentialType)), e.credentialType === 'pan_fallback' ? 'fallback' : 'token'));
  if (typeof e.mit === 'boolean') items.push(metaItem('MIT', esc(yesNo(e.mit))));
  if (typeof e.customerInitiated === 'boolean') items.push(metaItem('Customer-initiated', esc(yesNo(e.customerInitiated))));
  if (e.code) items.push(metaItem('Code', `<span class="mono">${esc(e.code)}</span>`));
  if (e.mac) items.push(metaItem('MAC', `<span class="mono">${esc(e.mac)}</span>`, 'mac'));
  return items.length ? `<dl class="tl-meta">${items.join('')}</dl>` : '';
}

function decisionMeta(e) {
  const action = e.action ? `<p class="small">Action: <code>${esc(e.action)}</code></p>` : '';
  const rules = Array.isArray(e.rules) && e.rules.length
    ? `<p class="rules-h small">Rules applied</p><ul class="rules">${e.rules.map(ruleItem).join('')}</ul>`
    : '';
  return action + rules;
}

function timelineEntry(e) {
  const kind = KIND_LABELS[e.kind] ? e.kind : 'event';
  let extra = '';
  if (kind === 'attempt') extra = attemptMeta(e);
  else if (kind === 'decision') extra = decisionMeta(e);
  else if (e.status || e.code) extra = attemptMeta(e);
  return `<li class="tl-entry tl-${kind}">
    <p class="tl-when small mono">${esc(e.atLabel || fmtTime(e.at))}</p>
    <div class="tl-card">
      <p class="tl-head"><span class="kind kind-${kind}">${esc(KIND_LABELS[kind])}</span> <strong>${glossify(esc(e.title))}</strong></p>
      ${e.detail ? `<p class="tl-detail">${glossify(esc(e.detail))}</p>` : ''}
      ${extra}
    </div>
  </li>`;
}

function renderTimeline(payment, timeline, keepScroll) {
  const body = $('#tl-body');
  const scrollTop = body.scrollTop;
  const hadFocus = body.contains(document.activeElement) && document.activeElement !== body;
  const facts = payment ? paymentFacts(payment) : '';
  const live = payment && payment.status === 'recovering'
    ? '<p class="warn-note small">Still recovering: this timeline updates every 2 seconds.</p>'
    : '';
  const list = timeline.length
    ? `<ol class="timeline">${timeline.map(timelineEntry).join('')}</ol>`
    : '<p class="empty">No timeline entries yet.</p>';
  const terms = `<p class="muted small">Terms: MAC ${helpBtn('mac')} · NTID ${helpBtn('ntid')} · network token ${helpBtn('token')} · another PSP ${helpBtn('cascade')} · Visa categories ${helpBtn('visa')}</p>`;
  body.innerHTML = `${live}${facts}<h3 class="tl-section-h">Timeline</h3>${terms}${list}`;
  if (keepScroll) {
    body.scrollTop = scrollTop;
    if (hadFocus) body.focus({ preventScroll: true });
  } else {
    body.scrollTop = 0;
  }
}

/* ---------- How to use and glossary ---------- */

function renderGlossary() {
  $('#glossary').innerHTML = Object.entries(GLOSSARY)
    .map(([key, g]) => `<div id="gl-${key}"><dt tabindex="-1">${esc(g.term)}</dt><dd>${esc(g.text)}</dd></div>`)
    .join('');
}

function openHowto(opener) {
  openDialog($('#howto'), opener || $('#btn-howto'));
}

function openGlossary(key, opener) {
  openHowto(opener);
  const item = document.getElementById(`gl-${key}`);
  if (!item) return;
  document.querySelectorAll('#glossary > div').forEach((d) => d.classList.toggle('is-target', d === item));
  item.scrollIntoView({ block: 'center' });
  item.querySelector('dt').focus({ preventScroll: true });
  flash(item);
}

function maybeShowHowtoOnFirstVisit() {
  if (readStorage(HOWTO_KEY)) return;
  writeStorage(HOWTO_KEY, '1');
  openHowto($('#btn-howto'));
}

/* ---------- System Overview (README, marked and Mermaid loaded on first open) ---------- */

const overview = { status: 'idle', libs: null, diagrams: [], theme: null, seq: 0 };

function loadOverviewLibs() {
  if (!overview.libs) {
    overview.libs = Promise.all([import(MARKED_URL), import(MERMAID_URL)])
      .then(([markedMod, mermaidMod]) => ({ Marked: markedMod.Marked, mermaid: mermaidMod.default }))
      .catch(() => {
        overview.libs = null;
        throw new Error('Could not load the Markdown and diagram libraries from cdn.jsdelivr.net. Check your connection or content blocker, then retry.');
      });
  }
  return overview.libs;
}

async function fetchOverview() {
  let res;
  try {
    res = await fetch('/api/overview', { headers: { Accept: 'text/markdown' } });
  } catch {
    throw new Error('Could not reach the API to load the overview.');
  }
  if (!res.ok) throw new Error(`Could not load the overview (HTTP ${res.status}).`);
  return res.text();
}

function openOverview(opener) {
  openDialog($('#overview'), opener || $('#btn-overview'));
  if (overview.status === 'idle' || overview.status === 'error') loadOverview();
  else if (overview.status === 'ready' && overview.theme !== effectiveTheme()) renderDiagrams();
}

async function loadOverview() {
  if (overview.status === 'loading') return;
  overview.status = 'loading';
  const body = $('#ov-body');
  body.setAttribute('aria-busy', 'true');
  body.innerHTML = '<div class="state-box"><div class="state-row"><span class="spinner" aria-hidden="true"></span><span>Loading the overview…</span></div></div>';
  try {
    const [libs, markdown] = await Promise.all([loadOverviewLibs(), fetchOverview()]);
    renderOverview(libs, markdown);
    overview.status = 'ready';
    announce('System overview loaded');
    await renderDiagrams();
  } catch (e) {
    overview.status = 'error';
    body.innerHTML = `<div class="state-box"><p class="inline-error">${esc(e.message)}</p><button type="button" class="btn" data-retry="overview">Retry</button></div>`;
  } finally {
    body.removeAttribute('aria-busy');
  }
}

function repoLink(href) {
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.startsWith('//') || href.startsWith('#')) return href;
  const [path, frag] = href.replace(/^\.?\//, '').split('#');
  const last = path.split('/').pop() || '';
  const kind = last.includes('.') ? 'blob' : 'tree'; // directories such as docs/adr open as a tree
  return `${REPO}/${kind}/main/${path}${frag ? `#${frag}` : ''}`;
}

function renderOverview(libs, markdown) {
  const diagrams = [];
  const md = new libs.Marked({ gfm: true });
  md.use({
    renderer: {
      // marked 12 passes (code, infostring); newer versions pass a token. Support both.
      code(code, infostring) {
        const text = code && typeof code === 'object' ? code.text : code;
        const lang = code && typeof code === 'object' ? code.lang : infostring;
        if (String(lang || '').trim().split(/\s+/)[0].toLowerCase() !== 'mermaid') return false;
        const i = diagrams.push(String(text)) - 1;
        return `<div class="mermaid-wrap" data-diagram="${i}" tabindex="0" role="group" aria-label="Diagram ${i + 1}"><p class="muted small">Drawing diagram…</p></div>\n`;
      },
    },
  });

  const root = document.createElement('div');
  root.className = 'md';
  root.innerHTML = md.parse(String(markdown));

  for (const a of root.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href');
    if (href.startsWith('#')) continue;
    a.href = repoLink(href);
    a.target = '_blank';
    a.rel = 'noopener noreferrer';
  }
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src');
    if (!/^[a-z][a-z0-9+.-]*:|^\/\//i.test(src)) img.src = `${RAW}/${src.replace(/^\.?\//, '')}`;
    img.loading = 'lazy';
  }
  for (const table of root.querySelectorAll('table')) {
    const wrap = document.createElement('div');
    wrap.className = 'table-wrap';
    wrap.tabIndex = 0;
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Table (scrolls sideways)');
    table.replaceWith(wrap);
    wrap.append(table);
  }

  overview.diagrams = diagrams;
  $('#ov-body').replaceChildren(root);
}

async function renderDiagrams() {
  const theme = effectiveTheme();
  overview.theme = theme;
  if (overview.status !== 'ready' || !overview.diagrams.length) return;
  const { mermaid } = await loadOverviewLibs();
  const seq = ++overview.seq;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: theme === 'dark' ? 'dark' : 'default',
    // Fit diagrams to the panel; the CSS keeps a minimum width so phones scroll instead of shrinking text.
    flowchart: { useMaxWidth: true },
    sequence: { useMaxWidth: true },
  });
  for (const wrap of $('#ov-body').querySelectorAll('.mermaid-wrap[data-diagram]')) {
    const i = Number(wrap.dataset.diagram);
    const id = `ov-mmd-${seq}-${i}`;
    try {
      const { svg } = await mermaid.render(id, overview.diagrams[i]);
      if (seq !== overview.seq) return;
      wrap.innerHTML = svg;
    } catch {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
      if (seq !== overview.seq) return;
      wrap.innerHTML = `<p class="inline-error small">Could not draw this diagram. Its source:</p><pre><code>${esc(overview.diagrams[i])}</code></pre>`;
    }
  }
}

/* ---------- Theme ---------- */

const darkQuery = window.matchMedia('(prefers-color-scheme: dark)');

function effectiveTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  if (t === 'light' || t === 'dark') return t;
  return darkQuery.matches ? 'dark' : 'light';
}

function updateThemeButton() {
  const dark = effectiveTheme() === 'dark';
  const btn = $('#btn-theme');
  btn.textContent = dark ? 'Light theme' : 'Dark theme';
  btn.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
}

function onThemeChange() {
  updateThemeButton();
  if (overview.status === 'ready' && $('#overview').open) renderDiagrams();
}

function toggleTheme() {
  const next = effectiveTheme() === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', next);
  writeStorage(THEME_KEY, next);
  onThemeChange();
}

/* ---------- Chat ---------- */

// Escapes text, keeps line breaks, and turns "- " lines into bullet lists.
function renderRichText(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  let html = '';
  let para = [];
  let list = [];
  const flushPara = () => {
    if (para.length) html += `<p>${para.map(esc).join('<br>')}</p>`;
    para = [];
  };
  const flushList = () => {
    if (list.length) html += `<ul>${list.map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`;
    list = [];
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    if (bullet) {
      flushPara();
      list.push(bullet[1]);
    } else if (!line.trim()) {
      flushPara();
      flushList();
    } else {
      flushList();
      para.push(line.trim());
    }
  }
  flushPara();
  flushList();
  return html;
}

function fmtArgs(args) {
  if (args === undefined || args === null) return '';
  if (typeof args === 'object' && !Array.isArray(args) && !Object.keys(args).length) return '';
  try { return JSON.stringify(args); } catch { return String(args); }
}

function toolsHtml(tools) {
  if (!Array.isArray(tools) || !tools.length) {
    return '<div class="tools"><p class="tools-h">Tools used: none</p></div>';
  }
  return `<div class="tools">
    <p class="tools-h">Tools used</p>
    <ul>${tools.map((t) => {
      const args = fmtArgs(t.args);
      return `<li><code class="tool-name">${esc(t.name)}</code>${args ? ` <code class="tool-args">${esc(args)}</code>` : ' <span class="muted">(no arguments)</span>'}</li>`;
    }).join('')}</ul>
  </div>`;
}

function messageHtml(m) {
  if (m.role === 'user') {
    return `<div class="msg msg-user"><p class="msg-who">You</p><div class="msg-body">${renderRichText(m.content)}</div></div>`;
  }
  return `<div class="msg msg-assistant"><p class="msg-who">Assistant</p><div class="msg-body">${renderRichText(m.content)}</div>${toolsHtml(m.tools)}</div>`;
}

function chatEmptyHtml() {
  return '<p class="empty chat-empty">No questions yet for this run. Try one of the suggestions below.</p>';
}

function appendMessage(m) {
  const log = $('#chat-log');
  const empty = log.querySelector('.chat-empty');
  if (empty) empty.remove();
  log.insertAdjacentHTML('beforeend', messageHtml(m));
  log.scrollTop = log.scrollHeight;
  return log.lastElementChild;
}

function setChatError(message) {
  const el = $('#chat-error');
  el.textContent = message || '';
  el.hidden = !message;
}

async function loadChat() {
  const gen = state.gen;
  const log = $('#chat-log');
  log.innerHTML = '<p class="muted">Loading conversation…</p>';
  setChatError('');
  try {
    const data = await api(`/api/runs/${enc(state.runId)}/chat`);
    if (gen !== state.gen) return;
    const msgs = data.messages || [];
    log.innerHTML = msgs.length ? msgs.map(messageHtml).join('') : chatEmptyHtml();
    log.scrollTop = log.scrollHeight;
  } catch (e) {
    if (gen !== state.gen) return;
    log.innerHTML = `<p class="inline-error">Could not load the conversation. <button type="button" class="link" data-retry="chat">Retry</button></p>`;
    setChatError(e.message);
  }
}

async function sendChat(message) {
  const text = String(message || '').trim();
  if (!text || !state.runId || state.chatPending) return; // double-submit guard
  const gen = state.gen;
  state.chatPending = true;
  updateControls();
  setChatError('');
  const userEl = appendMessage({ role: 'user', content: text });
  const log = $('#chat-log');
  log.insertAdjacentHTML('beforeend',
    '<div class="msg msg-assistant msg-pending" id="chat-pending"><p class="msg-who">Assistant</p><p class="msg-body muted">Looking at the run…</p></div>');
  log.scrollTop = log.scrollHeight;
  $('#chat-input').value = '';
  try {
    const data = await api('/api/chat', { method: 'POST', body: { runId: rawRunId(), message: text } });
    if (gen !== state.gen) return;
    $('#chat-pending')?.remove();
    appendMessage({ role: 'assistant', content: data.answer, tools: data.tools });
  } catch (e) {
    if (gen !== state.gen) return;
    $('#chat-pending')?.remove();
    userEl.remove(); // the question was not answered; put it back in the box instead
    if (!log.querySelector('.msg')) log.innerHTML = chatEmptyHtml();
    if (e.status === 429 && isNum(e.data.resetsAt)) {
      setChatError(`The hourly chat limit has been reached. You can ask again at ${fmtClock(e.data.resetsAt)}.`);
    } else {
      setChatError(e.message);
    }
    if (!$('#chat-input').value) $('#chat-input').value = text;
  } finally {
    $('#chat-pending')?.remove();
    state.chatPending = false;
    updateControls();
  }
}

/* ---------- Actions ---------- */

async function runNight() {
  // Guard in code, not only through the disabled attribute: repeat clicks and Enter are ignored.
  if (state.creating || state.startingRecovery || activeRun()) return;
  clearError();
  setRunMessage('');
  state.creating = true;
  updateControls();
  renderProgressCard();
  announce(BILLING_TEXT);
  try {
    const data = await api('/api/runs', { method: 'POST', body: { size: 'full', start: true } });
    state.creating = false;
    if (!data.run) throw new ApiError(0, 'The server did not return the new run.');
    upsertRun(data.run);
    selectRun(data.run.id, { watch: true });
    if (isNum(data.failed) && data.failed > 0) {
      setRunMessage(`${fmtInt(data.failed)} declined renewals could not start recovery; the rest are running.`, 'warn');
    }
  } catch (e) {
    state.creating = false;
    if (e.status === 409 && e.data.runId) {
      const id = String(e.data.runId);
      await refreshRuns();
      selectRun(id, { watch: true });
      setRunMessage('Another night is already running — showing it live.');
    } else if (e.status === 429) {
      const when = isNum(e.data.resetsAt) ? ` You can run another night at ${fmtClock(e.data.resetsAt)}.` : ' Try again later.';
      setRunMessage(`The hourly limit for new nights has been reached.${when}`, 'warn');
    } else {
      showError(e.message);
    }
  } finally {
    state.creating = false;
    updateControls();
    renderProgressCard();
  }
}

async function startRecovery() {
  const run = state.run;
  if (state.startingRecovery || state.creating || !run || run.status !== 'generated') return;
  clearError();
  setRunMessage('');
  const gen = state.gen;
  state.startingRecovery = true;
  updateControls();
  try {
    const data = await api(`/api/runs/${enc(state.runId)}/recover`, { method: 'POST' });
    if (gen !== state.gen) return;
    if (data.run) setRun(data.run);
    state.watching = true;
    if (isNum(data.started)) setRunMessage(`Recovery started for ${fmtInt(data.started)} declined renewals.`);
    await loadRun();
  } catch (e) {
    if (gen !== state.gen) return;
    if (e.status === 409) setRunMessage(`Recovery could not start: ${e.data.error || 'the run is not available'}.`, 'warn');
    else showError(e.message);
  } finally {
    state.startingRecovery = false;
    updateControls();
    renderProgressCard();
  }
}

/* ---------- Wiring ---------- */

function populatePathFilter() {
  const sel = $('#f-path');
  sel.insertAdjacentHTML('beforeend', Object.entries(PATH_LABELS)
    .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
    .join(''));
}

function addHeaderHelp() {
  document.querySelectorAll('#payments-head th[data-help]').forEach((th) => {
    th.insertAdjacentHTML('beforeend', ` ${helpBtn(th.dataset.help)}`);
  });
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

const RETRY = {
  run: () => loadRun(),
  incidents: () => loadIncidents(),
  payments: () => loadPayments(),
  chat: () => loadChat(),
  overview: () => loadOverview(),
  timeline: () => state.tlId && openTimeline(state.tlId),
};

function bindEvents() {
  $('#run-select').addEventListener('change', (e) => {
    if (e.target.value) {
      setRunMessage('');
      selectRun(e.target.value);
    }
  });
  $('#show-test').addEventListener('change', (e) => {
    state.showTest = e.target.checked;
    renderRunSelect();
  });
  $('#btn-run').addEventListener('click', runNight);
  $('#btn-start').addEventListener('click', startRecovery);
  $('#btn-show-active').addEventListener('click', () => {
    const active = activeRun();
    if (active) selectRun(active.id);
  });
  $('#app-error-close').addEventListener('click', clearError);
  $('#app-error-retry').addEventListener('click', () => {
    const fn = errorRetry;
    clearError();
    if (fn) fn();
  });
  $('#run-message-close').addEventListener('click', () => setRunMessage(''));
  $('#done-close').addEventListener('click', () => { $('#done-banner').hidden = true; });

  $('#btn-howto').addEventListener('click', (e) => openHowto(e.currentTarget));
  $('#btn-overview').addEventListener('click', (e) => openOverview(e.currentTarget));
  $('#link-overview').addEventListener('click', (e) => openOverview(e.currentTarget));
  $('#btn-theme').addEventListener('click', toggleTheme);
  darkQuery.addEventListener('change', () => {
    if (!document.documentElement.hasAttribute('data-theme')) onThemeChange();
  });

  window.addEventListener('hashchange', () => {
    const id = readHashRun();
    if (id && id !== state.runId) selectRun(id);
  });

  // Delegated: glossary "?" buttons, Retry buttons, payment ids in the feed, overview links.
  document.addEventListener('click', (e) => {
    const help = e.target.closest('[data-glossary]');
    if (help) {
      e.preventDefault();
      e.stopPropagation();
      openGlossary(help.dataset.glossary, help);
      return;
    }
    const retry = e.target.closest('[data-retry]');
    if (retry && RETRY[retry.dataset.retry]) {
      RETRY[retry.dataset.retry]();
      return;
    }
    const ovLink = e.target.closest('[data-open-overview]');
    if (ovLink) {
      closeDialog($('#howto'));
      openOverview($('#btn-overview'));
      return;
    }
    const open = e.target.closest('#pc-feed [data-open]');
    if (open) openTimeline(open.dataset.open, open);
  });

  const filters = $('#filters');
  filters.addEventListener('submit', (e) => {
    e.preventDefault();
    resetAndLoadPayments();
  });
  filters.addEventListener('change', (e) => {
    if (e.target.tagName === 'SELECT') resetAndLoadPayments();
  });
  const debounced = debounce(resetAndLoadPayments, 300);
  filters.addEventListener('input', (e) => {
    if (e.target.tagName === 'INPUT') debounced();
  });
  filters.addEventListener('reset', () => setTimeout(resetAndLoadPayments, 0));

  $('#page-prev').addEventListener('click', () => {
    state.offset = Math.max(0, state.offset - LIMIT);
    loadPayments();
  });
  $('#page-next').addEventListener('click', () => {
    state.offset += LIMIT;
    loadPayments();
  });

  const tbody = $('#payments-body');
  tbody.addEventListener('click', (e) => {
    if (e.target.closest('a, button')) return;
    const row = e.target.closest('tr[data-id]');
    if (row) openTimeline(row.dataset.id, row);
  });
  tbody.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('tr[data-id]');
    if (!row || e.target !== row) return;
    e.preventDefault();
    openTimeline(row.dataset.id, row);
  });

  bindDialog($('#timeline'), () => {
    state.timelineSeq += 1;
    clearTimeout(state.tlTimer);
    // The row may have been re-rendered while the drawer was open: focus its replacement.
    const row = [...document.querySelectorAll('#payments-body tr[data-id]')].find((r) => r.dataset.id === state.tlId);
    return row || $('#payments-wrap');
  });
  bindDialog($('#howto'), () => $('#btn-howto'));
  bindDialog($('#overview'), () => $('#btn-overview'));

  $('#chat-form').addEventListener('submit', (e) => {
    e.preventDefault();
    sendChat($('#chat-input').value);
  });
  $('#chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendChat(e.target.value);
    }
  });
  document.querySelectorAll('.suggestions .chip').forEach((btn) => {
    btn.addEventListener('click', () => sendChat(btn.dataset.prompt));
  });

  // Pause polling while the tab is hidden; catch up straight away on return.
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopLive();
      return;
    }
    if (state.run && isActiveStatus(state.run.status)) {
      state.lastProgressAt = Date.now(); // the pause itself is not a stall
      startLive(0);
      refreshAll();
    }
    refreshRuns();
  });

  setInterval(renderClock, 1000);
  setInterval(() => {
    if (!document.hidden && !state.creating) refreshRuns();
  }, RUNS_MS);
}

function renderNoRuns(message) {
  $('#run-meta').textContent = '';
  $('#tiles').innerHTML = `<div class="tile tile-wide"><dt>No runs yet</dt><dd class="tile-sub">${esc(message || 'Press Run a night to simulate a night of renewals.')}</dd></div>`;
  $('#compare-body').innerHTML = '<tr><td colspan="4" class="muted">No data yet.</td></tr>';
  $('#paths').innerHTML = '<p class="muted">No data yet.</p>';
  $('#incidents').innerHTML = '<p class="empty">No run selected.</p>';
  $('#chat-log').innerHTML = '<p class="empty">Select or run a night to ask questions about it.</p>';
  $('#payments-body').innerHTML = '<tr><td colspan="11" class="empty">No run selected.</td></tr>';
  $('#progress-card').hidden = true;
  updateControls();
}

function renderUnreachable(message) {
  $('#run-select').innerHTML = '<option value="">Could not load runs</option>';
  $('#run-select').disabled = true;
  $('#tiles').innerHTML = `<div class="tile tile-wide"><dt>API unreachable</dt><dd class="tile-sub">${esc(message)} <button type="button" class="link" id="boot-retry">Retry</button></dd></div>`;
  $('#boot-retry').addEventListener('click', boot);
  $('#compare-body').innerHTML = '<tr><td colspan="4" class="muted">No data.</td></tr>';
  $('#paths').innerHTML = '<p class="muted">No data.</p>';
  $('#incidents').innerHTML = '<p class="muted">No data.</p>';
  $('#chat-log').innerHTML = '<p class="muted">Chat is unavailable until the API can be reached.</p>';
  $('#payments-body').innerHTML = '<tr><td colspan="11" class="muted">No data.</td></tr>';
}

async function boot() {
  clearError();
  $('#run-select').innerHTML = '<option value="">Loading runs…</option>';
  renderSummaryLoading();

  const [runsRes, latestRes] = await Promise.allSettled([api('/api/runs'), api('/api/runs/latest')]);
  const latestMissing = latestRes.status === 'rejected' && latestRes.reason.status === 404;
  if (runsRes.status === 'rejected' && !latestMissing) {
    const msg = runsRes.reason.status === 0
      ? 'The API cannot be reached right now. Check that the Worker is running, then retry.'
      : runsRes.reason.message;
    showError(msg, boot);
    renderUnreachable(msg);
    return;
  }

  state.runs = runsRes.status === 'fulfilled' ? (runsRes.value.runs || []).sort(byCreated) : [];
  const latest = latestRes.status === 'fulfilled' ? latestRes.value.run : null;
  if (latest && !findRun(latest.id)) {
    state.runs.push(latest);
    state.runs.sort(byCreated);
  }
  if (latestRes.status === 'rejected' && !latestMissing) showError(latestRes.reason.message);

  const hashId = readHashRun();
  let id = null;
  if (hashId && findRun(hashId)) id = hashId;
  else if (latest) id = String(latest.id);
  else if (state.runs[0]) id = String(state.runs[0].id);

  state.runId = id;
  renderRunSelect();
  if (id) selectRun(id);
  else renderNoRuns();
}

function init() {
  populatePathFilter();
  addHeaderHelp();
  renderGlossary();
  updateThemeButton();
  bindEvents();
  updateControls();
  boot();
  maybeShowHowtoOnFirstVisit();
}

init();
