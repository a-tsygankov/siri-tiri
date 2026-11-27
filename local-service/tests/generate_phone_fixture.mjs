// Synthetic interoperability fixture built with the shipping PWA functions.
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { buildCapture, buildTrim, buildReview } from '../../docs/app/records.js';
import { buildBundle } from '../../docs/app/export.js';
import { encodeWav, trimWav, sha256Hex } from '../../docs/app/wav.js';

const out = resolve(process.argv[2]);
await mkdir(out, { recursive: true });
const installId = randomUUID();
const now = () => '2026-11-26T12:00:00.000Z';
const events = [];
const reviewsByEvent = new Map();
for (const rate of [44100, 48000]) {
  const pcm = Int16Array.from({ length: rate }, (_, i) => Math.round(10000 * Math.sin(2 * Math.PI * 440 * i / rate)));
  const bytes = encodeWav(pcm, rate);
  const original = buildCapture({ installId, clipId: randomUUID(), sampleRate: rate, durationMs: 1000,
    sizeBytes: bytes.length, sha256: await sha256Hex(bytes), clippedSamples: 0,
    recordedAt: now(), interrupted: false, uuid: randomUUID, now });
  const cut = trimWav(bytes, 200, 800);
  const current = buildTrim({ installId, original, supersedesMessageId: original.messageId,
    clipId: randomUUID(), sha256: await sha256Hex(cut.bytes), sizeBytes: cut.bytes.length,
    durationMs: cut.durationMs, clippedSamples: cut.clippedSamples, startMs: 200, endMs: 800, uuid: randomUUID, now });
  events.push({ envelope: current, original, envelopes: [original, current] });
  reviewsByEvent.set(current.eventId, [buildReview({ eventId: current.eventId, reviewId: randomUUID(),
    fields: { context: 'unsure', note: 'Synthetic tone, not a Tiri recording' }, uuid: randomUUID, now })]);
  await writeFile(join(out, `${current.eventId}.wav`), bytes);
  await writeFile(join(out, `${current.eventId}.trimmed.wav`), cut.bytes);
}
const doc = buildBundle({ installId, events, reviewsByEvent, now, mode: 'all' });
await writeFile(join(out, 'bundle.json'), JSON.stringify(doc));
console.log(join(out, 'bundle.json'));
