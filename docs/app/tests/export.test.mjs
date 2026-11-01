import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEvents, buildBundle, bundleFilename, chunkClips, shareFiles, isRecordsOnly } from '../export.js';
import { buildCapture, buildTombstone, buildReview } from '../records.js';
import { APP_VERSION, PROTOCOL_VERSION } from '../version.js';

let n = 0;
const uuid = () => `id-${++n}`;
const now = () => '2026-11-01T12:00:00.000Z';

function row(exportedAt = null) {
  const envelope = buildCapture({
    installId: 'inst', clipId: uuid(), sampleRate: 16000, durationMs: 1000, sizeBytes: 32044,
    sha256: 'abc', clippedSamples: 0, recordedAt: now(), interrupted: false, uuid, now,
  });
  return { envelope, exportedAt };
}
const review = (eventId, previous, at = now) =>
  buildReview({ eventId, reviewId: 'r-' + eventId, previous, fields: { context: 'food' }, uuid, now: at });
const at = (iso) => () => iso;

test('new excludes exported', () => {
  const a = row(), b = row('2026-10-31T00:00:00Z');
  const out = selectEvents([a, b], new Map(), 'new');
  assert.deepEqual(out, [a]);
});

test('unreviewed uses needsReview', () => {
  const a = row(), b = row(), c = row();
  const rv = new Map([[b.envelope.eventId, [review(b.envelope.eventId)]]]);
  const del = review(c.envelope.eventId);
  del.deleted = true;
  rv.set(c.envelope.eventId, [del]);
  const out = selectEvents([a, b, c], rv, 'unreviewed');
  assert.deepEqual(out, [a, c]);
});

test('tombstoned events stay candidates (records only): all, unreviewed via needsReview, new when not exported', () => {
  const a = row('x'), b = row(), c = row(), d = row('y');
  const tC = buildTombstone({ installId: 'inst', eventId: c.envelope.eventId, clipId: 'k', supersedesMessageId: c.envelope.messageId, uuid, now });
  const tD = buildTombstone({ installId: 'inst', eventId: d.envelope.eventId, clipId: 'k2', supersedesMessageId: d.envelope.messageId, uuid, now });
  const ts = [tC, tD];
  assert.deepEqual(selectEvents([a, b, c, d], new Map(), 'all', ts), [a, b, c, d]);
  assert.deepEqual(selectEvents([a, b, c, d], new Map(), 'new', ts), [b, c]);
  const rv = new Map([[c.envelope.eventId, [review(c.envelope.eventId)]]]);
  assert.deepEqual(selectEvents([a, b, c, d], rv, 'unreviewed', ts), [a, b, d]);
});

test('buildBundle: deleted event exported as records only (capture + tombstone + reviews, no manifest entry)', () => {
  const a = row(), c = row();
  const tC = buildTombstone({ installId: 'inst', eventId: c.envelope.eventId, clipId: c.envelope.payload.clipId, supersedesMessageId: c.envelope.messageId, uuid, now });
  const r1 = review(c.envelope.eventId);
  const r2 = buildReview({ eventId: c.envelope.eventId, reviewId: r1.reviewId, previous: r1, fields: { deleted: true }, uuid, now });
  const r3 = buildReview({ eventId: c.envelope.eventId, reviewId: r1.reviewId, previous: r2, fields: { context: 'door' }, uuid, now });
  const rv = new Map([[c.envelope.eventId, [r1, r2, r3]]]);
  const bundle = buildBundle({ installId: 'inst', events: [a, { ...c, deleted: true }], tombstones: [tC], reviewsByEvent: rv, now });
  assert.deepEqual(bundle.events, [a.envelope, c.envelope, tC]);
  assert.deepEqual(bundle.reviews.map((r) => r.revision), [1, 2, 3]);
  assert.deepEqual(bundle.clips.map((m) => m.eventId), [a.envelope.eventId]);
  // Deleted status is also recognised from the tombstone alone (row without a deleted flag).
  const viaTomb = buildBundle({ installId: 'inst', events: [a, c], tombstones: [tC], reviewsByEvent: rv, now });
  assert.deepEqual(viaTomb.clips.map((m) => m.eventId), [a.envelope.eventId]);
});

