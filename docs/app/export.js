import { APP_VERSION, PROTOCOL_VERSION } from './version.js';
import { needsReview, LIMITS } from './records.js';

export function selectEvents(rows, reviewsByEvent, mode, tombstones = []) {
  const deleted = new Set(tombstones.map((t) => t.eventId));
  return rows.filter((row) => {
    const id = row.envelope.eventId;
    if (deleted.has(id)) return false;
    if (mode === 'new') return !row.exportedAt;
    if (mode === 'unreviewed') return needsReview(reviewsByEvent.get(id) || []);
    return true;
  });
}

export function buildBundle({ installId, events, tombstones = [], reviewsByEvent, now }) {
  const ids = new Set(events.map((e) => e.envelope.eventId));
  const envelopes = [
    ...events.map((e) => e.envelope),
    ...tombstones.filter((t) => ids.has(t.eventId)),
  ];
  const reviews = [];
  for (const id of [...ids].sort()) {
    const list = [...(reviewsByEvent.get(id) || [])].sort((a, b) => a.revision - b.revision);
    reviews.push(...list);
  }
  const clips = events.map(({ envelope: e }) => ({
    clipId: e.payload.clipId,
    eventId: e.eventId,
    filename: `${e.eventId}.wav`,
    sha256: e.payload.sha256,
    sizeBytes: e.payload.sizeBytes,
    sampleRate: e.payload.sampleRate,
    durationMs: e.payload.durationMs,
  }));
  return {
    exportVersion: 1,
    appVersion: APP_VERSION,
    protocolVersion: PROTOCOL_VERSION,
    installId,
    exportedAt: now(),
    events: envelopes,
    reviews,
    clips,
  };
}

export function bundleFilename(now) {
  const stamp = now().replace(/-|:/g, '').replace(/\.\d+/, '');
  return `siri-tiri-export-${stamp}.json`;
}

export function chunkClips(manifest, size = LIMITS.exportChunk) {
  const out = [];
  for (let i = 0; i < manifest.length; i += size) out.push(manifest.slice(i, i + size));
  return out;
}

// Browser only; never touch `navigator`/`document` at module top level.
// `entries`: [{name, data}] with the bundle JSON first and one WAV per clip after it.
// WAVs are chunked by LIMITS.exportChunk and the bundle rides in the first chunk.
// `beforeChunk(index, total)` is awaited before every chunk after the first, so the
// caller can wait for a fresh tap (iOS requires user activation for each share()).
// Any throw (including a cancelled share) propagates; the caller must not mark exported.
export async function shareFiles(entries, { beforeChunk = async () => {} } = {}) {
  if (!entries || !entries.length) throw new Error('no_files');
  const toFile = ({ name, data }) =>
    new File([data], name, { type: name.endsWith('.json') ? 'application/json' : 'audio/wav' });
  const [bundle, ...wavs] = entries.map(toFile);
  const chunks = wavs.length ? chunkClips(wavs, LIMITS.exportChunk) : [[]];
  chunks[0].unshift(bundle);
  let shared = true;
  for (let i = 0; i < chunks.length; i++) {
    if (i > 0) await beforeChunk(i, chunks.length);
    const files = chunks[i];
    if (navigator.canShare?.({ files })) {
      await navigator.share({ files });
    } else {
      shared = false;
      for (const f of files) downloadFile(f);
    }
  }
  return shared ? 'shared' : 'downloaded';
}

function downloadFile(file) {
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = file.name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
