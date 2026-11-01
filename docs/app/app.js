import { APP_VERSION, PROTOCOL_VERSION } from './version.js';
import {
  CONTEXTS, LOCATIONS, BEHAVIORS, OUTCOMES, LIMITS,
  buildCapture, buildTombstone, buildReview, latestReview, needsReview, storageState,
} from './records.js';
import { selectEvents, buildBundle, bundleFilename, shareFiles } from './export.js';
import openDb from './db.js';
import { Recorder } from './recorder.js';

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
export async function runExport(db, mode, { beforeChunk, onCount } = {}) {
  const [rows, reviews, tombstones, meta] = await Promise.all([
    db.listEvents({ includeDeleted: true }), db.allReviews(), db.listTombstones(), db.getMeta(),
  ]);
  const deleted = new Set(tombstones.map((t) => t.eventId));
  const included = [];
  const entries = [];
  for (const ev of selectEvents(rows, reviews, mode, tombstones)) {
    if (ev.deleted || deleted.has(ev.envelope.eventId)) { included.push(ev); continue; }
    const blob = await db.getClip(ev.envelope.payload.clipId);
    if (!blob) continue;
    included.push(ev);
    entries.push({ name: `${ev.envelope.eventId}.wav`, data: blob });
  }
  if (!included.length) throw new Error('nothing_to_export');
  onCount?.(entries.length, included.length - entries.length);
  const bundle = buildBundle({ installId: meta.installId, events: included, tombstones, reviewsByEvent: reviews, now });
  entries.unshift({ name: bundleFilename(() => bundle.exportedAt), data: JSON.stringify(bundle, null, 2) });
  const result = await shareFiles(entries, { beforeChunk });
  await db.markExported(included.map((e) => e.envelope.eventId), bundle.exportedAt);
  return result;
}

// ---------------------------------------------------------------------------
// Application state and DOM utilities (only touched from init() onwards).
// ---------------------------------------------------------------------------

const state = {
  db: null, meta: null, route: 'today', filter: 'all', showDeleted: false, update: null,
  rec: null, finishing: false, pendingClip: null, autoStopped: false, cueShown: false,
  lastLevelText: 0, review: null, objectUrl: null, undo: null, undoTimer: null,
};

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = (iso) => new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(iso));
const fmtBytes = (n) => (n < 1e6 ? `${Math.round(n / 1e3)} KB` : `${(n / 1e6).toFixed(1)} MB`);
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const reduceMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;
const screen = (name) => $('#screen-' + name);
const busy = () => !!(state.rec || state.pendingClip || state.starting);

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
    <button data-action="apply-update" ${busy() ? 'disabled' : ''}>Reload to update</button></div>`;
}

function eventRow(row, reviews, label) {
  const e = row.envelope;
  const p = e.payload;
  const nr = needsReview(reviews);
  const action = label || (nr ? 'Review' : 'Edit');
  const when = fmtDate(p.recordedAt);
  return `<article class="event">
    <div class="event-main">
      <strong>${esc(when)}</strong>
      <small>${formatDuration(p.durationMs)} · Recorded by you</small>
      <span class="badges"><span class="badge ${nr ? 'todo' : 'done'}">${esc(eventBadge(row, reviews))}</span>${row.deleted ? '<span class="badge gone">Audio deleted</span>' : ''}</span>
    </div>
    <button class="primary" data-action="go" data-to="#review/${esc(e.eventId)}" aria-label="${action} recording from ${esc(when)}">${action}</button>
  </article>`;
}

function confirmDialog(text, okLabel) {
  const d = $('#confirm');
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = okLabel;
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
        <div><strong>${rows.length}</strong><small>Saved on this phone</small></div>
      </div>
      <p>All recordings stay on this phone</p>
    </div>
    ${latest ? `<h2>Latest to review</h2>${eventRow(latest, reviews.get(latest.envelope.eventId) || [], 'Review')}` : ''}`;
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const FILTERS = [['all', 'All'], ['needs', 'Needs review'], ['reviewed', 'Reviewed']];

async function renderEvents() {
  const [rows, reviews] = await Promise.all([
    state.db.listEvents({ includeDeleted: state.showDeleted }), state.db.allReviews(),
  ]);
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
    ${shown.length ? shown.map((r) => eventRow(r, reviews.get(r.envelope.eventId) || [])).join('') : empty}`;
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
  const [reviews, draft, blob] = await Promise.all([
    db.listReviews(eventId), db.getDraft(eventId),
    ev.deleted ? null : db.getClip(ev.envelope.payload.clipId),
  ]);
  const latest = latestReview(reviews);
  const fields = draft ? reviewFields(draft) : (latest && !latest.deleted ? reviewFields(latest) : {});
  state.review = { eventId, ev, latest, fields, hasAudio: !!blob };
  if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
  state.objectUrl = blob ? URL.createObjectURL(blob) : null;
  const p = ev.envelope.payload;
  const undoVisible = state.undo && state.undo.eventId === eventId;
  el.innerHTML = `
    <button class="back" data-action="go" data-to="#events">← Events</button>
    <h1 tabindex="-1">Recorded by you</h1>
    <p class="meta">${esc(fmtDate(p.recordedAt))} · ${formatDuration(p.durationMs)}</p>
    ${p.interrupted ? '<p class="flag">Recording was cut short</p>' : ''}
    ${blob ? `<audio controls preload="none" src="${state.objectUrl}" aria-label="Play recording"></audio>`
      : '<p class="flag">Audio deleted</p>'}
    <p><span class="badge ${needsReview(reviews) ? 'todo' : 'done'}" id="review-status">${esc(eventBadge(ev, reviews))}</span></p>
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
  catch { announce('Could not save. Try again.'); return; }
  if (!doc || state.review !== r) return; // ignored double tap, or the owner left the screen
  r.latest = doc;
  setReviewStatus([doc]);
  announce('Saved on this phone');
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
  catch { announce('Could not undo. Try again.'); return; }
  if (!doc) return;
  clearTimeout(state.undoTimer);
  state.undo = null;
  if (!state.review || state.review.eventId !== u.eventId) return;
  await renderReview(u.eventId);
  announce('Undone. Saved on this phone');
  $('[data-action="save"]')?.focus();
}

