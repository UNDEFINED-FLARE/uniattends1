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

import { openMic, captureAt, analyse } from './fingerprint.js';
import { fuse } from './fuse.js';

const CFG = {
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
  const secs = win.seconds || CFG.CAPTURE_SECONDS;
  const captureAtMs = new Date(win.opens_at).getTime() + CFG.LEAD_MS;

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
    const at = new Date(w.opens_at).getTime() + CFG.LEAD_MS;
    if (at - now() < CFG.MIN_LEAD_MS) continue;
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
export async function openListeningWindow(sessionId, onState) {
  await syncClock();
  const say = s => onState && onState(s);

  if (!lecMic) {
    say({ phase: 'mic', text: 'Asking for the microphone…' });
    lecMic = await openMic(now, CFG.MIC_BUFFER_SECONDS);
  }

  const win = ok(await sb().rpc('aa_open_window',
    { p_session: sessionId, p_seconds: CFG.CAPTURE_SECONDS }));
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

export function releaseLecturerMic() {
  if (lecMic) { lecMic.close(); lecMic = null; }
}

/** Match a window, then fold both layers into the register. */
export async function matchWindow(sessionId, windowId, onState) {
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
export async function fuseSession(sessionId) {
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
export async function startListening(sessionId, onState) {
  const say = s => onState && onState(s);
  await syncClock();

  if (!stuMic) {
    say({ phase: 'mic', text: 'Asking for the microphone…' });
    stuMic = await openMic(now, CFG.MIC_BUFFER_SECONDS);
  }
  const { data: { user } } = await sb().auth.getUser();

  watching = true;
  say({ phase: 'waiting', text: 'Listening for your lecturer to open a window' });

  (async function loop() {
    while (watching) {
      let win = null;
      try { win = await pendingWindow(sessionId); }
      catch (e) { await sleep(4000); continue; }

      if (!win || seen.has(win.id)) { await sleep(CFG.POLL_MS); continue; }

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

export function stopListening() {
  watching = false;
  if (stuMic) { stuMic.close(); stuMic = null; }
  seen = new Set();
}

export const acousticConfig = CFG;

// The app is a classic script, so hand it plain globals.
window.uvnAcoustic = {
  openListeningWindow, matchWindow, fuseSession, releaseLecturerMic,
  startListening, stopListening, config: CFG
};
window.dispatchEvent(new Event('uvn-acoustic-ready'));
