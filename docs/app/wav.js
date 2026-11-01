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
