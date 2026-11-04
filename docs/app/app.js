import { APP_VERSION, PROTOCOL_VERSION } from './version.js';
import {
  CONTEXTS, LOCATIONS, BEHAVIORS, OUTCOMES, LIMITS,
  buildCapture, buildTombstone, buildReview, buildTrim, buildRestore, isTrimmed,
  latestReview, needsReview, storageState, syncBadge, isRemote,
} from './records.js';
import { selectEvents, buildBundle, bundleFilename, shareFiles, isRecordsOnly, clipFilesFor } from './export.js';
import { trimWav, sha256Hex } from './wav.js';
import openDb from './db.js';
import { Recorder } from './recorder.js';
import { runSync, createApi, pair, deriveCounts, downloadClip } from './sync.js';

// ---------------------------------------------------------------------------
// Pure helpers (imported by tests/harness.html; no DOM access here).
// ---------------------------------------------------------------------------

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const FIELD_KEYS = ['context', 'location', 'observedBehavior', 'outcome', 'note'];
const SECTIONS = [
  { key: 'context', title: 'What was happening?', items: CONTEXTS, hint: 'Choose one. Unsure is fine.' },
  { key: 'location', title: 'Where was Tiri?', items: LOCATIONS, hint: 'Optional · can be left blank' },
  { key: 'observedBehavior', title: 'Observed behavior', items: BEHAVIORS, hint: 'Optional · can be left blank' },
  { key: 'outcome', title: 'Outcome', items: OUTCOMES, hint: 'Optional · can be left blank' },
];

