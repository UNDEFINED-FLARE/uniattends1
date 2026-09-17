// node test/fuse.test.mjs
//
// The cases that matter are the disagreements. Anyone can fuse two signals
// that already agree.

import fs from 'fs';
fs.mkdirSync('test/.tmp', { recursive: true });
fs.writeFileSync('test/.tmp/fuse.mjs', fs.readFileSync('js/fuse.js', 'utf8'));
const { fuse } = await import('./.tmp/fuse.mjs');

// a location verdict in the shape the UNIVEN app stores
const gps = (score, tier, opts = {}) => ({
  score, tier, reasons: [], flags: opts.flags || [],
  factors: {
    consensusScore: opts.consensus ?? 0,
    consensusPeers: opts.peers ?? 0,
    accuracy: opts.accuracy ?? 18
  }
});

// folded acoustic evidence across a class's windows
const heard = (o = {}) => ({
  available: true,
  clusterMember: o.member ?? true,
  confidenceBand: o.band ?? 'high',
  corroboratingDevices: o.peers ?? 9,
  clusterSize: o.clusterSize ?? 12,
  windowsPresent: o.present ?? 3,
  windowsAnalysed: o.total ?? 3,
  lecturerBound: o.bound ?? true,
  entropyScore: o.entropy ?? 0.8
});

const cases = [
  {
    name: 'no window ran - the location verdict is untouched',
    gps: gps(0.80, 'verified', { consensus: 0.8, peers: 6 }),
    acoustic: { available: false },
    expect: { tier: 'verified', score: 0.8, agreement: 'location-only' }
  },
  {
    name: 'both agree - corroboration lifts, stays verified',
    gps: gps(0.78, 'verified', { consensus: 0.8, peers: 6 }),
    acoustic: heard(),
    expect: { tier: 'verified', agreement: 'corroborated', min: 0.78 }
  },
  {
    name: 'THE RESCUE: bad indoor fix, but the phone heard the room',
    gps: gps(0.55, 'review', { consensus: 0.6, peers: 5, accuracy: 44 }),
    acoustic: heard(),
    expect: { tier: 'verified', agreement: 'acoustic-rescue' }
  },
  {
    name: 'THE CATCH: location looks perfect, the room never heard them',
    gps: gps(0.80, 'verified', { consensus: 0.8, peers: 6 }),
    acoustic: heard({ member: false, band: 'none', present: 0 }),
    expect: { tier: 'review', agreement: 'contradicted' }
  },
  {
    name: 'a contradiction never becomes an absence on its own',
    gps: gps(0.74, 'verified', { consensus: 0.9, peers: 8 }),
    acoustic: heard({ member: false, band: 'none', present: 0 }),
    expect: { tierNot: 'rejected' }
  },
  {
    name: 'GPS rejected but acoustically present - a human looks, not a machine',
    gps: gps(0.35, 'rejected'),
    acoustic: heard(),
    expect: { tier: 'review', agreement: 'acoustic-rescue' }
  },
  {
    name: 'a quiet room costs nobody their peer-consensus credit',
    gps: gps(0.80, 'verified', { consensus: 0.7, peers: 5 }),
    acoustic: heard({ member: false, band: 'none', present: 0, entropy: 0.2 }),
    expect: { tier: 'verified', score: 0.8, agreement: 'acoustic-inconclusive' }
  },
  {
    name: 'too few devices captured - absence proves nothing',
    gps: gps(0.80, 'verified', { consensus: 0.7, peers: 5 }),
    acoustic: heard({ member: false, band: 'none', present: 0, clusterSize: 2 }),
    expect: { tier: 'verified', agreement: 'acoustic-inconclusive' }
  },
  {
    name: 'a cluster without the lecturer cannot convict',
    gps: gps(0.78, 'verified', { consensus: 0.8, peers: 6 }),
    acoustic: heard({ member: false, band: 'none', present: 0, bound: false }),
    expect: { tierNot: 'rejected', agreement: 'acoustic-inconclusive' }
  },
  {
    name: 'present in one window of four is not present in four of four',
    gps: gps(0.60, 'review', { consensus: 0.5, peers: 5 }),
    acoustic: heard({ present: 1, total: 4, band: 'medium' }),
    expect: { tier: 'review' }
  },
  {
    name: 'faking location while genuinely in the room still goes to a human',
    gps: gps(0.40, 'rejected', { flags: [{ code: 'frozen' }] }),
    acoustic: heard(),
    expect: { tier: 'review' }
  }
];

let bad = 0;
for (const c of cases) {
  const r = fuse(c.gps, c.acoustic);
  const e = c.expect;
  const problems = [];
  if (e.tier && r.tier !== e.tier) problems.push(`tier ${r.tier} != ${e.tier}`);
  if (e.tierNot && r.tier === e.tierNot) problems.push(`tier must not be ${e.tierNot}`);
  if (e.agreement && r.agreement !== e.agreement)
    problems.push(`agreement ${r.agreement} != ${e.agreement}`);
  if (e.score !== undefined && Math.abs(r.score - e.score) > 0.001)
    problems.push(`score ${r.score} != ${e.score}`);
  if (e.min !== undefined && r.score < e.min) problems.push(`score ${r.score} < ${e.min}`);

  if (problems.length) bad++;
  console.log((problems.length ? 'FAIL  ' : 'PASS  ') + c.name);
  console.log('        -> ' + r.tier + '  score ' + r.score +
              '  (' + r.agreement + ', acoustic ' + r.acoustic.strength +
              (r.acoustic.decisive ? ', decisive' : ', not decisive') + ')');
  if (problems.length) console.log('        !! ' + problems.join('; '));
}
console.log('\n' + (bad ? bad + ' failing' : 'all ' + cases.length + ' cases pass'));
process.exit(bad ? 1 : 0);
