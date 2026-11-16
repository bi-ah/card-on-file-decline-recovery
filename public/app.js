// Operator page for the Card-on-File Decline Recovery demo.
// Vanilla ES module, no build step. All server text is escaped before it is inserted as HTML.

const LIMIT = 50;
const POLL_MS = 2000;

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

const state = {
  runs: [],
  runId: null, // always a string
  run: null,
  summary: null,
  gen: 0, // bumps on every run selection; stale responses are dropped
  pollTimer: null,
  pollInFlight: false,
  pollCount: 0,
  paymentsSeq: 0,
  timelineSeq: 0,
  offset: 0,
  total: 0,
  busy: false,
  chatPending: false,
  lastFocus: null,
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

const isNum = (n) => typeof n === 'number' && Number.isFinite(n);
const fmtMoney = (cents) => (isNum(cents) ? moneyFmt.format(cents / 100) : '–');
const fmtInt = (n) => (isNum(n) ? n.toLocaleString('en-US') : '–');
const fmtPct = (ratio) => (isNum(ratio) ? `${(ratio * 100).toFixed(1)}%` : '–');
const fmtTime = (ms) => (isNum(ms) && ms > 0 ? dateFmt.format(new Date(ms)) : '–');
const yesNo = (b) => (b ? 'Yes' : 'No');
const humanize = (s) => String(s ?? '').replace(/[_-]+/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

const pathLabel = (p) => (p ? PATH_LABELS[p] || humanize(p) : '–');
const credentialLabel = (c) => CREDENTIAL_LABELS[c] || (c ? humanize(c) : '–');
const brandLabel = (b) => BRAND_LABELS[b] || (b ? humanize(b) : '–');

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

/* ---------- API ---------- */

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function describeError(status, message) {
  const detail = message ? ` ${message}${/[.!?]$/.test(message) ? '' : '.'}` : '';
  if (status === 409) return `A run is already in progress (409).${detail}`;
  if (status === 429) return `Usage quota reached (429).${detail} Try again later.`;
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
    throw new ApiError(res.status, describeError(res.status, msg));
  }
  return data ?? {};
}

/* ---------- Global error and notice ---------- */

function showError(message) {
  $('#app-error-text').textContent = message;
  $('#app-error').hidden = false;
}

function clearError() {
  $('#app-error').hidden = true;
  $('#app-error-text').textContent = '';
}

function setNotice(message) {
  $('#notice').textContent = message || '';
}

/* ---------- Run selection ---------- */

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

function runOptionText(r) {
  return `${r.label} · ${r.status} · ${fmtTime(r.createdAt)}`;
}

function renderRunSelect() {
  const sel = $('#run-select');
  if (!state.runs.length) {
    sel.innerHTML = '<option value="">No runs yet</option>';
    sel.disabled = true;
    return;
  }
  sel.innerHTML = state.runs
    .map((r) => `<option value="${esc(r.id)}">${esc(runOptionText(r))}</option>`)
    .join('');
  sel.disabled = false;
  if (state.runId) sel.value = state.runId;
}

function upsertRun(run) {
  if (!run) return;
  const idx = state.runs.findIndex((r) => String(r.id) === String(run.id));
  if (idx === -1) {
    state.runs.unshift(run);
    state.runs.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
    renderRunSelect();
    return;
  }
  state.runs[idx] = run;
  // Update the option text in place so an open dropdown is not disturbed.
  const opt = [...$('#run-select').options].find((o) => o.value === String(run.id));
  if (opt) opt.textContent = runOptionText(run);
}

function selectRun(id) {
  state.runId = String(id);
  state.gen += 1;
  state.run = findRun(id);
  state.summary = null;
  state.offset = 0;
  state.pollCount = 0;
  stopPolling();
  writeHashRun(state.runId);
  $('#run-select').value = state.runId;
  setNotice('');
  updateControls();
  renderSummaryLoading();
  loadRun();
  loadIncidents();
  loadPayments();
  loadChat();
}

function updateControls() {
  const run = state.run;
  const status = run ? run.status : null;
  $('#btn-recover').disabled = state.busy || status !== 'generated';
  $('#btn-generate').disabled = state.busy;
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
  $('#chat-send').disabled = chatDisabled;
  document.querySelectorAll('.suggestions .chip').forEach((b) => { b.disabled = chatDisabled; });
}

function setBusy(busy) {
  state.busy = busy;
  updateControls();
}

/* ---------- Run detail and polling ---------- */

async function loadRun() {
  const gen = state.gen;
  try {
    const data = await api(`/api/runs/${enc(state.runId)}`);
    if (gen !== state.gen) return;
    applyRun(data);
  } catch (e) {
    if (gen !== state.gen) return;
    showError(e.message);
    $('#tiles').innerHTML = '<div class="tile"><dt>Summary</dt><dd class="tile-sub">Could not load this run.</dd></div>';
  }
}

function applyRun(data) {
  if (!data || !data.run) return;
  state.run = data.run;
  state.summary = data.summary || null;
  upsertRun(data.run);
  if (data.simulatedLabel) $('#sim-label').textContent = data.simulatedLabel;
  updateControls();
  renderSummary();
  if (data.run.status === 'recovering') startPolling();
  else stopPolling();
}

function startPolling() {
  if (state.pollTimer) return;
  const gen = state.gen;
  state.pollTimer = setInterval(() => poll(gen), POLL_MS);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
}

async function poll(gen) {
  if (gen !== state.gen || state.pollInFlight) return;
  state.pollInFlight = true;
  try {
    const data = await api(`/api/runs/${enc(state.runId)}`);
    if (gen !== state.gen) return;
    state.pollCount += 1;
    applyRun(data);
    if (data.run.status !== 'recovering') {
      setNotice(`Recovery ${data.run.status === 'completed' ? 'completed' : data.run.status}.`);
      loadIncidents();
      loadPayments({ quiet: true });
    } else if (state.pollCount % 3 === 0) {
      loadPayments({ quiet: true });
    }
  } catch (e) {
    if (gen === state.gen) showError(e.message);
  } finally {
    state.pollInFlight = false;
  }
}

/* ---------- Summary ---------- */

function renderSummaryLoading() {
  $('#tiles').innerHTML = '<div class="tile"><dt>Summary</dt><dd class="tile-sub">Loading…</dd></div>';
  $('#run-meta').textContent = '';
  $('#progress').hidden = true;
}

function tile(label, value, sub, tone) {
  return `<div class="tile${tone ? ` tile-${tone}` : ''}">
    <dt>${esc(label)}</dt>
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
    $('#tiles').innerHTML = '<div class="tile"><dt>Summary</dt><dd class="tile-sub">No summary for this run.</dd></div>';
    return;
  }

  const prevention = s.prevention || {};
  const prevented = (prevention.tokenLifecycle || 0) + (prevention.accountUpdater || 0);
  const creds = s.credentialTypes || {};

  let violationsTile;
  if (s.violations === null || s.violations === undefined) {
    violationsTile = tile('Guardrail violations', '–', 'Checked once recovery finishes');
  } else if (s.violations === 0) {
    violationsTile = tile('Guardrail violations', '0', 'No scheme rule broken', 'good');
  } else {
    violationsTile = tile('Guardrail violations', fmtInt(s.violations), 'Rules broken: review timelines', 'bad');
  }

  $('#tiles').innerHTML = [
    tile('Renewals', fmtInt(s.renewals),
      `${fmtInt(s.approvedFirstTime)} approved first time · ${fmtInt(creds.networkToken)} token, ${fmtInt(creds.panFallback)} card-number`),
    tile('Declined', fmtInt(s.declined), `${fmtMoney(s.declinedCents)} declined`),
    tile('Recovered', fmtMoney(s.recoveredCents),
      `${fmtPct(s.recoveryRateByAmount)} of declined $ · ${fmtInt(s.recovered)} renewals`, s.recoveredCents > 0 ? 'good' : null),
    tile('Retries', fmtInt(s.retries), `${fmtInt(s.altPspRetries)} via another PSP`),
    tile('Customers asked', fmtInt(s.customersAsked), 'Asked to update their card'),
    tile('Prevented before billing', fmtInt(prevented),
      `${fmtInt(prevention.tokenLifecycle || 0)} token lifecycle · ${fmtInt(prevention.accountUpdater || 0)} account updater`),
    violationsTile,
  ].join('');

  renderProgress();
  renderCompare();
  renderPaths();
}

function renderProgress() {
  const box = $('#progress');
  const s = state.summary;
  if (!state.run || state.run.status !== 'recovering' || !s) {
    box.hidden = true;
    return;
  }
  const declined = s.declined || 0;
  const done = Math.max(0, declined - (s.inProgress || 0));
  const ratio = declined > 0 ? done / declined : 1;
  const bar = $('#progress-bar');
  bar.max = 1;
  bar.value = ratio;
  $('#progress-label').textContent =
    `Recovering: ${fmtInt(done)} of ${fmtInt(declined)} declined renewals settled (${fmtPct(ratio)})`;
  box.hidden = false;
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
      <th scope="row">Never-retry violations</th>
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

async function loadIncidents() {
  const gen = state.gen;
  const box = $('#incidents');
  if (!box.children.length || box.dataset.run !== state.runId) box.innerHTML = '<p class="muted">Loading…</p>';
  box.dataset.run = state.runId;
  try {
    const data = await api(`/api/runs/${enc(state.runId)}/incidents`);
    if (gen !== state.gen) return;
    renderIncidents(data.incidents || []);
  } catch (e) {
    if (gen !== state.gen) return;
    box.innerHTML = `<p class="inline-error">${esc(e.message)}</p>`;
  }
}

function renderIncidents(list) {
  const box = $('#incidents');
  if (!list.length) {
    box.innerHTML = '<p class="empty">No incidents detected for this run. Incidents are flagged when declines cluster on one PSP or one issuer.</p>';
    return;
  }
  box.innerHTML = `<ul class="incidents">${list.map((i) => `
    <li class="incident">
      <div class="incident-head">
        <span class="badge badge-warn">${esc(INCIDENT_LABELS[i.kind] || humanize(i.kind))}</span>
        <strong>${esc(i.subject)}</strong>
        <span class="muted small">${esc(i.fromLabel)}–${esc(i.toLabel)}</span>
      </div>
      <p class="incident-stats small">Affected <strong>${esc(fmtInt(i.affected))}</strong> · Recovered <strong>${esc(fmtInt(i.recovered))}</strong></p>
      ${i.text ? `<p class="incident-text">${esc(i.text)}</p>` : ''}
    </li>`).join('')}</ul>`;
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
    renderPayments(data.rows || []);
  } catch (e) {
    if (seq !== state.paymentsSeq || gen !== state.gen) return;
    body.innerHTML = `<tr><td colspan="11" class="inline-error">${esc(e.message)}</td></tr>`;
    state.total = 0;
    renderPager(0);
  } finally {
    if (seq === state.paymentsSeq) body.removeAttribute('aria-busy');
  }
}

function paymentRow(p) {
  const mac = p.firstMac ? `<span class="sub">MAC ${esc(p.firstMac)}</span>` : '';
  const alt = p.altRetries ? `<span class="sub">${esc(fmtInt(p.altRetries))} via another PSP</span>` : '';
  return `<tr data-id="${esc(p.id)}">
    <th scope="row"><button type="button" class="link mono" data-open="${esc(p.id)}" aria-label="Open timeline for payment ${esc(p.id)}">${esc(p.id)}</button></th>
    <td>${esc(brandLabel(p.brand))}</td>
    <td>${esc(p.region)}</td>
    <td class="mono nowrap">${esc(p.bin)} •••• ${esc(p.last4)}</td>
    <td>${esc(credentialLabel(p.credentialType))}</td>
    <td class="num">${esc(fmtMoney(p.amountCents))}</td>
    <td class="mono">${esc(p.firstCode)}${mac}</td>
    <td class="mono">${esc(p.firstPsp)}</td>
    <td>${esc(pathLabel(p.path))}</td>
    <td>${badge(p.status)}</td>
    <td class="num">${esc(fmtInt(p.retries))}${alt}</td>
  </tr>`;
}

function renderPayments(rows) {
  const body = $('#payments-body');
  if (!rows.length) {
    body.innerHTML = '<tr><td colspan="11" class="empty">No declined renewals match these filters.</td></tr>';
  } else {
    body.innerHTML = rows.map(paymentRow).join('');
  }
  renderPager(rows.length);
}

function renderPager(count) {
  const from = count ? state.offset + 1 : 0;
  const to = state.offset + count;
  $('#pager-text').textContent = state.total
    ? `Showing ${fmtInt(from)}–${fmtInt(to)} of ${fmtInt(state.total)}`
    : '';
  $('#page-prev').disabled = state.offset <= 0;
  $('#page-next').disabled = to >= state.total;
}

function resetAndLoadPayments() {
  state.offset = 0;
  loadPayments();
}

/* ---------- Timeline drawer ---------- */

async function openTimeline(id) {
  const dlg = $('#timeline');
  const seq = ++state.timelineSeq;
  $('#tl-title').textContent = `Payment ${id}`;
  $('#tl-body').innerHTML = '<p class="muted">Loading timeline…</p>';
  if (!dlg.open) {
    state.lastFocus = document.activeElement;
    dlg.showModal();
  }
  try {
    const data = await api(`/api/payments/${enc(id)}`);
    if (seq !== state.timelineSeq) return;
    renderTimeline(data.payment, data.timeline || []);
  } catch (e) {
    if (seq !== state.timelineSeq) return;
    $('#tl-body').innerHTML = `<p class="inline-error">${esc(e.message)}</p>`;
  }
}

function closeTimeline() {
  const dlg = $('#timeline');
  if (dlg.open) dlg.close();
}

function metaItem(label, valueHtml) {
  return `<div><dt>${esc(label)}</dt><dd>${valueHtml}</dd></div>`;
}

function paymentFacts(p) {
  const items = [
    metaItem('Status', badge(p.status)),
    metaItem('Path', esc(pathLabel(p.path))),
    metaItem('Amount', esc(fmtMoney(p.amountCents))),
    metaItem('Card', `<span class="mono">${esc(brandLabel(p.brand))} ${esc(p.bin)} •••• ${esc(p.last4)}</span>`),
    metaItem('Expiry', esc(p.expiry || '–')),
    metaItem('Credential', esc(credentialLabel(p.credentialType))),
    metaItem('Region', esc(p.region)),
    metaItem('Customer', `<span class="mono">${esc(p.customerId)}</span>`),
    metaItem('PSP', `<span class="mono">${esc(p.firstPsp)}${p.lastPsp && p.lastPsp !== p.firstPsp ? ` → ${esc(p.lastPsp)}` : ''}</span>`),
    metaItem('First code', `<span class="mono">${esc(p.firstCode)}${p.firstMac ? ` · MAC ${esc(p.firstMac)}` : ''}</span>`),
    metaItem('Retries', `${esc(fmtInt(p.retries))}${p.altRetries ? ` (${esc(fmtInt(p.altRetries))} via another PSP)` : ''}`),
    metaItem('Customer asked', esc(yesNo(p.customerAsked))),
  ];
  if (p.outcome) items.push(metaItem('Outcome', esc(humanize(p.outcome))));
  if (p.preventedBy) items.push(metaItem('Prevented by', esc(humanize(p.preventedBy))));
  if (p.finalReason) items.push(metaItem('Final reason', esc(p.finalReason)));
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
    <p class="rule-label">${esc(rule.label)}</p>
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
  if (e.credentialType) items.push(metaItem('Credential', esc(credentialLabel(e.credentialType))));
  if (typeof e.mit === 'boolean') items.push(metaItem('MIT', esc(yesNo(e.mit))));
  if (typeof e.customerInitiated === 'boolean') items.push(metaItem('Customer-initiated', esc(yesNo(e.customerInitiated))));
  if (e.code) items.push(metaItem('Code', `<span class="mono">${esc(e.code)}</span>`));
  if (e.mac) items.push(metaItem('MAC', `<span class="mono">${esc(e.mac)}</span>`));
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
      <p class="tl-head"><span class="kind kind-${kind}">${esc(KIND_LABELS[kind])}</span> <strong>${esc(e.title)}</strong></p>
      ${e.detail ? `<p class="tl-detail">${esc(e.detail)}</p>` : ''}
      ${extra}
    </div>
  </li>`;
}

function renderTimeline(payment, timeline) {
  const body = $('#tl-body');
  const facts = payment ? paymentFacts(payment) : '';
  const list = timeline.length
    ? `<ol class="timeline">${timeline.map(timelineEntry).join('')}</ol>`
    : '<p class="empty">No timeline entries yet.</p>';
  body.innerHTML = `${facts}<h3 class="tl-section-h">Timeline</h3>${list}`;
  body.scrollTop = 0;
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
    log.innerHTML = chatEmptyHtml();
    setChatError(e.message);
  }
}

