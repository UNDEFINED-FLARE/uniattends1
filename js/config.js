// js/config.js - project wiring and the capture contract.
//
// The backend lives in the Supabase project "acvosa": the aa_* tables, their
// RLS policies, and the analyse-window edge function. This client is written
// against that contract and does not define its own schema.

export const SUPABASE_URL = 'https://rbnnbmduwrvokhbkezyh.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_Ddn7Hew9PxMs0ozk7wP0XQ_ZePJsncq';

export const TUNING = {
  // Every device captures [opens_at + LEAD_MS, + seconds]. The lecturer's
  // window row carries opens_at from the server clock, so all devices derive
  // the same instant without needing to agree with each other.
  //
  // This matters more than it looks. The matcher recovers the offset between
  // two recordings, but only if they contain overlapping audio in the first
  // place; devices that record different moments share nothing to align.
  LEAD_MS: 8000,

  // How long a phone may still join a window after it opens. Below this much
  // lead time the device waits for the next window instead of half-capturing.
  MIN_LEAD_MS: 2500,

  CAPTURE_SECONDS: 5,   // aa_open_window clamps this to 3..15
  MIC_BUFFER_SECONDS: 40,
  POLL_MS: 1500,

  // Mirrors MATCH_DEFAULTS.lowEntropy in the deployed matcher: below this the
  // window is not treated as decisive evidence either way.
  LOW_ENTROPY: 0.35
};
