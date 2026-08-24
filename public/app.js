/* Standby dashboard — plain modules, no framework, no build step.
   The server streams every state change; this file only renders. */

const $ = (id) => document.getElementById(id);

const fmtTime = (ms, tz) => (ms == null ? '—'
  : new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: tz ?? 'UTC' }));

const TAG = {
  queued: 'waiting', calling: 'calling', accepted: 'accepted', declined: 'declined',
  no_answer: 'no answer', failed: 'failed', skipped: 'skipped', stood_down: 'stood down',
  needs_review: 'held',
};

/**
 * What the PERSON said, not the whole conversation.
 *
 * A CALL-E transcript is timestamped and starts with the agent's greeting:
 *   [00:00:00] BOT: Hallo.  [00:00:03] USER: Hallo.  [00:00:03] BOT: Ich rufe…
 * Rendering that raw into a roster row shows a supervisor the bot saying hello
 * and hides the one thing they need — the answer. Take the last thing the
 * callee said that is longer than a greeting.
 */
function calleeAnswer(transcript) {
  if (!transcript) return null;
  const said = [...transcript.matchAll(/USER:\s*([^\n[]+)/g)]
    .map((m) => m[1].trim())
    .filter((line) => line.length > 6);
  return said.length ? said[said.length - 1] : null;
}

const SKIP_TEXT = {
  opted_out: 'opted out of standby calls',
  no_phone_number: 'no number on file',
  marked_unavailable: 'marked unavailable',
  filled: 'never rung — the shift was already filled',
  cutoff: 'never rung — the shift started',
  exhausted: 'never rung — the list ran out',
};

// Someone who was rung once and then stood down was NOT "never rung". Saying
// so on screen is a plain factual error about a call that is sitting in the
// audit log two lines below.
const STOOD_DOWN_AFTER = {
  no_answer: 'no answer — stood down before the second sweep',
  callback: 'asked to be rung back — stood down first',
  decline: 'declined',
  failed: 'call failed — not retried',
};

let demo = null;
let view = null;
let es = null;

/* ── boot ─────────────────────────────────────────────────────────────────── */

async function boot() {
  demo = await (await fetch('/api/demo')).json();

  $('mode-badge').textContent = demo.mode === 'live' ? 'live · real calls' : 'fixture · authored calls, no account';
  $('mode-badge').classList.toggle('live', demo.mode === 'live');
  $('foot-mode').textContent = demo.mode === 'live'
    ? 'Live mode — CALLE_LIVE=1'
    : 'Fixture mode — the whole product, no credentials, no cost. CALLE_LIVE=1 switches the same code path to real calls.';

  $('shift-select').innerHTML = demo.shifts
    .map((s) => `<option value="${s.id}">${s.role} — ${fmtTime(s.startsAt, s.timeZone)}</option>`).join('');
  $('scenario-select').innerHTML = demo.scenarios
    .map((s) => `<option value="${s}">${s.replace(/-/g, ' ')}</option>`).join('');

  $('shift-select').onchange = renderShift;
  $('btn-run').onclick = start;
  $('btn-abort').onclick = abort;
  for (const b of document.querySelectorAll('[data-reconcile]')) {
    b.onclick = () => reconcile(b.dataset.reconcile);
  }

  renderShift();
  await renderCapabilities();
  renderRoster(demo.roster.map((p, i) => ({ ...p, position: i, state: 'queued', attempts: [] })), null);
}

function currentShift() {
  return demo.shifts.find((s) => s.id === $('shift-select').value) ?? demo.shifts[0];
}

function renderShift() {
  const s = currentShift();
  $('shift-note').textContent = s.note;
  $('shift-meta').innerHTML = `
    <dt>Starts</dt><dd>${fmtTime(s.startsAt, s.timeZone)}</dd>
    <dt>Ends</dt><dd>${fmtTime(s.endsAt, s.timeZone)}</dd>
    <dt>Where</dt><dd>${s.location}</dd>
    <dt>Standby list</dt><dd>${demo.roster.length} people</dd>`;
  $('cost-line').textContent = demo.mode === 'live'
    ? 'Live mode: each call spends one of twenty free CALL-E calls.'
    : 'Fixture mode: replayed from authored fixtures — written, not recorded. Nothing is dialled, nothing is spent.';
}

async function renderCapabilities() {
  const caps = await (await fetch('/api/capabilities')).json();
  $('can-list').innerHTML = caps.can.map((c) => `
    <li><span class="tool">${c.tool}</span><span class="prov">${c.provider}</span>
    <div class="what">${c.what}</div></li>`).join('');
  $('withheld-count').textContent = caps.withheld.length;
  $('withheld-list').innerHTML = caps.withheld.map((c) => `
    <li><span class="tool">${c.tool}</span>
    <div class="why"><b>Why not:</b> ${c.why}</div></li>`).join('');
}

/* ── the run ──────────────────────────────────────────────────────────────── */

async function start() {
  $('btn-run').disabled = true;
  $('btn-abort').disabled = false;
  $('outcome').hidden = true;
  $('transcript-panel').hidden = true;

  const res = await fetch('/api/cascades', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      shiftId: currentShift().id,
      scenario: $('scenario-select').value,
    }),
  });
  const { stream } = await res.json();

  es?.close();
  es = new EventSource(stream);
  es.onmessage = (m) => {
    const payload = JSON.parse(m.data);
    view = payload.view;
    render();
    if (payload.event?.type === 'closed') finish();
  };
  es.onerror = () => finish();
}