async function sendChat(message) {
  const text = String(message || '').trim();
  if (!text || !state.runId || state.chatPending) return;
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
    setChatError(e.message);
    if (!$('#chat-input').value) $('#chat-input').value = text;
  } finally {
    $('#chat-pending')?.remove();
    state.chatPending = false;
    updateControls();
  }
}

/* ---------- Actions ---------- */

async function generateNight() {
  clearError();
  setNotice('Generating a simulated night of renewals…');
  setBusy(true);
  try {
    const data = await api('/api/runs', { method: 'POST', body: { size: 'full' } });
    upsertRun(data.run);
    renderRunSelect();
    setNotice('Night generated. Press Recover to start recovering its declines.');
    selectRun(data.run.id);
  } catch (e) {
    setNotice('');
    showError(e.message);
  } finally {
    setBusy(false);
  }
}

async function recover() {
  if (!state.runId) return;
  clearError();
  const gen = state.gen;
  setBusy(true);
  try {
    const data = await api(`/api/runs/${enc(state.runId)}/recover`, { method: 'POST' });
    if (gen !== state.gen) return;
    if (data.run) {
      state.run = data.run;
      upsertRun(data.run);
    }
    setNotice(`Recovery started for ${fmtInt(data.started)} declined renewals.`);
    await loadRun();
  } catch (e) {
    showError(e.message);
  } finally {
    setBusy(false);
  }
}

