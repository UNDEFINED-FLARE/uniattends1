/* =====================================================================
   LOCATION ENGINE — GPS polygon containment and the check-in score.
   Pure functions, shared unchanged with univen.html.
   ===================================================================== */
const DEFAULT_RADIUS_METERS = 50;

const GPS_GOOD_ENOUGH_ACCURACY = 20;     // metres — stop early once we get a fix this good;

const VERIFY_CFG = {
  windowMs: 9000,        // how long to keep sampling
  sampleEveryMs: 1200,
  targetSamples: 8,      // stop early once we have this many
  autoPass: 0.72,        // score at or above this marks present outright
  reviewFloor: 0.42,     // below this the check-in is refused
  tokenTtlMs: 90000,     // how long a scanned rotating code stays valid
  tokenRotateMs: 30000,  // how often the lecturer's QR regenerates
  maxSpeedMps: 12        // ~43 km/h between two readings = not a walking student
};

function haversineMeters(lat1, lng1, lat2, lng2){
  const R = 6371000;
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2-lat1), dLng = toRad(lng2-lng1);
  const a = Math.sin(dLat/2)**2 + Math.cos(toRad(lat1))*Math.cos(toRad(lat2))*Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Flattens lat/lng to local metres around an origin point — accurate
// enough for building-sized areas, and lets us do plain 2D geometry
// (point-in-polygon, distance-to-edge) instead of spherical math.
function projectToMeters(lat, lng, originLat, originLng){
  const x = (lng - originLng) * Math.cos(originLat * Math.PI/180) * 111320;
  const y = (lat - originLat) * 110540;
  return { x, y };
}

function pointInPolygon(pt, poly){
  let inside = false;
  for(let i=0, j=poly.length-1; i<poly.length; j=i++){
    const xi=poly[i].x, yi=poly[i].y, xj=poly[j].x, yj=poly[j].y;
    const intersect = ((yi>pt.y) !== (yj>pt.y)) && (pt.x < (xj-xi)*(pt.y-yi)/(yj-yi)+xi);
    if(intersect) inside = !inside;
  }
  return inside;
}

