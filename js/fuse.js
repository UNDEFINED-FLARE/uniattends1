// js/fuse.js - combining the location check-in with the acoustic window.
//
// Two independent systems, deliberately kept independent:
//
//   Location (the UNIVEN app)   GPS polygon containment, sample agreement,
//                               fix precision, peer GPS consensus, a rotating
//                               QR token, and mock-location heuristics.
//                               Answers: "is this phone at this venue?"
//
//   Acoustic (this app)         every device captures the same seconds, the
//                               server matches landmark sets and clusters the
//                               ones that heard the same air, anchored to the
//                               lecturer's own phone.
//                               Answers: "is this phone in this ROOM, now?"
//
// They fail in opposite conditions, which is the whole point of running both:
//
//   GPS is weakest exactly where lectures happen - indoors, under concrete,
//   where a fix drifts tens of metres and cannot tell Hall A from the Hall B
//   next door. It is also the layer a mock-location app defeats outright.
//
//   Acoustic is weakest at the start of a class, when too few devices have
//   captured to form a cluster, and in a silent room. It cannot be faked by
//   mock location, and it cannot be forwarded like a QR screenshot, because
//   the seconds it attests to were not knowable in advance.
//
// So neither is a tiebreaker for the other. Each is authoritative where the
// other is blind, and their agreement is worth more than either alone
// precisely because the two are not fooled by the same trick.

export const FUSE_CFG = {
  autoPass:    0.72,   // same tiers the location engine already uses
  reviewFloor: 0.42,

  // The location engine spends 0.15 of its weight on peer GPS consensus -
  // "are you near the median of everyone else who checked in". Acoustic
  // clustering answers that same question far better. When acoustic evidence
  // exists, that slice is transferred rather than added, otherwise the same
  // fact is counted twice and two correlated signals masquerade as two
  // independent ones.
  consensusWeight: 0.15,

  maxLift:  0.22,      // most that corroboration may add
  maxDrop:  0.30,      // most that contradiction may take away

  // Acoustic evidence is only decisive when the window itself was sound.
  minCorroborating: 2, // devices that must agree before absence means anything
  lowEntropy:       0.35
};

const clamp01 = x => x < 0 ? 0 : x > 1 ? 1 : x;
const r2 = x => Math.round(x * 100) / 100;

/**
 * How much a window's acoustic verdict is worth, in [0,1], before we decide
 * whether it agrees with the location layer.
 *
 * `acoustic` is one student's folded result across the windows of a class:
 *   { available, clusterMember, confidenceBand, corroboratingDevices,
 *     windowsPresent, windowsAnalysed, lecturerBound, entropyScore }
 */
export function acousticStrength(acoustic) {
  if (!acoustic || !acoustic.available) return { score: 0, decisive: false };

  const band = { high: 1, medium: 0.72, low: 0.35, none: 0 }[acoustic.confidenceBand] ?? 0;

  // Being in one window out of four is not the same as being in four of four.
  const total = acoustic.windowsAnalysed || 0;
  const share = total > 0 ? (acoustic.windowsPresent || 0) / total : 0;

  let score = band * (0.45 + 0.55 * share);

  // A cluster that does not contain the lecturer's phone is a room, but not
  // provably THIS class's room.
  if (acoustic.lecturerBound === false) score *= 0.5;

  // A quiet window cannot support a strong conclusion in either direction.
  const quiet = (acoustic.entropyScore ?? 1) < FUSE_CFG.lowEntropy;
  if (quiet) score *= 0.6;

  // Absence of corroboration only counts as evidence when there was a room to
  // corroborate with. Three phones in a lecture theatre is not a quorum.
  const decisive = total > 0 && !quiet &&
    acoustic.lecturerBound !== false &&
    (acoustic.clusterMember
      ? true
      : (acoustic.clusterSize || 0) >= FUSE_CFG.minCorroborating + 1);

  return { score: clamp01(score), decisive, share, quiet, band };
}

/**
 * Fuse one student's two verdicts.
 *
 * @param {object} checkIn  the record's `verification` object from the UNIVEN
 *                          app: { score, tier, factors, flags, reasons }
 * @param {object} acoustic folded acoustic evidence, or { available:false }
 * @returns {{score:number, tier:string, status:string, reasons:string[],
 *            agreement:string, acoustic:object}}
 */
