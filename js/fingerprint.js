// js/fingerprint.js - ambient acoustic fingerprinting.
// No dependencies. Landmark (constellation) hashing, Wang-style.
//
// The important change from a naive version: capture is SYNCHRONISED.
// Two devices only match if they heard the same air at the same moment,
// so every device records the identical wall-clock interval. Opening the
// microphone early and slicing afterwards is what makes that possible.

export const CFG = {
  RATE:      16000, // all analysis normalised to this
  WIN:       1024,  // FFT window (samples)
  HOP:       512,   // hop -> 31.25 frames/sec
  MIN_BIN:   19,    // ~300 Hz
  MAX_BIN:   384,   // ~6000 Hz
  NEIGH_T:   2,     // local-max neighbourhood, frames
  NEIGH_F:   4,     // local-max neighbourhood, bins
  PEAKS_SEC: 30,    // density cap
  FAN_OUT:   5,     // targets per anchor
  MIN_DT:    1,     // min frame gap
  MAX_DT:    63     // max frame gap (6 bits)
};

// ---------- 1. microphone ----------

const WORKLET_SRC = `
class Cap extends AudioWorkletProcessor {
  constructor() { super(); this.buf = new Float32Array(2048); this.n = 0; }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.buf[this.n++] = ch[i];
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf.slice());
        this.n = 0;
      }
    }
    return true;
  }
}
registerProcessor('cap', Cap);
`;

/**
 * Open the microphone and start buffering immediately. Call this BEFORE the
 * moment you actually want to capture - a second or two of head start
 * absorbs permission prompts and audio-graph warm-up.
 *
 * @param {() => number} nowMs  clock used to stamp blocks (server-corrected)
 */
export async function openMic(nowMs = Date.now, maxSeconds = 25) {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: false,  // these three REMOVE room sound.
      noiseSuppression: false,  // leaving them on will silently
      autoGainControl:  false,  // destroy your match rates.
      channelCount: 1
    }
  });

  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') await ctx.resume();
  const src = ctx.createMediaStreamSource(stream);

  const mic = {
    ctx, stream, rate: ctx.sampleRate,
    blocks: [],     // Float32Array chunks, in order
    samples: 0,
    t0: null,       // wall-clock ms of blocks[0] sample 0
    node: null, sink: null
  };

  const take = (data) => {
    if (mic.t0 === null) {
      // this block was already captured when the callback fired
      mic.t0 = nowMs() - (data.length / mic.rate) * 1000;
    }
    mic.blocks.push(data);
    mic.samples += data.length;

    // The mic may stay open for a minute while we wait for the agreed
    // moment. Keep only a rolling tail, and move t0 with it.
    const cap = maxSeconds * mic.rate;
    while (mic.samples > cap && mic.blocks.length > 1) {
      const old = mic.blocks.shift();
      mic.samples -= old.length;
      mic.t0 += (old.length / mic.rate) * 1000;
    }
  };

  let usedWorklet = false;
  if (ctx.audioWorklet) {
    try {
      const url = URL.createObjectURL(
        new Blob([WORKLET_SRC], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      const w = new AudioWorkletNode(ctx, 'cap');
      w.port.onmessage = e => take(e.data);
      src.connect(w);
      mic.node = w;
      usedWorklet = true;
    } catch (e) { /* fall through to the legacy path */ }
  }

  if (!usedWorklet) {
    // legacy path. route into a muted gain node, never the speakers.
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    sp.onaudioprocess = e =>
      take(new Float32Array(e.inputBuffer.getChannelData(0)));
    const mute = ctx.createGain();
    mute.gain.value = 0;
    src.connect(sp); sp.connect(mute); mute.connect(ctx.destination);
    mic.node = sp; mic.sink = mute;
  }

  mic.close = async () => {
    try { if (mic.node) mic.node.disconnect(); } catch (e) {}
    try { if (mic.sink) mic.sink.disconnect(); } catch (e) {}
    try { src.disconnect(); } catch (e) {}
    stream.getTracks().forEach(t => t.stop());
    try { await ctx.close(); } catch (e) {}
  };

  return mic;
}

/** flatten everything buffered so far into one Float32Array */
function flatten(mic) {
  const out = new Float32Array(mic.samples);
  let o = 0;
  for (const b of mic.blocks) { out.set(b, o); o += b.length; }
  return out;
}

/**
 * Wait for `startWall`, keep buffering, then cut exactly the requested
 * interval out of what the microphone heard.
 * Returns { samples, lateBy } - lateBy > 0 means the mic opened after the
 * interval had already begun and the clip is short.
 */
export async function captureAt(mic, startWall, seconds, nowMs = Date.now, onTick) {
  const endWall = startWall + seconds * 1000;
  const tick = onTick
    ? setInterval(() => onTick((startWall - nowMs()) / 1000), 100)
    : null;

  // +250 ms of slack so the tail is definitely in the buffer
  while (nowMs() < endWall + 250) {
    await new Promise(r => setTimeout(r, 40));
  }
  if (tick) clearInterval(tick);

  if (mic.t0 === null) throw new Error('microphone produced no audio');

  const all = flatten(mic);
  const want = Math.round(seconds * mic.rate);
  let start = Math.round(((startWall - mic.t0) / 1000) * mic.rate);
  const lateBy = start < 0 ? -start / mic.rate : 0;
  if (start < 0) start = 0;
  if (start > all.length - 1) start = Math.max(0, all.length - want);

  const clip = all.subarray(start, Math.min(all.length, start + want));
  return { samples: resample(clip, mic.rate, CFG.RATE), lateBy };
}

function resample(input, inRate, outRate) {
  if (inRate === outRate) return Float32Array.from(input);
  const ratio  = inRate / outRate;
  const outLen = Math.floor(input.length / ratio);
  const out    = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos  = i * ratio;
    const i0   = Math.floor(pos);
    const frac = pos - i0;
    const a = input[i0] || 0;
    const b = input[i0 + 1] || 0;
    out[i] = a + (b - a) * frac;
  }
  return out;
}