test('new also selects exported events with a review or tombstone after the export', () => {
  const exp = '2026-11-01T10:00:00.000Z';
  const quiet = row(exp), edited = row(exp), oldEdit = row(exp), tomb = row(exp), oldTomb = row(exp);
  const r0 = review(oldEdit.envelope.eventId, null, at('2026-11-01T09:00:00.000Z'));
  const r1 = review(edited.envelope.eventId, null, at('2026-11-01T09:00:00.000Z'));
  const r2 = review(edited.envelope.eventId, r1, at('2026-11-01T11:00:00.000Z'));
  const rv = new Map([[oldEdit.envelope.eventId, [r0]], [edited.envelope.eventId, [r1, r2]]]);
  const tLate = buildTombstone({ installId: 'inst', eventId: tomb.envelope.eventId, clipId: 'k', supersedesMessageId: tomb.envelope.messageId, uuid, now: at('2026-11-01T10:00:01.000Z') });
  const tEarly = buildTombstone({ installId: 'inst', eventId: oldTomb.envelope.eventId, clipId: 'k', supersedesMessageId: oldTomb.envelope.messageId, uuid, now: at('2026-11-01T09:59:59.000Z') });
  const out = selectEvents([quiet, edited, oldEdit, tomb, oldTomb], rv, 'new', [tLate, tEarly]);
  assert.deepEqual(out, [edited, tomb]);
  // A review saved at exactly the export instant was in that export.
  const same = row(exp);
  const rSame = review(same.envelope.eventId, null, at(exp));
  assert.deepEqual(selectEvents([same], new Map([[same.envelope.eventId, [rSame]]]), 'new'), []);
});

test('isRecordsOnly: deleted, tombstoned or already exported rows carry no audio', () => {
  const fresh = row(), exported = row('2026-11-01T10:00:00.000Z'), del = row(), viaTomb = row();
  assert.equal(isRecordsOnly(fresh), false);
  assert.equal(isRecordsOnly(exported), true);
  assert.equal(isRecordsOnly({ ...del, deleted: true }), true);
  assert.equal(isRecordsOnly(viaTomb, new Set([viaTomb.envelope.eventId])), true);
  assert.equal(isRecordsOnly({ ...fresh, recordsOnly: true }), true);
});

test('buildBundle: re-exported event goes out records only (envelope + reviews, no manifest entry)', () => {
  const fresh = row(), again = row('2026-11-01T10:00:00.000Z');
  const r1 = review(again.envelope.eventId, null, at('2026-11-01T09:00:00.000Z'));
  const r2 = review(again.envelope.eventId, r1, at('2026-11-01T11:00:00.000Z'));
  const rv = new Map([[again.envelope.eventId, [r1, r2]]]);
  const bundle = buildBundle({ installId: 'inst', events: [fresh, again], tombstones: [], reviewsByEvent: rv, now });
  assert.deepEqual(bundle.events, [fresh.envelope, again.envelope]);
  assert.deepEqual(bundle.reviews.map((r) => r.revision), [1, 2]);
  assert.deepEqual(bundle.clips.map((m) => m.eventId), [fresh.envelope.eventId]);
});

test("mode-aware records-only: 'all' re-exports the WAV of an already-exported live event; 'new' does not", () => {
  const exp = '2026-11-01T10:00:00.000Z';
  const live = row(exp), fresh = row(), gone = row(exp);
  const tG = buildTombstone({ installId: 'inst', eventId: gone.envelope.eventId, clipId: 'k', supersedesMessageId: gone.envelope.messageId, uuid, now: at('2026-11-01T09:00:00.000Z') });
  const r1 = review(live.envelope.eventId, null, at('2026-11-01T11:00:00.000Z'));
  const rv = new Map([[live.envelope.eventId, [r1]]]);
  assert.equal(isRecordsOnly(live, new Set(), 'all'), false);
  assert.equal(isRecordsOnly(live, new Set(), 'new'), true);
  assert.equal(isRecordsOnly(live, new Set(), 'unreviewed'), true);
  assert.equal(isRecordsOnly(gone, new Set([gone.envelope.eventId]), 'all'), true);
  assert.equal(isRecordsOnly({ ...gone, deleted: true }, new Set(), 'all'), true);
  const all = buildBundle({ installId: 'inst', events: [live, fresh, gone], tombstones: [tG], reviewsByEvent: rv, now, mode: 'all' });
  assert.deepEqual(all.clips.map((m) => m.eventId), [live.envelope.eventId, fresh.envelope.eventId]);
  const sel = selectEvents([live, fresh, gone], rv, 'new', [tG]);
  assert.deepEqual(sel, [live, fresh]);
  const nw = buildBundle({ installId: 'inst', events: sel, tombstones: [tG], reviewsByEvent: rv, now, mode: 'new' });
  assert.deepEqual(nw.clips.map((m) => m.eventId), [fresh.envelope.eventId]);
  assert.ok(nw.events.includes(live.envelope) && nw.reviews.includes(r1), 'new carries records of the exported event');
});

test('selectEvents does not mutate input', () => {
  const rows = [row(), row('x')];
  const copy = JSON.stringify(rows);
  selectEvents(rows, new Map(), 'all');
  assert.equal(JSON.stringify(rows), copy);
});