export function formatDuration(ms) {
  const s = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

const labelOf = (list, value) => list.find((o) => o.value === value)?.label ?? value;

export function eventBadge(storedEvent, reviews) {
  if (needsReview(reviews || [])) return 'Needs review';
  return 'Reviewed · ' + labelOf(CONTEXTS, latestReview(reviews).context);
}

// The owner-entered fields of a review doc (or draft), in a stable key order.
export function reviewFields(doc, { withDeleted = false } = {}) {
  const out = {};
  for (const k of FIELD_KEYS) if (doc && doc[k]) out[k] = doc[k];
  if (withDeleted && doc && doc.deleted === true) out.deleted = true;
  return out;
}

// Fields for the revision Undo appends after `saved` (whose predecessor is `previous`).
export function undoFields(previous, saved) {
  if (!previous || saved.revision === 1) return { deleted: true };
  return reviewFields(previous, { withDeleted: true });
}

// One review write (save, undo, delete clip) per event at a time; a second call while one
// is in flight is ignored (returns null) so double taps cannot fork the revision chain.
const reviewOps = new Set();
export async function reviewOp(eventId, fn) {
  if (reviewOps.has(eventId)) return null;
  reviewOps.add(eventId);
  try { return await fn(); } finally { reviewOps.delete(eventId); }
}

// Appends the next revision after `previous` (null for the first) under the per-event guard.
export function appendReview(db, { eventId, previous, fields }) {
  return reviewOp(eventId, async () => {
    const doc = buildReview({ eventId, reviewId: previous?.reviewId ?? uuid(), previous, fields, uuid, now });
    await db.saveReview(doc);
    return doc;
  });
}

// Single export entry point: select → bundle → share/download → only then markExported.
// Deleted events go out as records only (capture, tombstone, reviews; no WAV, no manifest entry).
// In 'new' and 'unreviewed' so do events whose clip already left in an earlier export; 'all'
// always carries the WAV of every event that still has a clip (the backup/recovery path).
// A download cannot be observed, so a 'downloaded' result is marked exported only when
// `confirmDownloaded(n)` resolves true; otherwise it resolves 'unconfirmed' and marks nothing.
// Resolves 'shared' | 'downloaded' | 'unconfirmed'.
export async function runExport(db, mode, { beforeChunk, onCount, confirmDownloaded, download } = {}) {
  const [rows, reviews, tombstones, meta] = await Promise.all([
    db.listEvents({ includeDeleted: true }), db.allReviews(), db.listTombstones(), db.getMeta(),
  ]);
  const deleted = new Set(tombstones.map((t) => t.eventId));
  const included = [];
  const entries = [];
  for (const ev of selectEvents(rows, reviews, mode, tombstones)) {
    if (isRecordsOnly(ev, deleted, mode)) { included.push({ ...ev, recordsOnly: true }); continue; }
    // A trimmed event may contribute two files (original and trimmed WAV); see clipFilesFor.
    const clipFiles = [];
    for (const cf of clipFilesFor(ev, mode)) {
      const blob = await db.getClip(cf.envelope.payload.clipId);
      if (blob) { clipFiles.push(cf); entries.push({ name: cf.filename, data: blob }); }
    }
    if (!clipFiles.length) continue;
    included.push({ ...ev, clipFiles });
  }
  if (!included.length) throw new Error('nothing_to_export');
  onCount?.(entries.length, included.length - entries.length);
  const bundle = buildBundle({ installId: meta.installId, events: included, tombstones, reviewsByEvent: reviews, now, mode });
  entries.unshift({ name: bundleFilename(() => bundle.exportedAt), data: JSON.stringify(bundle, null, 2) });
  const { outcome, downloaded } = await shareFiles(entries, download ? { beforeChunk, download } : { beforeChunk });
  if (outcome === 'downloaded' && !(confirmDownloaded && await confirmDownloaded(downloaded))) return 'unconfirmed';
  await db.markExported(included.map((e) => e.envelope.eventId), bundle.exportedAt);
  return outcome;
}

// ---------------------------------------------------------------------------
// Application state and DOM utilities (only touched from init() onwards).
// ---------------------------------------------------------------------------

const state = {
  db: null, meta: null, route: 'today', filter: 'all', showDeleted: false, update: null,
  rec: null, finishing: false, pendingClip: null, autoStopped: false, cueShown: false,
  lastLevelText: 0, review: null, objectUrl: null, undo: null, undoTimer: null,
  sync: { running: false, last: null, timer: null },
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const fmtBytes = (n) => (n < 1e6 ? `${Math.round(n / 1e3)} KB` : `${(n / 1e6).toFixed(1)} MB`);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const paired = () => !!(state.meta && state.meta.deviceToken && state.meta.syncUrl);
const syncHost = () => { try { return new URL(state.meta.syncUrl).host; } catch { return state.meta.syncUrl; } };
const fmtWhen = (iso) => (iso ? fmtDate(iso) : 'never');
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const screen = (name) => $('#screen-' + name);
const busy = () => !!(state.rec || state.pendingClip || state.starting);
// The Update row also waits for an export or bulk delete holding the action lock.
const updateBlocked = () => busy() || !!state.locked;

let liveTimer = null;
export function announce(msg) {
  const live = $('#live');
  if (!live) return;
  live.textContent = '';
  clearTimeout(liveTimer);
  setTimeout(() => { live.textContent = msg; }, 60);
  liveTimer = setTimeout(() => { live.textContent = ''; }, 7000);
}

// Task 7's service-worker code calls this when a waiting worker exists; `apply` activates it.
export function notifyUpdateReady(apply) {
  state.update = apply;
  if (state.route === 'today' || state.route === 'settings') render();
}

function updateRow() {
  if (!state.update) return '';
  return `<div class="banner"><p><strong>Update ready</strong></p>
    <button data-action="apply-update" ${updateBlocked() ? 'disabled' : ''}>Reload to update</button></div>`;
}

// Sync context for a list render: outbox rows grouped by event, clip rows by clipId.
async function syncContext(rows, reviews) {
  const [outbox, clips] = await Promise.all([
    state.db.listOutbox({ states: ['pending', 'sent', 'failed', 'conflict'] }), state.db.listClipRows(),
  ]);
  const eventOf = new Map();
  for (const r of rows) eventOf.set(r.envelope.messageId, r.envelope.eventId);
  for (const t of await state.db.listTombstones()) eventOf.set(t.messageId, t.eventId);
  for (const [eventId, list] of reviews) for (const d of list) eventOf.set(d.messageId, eventId);
  const byEvent = new Map();
  const annotated = [];
  for (const r of outbox) {
    const eventId = eventOf.get(r.messageId);
    if (!eventId) continue;
    if (!byEvent.has(eventId)) byEvent.set(eventId, []);
    byEvent.get(eventId).push(r);
    annotated.push({ ...r, eventId });
  }
  return { byEvent, clips, outbox: annotated, paired: paired(), installId: state.meta.installId };
}

const SYNC_CLASS = { 'Saved on this phone': 'local', Queued: 'queued', Synced: 'synced', 'Sync failed': 'failed' };

function syncBadgeHtml(row, ctx) {
  if (!ctx) return '';
  const label = syncBadge({ event: row, outboxRows: ctx.byEvent.get(row.envelope.eventId) || [], clip: ctx.clips.get(row.envelope.payload.clipId) || null, paired: ctx.paired, installId: ctx.installId });
  return `<span class="badge ${SYNC_CLASS[label]}">${esc(label)}</span>`;
}

const recordedBy = (envelope) => (isRemote(envelope, state.meta.installId) ? 'Recorded on another device' : 'Recorded by you');

function eventRow(row, reviews, label, ctx) {
  const e = row.envelope;
  const p = e.payload;
  const nr = needsReview(reviews);
  const action = label || (nr ? 'Review' : 'Edit');
  const when = fmtDate(p.recordedAt);
  return `<article class="event">
    <div class="event-main">
      <strong>${esc(when)}</strong>
      <small>${formatDuration(p.durationMs)} · ${recordedBy(e)}</small>
      <span class="badges"><span class="badge ${nr ? 'todo' : 'done'}">${esc(eventBadge(row, reviews))}</span>${syncBadgeHtml(row, ctx)}${isTrimmed(e) ? '<span class="badge gone">Trimmed</span>' : ''}${row.deleted ? '<span class="badge gone">Audio deleted</span>' : ''}</span>
    </div>
    <button class="primary" data-action="go" data-to="#review/${esc(e.eventId)}" aria-label="${action} recording from ${esc(when)}">${action}</button>
  </article>`;
}

function confirmDialog(text, okLabel, { cancelLabel = 'Cancel', danger = true } = {}) {
  const d = $('#confirm');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
  $('#confirm-ok').className = danger ? 'danger' : 'primary';
  d.querySelector('button[value="cancel"]').textContent = cancelLabel;
  d.returnValue = '';
  d.showModal();
  // Resolve on the synchronous submit (the button pressed); `close` only covers Esc.
  return new Promise((resolve) => {
    const form = d.querySelector('form');
    const finish = (ok) => {
      form.removeEventListener('submit', onSubmit);
      d.removeEventListener('close', onClose);
      resolve(ok);
    };
    const onSubmit = (e) => finish(e.submitter?.value === 'ok');
    const onClose = () => finish(false);
    form.addEventListener('submit', onSubmit);
    d.addEventListener('close', onClose);
  });
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

const SCREENS = { today: renderToday, events: renderEvents, review: renderReview, settings: renderSettings };

function parseHash() {
  const [name, id] = (location.hash.slice(1) || 'today').split('/');
  return SCREENS[name] ? { name, id } : { name: 'today', id: undefined };
}

function leaveReview() {
  const t = state.review?.trim;
  if (t) { try { t.audio?.pause(); } catch {} cancelAnimationFrame(t.raf); URL.revokeObjectURL(t.url); }
  if (state.objectUrl) { URL.revokeObjectURL(state.objectUrl); state.objectUrl = null; }
  clearTimeout(state.undoTimer);
  state.undo = null;
  state.review = null;
}

async function route({ focus = true } = {}) {
  onRouteChange();
  leaveReview();
  const { name } = parseHash();
  state.route = name;
  for (const s of document.querySelectorAll('main > section')) s.hidden = s.id !== 'screen-' + name;
  for (const b of document.querySelectorAll('nav [data-tab]')) {
    if (b.dataset.tab === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  await render();
  if (focus) screen(name).querySelector('h1')?.focus();
}

export async function render() {
  const { name, id } = parseHash();
  // A re-render replaces the section content, including any "Share part N" prompt.
  onRouteChange();
  try { await SCREENS[name](id); } catch (e) {
    console.error(e);
    screen(name).innerHTML = '<h1 tabindex="-1">Something went wrong</h1><p>Could not read data on this phone. Reload the app to try again.</p>';
  }
}

// ---------------------------------------------------------------------------
// Today
// ---------------------------------------------------------------------------

async function renderToday() {
  const db = state.db;
  const [rows, reviews, usage] = await Promise.all([db.listEvents(), db.allReviews(), db.usage()]);
  const ctx = await syncContext(rows, reviews);
  const counts = deriveCounts({ events: rows, outbox: ctx.outbox, clips: ctx.clips, installId: ctx.installId, paired: ctx.paired });
  const pending = rows.filter((r) => needsReview(reviews.get(r.envelope.eventId) || []));
  const st = storageState(usage);
  const latest = pending[0];
  screen('today').innerHTML = `
    <header class="hero"><img src="../assets/cat-tiri-avatar.png" alt="" width="64" height="64"><h1 tabindex="-1">Tiri</h1></header>
    ${isStandalone() ? '' : '<p class="banner" role="note">Install to the home screen before recording. Clips recorded here will not appear in the installed app.</p>'}
    ${updateRow()}
    ${st === 'warn' ? `<div class="banner warn"><p>Storage is filling up: ${usage.clips} clips, ${fmtBytes(usage.bytes)}. Export new clips, then delete exported clips.</p>
      <button data-action="go" data-to="#settings">Export and clear</button></div>` : ''}
    <button class="record" data-action="record" ${st === 'blocked' ? 'disabled' : ''}>${st === 'blocked' ? 'Storage full. Export or delete clips to record.' : 'Record'}</button>
    <div class="stat">
      <div class="numbers">
        <div><strong>${pending.length}</strong><small>Needs review</small></div>
        ${ctx.paired ? `<div><strong>${counts.queued}</strong><small>Queued</small></div>
        <div><strong>${counts.synced}</strong><small>Synced</small></div>
        ${counts.failed ? `<div><strong>${counts.failed}</strong><small>Sync failed</small></div>` : ''}`
        : `<div><strong>${rows.length}</strong><small>Saved on this phone</small></div>`}
      </div>
      <p>${ctx.paired ? `Syncing to ${esc(syncHost())}` : 'All recordings stay on this phone'}</p>
    </div>
    ${latest ? `<h2>Latest to review</h2>${eventRow(latest, reviews.get(latest.envelope.eventId) || [], 'Review', ctx)}` : ''}`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const FILTERS = [['all', 'All'], ['needs', 'Needs review'], ['reviewed', 'Reviewed']];

async function renderEvents() {
  const [rows, reviews] = await Promise.all([
    state.db.listEvents({ includeDeleted: state.showDeleted }), state.db.allReviews(),
  ]);
  const ctx = await syncContext(rows, reviews);
  const shown = rows.filter((r) => {
    const nr = needsReview(reviews.get(r.envelope.eventId) || []);
    return state.filter === 'all' || (state.filter === 'needs' ? nr : !nr);
  });
  const chips = FILTERS.map(([v, l]) => {
    const on = state.filter === v;
    return `<button class="chip" role="radio" aria-checked="${on}" tabindex="${on ? 0 : -1}" data-action="filter" data-filter="${v}">${l}</button>`;
  }).join('');
  const empty = rows.length
    ? '<p class="empty">Nothing matches this filter.</p>'
    : '<p class="empty">No recordings yet. Tap Record on Today to save one on this phone.</p>';
  screen('events').innerHTML = `
    <h1 tabindex="-1">Events</h1>
    <div class="chips">
      <div role="radiogroup" aria-label="Filter events" class="chips">${chips}</div>
      <button class="chip" aria-pressed="${state.showDeleted}" data-action="toggle-deleted">Show deleted</button>
    </div>
    ${shown.length ? shown.map((r) => eventRow(r, reviews.get(r.envelope.eventId) || [], undefined, ctx)).join('') : empty}`;
}

// ---------------------------------------------------------------------------
// Review
// ---------------------------------------------------------------------------

async function renderReview(eventId) {
  const db = state.db;
  const el = screen('review');
  const ev = eventId ? await db.getEvent(eventId) : null;
  if (!ev) {
    el.innerHTML = `<h1 tabindex="-1">Recording not found</h1>
      <button data-action="go" data-to="#events">Back to Events</button>`;
    return;
  }
  const [reviews, draft, blob, clipRow, conflicts] = await Promise.all([
    db.listReviews(eventId), db.getDraft(eventId),
    ev.deleted ? null : db.getClip(ev.envelope.payload.clipId),
    ev.deleted ? null : db.getClipRow(ev.envelope.payload.clipId),
    db.listConflicts(eventId),
  ]);
  const latest = latestReview(reviews);
  const fields = draft ? reviewFields(draft) : (latest && !latest.deleted ? reviewFields(latest) : {});
  state.review = { eventId, ev, latest, fields, hasAudio: !!blob, conflicts, trim: null };
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = blob ? URL.createObjectURL(blob) : null;
  const p = ev.envelope.payload;
  const trimmed = isTrimmed(ev.envelope);
  const undoVisible = state.undo && state.undo.eventId === eventId;
  const ctx = await syncContext([ev], new Map([[eventId, reviews]]));
  const pendingAudio = !blob && !ev.deleted && clipRow && clipRow.remoteAvailable;
  const audioHtml = blob ? `<audio controls preload="none" src="${state.objectUrl}" aria-label="Play recording"></audio>`
    : pendingAudio ? `<p class="flag" id="audio-state">${paired() ? 'Downloading audio…' : 'Audio not downloaded yet'}</p>`
    : '<p class="flag">Audio deleted</p>';
  const conflict = conflicts[0];
  el.innerHTML = `
    <button class="back" data-action="go" data-to="#events">← Events</button>
    <h1 tabindex="-1">${recordedBy(ev.envelope)}</h1>
    <p class="meta">${esc(fmtDate(p.recordedAt))} · ${formatDuration(p.durationMs)}${trimmed ? ` · Trimmed from ${formatDuration(p.trim.sourceDurationMs)}` : ''}</p>
    ${p.interrupted ? '<p class="flag">Recording was cut short</p>' : ''}
    ${audioHtml}
    ${blob && !ev.deleted ? `<div class="row trim-actions">
        <button data-action="trim-open" aria-expanded="false" aria-controls="trim-editor">${trimmed ? 'Change trim' : 'Trim clip'}</button>
        ${trimmed ? '<button data-action="trim-restore">Restore original</button>' : ''}
      </div>
      <section class="section trim" id="trim-editor" hidden aria-labelledby="trim-title"></section>` : ''}
    <p><span class="badge ${needsReview(reviews) ? 'todo' : 'done'}" id="review-status">${esc(eventBadge(ev, reviews))}</span> ${syncBadgeHtml(ev, ctx)}</p>
    ${conflict ? `<div class="banner warn" id="conflict-row"><p><strong>Review conflict.</strong> Another device saved a review first. Your choice here (${esc(labelOf(CONTEXTS, conflict.doc.context))}) was not applied.</p>
      <button data-action="resolve-conflict">Save again</button><button data-action="dismiss-conflict">Discard mine</button></div>` : ''}
    ${SECTIONS.map((s) => `
      <fieldset class="section">
        <legend>${s.title}</legend>
        <p class="hint">${s.hint}</p>
        <div class="choices">${s.items.map((o) => `<button data-action="choose" data-key="${s.key}" data-value="${o.value}" aria-pressed="${fields[s.key] === o.value}">${esc(o.label)}</button>`).join('')}</div>
      </fieldset>`).join('')}
    <label class="section note" for="note">Note · optional
      <textarea id="note" maxlength="500" rows="3"></textarea>
      <small id="note-count" aria-live="off"></small>
    </label>
    <div class="actions">
      <div class="banner" id="undo-row" ${undoVisible ? '' : 'hidden'}><p>Saved on this phone</p><button data-action="undo">Undo</button></div>
      <div class="row">
        <button class="primary" data-action="save">Save review</button>
        <button data-action="go" data-to="#events">Later</button>
      </div>
    </div>
    <p class="hint">One context is enough. Details are optional.</p>
    ${ev.deleted || !blob ? '' : '<button class="danger" data-action="delete-clip">Delete clip</button>'}`;
  const note = $('#note', el);
  note.value = fields.note || '';
  const count = () => { $('#note-count', el).textContent = `${note.value.length}/500`; };
  count();
  note.addEventListener('input', () => {
    if (!state.review) return;
    state.review.fields.note = note.value;
    count();
    saveDraft();
  });
  if (pendingAudio && paired()) fetchClipForReview(eventId, clipRow);
}

// On-demand download of a remote clip the owner just opened; re-renders when it lands.
async function fetchClipForReview(eventId, clipRow) {
  const r = state.review;
  const result = await downloadClip(state.db, syncApi(), clipRow).catch(() => 'network');
  if (state.review !== r) return;
  if (result === 'ok') { await renderReview(eventId); return; }
  const el = $('#audio-state');
  if (el) el.textContent = result === 'unauthorized' ? 'Not paired. Audio not downloaded yet' : 'Audio not downloaded yet';
}

// Rebase the refused local revision on the latest synced one and save it as a new revision.
async function resolveConflictAction() {
  const r = state.review;
  const conflict = r && r.conflicts && r.conflicts[0];
  if (!conflict) return;
  const latest = latestReview(await state.db.listReviews(r.eventId));
  let doc;
  try { doc = await appendReview(state.db, { eventId: r.eventId, previous: latest, fields: reviewFields(conflict.doc) }); }
  catch (e) { if (!(await onReviewConflict(e, r.eventId))) announce('Could not save. Try again.'); return; }
  if (!doc) return;
  await state.db.deleteConflict(conflict.messageId);
  await renderReview(r.eventId);
  announce('Saved on this phone');
  scheduleSync('review');
}

async function dismissConflictAction() {
  const r = state.review;
  const conflict = r && r.conflicts && r.conflicts[0];
  if (!conflict) return;
  await state.db.deleteConflict(conflict.messageId);
  await renderReview(r.eventId);
  announce('Discarded');
}

// ---------------------------------------------------------------------------
// Trim editor (start/end cut on the ORIGINAL recording; a save appends a new capture message)
// ---------------------------------------------------------------------------

const TRIM_STEP_MS = 50;
const fmtSec = (ms) => `${(ms / 1000).toFixed(2)} s`;

// Opens the editor under the Play control, loaded with the original WAV and the current cut.
async function openTrim() {
  const r = state.review;
  if (!r || r.trim) { $('#trim-start')?.focus(); return; }
  const original = r.ev.original;
  const blob = await state.db.getClip(original.payload.clipId);
  if (!blob || state.review !== r) { announce('The original recording is not on this phone.'); return; }
  const total = original.payload.durationMs;
  const cur = r.ev.envelope.payload.trim;
  const t = {
    blob, total, start: cur ? cur.startMs : 0, end: cur ? cur.endMs : total,
    url: URL.createObjectURL(blob), audio: null, raf: 0, playing: false,
  };
  r.trim = t;
  const box = $('#trim-editor');
  box.hidden = false;
  box.innerHTML = `
    <h2 id="trim-title">Trim</h2>
    <p class="hint">Cut silence or noise from the start and the end. The original recording stays on this phone and in exports.</p>
    <label for="trim-start">Start <output id="trim-start-out" for="trim-start">${fmtSec(t.start)}</output></label>
    <input type="range" id="trim-start" min="0" max="${total}" step="${TRIM_STEP_MS}" value="${t.start}" aria-valuetext="${fmtSec(t.start)}">
    <label for="trim-end">End <output id="trim-end-out" for="trim-end">${fmtSec(t.end)}</output></label>
    <input type="range" id="trim-end" min="0" max="${total}" step="${TRIM_STEP_MS}" value="${t.end}" aria-valuetext="${fmtSec(t.end)}">
    <p class="meta" id="trim-length"></p>
    <audio id="trim-audio" src="${t.url}" preload="auto" hidden></audio>
    <div class="row">
      <button data-action="trim-play" aria-pressed="false">Play selection</button>
      <button class="primary" data-action="trim-save">Save trim</button>
      <button data-action="trim-cancel">Cancel</button>
    </div>`;
  t.audio = $('#trim-audio', box);
  t.audio.addEventListener('pause', () => setTrimPlaying(false));
  t.audio.addEventListener('ended', () => setTrimPlaying(false));
  $('#trim-start', box).addEventListener('input', (e) => setTrimPoint('start', Number(e.target.value)));
  $('#trim-end', box).addEventListener('input', (e) => setTrimPoint('end', Number(e.target.value)));
  $('[data-action="trim-open"]')?.setAttribute('aria-expanded', 'true');
  updateTrimReadout();
  $('#trim-start', box).focus();
}

// Keeps start < end with at least LIMITS.minMs between them; the other handle gives way.
function setTrimPoint(which, ms) {
  const t = state.review?.trim;
  if (!t) return;
  const min = LIMITS.minMs;
  if (which === 'start') {
    t.start = Math.max(0, Math.min(ms, t.total - min));
    if (t.end - t.start < min) t.end = Math.min(t.total, t.start + min);
  } else {
    t.end = Math.min(t.total, Math.max(ms, min));
    if (t.end - t.start < min) t.start = Math.max(0, t.end - min);
  }
  stopTrimPlayback();
  updateTrimReadout();
}

function updateTrimReadout() {
  const t = state.review?.trim;
  if (!t) return;
  const s = $('#trim-start'); const e = $('#trim-end');
  if (s) { s.value = t.start; s.setAttribute('aria-valuetext', fmtSec(t.start)); $('#trim-start-out').textContent = fmtSec(t.start); }
  if (e) { e.value = t.end; e.setAttribute('aria-valuetext', fmtSec(t.end)); $('#trim-end-out').textContent = fmtSec(t.end); }
  const whole = t.start === 0 && t.end === t.total;
  const len = $('#trim-length');
  if (len) len.textContent = whole ? `Whole clip (${fmtSec(t.total)}). Move a handle to cut.` : `Keeps ${fmtSec(t.end - t.start)} of ${fmtSec(t.total)}`;
  const save = $('[data-action="trim-save"]');
  if (save) save.disabled = whole;
}

function setTrimPlaying(on) {
  const t = state.review?.trim;
  if (!t) return;
  t.playing = on;
  const b = $('[data-action="trim-play"]');
  if (b) { b.textContent = on ? 'Stop' : 'Play selection'; b.setAttribute('aria-pressed', String(on)); }
  if (!on) cancelAnimationFrame(t.raf);
}

function stopTrimPlayback() {
  const t = state.review?.trim;
  if (t?.audio && !t.audio.paused) t.audio.pause();
}

// Plays [start, end) of the original; a frame loop stops at the end point (timeupdate is too coarse).
async function toggleTrimPlay() {
  const t = state.review?.trim;
  if (!t?.audio) return;
  if (t.playing) { stopTrimPlayback(); return; }
  const a = t.audio;
  a.currentTime = t.start / 1000;
  try { await a.play(); } catch { announce('Could not play. Tap again.'); return; }
  setTrimPlaying(true);
  const endSec = t.end / 1000;
  const tick = () => {
    if (!t.playing) return;
    if (a.currentTime >= endSec) { a.pause(); return; }
    t.raf = requestAnimationFrame(tick);
  };
  t.raf = requestAnimationFrame(tick);
}

function closeTrim() {
  const r = state.review;
  const t = r?.trim;
  if (!t) return;
  stopTrimPlayback();
  cancelAnimationFrame(t.raf);
  URL.revokeObjectURL(t.url);
  r.trim = null;
  const box = $('#trim-editor');
  if (box) { box.hidden = true; box.innerHTML = ''; }
  const open = $('[data-action="trim-open"]');
  if (open) { open.setAttribute('aria-expanded', 'false'); open.focus(); }
}

// Cuts the original WAV, hashes it and appends a trim message superseding the current clip.
// The review (fields, draft, revisions) is untouched: trimming is about the audio only.
async function saveTrimAction() {
  const r = state.review;
  const t = r?.trim;
  if (!t) return;
  if (t.start === 0 && t.end === t.total) { announce('Move a handle to cut something first.'); return; }
  stopTrimPlayback();
  $('[data-action="trim-save"]').disabled = true;
  let done = false;
  try {
    done = await reviewOp(r.eventId, async () => {
      const cut = trimWav(new Uint8Array(await t.blob.arrayBuffer()), t.start, t.end);
      const current = r.ev.envelope;
      const envelope = buildTrim({
        installId: state.meta.installId, original: r.ev.original, supersedesMessageId: current.messageId,
        clipId: uuid(), sha256: await sha256Hex(cut.bytes), sizeBytes: cut.bytes.length,
        durationMs: cut.durationMs, clippedSamples: cut.clippedSamples, startMs: t.start, endMs: t.end, uuid, now,
      });
      const removeClipIds = isTrimmed(current) ? [current.payload.clipId] : [];
      await state.db.saveTrim(envelope, new Blob([cut.bytes], { type: 'audio/wav' }), { removeClipIds });
      return true;
    });
  } catch (e) {
    console.error(e);
    announce('Could not save the trim. Try again.');
    const b = $('[data-action="trim-save"]');
    if (b) b.disabled = false;
    return;
  }
  if (!done || state.review !== r) return;
  closeTrim();
  leaveReview();
  await renderReview(r.eventId);
  announce('Trimmed. Saved on this phone');
  scheduleSync('capture');
  $('[data-action="trim-open"]')?.focus();
}

// Appends a restore message so the untrimmed original is the current clip again.
async function restoreTrimAction() {
  const r = state.review;
  if (!r || !isTrimmed(r.ev.envelope)) return;
  const ok = await confirmDialog('Put back the original, untrimmed recording? The trimmed copy is removed from this phone; its record stays.', 'Restore original', { danger: false });
  if (!ok || state.review !== r) return;
  let done = false;
  try {
    done = await reviewOp(r.eventId, async () => {
      const current = r.ev.envelope;
      const envelope = buildRestore({ installId: state.meta.installId, original: r.ev.original, supersedesMessageId: current.messageId, uuid, now });
      await state.db.saveTrim(envelope, null, { removeClipIds: [current.payload.clipId] });
      return true;
    });
  } catch { announce('Could not restore. Try again.'); return; }
  if (!done || state.review !== r) return;
  closeTrim();
  leaveReview();
  await renderReview(r.eventId);
  announce('Original restored. Saved on this phone');
  scheduleSync('capture');
  $('[data-action="trim-open"]')?.focus();
}

function saveDraft() {
  const r = state.review;
  state.db.putDraft(r.eventId, reviewFields(r.fields)).catch(() => announce('Could not save this choice. Try again.'));
}

function choose(btn) {
  const r = state.review;
  const { key, value } = btn.dataset;
  r.fields[key] = r.fields[key] === value ? undefined : value;
  for (const b of btn.parentElement.children) b.setAttribute('aria-pressed', String(b.dataset.value === r.fields[key]));
  saveDraft();
}

function setReviewStatus(reviews) {
  const s = $('#review-status');
  s.textContent = eventBadge(null, reviews);
  s.className = 'badge ' + (needsReview(reviews) ? 'todo' : 'done');
}

async function saveReviewAction() {
  const r = state.review;
  if (!r.fields.context) {
    announce('Choose what was happening first. Unsure is fine.');
    $('[data-key="context"]').focus();
    return;
  }
  const previous = r.latest;
  let doc;
  try { doc = await appendReview(state.db, { eventId: r.eventId, previous, fields: reviewFields(r.fields) }); }
  catch (e) { if (!(await onReviewConflict(e, r.eventId))) announce('Could not save. Try again.'); return; }
  if (!doc || state.review !== r) return; // ignored double tap, or the owner left the screen
  r.latest = doc;
  setReviewStatus([doc]);
  announce('Saved on this phone');
  scheduleSync('review');
  state.undo = { eventId: r.eventId, previous, saved: doc };
  $('#undo-row').hidden = false;
  clearTimeout(state.undoTimer);
  state.undoTimer = setTimeout(() => {
    state.undo = null;
    const row = $('#undo-row');
    if (row) row.hidden = true;
  }, 6000);
}

async function undoAction() {
  const u = state.undo;
  if (!u) return;
  let doc;
  try { doc = await appendReview(state.db, { eventId: u.eventId, previous: u.saved, fields: undoFields(u.previous, u.saved) }); }
  catch (e) {
    clearTimeout(state.undoTimer);
    state.undo = null;
    if (!(await onReviewConflict(e, u.eventId))) announce('Could not undo. Try again.');
    return;
  }
  if (!doc) return;
  clearTimeout(state.undoTimer);
  state.undo = null;
  scheduleSync('review');
  if (!state.review || state.review.eventId !== u.eventId) return;
  await renderReview(u.eventId);
  announce('Undone. Saved on this phone');
  $('[data-action="save"]')?.focus();
}

// Another tab saved a revision first (db.js rejects with 'revision_conflict'): re-render the
// Review screen from the store (the draft is kept) and ask the owner to check and save again.
// Returns true when `e` was a conflict and has been handled.
async function onReviewConflict(e, eventId) {
  if (!e || e.message !== 'revision_conflict') return false;
  if (state.review && state.review.eventId === eventId) {
    leaveReview();
    await renderReview(eventId);
  }
  announce('This review changed elsewhere. Check it and save again.');
  return true;
}

// Every clipId an event has had (original plus trims), so a delete leaves no blob behind.
const clipIdsOf = (ev) => [...new Set((ev.envelopes || [ev.envelope]).map((e) => e.payload.clipId))];

async function deleteClipAction() {
  const r = state.review;
  closeTrim();
  const text = r.latest && !r.latest.deleted
    ? 'Delete the audio of this clip? The audio is removed from this phone and the review is marked deleted, so the recording returns to Needs review. Its record and review history stay on this phone.'
    : 'Delete the audio of this clip? The audio is removed from this phone. Its record and review history stay on this phone.';
  const ok = await confirmDialog(text, 'Delete clip');
  if (!ok || state.review !== r) return;
  const env = r.ev.envelope;
  let done;
  try {
    done = await reviewOp(r.eventId, async () => {
      const tombstone = buildTombstone({
        installId: state.meta.installId, eventId: r.eventId, clipId: env.payload.clipId,
        supersedesMessageId: env.messageId, uuid, now,
      });
      const reviewTombstone = r.latest && !r.latest.deleted
        ? buildReview({ eventId: r.eventId, reviewId: r.latest.reviewId, previous: r.latest, fields: { deleted: true }, uuid, now })
        : null;
      await state.db.deleteClip({ tombstone, reviewTombstone, clipIds: clipIdsOf(r.ev) });
      return true;
    });
  } catch (e) { if (!(await onReviewConflict(e, r.eventId))) announce('Could not delete. Try again.'); return; }
  scheduleSync('delete');
  if (!done || state.review !== r) return;
  leaveReview();
  await renderReview(r.eventId);
  announce('Audio deleted');
  $('#screen-review h1')?.focus();
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

async function persistState(request) {
  if (!navigator.storage?.persist) return 'unavailable';
  let granted = await navigator.storage.persisted?.().catch(() => false);
  if (!granted && request) granted = await navigator.storage.persist().catch(() => false);
  if (granted !== state.meta.persistGranted) {
    state.meta.persistGranted = !!granted;
    await state.db.setMeta({ persistGranted: !!granted });
  }
  return granted ? 'granted' : 'denied';
}

function syncCard(syncState, failedRows, queuedCount) {
  if (!paired()) {
    return `<section class="card" id="sync-card"><h2>Cloud sync</h2>
      <p><span class="badge local">Not paired</span></p>
      <p class="hint">Pair this app with your Siri-Tiri server so clips and reviews reach your other phones. Get a pairing code from the server's pairing script; it works once.</p>
      <label for="sync-url">Server URL</label>
      <input id="sync-url" inputmode="url" autocapitalize="off" autocomplete="off" spellcheck="false" placeholder="https://…" value="${esc(state.meta.syncUrl || '')}">
      <label for="sync-code">Pairing code</label>
      <input id="sync-code" autocapitalize="characters" autocomplete="one-time-code" spellcheck="false" maxlength="12">
      <button class="primary" data-action="pair">Pair</button>
      <p class="hint" id="sync-msg" role="status"></p>
    </section>`;
  }
  const failed = failedRows.map((r) => `<li>${r.kind === 'review' ? 'Review' : 'Recording'} · ${esc(r.lastError || r.state)}</li>`).join('');
  return `<section class="card" id="sync-card"><h2>Cloud sync</h2>
    <p><span class="badge synced">Paired</span> as ${esc(state.meta.deviceLabel || 'this device')} with ${esc(syncHost())}</p>
    <dl>
      <div><dt>Last sync</dt><dd>${esc(fmtWhen(syncState.lastSyncAt))}</dd></div>
      <div><dt>Queued</dt><dd>${queuedCount}</dd></div>
      ${syncState.lastError ? `<div><dt>Last problem</dt><dd>${esc(syncErrorText(syncState.lastError))}</dd></div>` : ''}
    </dl>
    ${failed ? `<p><strong>Sync failed</strong> for ${failedRows.length} ${failedRows.length === 1 ? 'item' : 'items'}:</p><ul class="failed-list">${failed}</ul>
      <button data-action="retry-failed">Retry failed</button>` : ''}
    <div class="sync-row">
      <button class="primary" data-action="sync-now" ${state.sync.running ? 'disabled' : ''}>${state.sync.running ? 'Syncing…' : 'Sync now'}</button>
      <button data-action="unpair">Unpair</button>
    </div>
    <p class="hint" id="sync-msg" role="status"></p>
  </section>`;
}

const syncErrorText = (e) => ({ network: 'Could not reach the server', unauthorized: 'This device is no longer paired', apply_failed: 'Could not store synced data on this phone' }[e] || e);

async function renderSettings() {
  const usage = await state.db.usage();
  const st = storageState(usage);
  const persist = await persistState(true);
  const persistText = { unavailable: 'Not available on this browser', granted: 'Granted', denied: 'Not granted' }[persist];
  const [syncState, failedRows, queuedRows] = await Promise.all([
    state.db.getSyncState(), state.db.listOutbox({ states: ['failed', 'conflict'] }), state.db.listOutbox({ states: ['pending', 'sent'] }),
  ]);
  const el = screen('settings');
  el.innerHTML = `
    <h1 tabindex="-1">Settings</h1>
    ${updateRow()}
    ${syncCard(syncState, failedRows, queuedRows.length)}
    <section class="card"><h2>About</h2><dl>
      <div><dt>App version</dt><dd>${APP_VERSION}</dd></div>
      <div><dt>Protocol version</dt><dd>${PROTOCOL_VERSION}</dd></div>
    </dl></section>
    <section class="card"><h2>Storage</h2><dl>
      <div><dt>Clips</dt><dd>${usage.clips}</dd></div>
      <div><dt>Storage used</dt><dd>${fmtBytes(usage.bytes)}</dd></div>
      <div><dt>Persistent storage</dt><dd>${persistText}</dd></div>
    </dl>
    ${persist === 'denied' ? '<button data-action="persist">Keep my data</button>' : ''}
    ${st === 'warn' ? '<p class="banner warn">Storage is filling up. Export new clips, then delete exported clips.</p>' : ''}
    ${st === 'blocked' ? '<p class="banner warn">Storage full. Export or delete clips to record.</p>' : ''}
    </section>
    <section class="card"><h2>Export</h2>
      <p class="hint">Opens the share sheet, or downloads the files. Export new also includes reviews changed since the last export. Export all always includes audio; Export new and Export unreviewed carry records only for clips that already left the phone. Deleted clips are always records only.</p>
      <div class="stack">
        <button class="primary" data-action="export" data-mode="new">Export new</button>
        <button data-action="export" data-mode="unreviewed">Export unreviewed</button>
        <button data-action="export" data-mode="all">Export all</button>
      </div>
      <div id="export-next"></div>
    </section>
    <section class="card"><h2>Delete</h2>
      <button data-action="delete-exported">Delete exported clips</button>
      <p class="hint">Removes the audio of clips already exported. Their records and reviews stay on this phone.</p>
      <label for="confirm-delete">Type DELETE to delete everything on this phone</label>
      <input id="confirm-delete" autocomplete="off" autocapitalize="characters" spellcheck="false">
      <button class="danger" data-action="delete-all" disabled>Delete everything</button>
    </section>
    ${isStandalone() ? '' : `<section class="card"><h2>Install</h2><p class="hint">In Safari tap Share, then Add to Home Screen.
      The installed app keeps its own storage. In a Safari tab, iOS may remove clips after seven days without use; the installed app is not affected. Export regularly either way.</p></section>`}`;
  const input = $('#confirm-delete', el);
  input.addEventListener('input', () => { $('[data-action="delete-all"]', el).disabled = input.value !== 'DELETE'; });
}

// ---------------------------------------------------------------------------
// Cloud sync wiring
// ---------------------------------------------------------------------------

function syncApi() {
  return createApi({ baseUrl: state.meta.syncUrl, token: state.meta.deviceToken });
}

function syncMessage(text) {
  const el = $('#sync-msg');
  if (el) el.textContent = text;
}

// Runs a sync now (serialized inside sync.js) and refreshes the visible screen afterwards.
export async function syncNow({ announceResult = false } = {}) {
  if (!paired()) return { outcome: 'unpaired' };
  state.sync.running = true;
  if (state.route === 'settings') $('[data-action="sync-now"]')?.setAttribute('disabled', '');
  let result;
  try {
    result = await runSync(state.db, syncApi(), { canDownload: () => !busy() });
  } finally {
    state.sync.running = false;
    state.sync.last = result || null;
  }
  if (result.outcome === 'unauthorized') {
    state.meta = await state.db.getMeta();
    announce('This device is no longer paired. Pair again in Settings.');
  } else if (announceResult) {
    const text = {
      ok: `Synced. ${result.pushed} sent, ${result.pulled} received, ${result.uploaded} uploaded, ${result.downloaded} downloaded${result.failed ? `, ${result.failed} failed` : ''}.`,
      offline: 'Could not reach the server. Will retry later.',
      error: 'Sync stopped on an error. Will retry later.',
      busy: 'Sync is already running.',
    }[result.outcome] || 'Sync finished.';
    announce(text);
  }
  if (result.outcome !== 'busy') await render();
  return result;
}

// Debounced trigger after a save, on launch, resume and reconnect.
export function scheduleSync(reason, delayMs = 2000) {
  if (!paired()) return;
  clearTimeout(state.sync.timer);
  state.sync.timer = setTimeout(() => { syncNow().catch((e) => console.error('sync', reason, e)); }, delayMs);
}

async function pairAction() {
  const url = ($('#sync-url')?.value || '').trim();
  const code = ($('#sync-code')?.value || '').trim();
  if (!/^https?:\/\//.test(url)) { syncMessage('Enter the server URL, starting with https://'); $('#sync-url')?.focus(); return; }
  if (!code) { syncMessage('Enter the pairing code.'); $('#sync-code')?.focus(); return; }
  syncMessage('Pairing…');
  const label = `${isStandalone() ? 'Installed app' : 'Browser tab'} · ${navigator.platform || 'phone'}`;
  const res = await pair({ baseUrl: url, code, sourceId: state.meta.installId, version: APP_VERSION, label });
  if (!res.ok) {
    syncMessage({ rejected: 'That code was not accepted. Codes work once and expire after 15 minutes.', network: 'Could not reach that server.', protocol: 'That server speaks a different protocol version.' }[res.reason]);
    return;
  }
  await state.db.setMeta({ syncUrl: url.replace(/\/+$/, ''), deviceToken: res.token, deviceId: res.deviceId, deviceLabel: label });
  state.meta = await state.db.getMeta();
  announce('Paired. Syncing…');
  await render();
  await syncNow({ announceResult: true });
}

async function unpairAction() {
  const ok = await confirmDialog('Unpair this device? Recordings stay on this phone and stop syncing until you pair again.', 'Unpair');
  if (!ok) return;
  await state.db.setMeta({ deviceToken: null, deviceId: null, deviceLabel: null });
  state.meta = await state.db.getMeta();
  announce('Unpaired');
  await render();
}

// Failed and conflict rows go back to pending, except a clip the Worker refused for good.
async function retryFailedAction() {
  const rows = await state.db.listOutbox({ states: ['failed', 'conflict'] });
  let n = 0;
  for (const r of rows) {
    if (r.lastError === 'clip_mismatch' || r.lastError === 'revision_conflict') continue;
    await state.db.updateOutbox(r.messageId, { state: 'pending', attempts: 0, nextAttemptAt: 0, lastError: null });
    n++;
  }
  announce(n ? `Retrying ${n} ${n === 1 ? 'item' : 'items'}.` : 'Nothing can be retried automatically. Open the recording for details.');
  if (n) await syncNow({ announceResult: true }); else await render();
}

let pendingTap = null;

// Rejects a pending "Share part N of M" wait; called on every route change.
export function onRouteChange() {
  if (pendingTap) pendingTap(new Error('cancelled'));
}

export const isLocked = () => !!state.locked;

// Shown before every chunk, the first included, so each share()/download runs in a fresh tap.
export function waitForTap(i, total, mode = 'share') {
  const box = $('#export-next');
  return new Promise((resolve, rej) => {
    const reject = (e) => { pendingTap = null; if (box) box.innerHTML = ''; rej(e); };
    if (!box) { reject(new Error('cancelled')); return; }
    pendingTap = reject;
    const verb = mode === 'download' ? 'Download' : 'Share';
    box.innerHTML = `<div class="banner"><p>${total > 1 ? `Ready to ${verb.toLowerCase()} part ${i + 1} of ${total}.` : 'Export is ready.'}</p>
      <button class="primary" id="share-next">${total > 1 ? `${verb} part ${i + 1} of ${total}` : `${verb} export`}</button>
      <button id="share-cancel">Cancel</button></div>`;
    $('#share-next').focus();
    $('#share-next').addEventListener('click', () => { pendingTap = null; box.innerHTML = ''; resolve(); }, { once: true });
    $('#share-cancel').addEventListener('click', () => reject(new Error('cancelled')), { once: true });
  });
}

const confirmDownloaded = (n) =>
  confirmDialog(`Did all ${n} ${n === 1 ? 'file' : 'files'} download?`, 'Yes', { cancelLabel: 'No', danger: false });

// The UI export path, under the action lock.
// Resolves 'shared' | 'downloaded' | 'unconfirmed' | 'failed' | 'busy'. `opts` (tests) may
// override runExport options such as `download` or `confirmDownloaded`.
export async function startExport(db, mode, opts = {}) {
  let outcome = 'busy';
  await exclusive(async () => {
    document.querySelectorAll('[data-action="export"]').forEach((b) => { b.disabled = true; });
    let clips = 0;
    let records = 0;
    try {
      outcome = await runExport(db, mode, {
        beforeChunk: waitForTap, confirmDownloaded, ...opts, onCount: (c, r) => { clips = c; records = r; },
      });
      const extra = records ? `, ${records} as records only` : '';
      const what = `${clips} ${clips === 1 ? 'clip' : 'clips'}${extra}`;
      if (outcome === 'unconfirmed') announce(`Downloaded ${what}. Not marked as exported; export again once the files are saved.`);
      else announce(`${outcome === 'shared' ? 'Shared' : 'Downloaded'} ${what}. Marked as exported.`);
    } catch (e) {
      outcome = 'failed';
      announce(e.message === 'nothing_to_export' ? 'Nothing to export.' : 'Export did not finish. Nothing was marked as exported.');
    }
  });
  return outcome;
}

async function deleteExportedAction() {
  const rows = await state.db.listEvents();
  const targets = [];
  for (const r of rows) if (r.exportedAt && await state.db.getClip(r.envelope.payload.clipId)) targets.push(r);
  if (!targets.length) { announce('No exported clips to delete.'); return; }
  const n = targets.length;
  const ok = await confirmDialog(`Delete the audio of ${n} exported ${n === 1 ? 'clip' : 'clips'}? Records and reviews stay on this phone.`, 'Delete exported clips');
  if (!ok) return;
  try {
    for (const r of targets) {
      const env = r.envelope;
      await state.db.deleteClip({ tombstone: buildTombstone({
        installId: state.meta.installId, eventId: env.eventId, clipId: env.payload.clipId,
        supersedesMessageId: env.messageId, uuid, now,
      }), clipIds: clipIdsOf(r) });
    }
    announce(`Deleted the audio of ${n} exported ${n === 1 ? 'clip' : 'clips'}.`);
    scheduleSync('delete');
  } catch { announce('Could not delete every clip. Try again.'); }
  await render();
}

async function deleteAllAction() {
  if ($('#confirm-delete').value !== 'DELETE') return;
  try { await state.db.clearAll(); announce('Everything was deleted from this phone.'); } catch { announce('Could not delete. Try again.'); }
  await render();
}

// ---------------------------------------------------------------------------
// Recording sheet
// ---------------------------------------------------------------------------

const SHEET_VIEWS = {
  starting: () => `<h2 id="rec-title">Starting microphone…</h2>
    <div class="stack"><button data-action="cancel-start">Cancel</button></div>`,
  recording: () => `<h2 id="rec-title">Recording</h2>
    <p class="elapsed" id="elapsed">0:00</p>
    ${reduceMotion() ? '<p class="level-text" id="level-text">Level: silent</p>'
      : '<meter id="level" min="0" max="1" low="0.6" high="0.9" optimum="0.3" value="0" aria-label="Input level"></meter>'}
    <button class="stop" data-action="stop">Stop</button>`,
  saving: () => '<h2 id="rec-title">Saving…</h2>',
  'save-error': () => `<h2 id="rec-title">Could not save. Try again.</h2>
    <div class="stack"><button class="primary" data-action="save-retry">Retry</button><button data-action="discard">Discard</button></div>`,
  permission: () => `<h2 id="rec-title">Microphone access is needed to record</h2>
    <p>Allow microphone access for this site in your browser settings, then try again.</p>
    <div class="stack"><button class="primary" data-action="record">Retry</button><button data-action="close-sheet">Close</button></div>`,
  'start-error': () => `<h2 id="rec-title">Could not start recording</h2>
    <p>Check that a microphone is available, then try again.</p>
    <div class="stack"><button class="primary" data-action="record">Retry</button><button data-action="close-sheet">Close</button></div>`,
};

function sheetView(name, status = '') {
  $('#rec-body').innerHTML = SHEET_VIEWS[name]();
  $('#rec-status').textContent = status;
  ($('#rec-body button') || $('#rec-body h2'))?.focus();
}

function closeSheet() {
  const d = $('#rec-sheet');
  if (d.open) d.close();
}

function showLevel(level) {
  const meter = $('#level');
  if (meter) { meter.value = level; return; }
  const t = performance.now();
  const text = $('#level-text');
  if (!text || t - state.lastLevelText < 250) return;
  state.lastLevelText = t;
  const db = level > 0 ? Math.max(-60, Math.round(20 * Math.log10(level))) : -60;
  text.textContent = db <= -60 ? 'Level: silent' : `Level: ${db} dB`;
}

function showTick(ms) {
  const el = $('#elapsed');
  if (el) el.textContent = formatDuration(ms);
  if (ms >= LIMITS.softCueMs && !state.cueShown) {
    state.cueShown = true;
    $('#rec-status').textContent = '20 s — wrap up soon';
  }
}

const START_SLOW_MS = 10000;

// The tap handler. The AudioContext is created (and resumed) synchronously here, inside the
// user's tap, because iOS only lets audio start from a gesture; nothing above it awaits.
function startRecording() {
  if (busy()) return;
  let ctx = null;
  try {
    ctx = Recorder.createContext();
    ctx.resume?.().catch(() => {});
  } catch { /* Recorder.start reports the failure */ }
  const attempt = { ctx, stream: null, cancelled: false, slowTimer: null };
  state.starting = attempt;
  return beginRecording(attempt).finally(() => {
    clearTimeout(attempt.slowTimer);
    if (state.starting === attempt) state.starting = null;
  });
}

// Releases whatever a start attempt holds (tracks, AudioContext). Safe to call twice.
function releaseAttempt(attempt) {
  try { attempt.stream?.getTracks().forEach((t) => t.stop()); } catch {}
  try { if (attempt.ctx && attempt.ctx.state !== 'closed') attempt.ctx.close().catch(() => {}); } catch {}
}

// Cancel on the 'starting' view: the pending start is abandoned and cleans up when it returns.
function cancelStart() {
  const attempt = state.starting;
  if (!attempt) return;
  attempt.cancelled = true;
  clearTimeout(attempt.slowTimer);
  releaseAttempt(attempt);
  state.starting = null;
  closeSheet();
  announce('Recording cancelled');
}

async function beginRecording(attempt) {
  const sheet = $('#rec-sheet');
  if (!sheet.open) sheet.showModal();
  sheetView('starting');
  attempt.slowTimer = setTimeout(() => {
    if (attempt.cancelled || state.starting !== attempt) return;
    $('#rec-status').textContent = 'The microphone is taking a while. Cancel and try again.';
    $('[data-action="cancel-start"]')?.focus();
  }, START_SLOW_MS);
  let stream;
  try { stream = await Recorder.requestPermission(); } catch (e) {
    releaseAttempt(attempt);
    if (attempt.cancelled) return;
    sheetView(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'permission' : 'start-error');
    return;
  }
  attempt.stream = stream;
  if (attempt.cancelled) { releaseAttempt(attempt); return; }
  state.autoStopped = false;
  state.cueShown = false;
  const rec = new Recorder({
    onLevel: showLevel,
    onTick: showTick,
    onAutoStop: () => {
      state.autoStopped = true;
      $('#rec-status').textContent = 'Stopped at 30 s';
      finishRecording(false);
    },
  });
  state.recordedAt = now();
  try { await rec.start(stream, attempt.ctx || undefined); } catch {
    releaseAttempt(attempt);
    if (!attempt.cancelled) sheetView('start-error');
    return;
  }
  if (attempt.cancelled) { await rec.teardown(); return; }
  // Set only once started, so a hide during start-up is handled here or by the Recorder itself.
  state.rec = rec;
  clearTimeout(attempt.slowTimer);
  if (document.hidden) { await finishRecording(true); return; }
  sheetView('recording');
}

async function finishRecording(interrupted) {
  const rec = state.rec;
  if (!rec || state.finishing) return;
  state.finishing = true;
  let clip;
  try { clip = await rec.stop({ interrupted }); } catch (e) {
    state.rec = null;
    state.finishing = false;
    closeSheet();
    if (location.hash !== '#today' && location.hash !== '') location.hash = '#today'; else await render();
    announce(e && e.message === 'too_short' ? 'Too short to save' : 'Could not save. Try again.');
    return;
  }
  state.rec = null;
  state.finishing = false;
  const envelope = buildCapture({
    installId: state.meta.installId, clipId: uuid(), sampleRate: clip.sampleRate,
    durationMs: Math.round(clip.durationMs), sizeBytes: clip.sizeBytes, sha256: clip.sha256,
    clippedSamples: clip.clippedSamples, recordedAt: state.recordedAt, interrupted: clip.interrupted, uuid, now,
  });
  state.pendingClip = { clip, envelope };
  await saveClip();
}

async function saveClip() {
  const pending = state.pendingClip;
  if (!pending) return;
  sheetView('saving', state.autoStopped ? 'Stopped at 30 s' : '');
  try { await state.db.saveCapture(pending.envelope, pending.clip.blob); } catch {
    sheetView('save-error', 'Could not save. Try again.');
    return;
  }
  state.pendingClip = null;
  closeSheet();
  location.hash = '#review/' + pending.envelope.eventId;
  announce((state.autoStopped ? 'Stopped at 30 s. ' : '') + 'Saved on this phone');
  scheduleSync('capture');
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const ACTIONS = {
  go: (b) => { location.hash = b.dataset.to; },
  record: startRecording,
  'cancel-start': cancelStart,
  stop: () => finishRecording(false),
  'save-retry': saveClip,
  discard: () => { state.pendingClip = null; closeSheet(); announce('Recording discarded'); render(); },
  'close-sheet': closeSheet,
  choose,
  save: saveReviewAction,
  undo: undoAction,
  'delete-clip': deleteClipAction,
  'trim-open': openTrim,
  'trim-play': toggleTrimPlay,
  'trim-save': saveTrimAction,
  'trim-cancel': closeTrim,
  'trim-restore': restoreTrimAction,
  filter: (b) => { state.filter = b.dataset.filter; render().then(() => $(`[data-filter="${state.filter}"]`)?.focus()); },
  'toggle-deleted': () => { state.showDeleted = !state.showDeleted; render().then(() => $('[data-action="toggle-deleted"]')?.focus()); },
  persist: async () => {
    const res = await persistState(true);
    announce(res === 'granted' ? 'This browser will keep your data.' : 'The browser did not grant persistent storage.');
    await render();
  },
  export: async (b) => { await startExport(state.db, b.dataset.mode); if (state.route === 'settings') await render(); },
  'delete-exported': () => exclusive(deleteExportedAction),
  'delete-all': () => exclusive(deleteAllAction),
  'apply-update': () => { if (!updateBlocked() && state.update) state.update(); },
  pair: () => exclusive(pairAction),
  'sync-now': () => syncNow({ announceResult: true }),
  unpair: () => exclusive(unpairAction),
  'retry-failed': () => exclusive(retryFailedAction),
  'resolve-conflict': resolveConflictAction,
  'dismiss-conflict': dismissConflictAction,
};

// Export and bulk deletes must not interleave (e.g. Delete everything mid-way through a loop).
async function exclusive(fn) {
  if (state.locked) { announce('Please wait for the current action to finish.'); return; }
  state.locked = true;
  try { await fn(); } finally { state.locked = false; }
}

function onKeydown(e) {
  const radio = e.target.closest?.('[role="radio"]');
  if (!radio || !['ArrowRight', 'ArrowLeft', 'ArrowDown', 'ArrowUp'].includes(e.key)) return;
  e.preventDefault();
  const all = [...radio.parentElement.querySelectorAll('[role="radio"]')];
  const step = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : -1;
  ACTIONS.filter(all[(all.indexOf(radio) + step + all.length) % all.length]);
}

export async function init() {
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-action]');
    if (b && !b.disabled && ACTIONS[b.dataset.action]) ACTIONS[b.dataset.action](b);
  });
  document.addEventListener('keydown', onKeydown);
  // Registered before any Recorder, so it runs first and marks the clip interrupted.
  document.addEventListener('visibilitychange', () => { if (document.hidden && state.rec) finishRecording(true); });
  $('#rec-sheet').addEventListener('cancel', (e) => { if (busy()) e.preventDefault(); });
  window.addEventListener('beforeunload', (e) => { if (busy()) e.preventDefault(); });
  window.addEventListener('hashchange', () => route());
  try {
    state.db = await openDb();
    state.meta = await state.db.getMeta();
    await state.db.setMeta({ appVersionAtLastRun: APP_VERSION });
  } catch (e) {
    console.error(e);
    screen('today').hidden = false;
    screen('today').innerHTML = '<h1 tabindex="-1">Storage unavailable</h1><p>This browser cannot store recordings here. Private browsing can cause this.</p>';
    return;
  }
  persistState(!state.meta.persistGranted).catch(() => {});
  await route({ focus: false });
  registerWorker();
  // Sync on launch, on return to the foreground and on reconnect. Never in the background.
  scheduleSync('launch', 500);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) scheduleSync('resume', 1000); });
  window.addEventListener('online', () => scheduleSync('online', 1000));
}

// After the first render, so a registration failure never blocks the app.
function registerWorker() {
  if (!('serviceWorker' in navigator)) return;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (reloading || !state.applying) return;
    reloading = true;
    location.reload();
  });
  const offer = (worker) => notifyUpdateReady(() => {
    state.applying = true;
    worker.postMessage({ type: 'SKIP_WAITING' });
  });
  navigator.serviceWorker.register('./sw.js', { scope: './' }).then((reg) => {
    if (reg.waiting && navigator.serviceWorker.controller) offer(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const w = reg.installing;
      if (!w) return;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed' && navigator.serviceWorker.controller) offer(w);
      });
    });
  }).catch((e) => console.error('service worker registration failed', e));
}