export function fuse(checkIn, acoustic) {
  const gpsScore = typeof checkIn?.score === 'number' ? checkIn.score : 0;
  const gpsTier  = checkIn?.tier || 'review';
  const reasons  = [];

  const a = acousticStrength(acoustic);

  // --- no acoustic evidence: the location verdict stands, unchanged.
  if (!acoustic || !acoustic.available) {
    return finish(gpsScore, gpsTier, 'location-only',
      [...(checkIn?.reasons || [])], a,
      'no listening window was matched for this class');
  }

  // --- transfer, do not add. See FUSE_CFG.consensusWeight.
  // Only transfer when the acoustic layer actually has something to say. An
  // inconclusive window must not quietly cost a student the peer-consensus
  // credit they had already earned - that would make running the audio check
  // worse than not running it.
  const gpsConsensus = checkIn?.factors?.consensusScore;
  const hadConsensus = typeof gpsConsensus === 'number' &&
                       (checkIn?.factors?.consensusPeers || 0) >= 3;
  const acousticSpeaks = a.decisive || a.score >= 0.5;
  let base = gpsScore;
  if (hadConsensus && acousticSpeaks) {
    base = gpsScore - FUSE_CFG.consensusWeight * gpsConsensus +
                      FUSE_CFG.consensusWeight * a.score;
    reasons.push('peer-location consensus replaced by acoustic corroboration');
  }

  const gpsPositive = gpsTier === 'verified';
  const hardFail = (checkIn?.flags || []).some(f => f.code === 'frozen' || f.code === 'teleport');

  let score = base, agreement;

  // Branch on the qualitative fact, not on the number. A student heard in one
  // window of four arrived late, or left early, or had a phone in a bag - they
  // were still in the room, and partial presence is weak corroboration, never
  // contradiction. Scoring alone would fold that case in with never-heard-at-
  // all, which is the opposite of what the evidence says.
  if (acoustic.clusterMember) {
    if (gpsPositive) {
      agreement = 'corroborated';
      score = base + Math.min(FUSE_CFG.maxLift, 0.22 * a.score);
      reasons.push(`heard the room in ${acoustic.windowsPresent} of ${acoustic.windowsAnalysed} windows, alongside ${acoustic.corroboratingDevices} other devices`);
    } else {
      // The interesting case, and the reason to run both. A lecture hall is
      // the worst place on campus for a GPS fix; the acoustic layer does not
      // care about concrete. Corroboration here is a rescue, not a rubber
      // stamp - it lifts, and the tiers decide what that is worth.
      agreement = 'acoustic-rescue';
      score = base + Math.min(FUSE_CFG.maxLift, 0.22 * a.score);
      reasons.push(`location evidence was weak, but the phone heard this room in ${acoustic.windowsPresent} of ${acoustic.windowsAnalysed} windows`);
    }
  } else if (a.decisive && !acoustic.clusterMember) {
    // --- acoustic says: this phone was NOT in the room, and it was in a
    //     position to know.
    agreement = gpsPositive ? 'contradicted' : 'both-weak';
    score = base - Math.min(FUSE_CFG.maxDrop, 0.30 * (1 - a.score));
    reasons.push(gpsPositive
      ? `location looked right, but no device in the room heard what this phone heard across ${acoustic.windowsAnalysed} windows`
      : 'neither the location fix nor the room audio placed this phone here');
  } else {
    // --- acoustic ran but cannot speak: too quiet, too few devices, or a
    //     cluster not bound to the lecturer.
    agreement = 'acoustic-inconclusive';
    reasons.push(a.quiet
      ? 'the room was too quiet for the audio check to be decisive'
      : 'not enough devices captured for the audio check to be decisive');
  }

  let tier = tierFor(score);

  // --- floors and ceilings that neither layer may cross alone.
  //
  // Nothing here produces "rejected" from acoustic silence. A student whose
  // phone is flat, or muted, or simply refused the microphone, must not be
  // marked absent by a system they could not participate in.
  if (agreement === 'contradicted' && tier === 'rejected') tier = 'review';
  if (agreement === 'acoustic-rescue' && tier === 'rejected') tier = 'review';

  // A device that clustered with the room was in the room. Whatever the
  // location layer thought, that cannot end as an absence.
  if (acoustic.clusterMember && tier === 'rejected') tier = 'review';

  // Conversely, a device caught faking its location does not get waved
  // through because it was genuinely in the room. Being present and running a
  // mock-location app at the same time is a discipline question, not an
  // attendance one, and a human should see it.
  if (hardFail) {
    tier = 'review';
    reasons.push('location readings showed signs of tampering - present, but worth a look');
  }

  return finish(score, tier, agreement, reasons, a);
}

function tierFor(score) {
  const s = clamp01(score);
  if (s >= FUSE_CFG.autoPass) return 'verified';
  if (s >= FUSE_CFG.reviewFloor) return 'review';
  return 'rejected';
}

function finish(score, tier, agreement, reasons, a, note) {
  if (note) reasons.push(note);
  return {
    score: r2(clamp01(score)),
    tier,
    status: tier === 'verified' ? 'present'
          : tier === 'review'   ? 'pending-review'
          : 'rejected',
    agreement,
    acoustic: { strength: r2(a.score), decisive: a.decisive },
    reasons,
    engine: 3
  };
}
