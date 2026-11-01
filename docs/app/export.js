import { APP_VERSION, PROTOCOL_VERSION } from './version.js';
import { needsReview, LIMITS } from './records.js';

// True when `a` is a later instant than `b` (ISO strings; unparsable values never count as later).
const later = (a, b) => Date.parse(a) > Date.parse(b);

// 'new' selects an event that was never exported, or whose reviews or tombstone changed after
// its last export, so later revisions and deletions also leave the phone through Export new.
// Deleted (tombstoned) events stay candidates; buildBundle exports them as records only.
export function selectEvents(rows, reviewsByEvent, mode, tombstones = []) {
  return rows.filter((row) => {
    const id = row.envelope.eventId;
    if (mode === 'new') {
      if (!row.exportedAt) return true;
      if ((reviewsByEvent.get(id) || []).some((r) => later(r.editedAt, row.exportedAt))) return true;
      return tombstones.some((t) => t.eventId === id && later(t.createdAt, row.exportedAt));
    }
    if (mode === 'unreviewed') return needsReview(reviewsByEvent.get(id) || []);
    return true;
  });
}

// Per-row decision: a deleted (tombstoned) event goes out as records only (capture, tombstone,
// reviews; no WAV, no manifest entry) in every mode. In 'new' and 'unreviewed' an event whose
// clip already left in an earlier export is records only too; 'all' is the full backup and
// recovery path, so it always carries the WAV of every event that still has a clip.
export function isRecordsOnly(row, deletedIds = new Set(), mode) {
  if (row.recordsOnly === true || row.deleted === true || deletedIds.has(row.envelope.eventId)) return true;
  return mode !== 'all' && !!row.exportedAt;
}

// The WAV files an event contributes: its current clip (`<eventId>.wav`, or
// `<eventId>.trimmed.wav` when the current clip is a trim), plus the untrimmed original when
// the current clip is a trim and the original never left the phone (always in 'all').
// Row shape: { envelope (current), original?, exportedAt, originalExportedAt? }.
export function clipFilesFor(row, mode) {
  const cur = row.envelope;
  const id = cur.eventId;
  const out = [];
  const trimmed = !!cur.payload.trim;
  if (trimmed && row.original && (mode === 'all' || !row.originalExportedAt)) {
    out.push({ envelope: row.original, filename: `${id}.wav` });
  }
  out.push({ envelope: cur, filename: trimmed ? `${id}.trimmed.wav` : `${id}.wav` });
  return out;
}

export function buildBundle({ installId, events, tombstones = [], reviewsByEvent, now, mode }) {
  const ids = new Set(events.map((e) => e.envelope.eventId));
  const deleted = new Set(tombstones.map((t) => t.eventId));
  const envelopes = [
    ...events.flatMap((e) => e.envelopes || [e.envelope]),
    ...tombstones.filter((t) => ids.has(t.eventId)),
  ];
  const reviews = [];
  for (const id of [...ids].sort()) {
    const list = [...(reviewsByEvent.get(id) || [])].sort((a, b) => a.revision - b.revision);
    reviews.push(...list);
  }
  const clips = events.filter((ev) => !isRecordsOnly(ev, deleted, mode))
    .flatMap((ev) => ev.clipFiles || clipFilesFor(ev, mode))
    .map(({ envelope: e, filename }) => ({
      clipId: e.payload.clipId,
      eventId: e.eventId,
      filename,
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

const SHARE_ATTEMPTS = 3;

// Browser only by default; never touch `navigator`/`document` at module top level.
// `entries`: [{name, data}] with the bundle JSON first and one WAV per clip after it.
// WAVs are chunked by LIMITS.exportChunk and the bundle rides in the first chunk.
// `beforeChunk(index, total, mode)` is awaited before EVERY chunk, the first included, so each
// share()/download runs inside a fresh tap (iOS requires user activation for each share(), and
// the activation of the Export tap is spent by the IndexedDB reads before it). A share rejected
// with NotAllowedError (activation expired) asks for another tap and retries.
// `mode` is 'share' or 'download'. Any other throw (including a cancelled share) propagates;
// the caller must not mark exported. Resolves { outcome: 'shared'|'downloaded', downloaded }.
// `nav` and `download` are injectable for tests.
export async function shareFiles(entries, { beforeChunk = async () => {}, download = downloadFile, nav = globalThis.navigator } = {}) {
  if (!entries || !entries.length) throw new Error('no_files');
  const toFile = ({ name, data }) =>
    new File([data], name, { type: name.endsWith('.json') ? 'application/json' : 'audio/wav' });
  const [bundle, ...wavs] = entries.map(toFile);
  const chunks = wavs.length ? chunkClips(wavs, LIMITS.exportChunk) : [[]];
  const canShare = (files) => { try { return !!nav?.canShare?.({ files }); } catch { return false; } };
  let first = [bundle, ...chunks[0]];
  if (!canShare(first)) {
    // Chromium's share allowlist may exclude application/json; plain text usually passes.
    const asText = new File([entries[0].data], `${bundle.name}.txt`, { type: 'text/plain' });
    if (canShare([asText, ...chunks[0]])) first = [asText, ...chunks[0]];
  }
  chunks[0] = first;
  let downloaded = 0;
  for (let i = 0; i < chunks.length; i++) {
    const files = chunks[i];
    const mode = canShare(files) ? 'share' : 'download';
    await beforeChunk(i, chunks.length, mode);
    if (mode === 'download') {
      for (const f of files) download(f);
      downloaded += files.length;
      continue;
    }
    for (let attempt = 1; ; attempt++) {
      try { await nav.share({ files }); break; } catch (e) {
        if (!e || e.name !== 'NotAllowedError' || attempt >= SHARE_ATTEMPTS) throw e;
        await beforeChunk(i, chunks.length, mode);
      }
    }
  }
  return { outcome: downloaded ? 'downloaded' : 'shared', downloaded };
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
