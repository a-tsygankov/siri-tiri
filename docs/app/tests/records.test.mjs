import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkSchema } from '../schema-check.js';
import {
  CONTEXTS, LOCATIONS, BEHAVIORS, OUTCOMES, LIMITS,
  buildCapture, buildTombstone, buildReview, latestReview, needsReview, storageState,
} from '../records.js';

const load = (p) => JSON.parse(fs.readFileSync(new URL(p, import.meta.url), 'utf8'));
const eventSchema = load('../../../contracts/event.v1.schema.json');
const reviewSchema = load('../../../contracts/review-v1.schema.json');

const now = () => '2026-11-01T12:00:00.000Z';
const seqUuid = () => { let n = 0; return () => `0000000${++n}-0000-4000-8000-000000000000`; };
const captureArgs = (uuid) => ({ installId: 'pwa-abc', clipId: 'c1', sampleRate: 48000, durationMs: 1200, sizeBytes: 115244, sha256: 'ab'.repeat(32), clippedSamples: 0, recordedAt: now(), interrupted: false, uuid, now });

test('buildCapture conforms to event.v1 and separates messageId from eventId', () => {
  const env = buildCapture(captureArgs(seqUuid()));
  assert.deepEqual(checkSchema(env, eventSchema), []);
  assert.notEqual(env.messageId, env.eventId);
  assert.equal(env.type, 'capture'); assert.equal(env.sourceId, 'pwa-abc');
  assert.equal(env.schemaVersion, 1);
  assert.equal(env.createdAt, now());
  assert.equal(env.payload.captureVersion, 'pwa-pcm16-native-v1');
  assert.equal(env.payload.encoding, 'pcm16-wav'); assert.equal(env.payload.channels, 1);
  assert.equal(env.payload.sourceKind, 'pwa-manual');
  assert.equal(env.payload.clipId, 'c1');
  assert.equal(env.payload.sampleRate, 48000);
  assert.equal(env.payload.durationMs, 1200);
  assert.equal(env.payload.sizeBytes, 115244);
  assert.equal(env.payload.sha256, 'ab'.repeat(32));
  assert.equal(env.payload.interrupted, false);
});

test('buildTombstone reuses eventId with a new messageId', () => {
  const uuid = seqUuid();
  const cap = buildCapture(captureArgs(uuid));
  const t = buildTombstone({ installId: 'pwa-abc', eventId: cap.eventId, clipId: 'c1', supersedesMessageId: cap.messageId, uuid, now });
  assert.deepEqual(checkSchema(t, eventSchema), []);
  assert.equal(t.eventId, cap.eventId);
  assert.notEqual(t.messageId, cap.messageId);
  assert.notEqual(t.messageId, t.eventId);
  assert.equal(t.type, 'capture');
  assert.equal(t.sourceId, 'pwa-abc');
  assert.deepEqual(t.payload, { deleted: true, clipId: 'c1', supersedesMessageId: cap.messageId });
});

test('buildReview first revision', () => {
  const uuid = seqUuid();
  const eventId = uuid();
  const reviewId = uuid();
  const r = buildReview({ eventId, reviewId, previous: null, fields: { context: 'food' }, uuid, now });
  assert.deepEqual(checkSchema(r, reviewSchema), []);
  assert.equal(r.revision, 1); assert.equal(r.baseRevision, null);
  assert.equal(r.reviewId, reviewId); assert.equal(r.eventId, eventId);
  assert.equal(r.source, 'pwa'); assert.equal(r.schemaVersion, 1);
  assert.equal(r.editedAt, now()); assert.equal(r.context, 'food');
  assert.notEqual(r.messageId, r.reviewId);
});

test('buildReview next revision keeps reviewId, new messageId, baseRevision = previous.revision', () => {
  const uuid = seqUuid();
  const eventId = uuid(); const reviewId = uuid();
  const r1 = buildReview({ eventId, reviewId, previous: null, fields: { context: 'food', location: 'kitchen', note: 'hi' }, uuid, now });
  const frozen = JSON.stringify(r1);
  const r2 = buildReview({ eventId, reviewId, previous: r1, fields: { context: 'play', outcome: 'played' }, uuid, now });
  assert.deepEqual(checkSchema(r2, reviewSchema), []);
  assert.equal(r2.reviewId, reviewId);
  assert.notEqual(r2.messageId, r1.messageId);
  assert.equal(r2.revision, 2); assert.equal(r2.baseRevision, 1);
  assert.equal(r2.context, 'play'); assert.equal(r2.outcome, 'played');
  assert.equal('location' in r2, false);
  assert.equal(JSON.stringify(r1), frozen, 'previous not mutated');
});

