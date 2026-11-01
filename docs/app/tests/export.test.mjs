import { test } from 'node:test';
import assert from 'node:assert/strict';
import { selectEvents, buildBundle, bundleFilename, chunkClips, shareFiles } from '../export.js';
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
const review = (eventId, previous) =>
  buildReview({ eventId, reviewId: 'r-' + eventId, previous, fields: { context: 'food' }, uuid, now });

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

test('all includes everything non-deleted; tombstoned never selected', () => {
  const a = row('x'), b = row(), c = row();
  const t = buildTombstone({ installId: 'inst', eventId: c.envelope.eventId, clipId: 'k', supersedesMessageId: c.envelope.messageId, uuid, now });
  const out = selectEvents([a, b, c], new Map(), 'all', [t]);
  assert.deepEqual(out, [a, b]);
  assert.equal(selectEvents([a, b, c], new Map(), 'new', [t]).includes(c), false);
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
  const tA = buildTombstone({ installId: 'inst', eventId: a.envelope.eventId, clipId: 'k', supersedesMessageId: a.envelope.messageId, uuid, now });
  const r1 = review(b.envelope.eventId);
  const r2 = review(b.envelope.eventId, r1);
  const rv = new Map([[b.envelope.eventId, [r2, r1]], ['zzz', [review('zzz')]]]);
  const bundle = buildBundle({ installId: 'inst', events: [a, b], tombstones: [tA, other], reviewsByEvent: rv, now });
  assert.equal(bundle.exportVersion, 1);
  assert.equal(bundle.appVersion, APP_VERSION);
  assert.equal(bundle.protocolVersion, PROTOCOL_VERSION);
  assert.equal(bundle.installId, 'inst');
  assert.equal(bundle.exportedAt, now());
  assert.deepEqual(bundle.events, [a.envelope, b.envelope, tA]);
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
