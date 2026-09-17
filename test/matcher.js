// Stages 6 and 7: pairwise matching with offset consistency, then clustering.
//
// This file is deployed verbatim as supabase/functions/analyse-window/matcher.js
// in the acvosa project, and is the same code test/bench.mjs runs against. Edit
// it here, run the bench, then redeploy. The two must never drift: if they do,
// the bench is validating something that is not deciding attendance.

export const MATCH_DEFAULTS = {
  deltaTolerance: 2,        // histogram bins merged either side (1 frame = 16 ms)
  backgroundRadius: 40,     // +/- frames of neighbourhood used as the chance floor
  maxOffsetsPerHash: 8,     // guard against pathological repeat hashes
  pairThreshold: 7.5,       // in sigma above the histogram's own chance floor
  minSharpness: 0.04,       // peak bin / total matches; low = smeared = suspect
  minDensity: 0.45,         // fraction of cluster a node must corroborate with
  minClusterSize: 3,
  lowEntropy: 0.35,         // below this the window is not treated as evidence

  // --- evidence floors, added after the bench found a false-accept path
  //
  // z is computed against a background estimated from the neighbourhood of the
  // peak. When two devices barely match at all that neighbourhood is empty, so
  // the background is ~0, the denominator collapses to sqrt(0+1) = 1, and a
  // handful of coincidental matches reports as many sigma. In the bench a
  // silent-room device drew 8.7 sigma to the lecturer off 33 matches.
  //
  // No statistic recovers from this, because the hashes themselves are
  // correlated: two noise-dominated recordings pick similar spurious peaks. The
  // answer is not a better test but a minimum amount of evidence to test.
  // Genuine co-presence produced 2419-2672 matches; every out-of-room pair
  // produced 105 or fewer. Both floors sit in that gap, an order of magnitude
  // clear of real pairs on one side and comfortably above coincidence on the
  // other. Failing them costs a student nothing worse than review.
  minMatches: 120,          // absolute floor on total matches for an edge
  minMatchRate: 0.35,       // and relative to the smaller hash set, so the
                            // floor scales with capture length and density

  // Alignment sharpness falls with signal-to-noise, so the back of a large
  // hall looks smeared for the same reason a relay does. Judge it against the
  // sharpness this room actually produced rather than a fixed number.
  relaySharpnessFraction: 0.45,
  relaySharpness: 0.10,     // fallback when there is no core to compare against
};

// ------------------------------------------------- Stage 6: pairwise matching

// a, b: { hashes: number[], offsets: number[] } - parallel arrays.
export function pairScore(a, b, opts = {}) {
  const o = { ...MATCH_DEFAULTS, ...opts };

  const index = new Map();
  for (let i = 0; i < a.hashes.length; i++) {
    const h = a.hashes[i];
    let arr = index.get(h);
    if (!arr) index.set(h, arr = []);
    if (arr.length < o.maxOffsetsPerHash) arr.push(a.offsets[i]);
  }

  const hist = new Map();
  let matches = 0;
  const seen = new Map();
  for (let j = 0; j < b.hashes.length; j++) {
    const h = b.hashes[j];
    const arr = index.get(h);
    if (!arr) continue;
    const used = seen.get(h) || 0;
    if (used >= o.maxOffsetsPerHash) continue;
    seen.set(h, used + 1);
    const offB = b.offsets[j];
    for (const offA of arr) {
      const delta = offA - offB;
      hist.set(delta, (hist.get(delta) || 0) + 1);
      matches++;
    }
  }

  let peakBin = 0, bestDelta = 0;
  for (const delta of hist.keys()) {
    let sum = 0;
    for (let d = delta - o.deltaTolerance; d <= delta + o.deltaTolerance; d++) {
      sum += hist.get(d) || 0;
    }
    if (sum > peakBin) { peakBin = sum; bestDelta = delta; }
  }

  const background = localBackground(hist, bestDelta, o.deltaTolerance, o.backgroundRadius);
  const z = (peakBin - background) / Math.sqrt(background + 1);

  return {
    score: z,
    peakBin,
    background: +background.toFixed(2),
    matches,
    delta: bestDelta,
    sharpness: matches > 0 ? peakBin / matches : 0,
    rawScore: peakBin / Math.sqrt(Math.max(1, a.hashes.length) * Math.max(1, b.hashes.length)),
    histogram: hist,
  };
}