async function abort() {
  if (!view) return;
  await fetch(`/api/cascades/${view.id}/abort`, { method: 'POST' });
  finish();
}

/**
 * Lift a hold. The server refuses without a name, and so does this — an audit
 * line reading "reconciled by (unknown)" looks like accountability and is not.
 */
async function reconcile(result) {
  if (!view?.summary?.heldOn) return;
  const by = $('held-by').value.trim();
  if (!by) { $('held-by').focus(); $('held-by').classList.add('needed'); return; }
  $('held-by').classList.remove('needed');
  for (const b of document.querySelectorAll('[data-reconcile]')) b.disabled = true;

  const res = await fetch(`/api/cascades/${view.id}/reconcile`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ candidateId: view.summary.heldOn.id, result, by }),
  });
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({ error: 'reconcile failed' }));
    $('held-why').textContent = error;
  }
  for (const b of document.querySelectorAll('[data-reconcile]')) b.disabled = false;
}

function finish() {
  es?.close();
  es = null;
  $('btn-run').disabled = false;
  $('btn-abort').disabled = true;
}

/* ── rendering ────────────────────────────────────────────────────────────── */

function render() {
  renderRoster(view.candidates, view.shift);
  const placed = view.summary.calls;
  $('counter').textContent = `${placed} call${placed === 1 ? '' : 's'} placed`;

  const held = view.summary.heldOn;
  $('held').hidden = !held;
  if (held) {
    $('held-why').textContent = `${held.name}: ${held.why}`;
    // The transcript is the evidence the decision is made on, so open it rather
    // than making somebody hunt for the row.
    showTranscript(held.id);
  }

  // A hold is not an outcome. Showing "the list is exhausted" underneath a
  // pending decision would be a straightforward lie about where the shift is.
  if (view.outcome && view.outcome !== 'needs_review') renderOutcome();
  else if (!view.outcome) $('outcome').hidden = true;
}