test('buildBundle shape, manifest, reviews, tombstones', () => {
  const a = row(), b = row();
  const other = buildTombstone({ installId: 'inst', eventId: 'zzz', clipId: 'k', supersedesMessageId: 'm', uuid, now });
  const r1 = review(b.envelope.eventId);
  const r2 = review(b.envelope.eventId, r1);
  const rv = new Map([[b.envelope.eventId, [r2, r1]], ['zzz', [review('zzz')]]]);
  const bundle = buildBundle({ installId: 'inst', events: [a, b], tombstones: [other], reviewsByEvent: rv, now });
  assert.equal(bundle.exportVersion, 1);
  assert.equal(bundle.appVersion, APP_VERSION);
  assert.equal(bundle.protocolVersion, PROTOCOL_VERSION);
  assert.equal(bundle.installId, 'inst');
  assert.equal(bundle.exportedAt, now());
  assert.deepEqual(bundle.events, [a.envelope, b.envelope]);
  assert.deepEqual(bundle.reviews.map((r) => r.revision), [1, 2]);
  assert.equal(bundle.clips.length, 2);
  assert.deepEqual(bundle.clips[0], {
    clipId: a.envelope.payload.clipId, eventId: a.envelope.eventId,
    filename: a.envelope.eventId + '.wav', sha256: 'abc', sizeBytes: 32044, sampleRate: 16000, durationMs: 1000,
  });
});

test('chunkClips 45 -> 20/20/5', () => {
  const items = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(chunkClips(items).map((c) => c.length), [20, 20, 5]);
  assert.deepEqual(chunkClips([], 3), []);
});

test('bundleFilename', () => {
  assert.equal(bundleFilename(() => '2026-11-01T12:34:56.000Z'), 'siri-tiri-export-20261101T123456Z.json');
});

test('shareFiles rejects with no files', async () => {
  await assert.rejects(shareFiles([]), /no_files/);
});

// --- shareFiles with an injected navigator and download function ---
const entries = (wavCount) => [
  { name: 'siri-tiri-export-x.json', data: '{}' },
  ...Array.from({ length: wavCount }, (_, i) => ({ name: `e${i}.wav`, data: new Uint8Array(4) })),
];
function fakeNav({ canShare = () => true, share = async () => {} } = {}) {
  const log = [];
  return { log, nav: { canShare: (d) => canShare(d), share: async (d) => { log.push(['share', d.files.map((f) => f.name)]); return share(d); } } };
}

test('shareFiles awaits beforeChunk before the first share and before every later chunk', async () => {
  const { log, nav } = fakeNav();
  const res = await shareFiles(entries(25), { nav, beforeChunk: async (i, total, mode) => { log.push(['tap', i, total, mode]); } });
  assert.deepEqual(res, { outcome: 'shared', downloaded: 0 });
  assert.deepEqual(log.map((l) => l[0] + (l[0] === 'tap' ? l[1] : l[1].length)), ['tap0', 'share21', 'tap1', 'share5']);
  assert.deepEqual(log[0], ['tap', 0, 2, 'share']);
  assert.equal(log[1][1][0], 'siri-tiri-export-x.json');
});

test('shareFiles: a rejected first tap means nothing is shared', async () => {
  const { log, nav } = fakeNav();
  await assert.rejects(shareFiles(entries(1), { nav, beforeChunk: async () => { throw new Error('cancelled'); } }), /cancelled/);
  assert.equal(log.length, 0);
});

test('shareFiles retries a NotAllowedError share after another tap; other errors propagate', async () => {
  let n = 0;
  const notAllowed = Object.assign(new Error('activation'), { name: 'NotAllowedError' });
  const { log, nav } = fakeNav({ share: async () => { if (++n === 1) throw notAllowed; } });
  let taps = 0;
  const res = await shareFiles(entries(1), { nav, beforeChunk: async () => { taps++; } });
  assert.equal(res.outcome, 'shared');
  assert.equal(taps, 2);
  assert.equal(log.length, 2);
  const always = fakeNav({ share: async () => { throw notAllowed; } });
  await assert.rejects(shareFiles(entries(1), { nav: always.nav }), (e) => e.name === 'NotAllowedError');
  assert.equal(always.log.length, 3);
  const abort = fakeNav({ share: async () => { throw Object.assign(new Error('x'), { name: 'AbortError' }); } });
  await assert.rejects(shareFiles(entries(1), { nav: abort.nav }), (e) => e.name === 'AbortError');
  assert.equal(abort.log.length, 1);
});