function localBackground(hist, centre, tol, radius) {
  const width = 2 * tol + 1;
  let sum = 0, bins = 0;
  for (let d = centre - radius; d <= centre + radius; d++) {
    if (d >= centre - tol && d <= centre + tol) continue;   // the peak itself
    sum += hist.get(d) || 0;
    bins++;
  }
  if (!bins) return 0;
  return (sum / bins) * width;
}

export function scoreAll(subs, opts = {}) {
  const pairs = [];
  for (let i = 0; i < subs.length; i++) {
    for (let j = i + 1; j < subs.length; j++) {
      const r = pairScore(subs[i], subs[j], opts);
      pairs.push({ a: i, b: j, ...r });
    }
  }
  return pairs;
}

// ----------------------------------------------------------- Stage 7: clustering

function connectedComponents(n, adj) {
  const seen = new Array(n).fill(false);
  const comps = [];
  for (let s = 0; s < n; s++) {
    if (seen[s]) continue;
    const stack = [s], comp = [];
    seen[s] = true;
    while (stack.length) {
      const v = stack.pop();
      comp.push(v);
      for (const w of adj[v]) if (!seen[w]) { seen[w] = true; stack.push(w); }
    }
    comps.push(comp);
  }
  return comps;
}

export function cluster(subs, pairs, opts = {}) {
  const o = { ...MATCH_DEFAULTS, ...opts };
  const n = subs.length;
  const adj = Array.from({ length: n }, () => new Set());
  const edges = [];

  for (const p of pairs) {
    // enough evidence to be worth testing at all
    const smaller = Math.min(subs[p.a].hashes.length, subs[p.b].hashes.length);
    p.qualified = p.matches >= o.minMatches &&
                  p.matches >= o.minMatchRate * smaller;

    if (p.qualified && p.score >= o.pairThreshold && p.sharpness >= o.minSharpness) {
      adj[p.a].add(p.b);
      adj[p.b].add(p.a);
      edges.push(p);
    }
  }

  const comps = connectedComponents(n, adj);
  comps.sort((x, y) => y.length - x.length);
  let core = comps[0] || [];

  let changed = true;
  while (changed && core.length >= o.minClusterSize) {
    changed = false;
    const inCore = new Set(core);
    const next = core.filter((v) => {
      let deg = 0;
      for (const w of adj[v]) if (inCore.has(w)) deg++;
      return deg >= o.minDensity * (core.length - 1);
    });
    if (next.length !== core.length) { core = next; changed = true; }
  }
  if (core.length < o.minClusterSize) core = [];

  return { core: new Set(core), adj, edges, components: comps };
}