// ---------- 2. FFT ----------

function fft(re, im) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    const half = len >> 1;
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < half; k++) {
        const pr = re[i + k], pi = im[i + k];
        const qr = re[i + k + half] * cr - im[i + k + half] * ci;
        const qi = re[i + k + half] * ci + im[i + k + half] * cr;
        re[i + k] = pr + qr;          im[i + k] = pi + qi;
        re[i + k + half] = pr - qr;   im[i + k + half] = pi - qi;
        const ncr = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = ncr;
      }
    }
  }
}

// ---------- 3. spectrogram ----------

export function spectrogram(samples) {
  const { WIN, HOP } = CFG;
  const hann = new Float32Array(WIN);
  for (let i = 0; i < WIN; i++)
    hann[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (WIN - 1));

  const frames = [];
  for (let s = 0; s + WIN <= samples.length; s += HOP) {
    const re = new Float64Array(WIN);
    const im = new Float64Array(WIN);
    for (let i = 0; i < WIN; i++) re[i] = samples[s + i] * hann[i];
    fft(re, im);
    const mag = new Float32Array(WIN / 2);
    for (let b = 0; b < WIN / 2; b++)
      mag[b] = 20 * Math.log10(Math.hypot(re[b], im[b]) + 1e-12);
    frames.push(mag);
  }
  return frames;
}

// ---------- 4. peak picking ----------

export function peaks(frames) {
  const { MIN_BIN, MAX_BIN, NEIGH_T, NEIGH_F, PEAKS_SEC, HOP, RATE } = CFG;
  const found = [];

  for (let t = 0; t < frames.length; t++) {
    // per-frame floor: median of the analysis band
    const band = Array.from(frames[t].slice(MIN_BIN, MAX_BIN)).sort((a, b) => a - b);
    const floor = band[band.length >> 1] + 6;

    for (let f = MIN_BIN; f < MAX_BIN; f++) {
      const v = frames[t][f];
      if (v < floor) continue;
      let isMax = true;
      for (let dt = -NEIGH_T; dt <= NEIGH_T && isMax; dt++) {
        const tt = t + dt;
        if (tt < 0 || tt >= frames.length) continue;
        for (let df = -NEIGH_F; df <= NEIGH_F; df++) {
          if (dt === 0 && df === 0) continue;
          const ff = f + df;
          if (ff < MIN_BIN || ff >= MAX_BIN) continue;
          if (frames[tt][ff] > v) { isMax = false; break; }
        }
      }
      if (isMax) found.push({ t, f, v });
    }
  }

  const seconds = (frames.length * HOP) / RATE;
  const cap = Math.max(20, Math.round(PEAKS_SEC * seconds));
  found.sort((a, b) => b.v - a.v);
  const kept = found.slice(0, cap);
  kept.sort((a, b) => a.t - b.t || a.f - b.f);
  return kept;
}

