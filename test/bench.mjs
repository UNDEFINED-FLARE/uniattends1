// Offline validation of the client against the DEPLOYED matcher.
//
//   node test/bench.mjs
//
// Synthesises a lecture hall, gives each device its own imperfect version of
// it, runs the real js/fingerprint.js over each, and feeds the result into a
// verbatim copy of the matcher that analyse-window runs server side. If the
// hashing parameters in fingerprint.js ever drift away from what the matcher
// expects, the cluster stops forming and this fails.

import fs from 'fs';
import { analyseWindow, MATCH_DEFAULTS } from './matcher.js';

// load js/fingerprint.js as ESM without touching the shipped file
fs.mkdirSync('test/.tmp', { recursive: true });
fs.writeFileSync('test/.tmp/fingerprint.mjs',
  fs.readFileSync('js/fingerprint.js', 'utf8'));
const { analyse, CFG } = await import('./.tmp/fingerprint.mjs');

const RATE = CFG.RATE, SECS = 5, N = RATE * SECS;
let seed = 7717;
const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff;
                    return seed / 0x7fffffff * 2 - 1; };

// A room: broadband noise plus wandering formants. `wob` is how fast the
// spectrum moves, which is what carries the timing information.
function room(n, tones = [420, 830, 1490, 2600], wob = 0.7, amp = 0.22, floor = 0.25) {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let v = rnd() * floor;
    for (const f of tones)
      v += amp * Math.sin(2 * Math.PI * f * i / RATE +
                          3 * Math.sin(2 * Math.PI * wob * i / RATE));
    out[i] = v;
  }
  return out;
}

// What one phone hears: the room at its own distance, with its own noise,
// its own gain and its own lag.
function heard(src, { noise = 0.05, gain = 1, lagFrames = 0 } = {}) {
  const lag = lagFrames * CFG.HOP;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const s = src[i + lag] === undefined ? 0 : src[i + lag];
    out[i] = s * gain + rnd() * noise;
  }
  return out;
}

const hall = room(N + CFG.HOP * 16);

const devices = [
  ['lecturer', 'lecturer', heard(hall, { noise: 0.04, gain: 1.00 })],
  ['front row', 'student', heard(hall, { noise: 0.05, gain: 0.90, lagFrames: 1 })],
  ['mid hall',  'student', heard(hall, { noise: 0.08, gain: 0.70, lagFrames: 2 })],
  ['back row',  'student', heard(hall, { noise: 0.12, gain: 0.55, lagFrames: 3 })],
  ['far back',  'student', heard(hall, { noise: 0.16, gain: 0.45, lagFrames: 4 })],
  // a different venue entirely: different resonances, different rhythm
  ['other room', 'student', room(N, [310, 705, 1155, 3310], 1.3)],
  // sitting in a silent residence room: a faint hum and nothing else
  ['residence',  'student', room(N, [90], 0.05, 0.004, 0.004)]
];

console.log('device        hashes  entropy  level  change  struct');
const subs = devices.map(([name, role, sig], i) => {
  const fp = analyse(sig);
  const e = fp.entropy;
  console.log(name.padEnd(13) +
    String(fp.hashes.length).padStart(6) +
    e.score.toFixed(3).padStart(9) +
    e.level.toFixed(2).padStart(7) +
    e.change.toFixed(2).padStart(8) +
    e.structure.toFixed(2).padStart(8));
  return { studentId: 'u' + i, displayName: name, role,
           hashes: fp.hashes, offsets: fp.offsets, entropy: fp.entropy };
});

const res = analyseWindow(subs);

console.log('\npairwise z-score (threshold ' + MATCH_DEFAULTS.pairThreshold + ')');
for (const p of res.pairs) {
  const edge = p.qualified && p.score >= MATCH_DEFAULTS.pairThreshold &&
               p.sharpness >= MATCH_DEFAULTS.minSharpness;
  console.log('  ' + (edge ? '*' : p.qualified ? ' ' : 'x') + ' ' +
    devices[p.a][0].padEnd(12) + devices[p.b][0].padEnd(13) +
    'z=' + p.score.toFixed(1).padStart(8) +
    '  peak=' + String(p.peakBin).padStart(4) +
    '  bg=' + p.background.toFixed(2).padStart(7) +
    '  matches=' + String(p.matches).padStart(5) +
    '  sharp=' + p.sharpness.toFixed(3) +
    '  delta=' + String(p.delta).padStart(4));
}

console.log('\nverdicts   (cluster size ' + res.clusterSize +
            ', lecturer bound ' + res.lecturerBound + ')');
for (const e of res.evidence)
  console.log('  ' + e.displayName.padEnd(13) + e.confidenceBand.padEnd(8) +
              (e.clusterMember ? 'in ' : 'out') +
              '  peers=' + String(e.corroboratingDevices).padStart(2) +
              '  deg=' + e.degreeFraction.toFixed(2) +
              '  ' + e.reasons[0].code);

console.log('\ndistributions:', JSON.stringify(res.distributions));

// ---------------------------------------------------------------- assertions
const by = Object.fromEntries(res.evidence.map(e => [e.displayName, e]));
const inRoom = ['lecturer', 'front row', 'mid hall', 'back row', 'far back'];

const clustered = inRoom.filter(n => by[n].clusterMember);

const checks = [
  ['lecturer binds the cluster', res.lecturerBound === true],
  // Not every seat has to make it: a far, quiet handset is allowed to fall out
  // and be reviewed. What must hold is that a quorum of the room agrees.
  ['a quorum of the room clusters', clustered.length >= 4],
  ['clustered students read high or medium',
      clustered.filter(n => n !== 'lecturer')
        .every(n => ['high', 'medium'].includes(by[n].confidenceBand))],
  ['other room excluded', by['other room'].clusterMember === false],
  ['nobody is ever called absent',
      res.evidence.every(e => ['high', 'medium', 'low', 'none']
        .includes(e.confidenceBand))],
  ['silent residence excluded', by['residence'].clusterMember === false],
  ['busy room passes the entropy gate',
      subs.slice(0, 5).every(s => s.entropy.score >= MATCH_DEFAULTS.lowEntropy)],
  ['silent room fails the entropy gate',
      subs[6].entropy.score < MATCH_DEFAULTS.lowEntropy],
  ['no qualified pair outside the room outscores one inside it',
      res.distributions.outCluster.n === 0 ||
      res.distributions.inCluster.min > res.distributions.outCluster.max],

  // the false-accept path the evidence floors close
  ['no out-of-room pair qualifies as evidence',
      res.pairs.filter(p => p.qualified)
        .every(p => inRoom.includes(devices[p.a][0]) &&
                    inRoom.includes(devices[p.b][0]))],
  ['the silent room draws no edge to the lecturer',
      !res.cluster.adj[0].has(6)],
  // and the distance penalty the relative relay check removes
  ['the whole hall now clusters', inRoom.every(n => by[n].clusterMember)],
  ['no in-room device is flagged as a relay',
      inRoom.every(n => !by[n].reasons.some(r => r.code === 'diffuse_alignment'))]
];

let bad = 0;
console.log('');
for (const [name, ok] of checks) {
  if (!ok) bad++;
  console.log((ok ? 'PASS  ' : 'FAIL  ') + name);
}
process.exit(bad ? 1 : 0);