test('buildReview omits optional fields that are empty', () => {
  const uuid = seqUuid();
  const r = buildReview({ eventId: uuid(), reviewId: uuid(), previous: null, fields: { context: 'unsure', note: '' }, uuid, now });
  for (const k of ['location', 'observedBehavior', 'outcome', 'note', 'deleted']) assert.equal(k in r, false, k);
  assert.deepEqual(checkSchema(r, reviewSchema), []);
  const full = buildReview({ eventId: uuid(), reviewId: uuid(), previous: null, fields: { context: 'play', location: 'hallway', observedBehavior: 'hiding', outcome: 'no-action', note: 'x' }, uuid, now });
  assert.equal(full.location, 'hallway'); assert.equal(full.observedBehavior, 'hiding');
  assert.equal(full.outcome, 'no-action'); assert.equal(full.note, 'x');
  assert.deepEqual(checkSchema(full, reviewSchema), []);
});

test('buildReview deleted keeps previous context and sets deleted', () => {
  const uuid = seqUuid();
  const eventId = uuid(); const reviewId = uuid();
  const r1 = buildReview({ eventId, reviewId, previous: null, fields: { context: 'door' }, uuid, now });
  const r2 = buildReview({ eventId, reviewId, previous: r1, fields: { deleted: true }, uuid, now });
  assert.equal(r2.deleted, true); assert.equal(r2.context, 'door');
  assert.deepEqual(checkSchema(r2, reviewSchema), []);
});

test('buildReview note longer than 500 chars throws', () => {
  const uuid = seqUuid();
  assert.throws(() => buildReview({ eventId: uuid(), reviewId: uuid(), previous: null, fields: { context: 'food', note: 'x'.repeat(501) }, uuid, now }));
  assert.doesNotThrow(() => buildReview({ eventId: uuid(), reviewId: uuid(), previous: null, fields: { context: 'food', note: 'x'.repeat(500) }, uuid, now }));
});

test('latestReview picks highest revision; needsReview true when none or latest deleted', () => {
  const uuid = seqUuid();
  const eventId = uuid(); const reviewId = uuid();
  const r1 = buildReview({ eventId, reviewId, previous: null, fields: { context: 'food' }, uuid, now });
  const r2 = buildReview({ eventId, reviewId, previous: r1, fields: { context: 'play' }, uuid, now });
  const r3 = buildReview({ eventId, reviewId, previous: r2, fields: { deleted: true }, uuid, now });
  assert.equal(latestReview([r2, r1]).revision, 2);
  assert.equal(latestReview([r1, r3, r2]).revision, 3);
  assert.equal(latestReview([]), null);
  assert.equal(needsReview([]), true);
  assert.equal(needsReview([r1, r2]), false);
  assert.equal(needsReview([r1, r2, r3]), true);
});

test('storageState thresholds', () => {
  assert.equal(storageState({ clips: 99, bytes: 0 }), 'ok');
  assert.equal(storageState({ clips: 100, bytes: 0 }), 'warn');
  assert.equal(storageState({ clips: 0, bytes: 300e6 }), 'warn');
  assert.equal(storageState({ clips: 200, bytes: 0 }), 'blocked');
  assert.equal(storageState({ clips: 0, bytes: 600e6 }), 'blocked');
  assert.equal(storageState({ clips: 200, bytes: 300e6 }), 'blocked');
});

test('LIMITS values', () => {
  assert.deepEqual(LIMITS, { softCueMs: 20000, maxMs: 30000, minMs: 300, warnClips: 100, warnBytes: 300e6, blockClips: 200, blockBytes: 600e6, exportChunk: 20 });
});

test('every CONTEXTS/LOCATIONS/BEHAVIORS/OUTCOMES value is in the review schema enum, with v5 labels', () => {
  const p = reviewSchema.properties;
  const pairs = [[CONTEXTS, p.context], [LOCATIONS, p.location], [BEHAVIORS, p.observedBehavior], [OUTCOMES, p.outcome]];
  for (const [list, prop] of pairs) {
    assert.ok(list.length > 0);
    for (const { value, label } of list) {
      assert.ok(prop.enum.includes(value), value);
      assert.equal(typeof label, 'string');
    }
  }
  assert.deepEqual(LOCATIONS.find((x) => x.value === 'living-room'), { value: 'living-room', label: 'Living room' });
  assert.deepEqual(BEHAVIORS.find((x) => x.value === 'looking-at-owner'), { value: 'looking-at-owner', label: 'Looking at me' });
  assert.deepEqual(OUTCOMES.find((x) => x.value === 'door-opened'), { value: 'door-opened', label: 'Opened door' });
  assert.deepEqual(CONTEXTS.map((x) => x.label), ['Food', 'Attention', 'Play', 'Door', 'Greeting', 'Resting', 'Handling', 'Other', 'Unsure']);
});
