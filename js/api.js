// js/api.js - every call this app makes against the acvosa backend.
//
// Nothing here invents storage. The aa_* tables, their RLS policies and the
// analyse-window edge function are the contract; this file is the only place
// that names them, so a schema change has one place to land.

import { sb, now } from './supabase.js';
import { TUNING } from './config.js';

const unwrap = ({ data, error }) => { if (error) throw error; return data; };

/** stable per-browser id: one phone, one person, per window */
export function deviceId() {
  let d = localStorage.getItem('aa_device');
  if (!d) {
    d = (crypto.randomUUID && crypto.randomUUID()) ||
        Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('aa_device', d);
  }
  return d;
}

// =====================================================================
// student
// =====================================================================

/** aa_join_by_code checks the code is open AND that you are enrolled. */
export const joinByCode = code =>
  sb.rpc('aa_join_by_code', { p_code: code.trim().toUpperCase() }).then(unwrap);

/**
 * The window a device should be aiming at: most recent, not yet analysed,
 * still open, and with enough lead time left to get the microphone ready.
 * Anything tighter than that is a half-capture, which is worse than none.
 */
export async function pendingWindow(classSessionId) {
  const rows = await sb.from('aa_windows')
    .select('id, idx, seconds, nonce, opens_at, closes_at, analysed_at')
    .eq('class_session_id', classSessionId)
    .is('analysed_at', null)
    .order('idx', { ascending: false })
    .limit(3)
    .then(unwrap);

  for (const w of rows || []) {
    const captureAt = new Date(w.opens_at).getTime() + TUNING.LEAD_MS;
    if (captureAt - now() < TUNING.MIN_LEAD_MS) continue;
    if (now() > new Date(w.closes_at).getTime()) continue;
    return { ...w, capture_at: captureAt };
  }
  return null;
}

/**
 * There is an INSERT policy on aa_submissions and no SELECT policy at all:
 * fingerprints go in and are never readable by any client, which is what stops
 * one student replaying another's landmarks. A duplicate is a plain conflict,
 * not an update, because there is no UPDATE policy either.
 */
export async function submitCapture(windowId, userId, fp) {
  const { error } = await sb.from('aa_submissions').insert({
    window_id: windowId,
    user_id: userId,
    device_id: deviceId(),
    hash_count: fp.hashes.length,
    entropy: fp.entropy,
    hashes: fp.hashes,
    offsets: fp.offsets
  });
  if (error) {
    if (error.code === '23505') return { duplicate: true };
    throw error;
  }
  return { duplicate: false };
}

/** What the student is allowed to attend at all. Empty means "ask to be enrolled". */
export const myEnrolments = () =>
  sb.from('aa_enrolments')
    .select('course_id, aa_courses ( code, title )')
    .then(unwrap);

export const myEvidence = windowId =>
  sb.from('aa_evidence')
    .select('cluster_member, confidence_band, corroborating_devices, reasons')
    .eq('window_id', windowId).maybeSingle().then(unwrap);

export const myAttendance = () =>
  sb.from('aa_attendance')
    .select(`status, source, confidence, windows_present, windows_analysed,
             updated_at,
             aa_class_sessions ( title, venue, started_at ),
             aa_courses ( code, title )`)
    .order('updated_at', { ascending: false })
    .limit(50)
    .then(unwrap);

// =====================================================================
// lecturer
// =====================================================================

export const myCourses = () =>
  sb.from('aa_courses')
    .select('id, code, title, min_attendance_pct')
    .order('code').then(unwrap);

// The INSERT policy requires lecturer_id = auth.uid() AND a profile whose role
// is 'lecturer', so this fails for a student by design.
export const createCourse = (lecturerId, code, title, minPct) =>
  sb.from('aa_courses').insert({
    lecturer_id: lecturerId,
    code: code.trim().toUpperCase(),
    title: title.trim(),
    min_attendance_pct: minPct
  }).select().single().then(unwrap);

export const roster = courseId =>
  sb.from('aa_enrolments')
    .select('student_id, aa_profiles!aa_enrolments_student_id_fkey(display_name, student_number)')
    .eq('course_id', courseId).then(unwrap);

export const enrolByNumber = (courseId, number) =>
  sb.rpc('aa_enrol_by_number', { p_course: courseId, p_number: number.trim() }).then(unwrap);

export const openClassSession = (courseId, title, venue) =>
  sb.rpc('aa_open_class_session',
    { p_course: courseId, p_title: title, p_venue: venue }).then(unwrap);

export const closeClassSession = sessionId =>
  sb.rpc('aa_close_class_session', { p_session: sessionId }).then(unwrap);

export const openWindow = (sessionId, seconds) =>
  sb.rpc('aa_open_window',
    { p_session: sessionId, p_seconds: seconds }).then(unwrap);

export const submissionCount = windowId =>
  sb.rpc('aa_window_submission_count', { p_window: windowId }).then(unwrap);

/**
 * The edge function is the only reader of aa_submissions. It authorises the
 * caller as the lecturer of the course, matches, writes evidence, folds every
 * analysed window into the register, and deletes the fingerprints.
 */
export async function analyseWindow(windowId) {
  const { data, error } = await sb.functions.invoke('analyse-window', {
    body: { windowId }
  });
  if (error) {
    // the function reports its own failures as JSON with a non-2xx status
    let detail = error.message;
    try { detail = (await error.context.json()).error || detail; } catch (e) {}
    throw new Error(detail);
  }
  if (data && data.error) throw new Error(data.error);
  return data;
}

export const windowsOf = sessionId =>
  sb.from('aa_windows')
    .select('id, idx, seconds, opens_at, closes_at, analysed_at, cluster_size, lecturer_bound')
    .eq('class_session_id', sessionId).order('idx').then(unwrap);

export const evidenceOf = windowId =>
  sb.from('aa_evidence')
    .select(`user_id, cluster_member, confidence_band, corroborating_devices,
             degree_fraction, mean_score, mean_sharpness, entropy_score, reasons,
             aa_profiles!aa_evidence_user_id_fkey ( display_name, student_number )`)
    .eq('window_id', windowId).then(unwrap);

export const registerOf = sessionId =>
  sb.from('aa_attendance')
    .select(`student_id, status, source, confidence, windows_present,
             windows_analysed, reasons, override_note, overridden_at,
             aa_profiles!aa_attendance_student_id_fkey ( display_name, student_number )`)
    .eq('class_session_id', sessionId).then(unwrap);

export const overrideAttendance = (sessionId, studentId, status, note) =>
  sb.rpc('aa_override_attendance', {
    p_session: sessionId, p_student: studentId,
    p_status: status, p_note: note || null }).then(unwrap);

export const courseReport = courseId =>
  sb.rpc('aa_course_report', { p_course: courseId }).then(unwrap);

export const openSessionsOf = courseId =>
  sb.from('aa_class_sessions')
    .select('id, title, venue, join_code, status, started_at')
    .eq('course_id', courseId).eq('status', 'open')
    .order('started_at', { ascending: false }).then(unwrap);
