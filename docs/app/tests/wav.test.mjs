import test from 'node:test'; import assert from 'node:assert/strict';
import { mergeFrames, floatToPcm16, encodeWav, sha256Hex } from '../wav.js';
test('mergeFrames concatenates in order', () => {
  const out = mergeFrames([new Float32Array([0.1, 0.2]), new Float32Array([0.3])]);
  assert.deepEqual(Array.from(out), [new Float32Array([0.1])[0], new Float32Array([0.2])[0], new Float32Array([0.3])[0]]);
});
test('floatToPcm16 scales, clamps and counts clipped samples', () => {
  const { pcm, clipped } = floatToPcm16(new Float32Array([0, 0.5, 1.5, -2, -1]));
  assert.deepEqual(Array.from(pcm), [0, 16384, 32767, -32768, -32768]);
  assert.equal(clipped, 2);
});
test('encodeWav writes a 44-byte PCM16 mono header with correct sizes', () => {
  const bytes = encodeWav(new Int16Array([1, -1, 2]), 48000);
  const dv = new DataView(bytes.buffer);
  assert.equal(bytes.length, 50);
  assert.equal(String.fromCharCode(...bytes.slice(0, 4)), 'RIFF');
  assert.equal(dv.getUint32(4, true), 42);
  assert.equal(String.fromCharCode(...bytes.slice(8, 12)), 'WAVE');
  assert.equal(dv.getUint16(20, true), 1);      // PCM
  assert.equal(dv.getUint16(22, true), 1);      // mono
  assert.equal(dv.getUint32(24, true), 48000);  // sample rate
  assert.equal(dv.getUint32(28, true), 96000);  // byte rate
  assert.equal(dv.getUint16(32, true), 2);      // block align
  assert.equal(dv.getUint16(34, true), 16);     // bits
  assert.equal(dv.getUint32(40, true), 6);      // data size
  assert.equal(dv.getInt16(44, true), 1);
});
test('sha256Hex matches a known vector', async () => {
  assert.equal(await sha256Hex(new TextEncoder().encode('abc')),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});
