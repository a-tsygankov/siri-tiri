export function mergeFrames(frames) {
  const total = frames.reduce((sum, frame) => sum + frame.length, 0);
  const out = new Float32Array(total);
  let offset = 0;
  for (const frame of frames) {
    out.set(frame, offset);
    offset += frame.length;
  }
  return out;
}

export function floatToPcm16(samples) {
  const pcm = new Int16Array(samples.length);
  let clipped = 0;
  for (let i = 0; i < samples.length; i++) {
    const value = samples[i];
    if (value > 1 || value < -1) clipped++;
    const scaled = Math.round(value * 32768);
    pcm[i] = Math.min(32767, Math.max(-32768, scaled));
  }
  return { pcm, clipped };
}

export function encodeWav(pcm, sampleRate) {
  const dataSize = pcm.length * 2;
  const bytes = new Uint8Array(44 + dataSize);
  const dv = new DataView(bytes.buffer);
  writeAscii(bytes, 0, 'RIFF');
  dv.setUint32(4, 36 + dataSize, true);
  writeAscii(bytes, 8, 'WAVE');
  writeAscii(bytes, 12, 'fmt ');
  dv.setUint32(16, 16, true);            // fmt chunk size
  dv.setUint16(20, 1, true);             // PCM
  dv.setUint16(22, 1, true);             // mono
  dv.setUint32(24, sampleRate, true);
  dv.setUint32(28, sampleRate * 2, true); // byte rate
  dv.setUint16(32, 2, true);             // block align
  dv.setUint16(34, 16, true);            // bits per sample
  writeAscii(bytes, 36, 'data');
  dv.setUint32(40, dataSize, true);
  for (let i = 0; i < pcm.length; i++) {
    dv.setInt16(44 + i * 2, pcm[i], true);
  }
  return bytes;
}

export async function sha256Hex(bytes) {
  const digest = await globalThis.crypto.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

function writeAscii(bytes, offset, text) {
  for (let i = 0; i < text.length; i++) bytes[offset + i] = text.charCodeAt(i);
}

// Parses a PCM16 mono WAV (as written by encodeWav, or any RIFF file with a 16-bit mono
// `fmt ` chunk) into its sample rate and samples. Throws on anything else.
export function decodeWav(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  const tag = (o) => String.fromCharCode(u8[o], u8[o + 1], u8[o + 2], u8[o + 3]);
  if (u8.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new Error('not a WAV file');
  let fmt = null;
  let data = null;
  for (let o = 12; o + 8 <= u8.length;) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') {
      fmt = { format: dv.getUint16(o + 8, true), channels: dv.getUint16(o + 10, true), sampleRate: dv.getUint32(o + 12, true), bits: dv.getUint16(o + 22, true) };
    }
    if (id === 'data') { data = { offset: o + 8, size: Math.min(size, u8.length - o - 8) }; break; }
    o += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('not a WAV file');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error('not a PCM16 WAV file');
  if (fmt.channels !== 1) throw new Error('not a mono WAV file');
  const count = Math.floor(data.size / 2);
  const pcm = new Int16Array(count);
  for (let i = 0; i < count; i++) pcm[i] = dv.getInt16(data.offset + i * 2, true);
  return { sampleRate: fmt.sampleRate, pcm };
}

// Cuts [startMs, endMs) out of a PCM16 mono WAV and re-encodes it. `clippedSamples` counts
// full-scale samples in the kept range (the only clipping evidence left after PCM16 encoding).
export function trimWav(bytes, startMs, endMs) {
  const { sampleRate, pcm } = decodeWav(bytes);
  const totalMs = (pcm.length / sampleRate) * 1000;
  if (!(startMs >= 0) || !(endMs > startMs) || endMs > totalMs + 0.5) throw new Error('trim range outside the clip');
  const from = Math.round((startMs / 1000) * sampleRate);
  const to = Math.min(pcm.length, Math.round((endMs / 1000) * sampleRate));
  if (to <= from) throw new Error('trim range outside the clip');
  const kept = pcm.subarray(from, to);
  let clippedSamples = 0;
  for (let i = 0; i < kept.length; i++) if (kept[i] === 32767 || kept[i] === -32768) clippedSamples++;
  return { bytes: encodeWav(kept, sampleRate), sampleRate, durationMs: Math.round((kept.length / sampleRate) * 1000), clippedSamples };
}