test('shareFiles retries canShare with the bundle as text/plain .json.txt', async () => {
  const { log, nav } = fakeNav({ canShare: ({ files }) => !files.some((f) => f.type === 'application/json') });
  const seen = [];
  const res = await shareFiles(entries(2), { nav, download: (f) => seen.push(f.name) });
  assert.equal(res.outcome, 'shared');
  assert.deepEqual(seen, []);
  assert.deepEqual(log[0][1], ['siri-tiri-export-x.json.txt', 'e0.wav', 'e1.wav']);
});

test('shareFiles falls back to downloads and reports how many files were downloaded', async () => {
  const { log, nav } = fakeNav({ canShare: () => false });
  const seen = [];
  const modes = [];
  const res = await shareFiles(entries(21), { nav, download: (f) => seen.push(f.name), beforeChunk: async (i, t, m) => { modes.push(m); } });
  assert.deepEqual(res, { outcome: 'downloaded', downloaded: 22 });
  assert.equal(seen[0], 'siri-tiri-export-x.json');
  assert.equal(seen.length, 22);
  assert.deepEqual(modes, ['download', 'download']);
  assert.equal(log.length, 0);
});

import { buildTrim } from '../records.js';
import { clipFilesFor } from '../export.js';

const trimOf = (a) => buildTrim({
  installId: 'inst', original: a.envelope, supersedesMessageId: a.envelope.messageId,
  clipId: 'trimmed', sha256: 'def', sizeBytes: 16044, durationMs: 500, clippedSamples: 0, startMs: 100, endMs: 600, uuid, now,
});

test('buildBundle carries every capture message of a trimmed event and a manifest entry per clip file', () => {
  const a = row();
  const t = trimOf(a);
  const ev = {
    envelope: t, original: a.envelope, envelopes: [a.envelope, t], exportedAt: null,
    clipFiles: [{ envelope: a.envelope, filename: `${a.envelope.eventId}.wav` }, { envelope: t, filename: `${a.envelope.eventId}.trimmed.wav` }],
  };
  const bundle = buildBundle({ installId: 'inst', events: [ev], tombstones: [], reviewsByEvent: new Map(), now, mode: 'all' });
  assert.deepEqual(bundle.events, [a.envelope, t]);
  assert.deepEqual(bundle.clips, [
    { clipId: a.envelope.payload.clipId, eventId: a.envelope.eventId, filename: `${a.envelope.eventId}.wav`, sha256: 'abc', sizeBytes: 32044, sampleRate: 16000, durationMs: 1000 },
    { clipId: 'trimmed', eventId: a.envelope.eventId, filename: `${a.envelope.eventId}.trimmed.wav`, sha256: 'def', sizeBytes: 16044, sampleRate: 16000, durationMs: 500 },
  ]);
  // Records only: no manifest entries, all messages still present.
  const ro = buildBundle({ installId: 'inst', events: [{ ...ev, recordsOnly: true }], tombstones: [], reviewsByEvent: new Map(), now, mode: 'all' });
  assert.deepEqual(ro.events, [a.envelope, t]);
  assert.deepEqual(ro.clips, []);
});

test('clipFilesFor: the current clip always; the original too only when unexported or in all mode', () => {
  const a = row('2026-10-31T00:00:00Z');
  const t = trimOf(a);
  const id = a.envelope.eventId;
  const exportedOriginal = { envelope: t, original: a.envelope, exportedAt: null, originalExportedAt: '2026-10-31T00:00:00Z' };
  assert.deepEqual(clipFilesFor(exportedOriginal, 'new').map((c) => c.filename), [`${id}.trimmed.wav`]);
  assert.deepEqual(clipFilesFor(exportedOriginal, 'all').map((c) => c.filename), [`${id}.wav`, `${id}.trimmed.wav`]);
  const fresh = { envelope: t, original: a.envelope, exportedAt: null, originalExportedAt: null };
  assert.deepEqual(clipFilesFor(fresh, 'new').map((c) => c.filename), [`${id}.wav`, `${id}.trimmed.wav`]);
  const untrimmed = { envelope: a.envelope, original: a.envelope, exportedAt: null, originalExportedAt: null };
  assert.deepEqual(clipFilesFor(untrimmed, 'new').map((c) => c.filename), [`${id}.wav`]);
  assert.deepEqual(clipFilesFor({ envelope: a.envelope, exportedAt: null }, 'new').map((c) => c.filename), [`${id}.wav`]);
});

test('selectEvents new picks a trimmed event whose current message is unexported', () => {
  const a = row('2026-10-31T00:00:00Z');
  const t = trimOf(a);
  const trimmedRow = { envelope: t, original: a.envelope, exportedAt: null, originalExportedAt: '2026-10-31T00:00:00Z' };
  assert.deepEqual(selectEvents([trimmedRow], new Map(), 'new'), [trimmedRow]);
});
