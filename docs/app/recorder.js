import { mergeFrames, floatToPcm16, encodeWav, sha256Hex } from './wav.js';
import { LIMITS } from './records.js';

const CONSTRAINTS = {
  audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false },
};
const LEVEL_INTERVAL_MS = 50;
const TICK_INTERVAL_MS = 250;

export class Recorder {
  static async requestPermission() {
    // Rejects (NotAllowedError etc.) if the user denies or no mic exists.
    return navigator.mediaDevices.getUserMedia(CONSTRAINTS);
  }

  constructor({ onLevel = () => {}, onTick = () => {}, onAutoStop = () => {} } = {}) {
    this.onLevel = onLevel;
    this.onTick = onTick;
    this.onAutoStop = onAutoStop;
    this.ctx = null;
    this.node = null;
    this.source = null;
    this.sink = null;
    this.stream = null;
    this.frames = [];
    this.sampleRate = 0;
    this.startedAt = 0;
    this.timers = [];
    this.stopPromise = null;
    this.recording = false;
    this.lastLevelAt = 0;
    this.onVisibility = () => { if (document.hidden) this.stop({ interrupted: true }).catch(() => {}); };
  }

  // Creates an AudioContext synchronously inside the user's tap (iOS requires it there).
  static createContext() {
    const Ctx = globalThis.AudioContext || globalThis.webkitAudioContext;
    return new Ctx();
  }

  // `audioContext` should be created by the caller in the tap handler (Recorder.createContext());
  // without it one is created here (harness path). The Recorder owns and closes it either way.
  async start(stream, audioContext = null) {
    if (this.recording || this.stopPromise) throw new Error('already_started');
    this.stream = stream;
    try {
      // Native rate cannot be forced.
      this.ctx = audioContext || Recorder.createContext();
      if (this.ctx.state === 'suspended') await this.ctx.resume();
      await this.ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
      this.sampleRate = this.ctx.sampleRate;
      this.source = this.ctx.createMediaStreamSource(stream);
      this.node = new AudioWorkletNode(this.ctx, 'pcm-capture', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      this.node.port.onmessage = (e) => this.handleFrame(e.data);
      // Silent sink keeps the node pulled by the graph (Safari needs this).
      this.sink = this.ctx.createGain();
      this.sink.gain.value = 0;
      this.source.connect(this.node);
      this.node.connect(this.sink);
      this.sink.connect(this.ctx.destination);
    } catch (err) {
      await this.teardown();
      throw err;
    }
    this.frames = [];
    this.startedAt = performance.now();
    this.recording = true;
    document.addEventListener('visibilitychange', this.onVisibility);
    this.timers.push(setInterval(() => this.onTick(this.elapsedMs()), TICK_INTERVAL_MS));
    this.timers.push(setTimeout(() => {
      this.onAutoStop();
      this.stop().catch(() => {}); // caller gets the same promise via its own stop()
    }, LIMITS.maxMs));
  }

  elapsedMs() {
    const samples = this.frames.reduce((n, f) => n + f.length, 0);
    return (samples / (this.sampleRate || 1)) * 1000;
  }

  handleFrame(frame) {
    if (!this.recording) return;
    this.frames.push(frame);
    const t = performance.now();
    if (t - this.lastLevelAt >= LEVEL_INTERVAL_MS) {
      this.lastLevelAt = t;
      let sum = 0;
      for (let i = 0; i < frame.length; i++) sum += frame[i] * frame[i];
      this.onLevel(Math.min(1, Math.sqrt(sum / (frame.length || 1))));
    }
  }

  // Idempotent: repeated calls return the same promise as the first call.
  // Calling before start() rejects with Error('not_recording').
  stop({ interrupted = false } = {}) {
    if (this.stopPromise) return this.stopPromise;
    if (!this.recording) return Promise.reject(new Error('not_recording'));
    // Synchronously, before any await: no tick or auto-stop may fire during a manual stop.
    this.clearTimers();
    this.recording = false;
    this.stopPromise = this.finish(interrupted);
    return this.stopPromise;
  }

  async finish(interrupted) {
    try {
      // A late timer must never yield a clip over LIMITS.maxMs (downstream limits are strict).
      const merged = mergeFrames(this.frames);
      const max = Math.floor((this.sampleRate * LIMITS.maxMs) / 1000);
      const samples = merged.length > max ? merged.subarray(0, max) : merged;
      this.frames = [];
      const durationMs = (samples.length / this.sampleRate) * 1000;
      if (durationMs < LIMITS.minMs) throw new Error('too_short');
      const { pcm, clipped } = floatToPcm16(samples);
      const wavBytes = encodeWav(pcm, this.sampleRate);
      return {
        wavBytes,
        blob: new Blob([wavBytes], { type: 'audio/wav' }),
        sampleRate: this.sampleRate,
        durationMs,
        sizeBytes: wavBytes.length,
        sha256: await sha256Hex(wavBytes),
        clippedSamples: clipped,
        interrupted,
      };
    } finally {
      await this.teardown();
    }
  }

  clearTimers() {
    for (const t of this.timers) { clearInterval(t); clearTimeout(t); }
    this.timers = [];
  }

  async teardown() {
    this.recording = false;
    document.removeEventListener('visibilitychange', this.onVisibility);
    this.clearTimers();
    try { if (this.node) { this.node.port.onmessage = null; this.node.disconnect(); } } catch {}
    try { this.source?.disconnect(); this.sink?.disconnect(); } catch {}
    try { this.stream?.getTracks().forEach((t) => t.stop()); } catch {}
    try { if (this.ctx && this.ctx.state !== 'closed') await this.ctx.close(); } catch {}
  }
}