/* ---------- Wiring ---------- */

function populatePathFilter() {
  const sel = $('#f-path');
  sel.insertAdjacentHTML('beforeend', Object.entries(PATH_LABELS)
    .map(([value, label]) => `<option value="${esc(value)}">${esc(label)}</option>`)
    .join(''));
}

function debounce(fn, ms) {
  let t;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

function bindEvents() {
  $('#run-select').addEventListener('change', (e) => {
    if (e.target.value) selectRun(e.target.value);
  });
  $('#btn-generate').addEventListener('click', generateNight);
  $('#btn-recover').addEventListener('click', recover);
  $('#app-error-close').addEventListener('click', clearError);

  window.addEventListener('hashchange', () => {
    const id = readHashRun();
    if (id && id !== state.runId) selectRun(id);
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

  $('#payments-body').addEventListener('click', (e) => {
    if (e.target.closest('a')) return;
    const row = e.target.closest('tr[data-id]');
    if (row) openTimeline(row.dataset.id);
  });

  const dlg = $('#timeline');
  $('#tl-close').addEventListener('click', closeTimeline);
  dlg.addEventListener('click', (e) => {
    if (e.target === dlg) closeTimeline(); // backdrop click
  });
  dlg.addEventListener('close', () => {
    state.timelineSeq += 1;
    if (state.lastFocus && typeof state.lastFocus.focus === 'function') state.lastFocus.focus();
  });

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
}

function renderNoRuns() {
  $('#run-meta').textContent = '';
  $('#tiles').innerHTML = '<div class="tile"><dt>No runs yet</dt><dd class="tile-sub">Press Generate night to simulate a night of renewals.</dd></div>';
  $('#incidents').innerHTML = '<p class="empty">No run selected.</p>';
  $('#chat-log').innerHTML = '<p class="empty">Select or generate a run to ask questions about it.</p>';
  updateControls();
}

async function init() {
  populatePathFilter();
  bindEvents();
  updateControls();

  const [runsRes, latestRes] = await Promise.allSettled([api('/api/runs'), api('/api/runs/latest')]);
  if (runsRes.status === 'fulfilled') {
    state.runs = runsRes.value.runs || [];
  } else {
    showError(runsRes.reason.message);
  }
  const latest = latestRes.status === 'fulfilled' ? latestRes.value.run : null;
  if (latest && !findRun(latest.id)) state.runs.unshift(latest);
  if (latestRes.status === 'rejected' && latestRes.reason.status !== 404 && runsRes.status === 'fulfilled') {
    showError(latestRes.reason.message);
  }

  renderRunSelect();

  const hashId = readHashRun();
  let id = null;
  if (hashId && findRun(hashId)) id = hashId;
  else if (latest) id = String(latest.id);
  else if (state.runs[0]) id = String(state.runs[0].id);

  if (id) selectRun(id);
  else renderNoRuns();
}

init();