function distToSegmentMeters(p, a, b){
  const dx=b.x-a.x, dy=b.y-a.y;
  const lenSq = dx*dx+dy*dy;
  let t = lenSq===0 ? 0 : ((p.x-a.x)*dx + (p.y-a.y)*dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const projX = a.x + t*dx, projY = a.y + t*dy;
  return Math.hypot(p.x-projX, p.y-projY);
}

function distToPolygonEdgeMeters(pt, poly){
  let min = Infinity;
  for(let i=0, j=poly.length-1; i<poly.length; j=i++){
    const d = distToSegmentMeters(pt, poly[j], poly[i]);
    if(d<min) min = d;
  }
  return min;
}

function polygonCentroid(points){
  let x=0, y=0;
  points.forEach(p=>{ x+=p.lat; y+=p.lng; });
  return { lat: x/points.length, lng: y/points.length };
}

function medianOf(arr){
  if(!arr.length) return 0;
  const a = [...arr].sort((x,y)=>x-y), m = a.length>>1;
  return a.length%2 ? a[m] : (a[m-1]+a[m])/2;
}

function logistic(x, midpoint, steepness){
  return 1/(1+Math.exp((x-midpoint)/Math.max(0.001, steepness)));
}

function getDeviceId(){
  let id = null;
  try{ id = localStorage.getItem('uvn_device_id'); }catch(e){}
  if(!id){
    id = 'd_' + Math.random().toString(36).slice(2,10) + Date.now().toString(36);
    try{ localStorage.setItem('uvn_device_id', id); }catch(e){}
  }
  return id;
}

function collectGpsSamples(onSample){
  return new Promise((resolve, reject)=>{
    if(!navigator.geolocation){ reject(new Error('This device cannot report its location')); return; }
    const samples = [];
    const startedAt = Date.now();
    let done = false, lastErr = null;
    const finish = ()=>{
      if(done) return;
      done = true;
      clearInterval(interval); clearTimeout(timer);
      if(samples.length) resolve(samples);
      else reject(lastErr || new Error('No location readings came through'));
    };
    const take = ()=>{
      navigator.geolocation.getCurrentPosition(
        pos=>{
          if(done) return;
          samples.push({
            lat: pos.coords.latitude,
            lng: pos.coords.longitude,
            accuracy: pos.coords.accuracy || 999,
            altitude: pos.coords.altitude,
            t: Date.now()
          });
          if(onSample) onSample(samples, Date.now()-startedAt);
          if(samples.length >= VERIFY_CFG.targetSamples) finish();
        },
        err=>{ lastErr = new Error(err.message); if(samples.length===0 && err.code===1) finish(); },
        { enableHighAccuracy:true, maximumAge:0, timeout:5000 }
      );
    };
    take();
    const interval = setInterval(take, VERIFY_CFG.sampleEveryMs);
    const timer = setTimeout(finish, VERIFY_CFG.windowMs);
  });
}

function robustFix(samples){
  const lats = samples.map(s=>s.lat), lngs = samples.map(s=>s.lng);
  const mLat = medianOf(lats), mLng = medianOf(lngs);
  const dists = samples.map(s=>haversineMeters(s.lat, s.lng, mLat, mLng));
  const medDist = medianOf(dists);
  const mad = medianOf(dists.map(d=>Math.abs(d-medDist)));
  const cutoff = Math.max(15, medDist + 3*mad);
  let kept = samples.filter((s,i)=>dists[i] <= cutoff);
  if(!kept.length) kept = samples;

  let wsum=0, lat=0, lng=0;
  kept.forEach(s=>{
    const w = 1/Math.max(9, s.accuracy*s.accuracy);
    wsum += w; lat += s.lat*w; lng += s.lng*w;
  });
  lat /= wsum; lng /= wsum;

  const spread = kept.length>1 ? medianOf(kept.map(s=>haversineMeters(s.lat,s.lng,lat,lng))) : 0;
  const bestAcc = Math.min(...kept.map(s=>s.accuracy));
  const meanAcc = kept.reduce((a,s)=>a+s.accuracy,0)/kept.length;
  const accuracy = Math.max(3, Math.min(meanAcc, Math.max(spread, bestAcc/Math.sqrt(kept.length))));

  return { lat, lng, accuracy: Math.round(accuracy*10)/10, bestAccuracy: Math.round(bestAcc),
           spread: Math.round(spread*10)/10, used: kept.length, dropped: samples.length-kept.length,
           total: samples.length, timestamp: Date.now() };
}

function signedDistanceToPolygon(pt, polygonLatLng){
  const origin = polygonLatLng[0];
  const polyM = polygonLatLng.map(v=>projectToMeters(v.lat, v.lng, origin.lat, origin.lng));
  const p = projectToMeters(pt.lat, pt.lng, origin.lat, origin.lng);
  const d = distToPolygonEdgeMeters(p, polyM);
  return pointInPolygon(p, polyM) ? -d : d;
}

function containmentProbability(pt, session){
  let signed;
  if(session.venuePolygon && session.venuePolygon.length >= 3){
    signed = signedDistanceToPolygon(pt, session.venuePolygon);
  }else{
    const radius = session.radiusMeters || DEFAULT_RADIUS_METERS;
    signed = haversineMeters(pt.lat, pt.lng, session.lat, session.lng) - radius;
  }
  const sigma = Math.max(4, (pt.accuracy||20)*0.6);
  return { p: logistic(signed, 0, sigma), signedDistance: signed };
}

function sampleAgreement(samples, session){
  if(!samples.length) return 0;
  let inside = 0;
  samples.forEach(s=>{ if(containmentProbability(s, session).p >= 0.5) inside++; });
  return inside/samples.length;
}

function integrityFlags(samples, fix){
  const flags = [];
  // Apparent speed only counts once the jump is bigger than the two
  // readings' own error bars. Otherwise ordinary jitter on a weak
  // signal would look like teleporting every single time.
  let maxSpeed = 0;
  for(let i=1;i<samples.length;i++){
    const dt = (samples[i].t - samples[i-1].t)/1000;
    if(dt < 0.3) continue;
    const jump = haversineMeters(samples[i].lat, samples[i].lng, samples[i-1].lat, samples[i-1].lng);
    const explained = samples[i].accuracy + samples[i-1].accuracy;
    const v = Math.max(0, jump - explained)/dt;
    if(v > maxSpeed) maxSpeed = v;
  }
  if(maxSpeed > VERIFY_CFG.maxSpeedMps){
    flags.push({ code:'teleport', weight:0.5, label:`Position jumped ${Math.round(maxSpeed)} m/s further than the signal error explains` });
  }
  const uniquePts = new Set(samples.map(s=>s.lat.toFixed(6)+','+s.lng.toFixed(6)));
  if(samples.length >= 4 && uniquePts.size === 1){
    flags.push({ code:'frozen', weight:0.6, label:'Every reading was byte-identical — real GPS always wobbles, mock-location apps do not' });
  }
  const uniqueAcc = new Set(samples.map(s=>s.accuracy));
  if(samples.length >= 4 && uniqueAcc.size === 1 && samples[0].accuracy <= 5){
    flags.push({ code:'synthetic', weight:0.2, label:'Accuracy stayed pinned at one impossibly clean value' });
  }
  if(fix.spread > 60){
    flags.push({ code:'unstable', weight:0.15, label:'Readings scattered widely — signal here is poor' });
  }
  return { flags, maxSpeed: Math.round(maxSpeed*10)/10 };
}

/* Where is the rest of the room? Students already checked in form a cloud;
   anyone far outside it is the outlier worth a second look.

   The aggregate arrives from aa_peer_centroid() rather than being derived on
   the device. Row-level security means a student can read only their own
   register row, so computing this client-side saw zero peers and silently
   fell back to neutral - and a student has no business seeing a classmate's
   coordinates anyway. The server returns the centroid and spread, nothing
   individual. */
function roomConsensus(session, fix, myStudentNumber, agg){
  const peers = (agg && agg.peers) || 0;
  if(peers < 3) return { available:false, score:0.6, peers, distance:null };
  const distance = haversineMeters(fix.lat, fix.lng, agg.lat, agg.lng);
  const typical = Number(agg.spread) || 8;
  const tolerance = Math.max(20, typical*2 + fix.accuracy);
  return {
    available: true,
    score: logistic(distance, tolerance, Math.max(6, tolerance*0.35)),
    peers,
    distance: Math.round(distance)
  };
}

function presenceProof(session, scannedToken){
  const live = session.liveToken;
  if(scannedToken && live && scannedToken === live.value){
    const age = Date.now() - (live.at || 0);
    if(age <= VERIFY_CFG.tokenTtlMs) return { score:1, label:'Live code scanned', detail:'Scanned a rotating code straight off the lecturer\u2019s screen' };
    return { score:0.7, label:'Code slightly stale', detail:'The scanned code had already rotated' };
  }
  if(scannedToken) return { score:0.5, label:'Old code', detail:'This code has been replaced — it may have been forwarded' };
  return { score:0.62, label:'Session ID entered', detail:'Identified by session ID rather than a live scan' };
}

function scoreCheckIn(input){
  const { fix, samples, session, scannedToken, studentNumber } = input;
  const containment = containmentProbability(fix, session);
  const agreement   = sampleAgreement(samples, session);
  const precision   = logistic(fix.accuracy, 35, 11);
  const consensus   = roomConsensus(session, fix, studentNumber, input.peerAgg);
  const presence    = presenceProof(session, scannedToken);
  const integrity   = integrityFlags(samples, fix);

  const penalty = integrity.flags.reduce((a,f)=>a+f.weight, 0);
  const integrityScore = Math.max(0, 1 - penalty);

  // Integrity is a discount on the whole result, not one slice of it.
  // Location evidence that is itself suspect should not be able to
  // carry a check-in on the strength of a tidy-looking polygon match.
  const weights = { containment:.37, agreement:.21, precision:.13, consensus:.15, presence:.14 };
  const evidence =
      weights.containment * containment.p +
      weights.agreement   * agreement +
      weights.precision   * precision +
      weights.consensus   * consensus.score +
      weights.presence    * presence.score;
  let score = Math.max(0, Math.min(1, evidence * integrityScore));

  const hardFail = integrity.flags.some(f => f.code === 'frozen' || f.code === 'teleport');
  let tier;
  if(hardFail) tier = 'rejected';
  else if(score >= VERIFY_CFG.autoPass) tier = 'verified';
  else if(score >= VERIFY_CFG.reviewFloor) tier = 'review';
  else tier = 'rejected';

  const reasons = [];
  if(containment.p < 0.5) reasons.push(`the fix sits about ${Math.round(Math.abs(containment.signedDistance))}m outside the venue`);
  if(agreement < 0.5 && samples.length > 2) reasons.push(`only ${Math.round(agreement*100)}% of readings landed inside`);
  if(precision < 0.5) reasons.push(`accuracy was only \u00b1${Math.round(fix.accuracy)}m`);
  if(consensus.available && consensus.score < 0.5) reasons.push(`they were ${consensus.distance}m from where the rest of the class is sitting`);
  if(presence.score < 0.65) reasons.push(presence.detail.toLowerCase());
  integrity.flags.forEach(f=>reasons.push(f.label.toLowerCase()));

  return {
    score: Math.round(score*100)/100,
    tier,
    reasons,
    flags: integrity.flags.map(f=>({ code:f.code, label:f.label })),
    factors: {
      containment: Math.round(containment.p*100)/100,
      distance: Math.round(containment.signedDistance),
      agreement: Math.round(agreement*100)/100,
      precision: Math.round(precision*100)/100,
      accuracy: fix.accuracy,
      spread: fix.spread,
      samples: fix.total,
      dropped: fix.dropped,
      consensusScore: Math.round(consensus.score*100)/100,
      consensusPeers: consensus.peers,
      consensusDistance: consensus.distance,
      presence: presence.label,
      presenceScore: presence.score,
      integrity: Math.round(integrityScore*100)/100,
      maxSpeed: integrity.maxSpeed
    },
    engine: 2
  };
}
