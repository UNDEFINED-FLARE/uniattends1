// js/supabase.js - the client, the session, and the clock.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true }
});

// ---------- clock ----------
//
// Windows are announced as server timestamps and every device has to land on
// the same instant, so device clocks are corrected rather than trusted. The
// Date header is second-resolution, which is ample: the matcher only needs the
// clips to OVERLAP, and it recovers the residual offset itself.

let skew = 0;
export const now = () => Date.now() + skew;
export const skewMs = () => skew;

export async function syncClock() {
  let bestRtt = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = Date.now();
    try {
      const res = await fetch(SUPABASE_URL + '/rest/v1/', {
        method: 'HEAD', headers: { apikey: SUPABASE_KEY }
      });
      const rtt = Date.now() - t0;
      const header = res.headers.get('date');
      if (!header) break;
      const server = new Date(header).getTime();
      if (rtt < bestRtt) { bestRtt = rtt; skew = server + rtt / 2 - Date.now(); }
    } catch (e) { break; }
  }
  return skew;
}

// ---------- identity ----------

export async function currentUser() {
  const { data } = await sb.auth.getUser();
  return data?.user || null;
}

export async function currentProfile() {
  const user = await currentUser();
  if (!user) return null;
  const { data, error } = await sb.from('aa_profiles')
    .select('id, role, display_name, student_number').eq('id', user.id).maybeSingle();
  if (error) throw new Error(error.message);
  return data ? { ...data, email: user.email } : null;
}

/**
 * Page guard. Sends anyone without a session (or with the wrong role) back to
 * the front door, and returns the profile to everyone else.
 */
export async function requireProfile(role) {
  const profile = await currentProfile();
  if (!profile) { location.replace('index.html'); return null; }
  if (role && profile.role !== role) {
    location.replace(profile.role === 'lecturer' ? 'lecturer.html' : 'student.html');
    return null;
  }
  await syncClock();
  return profile;
}

export async function signIn(email, password) {
  const { error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw new Error(error.message);
}

/**
 * The aa_handle_new_user trigger reads these three metadata keys and writes the
 * aa_profiles row, so the profile is created by the database, not by us.
 */
export async function signUp({ email, password, displayName, role, studentNumber }) {
  const { data, error } = await sb.auth.signUp({
    email, password,
    options: {
      data: {
        aa_display_name: displayName,
        aa_role: role,
        aa_student_number: role === 'student' ? studentNumber : null
      }
    }
  });
  if (error) throw new Error(error.message);
  // With email confirmation on, there is no session yet.
  return { needsConfirmation: !data.session };
}

export async function signOut() {
  await sb.auth.signOut();
  location.replace('index.html');
}

export async function sendPasswordReset(email) {
  const { error } = await sb.auth.resetPasswordForEmail(email, {
    redirectTo: location.origin + '/index.html'
  });
  if (error) throw new Error(error.message);
}

/**
 * Postgres and PostgREST errors are terse, and the same SQLSTATE means
 * different things in different places - 23505 on aa_profiles is a student
 * number clash, on aa_submissions it is a second capture for one window. Match
 * on the constraint that actually failed rather than on the word "duplicate".
 */
export function readable(error) {
  if (!error) return 'Something went wrong.';
  const m = error.message || error.error_description || String(error);
  const all = [m, error.details, error.hint].filter(Boolean).join(' ');

  if (/aa_profiles_student_number_key/.test(all))
    return 'That student number is already registered to a different account. ' +
           'Sign in with the account you first used, or use your own number.';
  if (/aa_profiles_pkey/.test(all))
    return 'This account already has a profile. Reload the page.';
  if (/submissions_one_per_device|aa_submissions_pkey/.test(all))
    return 'This window has already been captured from this device.';
  if (error.code === '23505') return 'That record already exists.';

  if (/not enrolled in that course/i.test(all))
    return 'You are not enrolled in that course, so you cannot join this class. ' +
           'Ask your lecturer to add your student number to the class list.';
  if (/no open class with that code/i.test(all))
    return 'No open class has that code. Check the code, or wait for your ' +
           'lecturer to start the class.';
  if (/no student with that number/i.test(all))
    return 'No account has that student number yet. The student has to create ' +
           'an account before you can enrol them.';
  if (/not your course|not your class/i.test(all))
    return 'That course belongs to another lecturer.';
  if (/this class session is closed/i.test(all))
    return 'This class has ended. Start a new one to open more windows.';
  if (/at least two submissions/i.test(all))
    return 'Only your own device has submitted. Matching needs at least two ' +
           'devices - wait for students to check in.';
  if (/only the lecturer runs matching/i.test(all))
    return 'Only the lecturer of this course can run matching.';

  if (/row-level security/i.test(all))
    return 'The server refused that. You are not enrolled, the window has ' +
           'closed, or it has already been matched.';
  if (error.code === '42501' || /permission denied/i.test(all))
    return 'You do not have permission for that.';
  if (/Invalid login credentials/i.test(all))
    return 'Wrong email or password for this project.';
  if (/Email not confirmed/i.test(all))
    return 'Confirm the link in your email before signing in.';
  if (/User already registered/i.test(all))
    return 'An account with that email already exists. Sign in instead.';
  if (/JWT|expired|token/i.test(all)) return 'Your session expired. Sign in again.';
  if (/Failed to fetch|NetworkError/i.test(all))
    return 'Cannot reach the server. Check your connection.';
  return m;
}