export function buildEvidence(subs, pairs, clusterResult, opts = {}) {
  const o = { ...MATCH_DEFAULTS, ...opts };
  const { core, adj } = clusterResult;
  const n = subs.length;

  const sharpTo = Array.from({ length: n }, () => []);
  const scoreTo = Array.from({ length: n }, () => []);
  for (const p of pairs) {
    // an unqualified pair is noise, and must not colour anyone's averages
    if (p.qualified === false) continue;
    if (core.has(p.b)) { sharpTo[p.a].push(p.sharpness); scoreTo[p.a].push(p.score); }
    if (core.has(p.a)) { sharpTo[p.b].push(p.sharpness); scoreTo[p.b].push(p.score); }
  }
  const mean = (xs) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);

  // What sharpness did THIS room produce? A quiet hall with distant handsets is
  // smeared everywhere, and that is a property of the venue, not evidence of a
  // relay. Compare each device against its peers instead of a fixed constant.
  const coreSharp = pairs
    .filter((p) => p.qualified !== false && core.has(p.a) && core.has(p.b))
    .map((p) => p.sharpness)
    .sort((x, y) => x - y);
  const medianCoreSharp = coreSharp.length
    ? coreSharp[Math.floor(coreSharp.length / 2)] : 0;
  const relayFloor = medianCoreSharp > 0
    ? o.relaySharpnessFraction * medianCoreSharp
    : o.relaySharpness;

  const coreSize = core.size;
  return subs.map((sub, i) => {
    const reasons = [];
    const member = core.has(i);

    let coreDeg = 0;
    for (const w of adj[i]) if (core.has(w) && w !== i) coreDeg++;
    const denom = Math.max(1, coreSize - (member ? 1 : 0));
    const degreeFraction = coreDeg / denom;

    const entropyScore = sub.entropy ? sub.entropy.score : 1;
    const meanSharp = mean(sharpTo[i]);

    let band;
    if (member && degreeFraction >= 0.6) band = 'high';
    else if (member) band = 'medium';
    else if (coreDeg > 0) band = 'low';
    else band = 'none';

    if (member) {
      reasons.push({
        code: 'cluster_member',
        detail: `corroborated by ${coreDeg} of ${denom} confirmed devices in the room`,
      });
    } else if (coreDeg > 0) {
      reasons.push({
        code: 'partial_correlation',
        detail: `matched ${coreDeg} of ${denom} room devices - consistent with a doorway, a propped-open door, or a thin partition`,
      });
    } else {
      reasons.push({
        code: 'no_corroboration',
        detail: 'no device in the room heard what this device heard',
      });
    }

    if (entropyScore < o.lowEntropy) {
      reasons.push({
        code: 'low_entropy_window',
        detail: `captured audio was too quiet or too stationary (entropy ${entropyScore.toFixed(2)}) to be decisive`,
      });
      if (band === 'high') band = 'medium';
      else if (band === 'medium') band = 'low';
    }

    if (member && meanSharp > 0 && meanSharp < relayFloor) {
      reasons.push({
        code: 'diffuse_alignment',
        detail: `alignment histogram is smeared (sharpness ${meanSharp.toFixed(2)} against a room median of ${medianCoreSharp.toFixed(2)}) - consistent with relayed or codec-degraded audio; review`,
      });
      if (band === 'high') band = 'medium';
      else if (band === 'medium') band = 'low';
    }

    if (band === 'none') {
      reasons.push({
        code: 'routed_to_review',
        detail: 'recorded as unclustered, not as absent - routed to lecturer review',
      });
    }

    return {
      index: i,
      studentId: sub.studentId,
      displayName: sub.displayName,
      role: sub.role,
      clusterMember: member,
      confidenceBand: band,
      degreeFraction: +degreeFraction.toFixed(3),
      corroboratingDevices: coreDeg,
      meanScore: +mean(scoreTo[i]).toFixed(4),
      meanSharpness: +meanSharp.toFixed(3),
      entropyScore: +entropyScore.toFixed(3),
      hashCount: sub.hashes.length,
      reasons,
    };
  });
}

export function analyseWindow(subs, opts = {}) {
  const o = { ...MATCH_DEFAULTS, ...opts };
  const pairs = scoreAll(subs, o);
  const clusterResult = cluster(subs, pairs, o);
  const evidence = buildEvidence(subs, pairs, clusterResult, o);

  const lecturerIdx = subs.findIndex((s) => s.role === 'lecturer');
  const lecturerBound = lecturerIdx >= 0 && clusterResult.core.has(lecturerIdx);

  if (lecturerIdx >= 0 && !lecturerBound) {
    for (const e of evidence) {
      e.reasons.push({
        code: 'session_not_bound',
        detail: 'the lecturer device is not in this cluster - the cluster is not tied to this session',
      });
      if (e.confidenceBand === 'high') e.confidenceBand = 'medium';
    }
  }

  // Only pairs that cleared the evidence floors belong here. A z-score built on
  // thirty coincidental matches is not a measurement, and letting it into the
  // reported margin would show an overlap that does not exist.
  const inCore = [], outCore = [];
  for (const p of pairs) {
    if (p.qualified === false) continue;
    (clusterResult.core.has(p.a) && clusterResult.core.has(p.b) ? inCore : outCore).push(p.score);
  }
  const stats = (xs) => {
    if (!xs.length) return { n: 0, min: 0, max: 0, mean: 0, median: 0 };
    const s = [...xs].sort((x, y) => x - y);
    return {
      n: s.length,
      min: +s[0].toFixed(4),
      max: +s[s.length - 1].toFixed(4),
      mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(4),
      median: +s[Math.floor(s.length / 2)].toFixed(4),
    };
  };

  return {
    pairs,
    cluster: clusterResult,
    evidence,
    clusterSize: clusterResult.core.size,
    lecturerBound,
    distributions: { inCluster: stats(inCore), outCluster: stats(outCore) },
    params: o,
  };
}
