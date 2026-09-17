// js/uvn-api.js - the UNIVEN app's data layer, on Supabase.
//
// This replaces every `db.ref(...)` call in the single-file app. The shapes it
// returns are the shapes that app already expects, so the 4,700 lines of UI
// above it keep working: a session still looks like a session, a register row
// still carries `verification`, `gps` and `deviceId`.
//
// What changes underneath is everything that matters. Firebase rules guarded
// paths; Postgres guards rows. A student can read their own attendance and
// their own courses, and nothing else - not the class list, not another
// student's fix, and above all not anyone's acoustic landmarks.

import { sb, now } from './supabase.js';

const unwrap = ({ data, error }) => { if (error) throw error; return data; };
const iso = t => (t ? new Date(t).toISOString() : null);
const ms  = t => (t ? new Date(t).getTime() : null);

// ---------------------------------------------------------------- profiles

export const profiles = {
  get: uid => sb.from('aa_profiles').select('*').eq('id', uid).maybeSingle().then(unwrap),

  byStudentNumber: n => sb.from('aa_profiles')
    .select('*').eq('role', 'student').ilike('student_number', n.trim())
    .maybeSingle().then(unwrap),

  byCardBarcode: b => sb.from('aa_profiles')
    .select('id, student_number, display_name').eq('card_barcode', b)
    .maybeSingle().then(unwrap),

  create: p => sb.from('aa_profiles').insert(p).select().single().then(unwrap),

  update: (uid, patch) => sb.from('aa_profiles')
    .update(patch).eq('id', uid).select().single().then(unwrap)
};

// ---------------------------------------------------------------- courses
// The UNIVEN app calls these "classes": a named roster the lecturer owns.

export const courses = {
  mine: () => sb.from('aa_courses')
    .select('id, code, title, min_attendance_pct, created_at')
    .order('code').then(unwrap),

  get: id => sb.from('aa_courses').select('*').eq('id', id).maybeSingle().then(unwrap),

  create: (lecturerId, code, title, minPct = 75) => sb.from('aa_courses')
    .insert({ lecturer_id: lecturerId, code: code.trim().toUpperCase(),
              title: title.trim(), min_attendance_pct: minPct })
    .select().single().then(unwrap),

  remove: id => sb.from('aa_courses').delete().eq('id', id).then(unwrap),

  roster: courseId => sb.from('aa_enrolments')
    .select('student_id, aa_profiles!aa_enrolments_student_id_fkey(display_name, student_number)')
    .eq('course_id', courseId).then(unwrap)
    .then(rows => rows.map(r => ({
      studentId: r.student_id,
      name: r.aa_profiles?.display_name,
      studentNumber: r.aa_profiles?.student_number
    }))),

  /** by student number, because that is what a class list is written in */
  enrol: (courseId, studentNumber) => sb.rpc('aa_enrol_by_number',
    { p_course: courseId, p_number: studentNumber.trim() }).then(unwrap),

  unenrol: (courseId, studentId) => sb.from('aa_enrolments')
    .delete().eq('course_id', courseId).eq('student_id', studentId).then(unwrap)
};

// ---------------------------------------------------------------- sessions

const SESSION_COLS = `id, course_id, title, venue, join_code, status, started_at,
  ended_at, venue_id, lat, lng, radius_meters, venue_polygon, live_token,
  expires_at, reflection_min_words, absentees,
  aa_courses ( code, title, lecturer_id )`;

/** Postgres row -> the object shape the UNIVEN UI already reads. */
function toSession(r) {
  if (!r) return null;
  return {
    id: r.id,
    sessionId: r.id,
    classId: r.course_id,
    moduleCode: r.aa_courses?.code || '',
    className: r.aa_courses?.title || '',
    lecturerId: r.aa_courses?.lecturer_id || null,
    title: r.title,
    venueName: r.venue,
    venue: r.venue,
    venueId: r.venue_id,
    lat: r.lat, lng: r.lng,
    radiusMeters: r.radius_meters,
    venuePolygon: r.venue_polygon,
    liveToken: r.live_token,
    status: r.status,
    createdAt: ms(r.started_at),
    expiresAt: ms(r.expires_at),
    endedAt: ms(r.ended_at),
    reflectionMinWords: r.reflection_min_words,
    absentees: r.absentees
  };
}

