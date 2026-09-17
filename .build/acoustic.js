/* =====================================================================
   ACOUSTIC LAYER — inlined so this file stands alone.
   Capture and landmark hashing, the fusion policy (the room decides, the
   venue polygon is the fallback), and the wiring that drives them. One
   scope; two names were renamed where the originals collided.
   ===================================================================== */
(function(){
'use strict';

// js/fingerprint.js - ambient acoustic fingerprinting.
// No dependencies. Landmark (constellation) hashing, Wang-style.
//
// The important change from a naive version: capture is SYNCHRONISED.
// Two devices only match if they heard the same air at the same moment,
// so every device records the identical wall-clock interval. Opening the
// microphone early and slicing afterwards is what makes that possible.

const CFG = {
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
async function openMic(nowMs = Date.now, maxSeconds = 25) {
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
async function captureAt(mic, startWall, seconds, nowMs = Date.now, onTick) {
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

function spectrogram(samples) {
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

function peaks(frames) {
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

function hashes(pk) {
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

function entropyReport(frames, samples) {
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
function analyse(samples) {
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

// js/fuse.js - the room decides; the polygon is the fallback.
//
//   Acoustic (primary)   every device captures the same seconds, the server
//                        matches landmark sets and clusters the ones that
//                        heard the same air, anchored to the lecturer's phone.
//                        Answers: "is this phone in this ROOM, now?"
//
//   Location (backup)    GPS polygon containment, sample agreement, fix
//                        precision, peer consensus, a rotating QR token, and
//                        mock-location heuristics.
//                        Answers: "is this phone at this venue?"
//
// Acoustic leads because it answers the question attendance actually asks. GPS
// is weakest exactly where lectures happen - indoors, under concrete, drifting
// tens of metres, unable to tell Hall A from Hall B next door - and it is the
// layer a mock-location app defeats outright. None of that touches whether a
// phone heard the room.
//
// So the polygon is not a second opinion on a question the audio already
// answered. It is what answers the question when the audio cannot: in the
// first minutes before a cluster exists, in a silent room, when too few
// devices captured, or when a student refused the microphone.
//
// The two paths are mutually exclusive, which is also why this no longer has
// to unpick double counting. When acoustic decides, GPS peer consensus is not
// added to it - the room already corroborated the room. When acoustic cannot
// decide, the location verdict stands exactly as its own engine computed it.

const FUSE_CFG = {
  autoPass:    0.72,   // the tiers the location engine already uses
  reviewFloor: 0.42,

  // An acoustic verdict on its own spans this range, so a strong cluster
  // clears autoPass without help and a thin one does not.
  acousticFloor: 0.45,
  acousticSpan:  0.50,

  // GPS only nudges a verdict the room already made. Small on purpose: an
  // indoor fix is the least trustworthy thing in the stack.
  confirmBonus: 0.08,
  conflictDrop: 0.06,

  minCorroborating: 2, // devices that must agree before absence means anything
  lowEntropy:       0.35
};

const fuseClamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const r2 = x => Math.round(x * 100) / 100;

/**
 * How much a student's acoustic result is worth, in [0,1].
 *
 * `acoustic` is one student folded across the windows of a class:
 *   { available, clusterMember, confidenceBand, corroboratingDevices,
 *     clusterSize, windowsPresent, windowsAnalysed, lecturerBound,
 *     entropyScore }
 */
function acousticStrength(acoustic) {
  if (!acoustic || !acoustic.available) return { score: 0, decisive: false };

  const band = { high: 1, medium: 0.72, low: 0.35, none: 0 }[acoustic.confidenceBand] ?? 0;

  // Being in one window of four is not being in four of four.
  const total = acoustic.windowsAnalysed || 0;
  const share = total > 0 ? (acoustic.windowsPresent || 0) / total : 0;

  let score = band * (0.45 + 0.55 * share);

  // A cluster without the lecturer's phone is a room, but not provably this
  // class's room.
  if (acoustic.lecturerBound === false) score *= 0.5;

  // A quiet window cannot support a strong conclusion in either direction.
  const quiet = (acoustic.entropyScore ?? 1) < FUSE_CFG.lowEntropy;
  if (quiet) score *= 0.6;

  // Absence only counts as evidence when there was a room to be absent from.
  const decisive = total > 0 && !quiet &&
    acoustic.lecturerBound !== false &&
    (acoustic.clusterMember
      ? true
      : (acoustic.clusterSize || 0) >= FUSE_CFG.minCorroborating + 1);

  return { score: fuseClamp01(score), decisive, share, quiet, band };
}

/**
 * @param {object} checkIn  the record's `verification` from the location
 *                          engine: { score, tier, factors, flags, reasons }
 * @param {object} acoustic folded acoustic evidence, or { available:false }
 */
function fuse(checkIn, acoustic) {
  const gpsScore = typeof checkIn?.score === 'number' ? checkIn.score : 0;
  const gpsTier  = checkIn?.tier || 'review';
  const gpsPositive = gpsTier === 'verified';
  const hardFail = (checkIn?.flags || [])
    .some(f => f.code === 'frozen' || f.code === 'teleport');

  const a = acousticStrength(acoustic);
  const reasons = [];
  let score, tier, agreement;

  // ---------------------------------------------------------- primary: room
  if (acoustic && acoustic.available && acoustic.clusterMember) {
    score = FUSE_CFG.acousticFloor + FUSE_CFG.acousticSpan * a.score;
    reasons.push(`heard this room in ${acoustic.windowsPresent} of ` +
      `${acoustic.windowsAnalysed} windows, alongside ` +
      `${acoustic.corroboratingDevices} other devices`);

    if (gpsPositive) {
      agreement = 'corroborated';
      score += FUSE_CFG.confirmBonus;
      reasons.push('the location fix agrees');
    } else if (gpsTier === 'rejected') {
      // Being heard in the room outranks a fix that could not place you. This
      // is the ordinary indoor case, not a suspicious one.
      agreement = 'acoustic-over-location';
      score -= FUSE_CFG.conflictDrop;
      reasons.push('the location fix could not place this phone, which is ' +
                   'expected indoors and does not outweigh the room');
    } else {
      agreement = 'acoustic-primary';
    }

  // ------------------------------------------- primary: the room says no
  } else if (acoustic && acoustic.available && a.decisive) {
    agreement = gpsPositive ? 'contradicted' : 'both-weak';
    score = Math.min(gpsScore, FUSE_CFG.reviewFloor - 0.02);
    reasons.push(gpsPositive
      ? `no device in the room heard what this phone heard, across ` +
        `${acoustic.windowsAnalysed} windows, though the location fix looked right`
      : 'neither the room nor the location fix placed this phone here');

  // --------------------------------------------------------- backup: polygon
  } else {
    agreement = 'location-fallback';
    score = gpsScore;
    tier = gpsTier;                       // stands exactly as its engine set it
    reasons.push(...(checkIn?.reasons || []));
    reasons.push(!acoustic || !acoustic.available
      ? 'no listening window was matched, so the venue polygon decided this'
      : a.quiet
        ? 'the room was too quiet to be decisive, so the venue polygon decided this'
        : 'too few devices captured for the room to be decisive, so the venue ' +
          'polygon decided this');
  }

  if (tier === undefined) tier = tierFor(score);

  // ------------------------------------------------------------- guard rails
  //
  // Nothing here turns silence into an absence. A student whose phone is flat,
  // or muted, or who refused the microphone, must not be marked absent by a
  // check they could not take part in.
  if (agreement === 'contradicted' && tier === 'rejected') tier = 'review';
  if (acoustic && acoustic.clusterMember && tier === 'rejected') tier = 'review';

  // A device caught faking its location is not waved through for having been
  // in the room. Present and running a mock-location app is a discipline
  // question, and a human should see it.
  if (hardFail) {
    tier = 'review';
    reasons.push('location readings showed signs of tampering - present, but worth a look');
  }

  return {
    score: r2(fuseClamp01(score)),
    tier,
    status: tier === 'verified' ? 'present'
          : tier === 'review'   ? 'pending-review'
          : 'rejected',
    agreement,
    primary: agreement === 'location-fallback' ? 'location' : 'acoustic',
    acoustic: { strength: r2(a.score), decisive: a.decisive },
    reasons,
    engine: 4
  };
}

function tierFor(score) {
  const s = fuseClamp01(score);
  if (s >= FUSE_CFG.autoPass) return 'verified';
  if (s >= FUSE_CFG.reviewFloor) return 'review';
  return 'rejected';
}

// js/uvn-acoustic.js — the acoustic layer, wired into the UNIVEN app.
//
// The location check-in happens once, at the door. Acoustic evidence arrives
// during the lecture, so it cannot be a seventh term in scoreCheckIn - it is a
// second stage that revises the record afterwards.
//
//   1. the lecturer opens a listening window; every device in the room,
//      theirs included, records the same few seconds
//   2. the server matches landmark sets and clusters the devices that heard
//      the same air, then deletes the landmarks
//   3. fuse() combines each student's location verdict with their acoustic
//      one, and the register is rewritten with what the two agreed on
//
// A module, loaded after the app's classic script, so it borrows the client
// the compat layer already authenticated rather than opening a second session.


const AC_CFG = {
  LEAD_MS: 8000,        // warning before the capture instant
  MIN_LEAD_MS: 2500,    // below this, wait for the next window
  CAPTURE_SECONDS: 5,
  MIC_BUFFER_SECONDS: 40,
  POLL_MS: 1500
};

const sb = () => window.sb;
const ok = r => { if (r.error) throw new Error(r.error.message); return r.data; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* Device clocks are not trusted: the capture instant is derived from the
   window's server-side opens_at, and each device corrects its own offset. */
let skew = 0;
const now = () => Date.now() + skew;

async function syncClock() {
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(window.SUPABASE_REST || (sb().supabaseUrl + '/rest/v1/'), {
        method: 'HEAD', headers: { apikey: sb().supabaseKey }
      });
      const rtt = Date.now() - t0;
      const h = res.headers.get('date');
      if (!h) break;
      if (rtt < best) { best = rtt; skew = new Date(h).getTime() + rtt / 2 - Date.now(); }
    } catch (e) { break; }
  }
  return skew;
}

/** Capture the agreed interval and hand the landmarks over. */
async function captureAndSubmit(mic, win, userId, onTick) {
  const secs = win.seconds || AC_CFG.CAPTURE_SECONDS;
  const captureAtMs = new Date(win.opens_at).getTime() + AC_CFG.LEAD_MS;

  const cut = await captureAt(mic, captureAtMs, secs, now, onTick);
  const fp = analyse(cut.samples);
  if (!fp.hashes.length) throw new Error('nothing usable was recorded');

  const res = await sb().from('aa_submissions').insert({
    window_id: win.id,
    user_id: userId,
    device_id: localStorage.getItem('uvn_device_id') || null,
    hash_count: fp.hashes.length,
    entropy: fp.entropy,
    hashes: fp.hashes,
    offsets: fp.offsets
  });
  // a second submission for the same window is a no-op, not an error
  if (res.error && res.error.code !== '23505') throw new Error(res.error.message);
  return fp;
}

/** The window a device should be aiming at, with enough lead time left. */
async function pendingWindow(sessionId) {
  const rows = ok(await sb().from('aa_windows')
    .select('id, idx, seconds, opens_at, closes_at, analysed_at')
    .eq('class_session_id', sessionId)
    .is('analysed_at', null)
    .order('idx', { ascending: false })
    .limit(3));
  for (const w of rows || []) {
    const at = new Date(w.opens_at).getTime() + AC_CFG.LEAD_MS;
    if (at - now() < AC_CFG.MIN_LEAD_MS) continue;
    if (now() > new Date(w.closes_at).getTime()) continue;
    return w;
  }
  return null;
}

// =====================================================================
// lecturer
// =====================================================================

let lecMic = null;

/** Open a window and anchor it with the lecturer's own device. */
async function openListeningWindow(sessionId, onState) {
  await syncClock();
  const say = s => onState && onState(s);

  if (!lecMic) {
    say({ phase: 'mic', text: 'Asking for the microphone…' });
    lecMic = await openMic(now, AC_CFG.MIC_BUFFER_SECONDS);
  }

  const win = ok(await sb().rpc('aa_open_window',
    { p_session: sessionId, p_seconds: AC_CFG.CAPTURE_SECONDS }));
  say({ phase: 'opened', window: win, text: 'Window ' + (win.idx + 1) + ' open' });

  const { data: { user } } = await sb().auth.getUser();
  const fp = await captureAndSubmit(lecMic, win, user.id, left => {
    say(left > 0
      ? { phase: 'countdown', seconds: Math.ceil(left),
          text: 'Everyone records in ' + Math.ceil(left) }
      : { phase: 'listening', text: 'Listening…' });
  });

  say({
    phase: 'anchored', window: win, entropy: fp.entropy.score,
    text: fp.entropy.score < 0.35
      ? 'Anchored, but the room is very quiet (' + fp.entropy.score.toFixed(2) +
        ') — this window may not be decisive.'
      : 'Anchored with ' + fp.hashes.length + ' landmarks. Students can keep capturing.'
  });
  return win;
}

function releaseLecturerMic() {
  if (lecMic) { lecMic.close(); lecMic = null; }
}

/** Match a window, then fold both layers into the register. */
async function matchWindow(sessionId, windowId, onState) {
  const say = s => onState && onState(s);
  say({ phase: 'matching', text: 'Matching…' });

  const { data, error } = await sb().functions.invoke('analyse-window', { body: { windowId } });
  if (error) {
    let detail = error.message;
    try { detail = (await error.context.json()).error || detail; } catch (e) {}
    throw new Error(detail);
  }
  if (data && data.error) throw new Error(data.error);

  const fused = await fuseSession(sessionId);
  say({
    phase: 'matched', result: data, fused,
    text: 'Matched ' + data.submissions + ' devices, cluster of ' + data.clusterSize +
          (data.lecturerBound ? ', anchored to your phone' : ' — WITHOUT your phone') +
          '. ' + fused.changed + ' of ' + fused.total + ' register rows revised.'
  });
  return data;
}

/**
 * Combine the two layers for every student in the session.
 *
 * The location verdict is whatever scoreCheckIn stored at the door; the
 * acoustic verdict is folded across every analysed window. fuse() decides what
 * they add up to, and refuses to turn either one into an absence on its own.
 */
async function fuseSession(sessionId) {
  const windows = ok(await sb().from('aa_windows')
    .select('id, cluster_size, lecturer_bound, analysed_at')
    .eq('class_session_id', sessionId).not('analysed_at', 'is', null));
  const ids = windows.map(w => w.id);

  const register = ok(await sb().from('aa_attendance')
    .select('student_id, verification, windows_present, windows_analysed, overridden_by')
    .eq('class_session_id', sessionId));

  if (!ids.length) return { total: register.length, changed: 0 };

  const evidence = ok(await sb().from('aa_evidence')
    .select('user_id, window_id, cluster_member, confidence_band, corroborating_devices, entropy_score')
    .in('window_id', ids));

  const byWindow = {};
  windows.forEach(w => { byWindow[w.id] = w; });

  const byUser = new Map();
  for (const e of evidence) {
    if (!byUser.has(e.user_id)) byUser.set(e.user_id, []);
    byUser.get(e.user_id).push(e);
  }

  const RANK = { none: 0, low: 1, medium: 2, high: 3 };
  let changed = 0;

  for (const row of register) {
    if (row.overridden_by) continue;          // a human already ruled on this
    const mine = byUser.get(row.student_id) || [];

    let acoustic;
    if (!mine.length) {
      acoustic = { available: false };
    } else {
      // best band across windows, worst-case entropy, and whether any cluster
      // this student sat in was actually anchored to the lecturer
      let band = 'none', peers = 0, entropy = 1, member = false, clusterSize = 0;
      let bound = false;
      for (const e of mine) {
        if (RANK[e.confidence_band] > RANK[band]) band = e.confidence_band;
        peers = Math.max(peers, e.corroborating_devices || 0);
        entropy = Math.min(entropy, e.entropy_score == null ? 1 : e.entropy_score);
        if (e.cluster_member) member = true;
        const w = byWindow[e.window_id] || {};
        clusterSize = Math.max(clusterSize, w.cluster_size || 0);
        if (w.lecturer_bound) bound = true;
      }
      acoustic = {
        available: true,
        clusterMember: member,
        confidenceBand: band,
        corroboratingDevices: peers,
        clusterSize: clusterSize,
        windowsPresent: row.windows_present || mine.filter(e => e.cluster_member).length,
        windowsAnalysed: row.windows_analysed || ids.length,
        lecturerBound: bound,
        entropyScore: entropy
      };
    }

    const verdict = fuse(row.verification, acoustic);
    const res = await sb().rpc('aa_set_fused', {
      p_session: sessionId, p_student: row.student_id, p_fused: verdict
    });
    if (!res.error && res.data) changed++;
  }

  return { total: register.length, changed };
}

// =====================================================================
// student
// =====================================================================

let stuMic = null, watching = false, seen = new Set();

/**
 * Called once, from a tap, after the student has checked in. The microphone
 * stays open for the class - only a rolling tail is held, in memory - and each
 * window the lecturer opens is captured automatically.
 */
async function startListening(sessionId, onState) {
  const say = s => onState && onState(s);
  await syncClock();

  if (!stuMic) {
    say({ phase: 'mic', text: 'Asking for the microphone…' });
    stuMic = await openMic(now, AC_CFG.MIC_BUFFER_SECONDS);
  }
  const { data: { user } } = await sb().auth.getUser();

  watching = true;
  say({ phase: 'waiting', text: 'Listening for your lecturer to open a window' });

  (async function loop() {
    while (watching) {
      let win = null;
      try { win = await pendingWindow(sessionId); }
      catch (e) { await sleep(4000); continue; }

      if (!win || seen.has(win.id)) { await sleep(AC_CFG.POLL_MS); continue; }

      try {
        const fp = await captureAndSubmit(stuMic, win, user.id, left => {
          if (!watching) return;
          say(left > 0
            ? { phase: 'countdown', seconds: Math.ceil(left),
                text: 'Window ' + (win.idx + 1) + ' — recording in ' + Math.ceil(left) }
            : { phase: 'listening', text: 'Listening…' });
        });
        seen.add(win.id);
        say({ phase: 'submitted', window: win.idx + 1, hashes: fp.hashes.length,
              text: 'Window ' + (win.idx + 1) + ' sent. Waiting for the next one.' });
      } catch (e) {
        seen.add(win.id);
        say({ phase: 'error', text: e.message });
        await sleep(2000);
      }
    }
  })();
}

function stopListening() {
  watching = false;
  if (stuMic) { stuMic.close(); stuMic = null; }
  seen = new Set();
}

const acousticConfig = AC_CFG;

// The app is a classic script, so hand it plain globals.
window.uvnAcoustic = {
  openListeningWindow, matchWindow, fuseSession, releaseLecturerMic,
  startListening, stopListening, config: AC_CFG
};
window.dispatchEvent(new Event('uvn-acoustic-ready'));
})();