// ---------- 5. hashing ----------

export function hashes(pk) {
  const { FAN_OUT, MIN_DT, MAX_DT } = CFG;
  const out = [];
  for (let i = 0; i < pk.length; i++) {
    let made = 0;
    for (let j = i + 1; j < pk.length && made < FAN_OUT; j++) {
      const dt = pk[j].t - pk[i].t;
      if (dt < MIN_DT) continue;
      if (dt > MAX_DT) break;
      const f1 = pk[i].f & 0x3FF;
      const f2 = pk[j].f & 0x3FF;
      const h  = (f1 << 16) | (f2 << 6) | (dt & 0x3F);
      out.push({ h, o: pk[i].t });
      made++;
    }
  }
  return out;
}


// ---------- 6. is this window worth believing? ----------
//
// The deployed matcher reads entropy.score and treats anything below 0.35 as
// too weak to be decisive in either direction. A near-silent or perfectly
// stationary room produces landmarks that are mostly microphone self-noise:
// they will either match nothing, or match everything.
//
// Three things have to be true for a window to carry information - there has
// to be sound, it has to change over time, and it has to have structure across
// the spectrum. A steady air-conditioner passes the first and fails the others.

const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const r3 = x => Math.round(x * 1000) / 1000;

export function entropyReport(frames, samples) {
  const { MIN_BIN, MAX_BIN } = CFG;
  const width = MAX_BIN - MIN_BIN;

  // 1. level, in dBFS
  let sq = 0;
  for (let i = 0; i < samples.length; i++) sq += samples[i] * samples[i];
  const dbfs = 20 * Math.log10(Math.sqrt(sq / Math.max(1, samples.length)) + 1e-12);
  const level = clamp01((dbfs + 60) / 35);           // -60 dBFS -> 0, -25 -> 1

  // 2. flux: how much the spectrum moves frame to frame
  let flux = 0;
  for (let t = 1; t < frames.length; t++) {
    let d = 0;
    for (let b = MIN_BIN; b < MAX_BIN; b++)
      d += Math.abs(frames[t][b] - frames[t - 1][b]);
    flux += d / width;
  }
  flux = frames.length > 1 ? flux / (frames.length - 1) : 0;
  const change = clamp01(flux / 6);                   // 6 dB mean step -> 1

  // 3. spread: structure across the analysis band
  let sum = 0, n = 0;
  for (const fr of frames)
    for (let b = MIN_BIN; b < MAX_BIN; b++) { sum += fr[b]; n++; }
  const mean = sum / Math.max(1, n);
  let varr = 0;
  for (const fr of frames)
    for (let b = MIN_BIN; b < MAX_BIN; b++) varr += (fr[b] - mean) ** 2;
  const spread = Math.sqrt(varr / Math.max(1, n));
  const structure = clamp01((spread - 2) / 10);       // 12 dB spread -> 1

  // Level GATES the other two rather than averaging with them. Microphone
  // self-noise in a silent room fluctuates just as much as a lecture does, so
  // a weighted mean of level and flux scores near-silence as informative -
  // which is exactly backwards. No sound, no evidence, however lively the
  // noise floor looks.
  return {
    score: r3(clamp01(level * (0.45 + 0.30 * change + 0.25 * structure))),
    level: r3(level), change: r3(change), structure: r3(structure),
    dbfs: r3(dbfs), spread: r3(spread)
  };
}

// ---------- 7. one call, in the shape aa_submissions wants ----------

/**
 * Samples in, submission out. `hashes` and `offsets` are parallel int arrays,
 * which is exactly how the matcher indexes them.
 */
export function analyse(samples) {
  const frames = spectrogram(samples);
  const pk = peaks(frames);
  const pairs = hashes(pk);
  return {
    hashes:  pairs.map(p => p.h),
    offsets: pairs.map(p => p.o),
    entropy: entropyReport(frames, samples),
    peakCount: pk.length,
    frameCount: frames.length
  };
}