export const sessions = {
  /**
   * Opening a class also seeds a register row per enrolled student, which is
   * what makes "who did NOT come" answerable at all.
   */
  async open({ courseId, title, venue, venueId, lat, lng, radiusMeters,
               polygon, expiresAt, reflectionMinWords }) {
    const row = await sb.rpc('aa_open_class_session',
      { p_course: courseId, p_title: title, p_venue: venue }).then(unwrap);

    const patch = {
      venue_id: venueId ?? null, lat: lat ?? null, lng: lng ?? null,
      radius_meters: radiusMeters ?? null, venue_polygon: polygon ?? null,
      expires_at: iso(expiresAt), reflection_min_words: reflectionMinWords ?? null
    };
    const full = await sb.from('aa_class_sessions')
      .update(patch).eq('id', row.id).select(SESSION_COLS).single().then(unwrap);
    return toSession(full);
  },

  get: id => sb.from('aa_class_sessions').select(SESSION_COLS)
    .eq('id', id).maybeSingle().then(unwrap).then(toSession),

  byJoinCode: code => sb.rpc('aa_join_by_code', { p_code: code }).then(unwrap),

  /** every session of this lecturer's courses, newest first */
  mine: (limit = 200) => sb.from('aa_class_sessions').select(SESSION_COLS)
    .order('started_at', { ascending: false }).limit(limit)
    .then(unwrap).then(rs => rs.map(toSession)),

  /** sessions a student may still check into */
  active: () => sb.from('aa_class_sessions').select(SESSION_COLS)
    .eq('status', 'open')
    .or('expires_at.is.null,expires_at.gt.' + new Date(now()).toISOString())
    .order('started_at', { ascending: false })
    .then(unwrap).then(rs => rs.map(toSession)),

  setToken: (id, value) => sb.from('aa_class_sessions')
    .update({ live_token: { value, at: now() } }).eq('id', id).then(unwrap),

  setAbsentees: (id, list) => sb.from('aa_class_sessions')
    .update({ absentees: list }).eq('id', id).then(unwrap),

  close: id => sb.rpc('aa_close_class_session', { p_session: id }).then(unwrap),

  /** expire it now, without ending the class session itself */
  expire: id => sb.from('aa_class_sessions')
    .update({ expires_at: new Date(now()).toISOString() }).eq('id', id).then(unwrap),

  /**
   * Live updates. Firebase gave this for free with .on('value'); here it is an
   * explicit subscription, which is the honest version - you can see what it
   * costs and when it stops.
   */
  watch(id, onChange) {
    const ch = sb.channel('session:' + id)
      .on('postgres_changes',
        { event: '*', schema: 'public', table: 'aa_attendance',
          filter: 'class_session_id=eq.' + id },
        () => onChange())
      .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'aa_class_sessions',
          filter: 'id=eq.' + id },
        () => onChange())
      .subscribe();
    return () => sb.removeChannel(ch);
  }
};

// ---------------------------------------------------------------- register

const REG_COLS = `class_session_id, student_id, course_id, status, source,
  confidence, windows_present, windows_analysed, reasons, gps, verification,
  device_id, reflection, reflection_word_count, checked_in_at, fused,
  override_note, overridden_at,
  aa_profiles!aa_attendance_student_id_fkey ( display_name, student_number )`;

function toRecord(r) {
  if (!r) return null;
  return {
    studentId: r.student_id,
    studentNumber: r.aa_profiles?.student_number || null,
    name: r.aa_profiles?.display_name || '',
    status: r.status,
    source: r.source,
    confidence: r.confidence,
    timestamp: ms(r.checked_in_at),
    gps: r.gps,
    verification: r.verification,
    deviceId: r.device_id,
    reflection: r.reflection,
    reflectionWordCount: r.reflection_word_count,
    acoustic: { windowsPresent: r.windows_present, windowsAnalysed: r.windows_analysed },
    fused: r.fused,
    reasons: r.reasons,
    overrideNote: r.override_note,
    overriddenAt: ms(r.overridden_at)
  };
}