async function deleteClipAction() {
  const r = state.review;
  const ok = await confirmDialog('Delete the audio of this clip? Its record and review history stay on this phone.', 'Delete clip');
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
      await state.db.deleteClip({ tombstone, reviewTombstone });
      return true;
    });
  } catch { announce('Could not delete. Try again.'); return; }
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

async function renderSettings() {
  const usage = await state.db.usage();
  const st = storageState(usage);
  const persist = await persistState(true);
  const persistText = { unavailable: 'Not available on this browser', granted: 'Granted', denied: 'Not granted' }[persist];
  const el = screen('settings');
  el.innerHTML = `
    <h1 tabindex="-1">Settings</h1>
    ${updateRow()}
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
      <p class="hint">Opens the share sheet, or downloads the files. Nothing is uploaded. Deleted clips are exported as records only.</p>
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

let pendingTap = null;

// Rejects a pending "Share part N of M" wait; called on every route change.
export function onRouteChange() {
  if (pendingTap) pendingTap(new Error('cancelled'));
}

export const isLocked = () => !!state.locked;

export function waitForTap(i, total) {
  const box = $('#export-next');
  return new Promise((resolve, rej) => {
    const reject = (e) => { pendingTap = null; if (box) box.innerHTML = ''; rej(e); };
    if (!box) { reject(new Error('cancelled')); return; }
    pendingTap = reject;
    box.innerHTML = `<div class="banner"><p>Ready to share part ${i + 1} of ${total}.</p>
      <button class="primary" id="share-next">${total > 1 ? `Share part ${i + 1} of ${total}` : 'Share export'}</button>
      <button id="share-cancel">Cancel</button></div>`;
    $('#share-next').focus();
    $('#share-next').addEventListener('click', () => { pendingTap = null; box.innerHTML = ''; resolve(); }, { once: true });
    $('#share-cancel').addEventListener('click', () => reject(new Error('cancelled')), { once: true });
  });
}

// The UI export path, under the action lock. Resolves 'shared' | 'downloaded' | 'failed' | 'busy'.
export async function startExport(db, mode) {
  let outcome = 'busy';
  await exclusive(async () => {
    document.querySelectorAll('[data-action="export"]').forEach((b) => { b.disabled = true; });
    let clips = 0;
    let records = 0;
    try {
      outcome = await runExport(db, mode, { beforeChunk: waitForTap, onCount: (c, r) => { clips = c; records = r; } });
      const extra = records ? `, ${records} deleted as records only` : '';
      announce(`${outcome === 'shared' ? 'Shared' : 'Downloaded'} ${clips} ${clips === 1 ? 'clip' : 'clips'}${extra}. Marked as exported.`);
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
      }) });
    }
    announce(`Deleted the audio of ${n} exported ${n === 1 ? 'clip' : 'clips'}.`);
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
  starting: () => '<h2 id="rec-title">Starting microphone…</h2>',
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

async function startRecording() {
  if (busy()) return;
  state.starting = true;
  try { await beginRecording(); } finally { state.starting = false; }
}

async function beginRecording() {
  const sheet = $('#rec-sheet');
  if (!sheet.open) sheet.showModal();
  sheetView('starting');
  let stream;
  try { stream = await Recorder.requestPermission(); } catch (e) {
    sheetView(e && (e.name === 'NotAllowedError' || e.name === 'SecurityError') ? 'permission' : 'start-error');
    return;
  }
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
  try { await rec.start(stream); } catch {
    try { stream.getTracks().forEach((t) => t.stop()); } catch {}
    sheetView('start-error');
    return;
  }
  // Set only once started, so a hide during start-up is handled by the Recorder itself.
  state.rec = rec;
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
}

// ---------------------------------------------------------------------------
// Wiring
// ---------------------------------------------------------------------------

const ACTIONS = {
  go: (b) => { location.hash = b.dataset.to; },
  record: startRecording,
  stop: () => finishRecording(false),
  'save-retry': saveClip,
  discard: () => { state.pendingClip = null; closeSheet(); announce('Recording discarded'); render(); },
  'close-sheet': closeSheet,
  choose,
  save: saveReviewAction,
  undo: undoAction,
  'delete-clip': deleteClipAction,
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
  'apply-update': () => { if (!busy() && state.update) state.update(); },
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