function renderRoster(candidates, shift) {
  const tz = shift?.timeZone;
  $('roster').innerHTML = candidates.map((c) => {
    const last = c.attempts?.[c.attempts.length - 1];
    const tag = c.state === 'queued' && c.notBefore ? 'call back' : (TAG[c.state] ?? c.state);

    let sub = '';
    if (c.state === 'skipped') sub = SKIP_TEXT[c.skipReason] ?? c.skipReason;
    else if (c.state === 'stood_down') {
      sub = last?.result
        ? (STOOD_DOWN_AFTER[last.result] ?? last.result)
        : (SKIP_TEXT[c.skipReason] ?? c.skipReason ?? 'never rung');
    }
    else if (c.state === 'accepted') {
      sub = c.arrivesAt ? `arriving ${fmtTime(c.arrivesAt, tz)}` : 'accepted, no arrival time given';
      if (c.lateByMs > 0) sub += ` — ${Math.round(c.lateByMs / 60000)} min after the shift starts`;
    }
    else if (c.state === 'queued' && c.notBefore) sub = `asked to be rung back at ${fmtTime(c.notBefore, tz)}`;
    else if (c.state === 'queued' && c.pass > 1) sub = 'no answer — queued for the second sweep';
    // A no-answer's "transcript" is the voicemail system talking, not the
    // person. Quoting an answering machine back at a supervisor is noise.
    else if (c.state === 'no_answer') sub = 'no answer — a message was left';
    else if (c.state === 'needs_review') {
      sub = 'the answer could not be read — waiting for a person, nobody else is being rung';
    }
    else if (last?.transcript) {
      const said = calleeAnswer(last.transcript);
      sub = said ? `“${said.slice(0, 88)}${said.length > 88 ? '…' : ''}”` : (last.summary ?? '');
    }
    else if (c.state === 'calling') sub = 'ringing…';
    else if (c.phone) sub = c.phone;

    const quote = last?.transcript && !['skipped', 'accepted', 'no_answer', 'needs_review'].includes(c.state) ? ' quote' : '';
    const clickable = last?.transcript ? '1' : '0';

    return `<li data-state="${c.state}" data-id="${c.id}" data-clickable="${clickable}">
      <span class="pos">${c.position + 1}</span>
      <span class="who"><div class="name">${c.name}</div><div class="sub${quote}">${sub}</div></span>
      <span class="tag">${tag}</span>
    </li>`;
  }).join('');

  for (const li of $('roster').children) {
    if (li.dataset.clickable === '1') li.onclick = () => showTranscript(li.dataset.id);
  }
}

function renderOutcome() {
  const s = view.summary;
  const filled = view.outcome === 'filled';
  $('outcome').hidden = false;
  $('outcome-main').className = `outcome-main ${filled ? 'filled' : 'unfilled'}`;
  const late = filled && s.filledBy.lateByMs > 0
    ? ` That is ${Math.round(s.filledBy.lateByMs / 60000)} minutes into the shift — the gap is covered, not closed.`
    : '';
  $('outcome-main').textContent = filled
    ? `Filled by ${s.filledBy.name}, arriving ${fmtTime(s.filledBy.arrivesAt, view.shift.timeZone)}.${late}`
    : ({
      exhausted: 'Nobody on the standby list could take it. The list is exhausted — a human has to decide what happens to the shift.',
      cutoff: 'The shift started before anyone accepted. Dialling stopped.',
      aborted: 'Stopped from the dashboard.',
      needs_review: 'Held — one call could not be read. No further call is placed until a person says what it meant.',
    })[view.outcome] ?? view.outcome;

  $('outcome-stats').innerHTML = `
    <div><b>${s.calls}</b>calls placed</div>
    <div><b>${s.callsAvoided}</b>stood down, never rung</div>
    <div><b>${s.rosterSize}</b>on the standby list</div>
    <div><b>${view.events.length}</b>audit events</div>`;
}

function showTranscript(id) {
  const c = view.candidates.find((x) => x.id === id);
  const last = c?.attempts?.[c.attempts.length - 1];
  if (!last?.transcript) return;
  const goal = view.events.find((e) => e.type === 'call_started' && e.candidateId === id)?.goal;
  $('transcript-panel').hidden = false;
  $('transcript-who').textContent = `— ${c.name}`;
  $('transcript-goal').textContent = goal ?? '';
  const said = calleeAnswer(last.transcript);
  $('transcript-text').innerHTML = said
    ? `<strong class="said">“${said}”</strong><span class="full">${last.transcript}</span>`
    : last.transcript;
  const read = last.result === 'ambiguous'
    ? 'could not be read — held for a person'
    : `read as “${last.result}”`;
  const who = last.reconciledBy ? ` · reconciled by ${last.reconciledBy}` : '';
  $('transcript-src').textContent = last.callRunId
    ? `call run ${last.callRunId} · result ${read}${who}`
    : `result ${read}${who}`;
  $('transcript-panel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

boot();