export const attendance = {
  /**
   * The check-in commit.
   *
   * Firebase used a transaction that aborted when the node already existed.
   * Here the row is seeded when the class opens, so the equivalent guard is an
   * UPDATE that only fires while `checked_in_at` is still null. One statement,
   * no race, and a returned row means "you got it" exactly once.
   */
  async checkIn(sessionId, studentId, { status, gps, verification, deviceId,
                                        reflection, reflectionWordCount }) {
    const rows = await sb.from('aa_attendance').update({
      status,
      source: 'location',
      confidence: verification?.tier || null,
      gps, verification,
      device_id: deviceId,
      reflection: reflection || null,
      reflection_word_count: reflectionWordCount || null,
      checked_in_at: new Date(now()).toISOString(),
      updated_at: new Date(now()).toISOString()
    })
      .eq('class_session_id', sessionId)
      .eq('student_id', studentId)
      .is('checked_in_at', null)
      .select('student_id').then(unwrap);

    return { committed: rows.length > 0 };
  },

  /** has this device already been used by somebody else in this class? */
  async deviceConflict(sessionId, deviceId, myStudentId) {
    const rows = await sb.from('aa_attendance')
      .select('student_id, aa_profiles!aa_attendance_student_id_fkey(display_name, student_number)')
      .eq('class_session_id', sessionId)
      .eq('device_id', deviceId)
      .neq('student_id', myStudentId)
      .limit(1).then(unwrap);
    if (!rows.length) return null;
    return { studentNumber: rows[0].aa_profiles?.student_number,
             name: rows[0].aa_profiles?.display_name };
  },

  forSession: sessionId => sb.from('aa_attendance').select(REG_COLS)
    .eq('class_session_id', sessionId).then(unwrap).then(rs => rs.map(toRecord)),

  /** the GPS cloud the location engine compares a new fix against */
  peerFixes: (sessionId, exceptStudentId) => sb.from('aa_attendance')
    .select('student_id, gps')
    .eq('class_session_id', sessionId)
    .not('gps', 'is', null)
    .neq('status', 'rejected')
    .then(unwrap)
    .then(rs => rs.filter(r => r.student_id !== exceptStudentId && r.gps)
                  .map(r => r.gps)),

  setStatus: (sessionId, studentId, status, note) => sb.rpc('aa_override_attendance',
    { p_session: sessionId, p_student: studentId,
      p_status: status, p_note: note || null }).then(unwrap),

  /** write back what the two layers agreed on */
  setFused: (sessionId, studentId, fused) => sb.from('aa_attendance').update({
    fused,
    status: fused.status === 'present' ? 'present'
          : fused.status === 'rejected' ? 'review' : 'review',
    source: 'fused',
    confidence: fused.tier,
    updated_at: new Date(now()).toISOString()
  }).eq('class_session_id', sessionId).eq('student_id', studentId).then(unwrap),

  mine: (limit = 50) => sb.from('aa_attendance')
    .select(`status, source, confidence, windows_present, windows_analysed,
             checked_in_at, fused, verification,
             aa_class_sessions ( title, venue, started_at ),
             aa_courses ( code, title )`)
    .order('updated_at', { ascending: false }).limit(limit).then(unwrap)
};

// ---------------------------------------------------------------- venues

export const venues = {
  all: () => sb.from('aa_venues').select('*').order('name').then(unwrap),
  create: v => sb.from('aa_venues').insert(v).select().single().then(unwrap),
  update: (id, v) => sb.from('aa_venues').update(v).eq('id', id).then(unwrap),
  remove: id => sb.from('aa_venues').delete().eq('id', id).then(unwrap)
};

// ---------------------------------------------------------------- timetables

export const timetables = {
  mine: () => sb.from('aa_timetables').select('*')
    .order('created_at', { ascending: false }).then(unwrap),
  create: t => sb.from('aa_timetables').insert(t).select().single().then(unwrap),
  update: (id, t) => sb.from('aa_timetables').update(t).eq('id', id).then(unwrap),
  remove: id => sb.from('aa_timetables').delete().eq('id', id).then(unwrap)
};

// ---------------------------------------------------------------- notices

export const notifications = {
  recent: (limit = 30) => sb.from('aa_notifications')
    .select('*, aa_profiles!aa_notifications_posted_by_fkey(display_name)')
    .order('created_at', { ascending: false }).limit(limit).then(unwrap),
  mine: (uid, limit = 20) => sb.from('aa_notifications').select('*')
    .eq('posted_by', uid)
    .order('created_at', { ascending: false }).limit(limit).then(unwrap),
  post: n => sb.from('aa_notifications').insert(n).select().single().then(unwrap),
  remove: id => sb.from('aa_notifications').delete().eq('id', id).then(unwrap)
};

export const uvn = {
  profiles, courses, sessions, attendance, venues, timetables, notifications
};
export default uvn;
