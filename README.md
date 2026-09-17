# Uni Attend — acoustic attendance client

Web client for the ambient-acoustic attendance system in the Supabase project
**acvosa** (`rbnnbmduwrvokhbkezyh`). Plain HTML, CSS and ES modules — no build
step, no framework, no bundler.

Attendance is decided by whether a phone heard the same air as the rest of the
room, in seconds nobody knew in advance.

## What lives where

The backend already existed and is authoritative. **This repository contains no
schema.** It is a client written against a contract:

| Backend (in acvosa, not here) | |
|---|---|
| `aa_profiles`, `aa_courses`, `aa_enrolments` | identity and class lists |
| `aa_class_sessions`, `aa_windows` | a class, and each listening window in it |
| `aa_submissions` | landmarks — insert-only, no client may ever read them |
| `aa_evidence`, `aa_attendance` | per-window verdicts, and the register |
| `analyse-window` edge function | matching, clustering, register, then deletion |

| Client (here) | |
|---|---|
| `index.html` | sign in / create account, routes by role |
| `student.html` | join a class, capture each window, see your own verdicts |
| `lecturer.html` | courses, class list, windows, matching, register, report |
| `js/fingerprint.js` | microphone, FFT, peak picking, landmark hashing, entropy |
| `js/api.js` | every backend call, in one file |
| `js/supabase.js` | client, session, role guard, clock correction |
| `js/config.js` | project keys and the capture contract |
| `test/bench.mjs` | offline validation against the deployed matcher |
| `test/matcher.js` | verbatim copy of the deployed matcher |

## Run it

```bash
python -m http.server 8000
```

Then <http://localhost:8000>. `localhost` counts as a secure origin, so the
microphone works. **Anywhere else must be HTTPS** — `getUserMedia` is refused
on plain HTTP. There is nothing to build, so any static host works.

## How a class runs

**Lecturer** — pick a course, *Start class*, read out the six-character code.
Press *Open a listening window*: your phone captures alongside the students and
anchors the room. When enough have submitted, press *Match this window*. Open
as many windows as you like through the lecture; the register counts how many
of them each student was in. Wrong calls are yours to fix in *Register*, and a
manual status is never overwritten by a later window.

**Student** — enter the code, allow the microphone, leave the page open. Each
time the lecturer opens a window your phone counts down and captures with
everyone else. Your verdict appears once the lecturer runs matching.

## The two things that make it work

**Synchronised capture.** Devices that record different moments share no audio,
and no amount of clever matching recovers an overlap that was never there. The
window row carries `opens_at` from the server clock, every device adds the same
`LEAD_MS`, and each phone opens its microphone early and slices out exactly
that interval. Device clocks are corrected against the server's `Date` header
rather than trusted.

**Mutual corroboration, not a stored template.** Nothing records "what the room
sounds like". The evidence is that a set of devices independently heard the
same unrepeatable seconds, and that the lecturer's phone is among them. There
is no reference fingerprint to leak, and last week's recording matches nothing.

## What it proves, and what it does not

It proves **a phone was in the room**. It does not prove **who held it**. The
backend is built around that honesty: matching returns `present` or `review`,
never `absent`. A device that does not cluster is routed to the lecturer, not
marked down.

`aa_submissions` has an INSERT policy and no SELECT policy for any client role.
Landmarks go in, only the edge function reads them, and it deletes them as soon
as a verdict exists.

## Checking it without a lecture hall

```bash
node test/bench.mjs
```

Synthesises a hall, gives seven devices their own imperfect version of it —
including one in a different venue and one in a silent residence room — runs
the real `js/fingerprint.js` over each, and feeds the output into a verbatim
copy of the matcher the edge function runs. Run it after changing anything in
`fingerprint.js`: if the hashing drifts away from what the matcher expects, the
cluster stops forming and the bench fails.

## Tuning

`js/config.js`:

| | |
|---|---|
| `LEAD_MS` | warning before capture. Must exceed microphone warm-up, and is how long a student has to join a window after it opens |
| `MIN_LEAD_MS` | below this the device waits for the next window rather than half-capturing |
| `CAPTURE_SECONDS` | `aa_open_window` clamps this to 3–15 |
| `LOW_ENTROPY` | mirrors `MATCH_DEFAULTS.lowEntropy` server side — keep them equal |

The entropy score gates on **level first**: microphone self-noise in a silent
room fluctuates as much as a lecture does, so a room that is merely quiet must
not read as informative. Open windows while people are talking.

## The UNIVEN app, on Supabase

[`univen.html`](univen.html) is the original single-file app with Firebase
removed. Two edits to 4,703 lines: the three `firebase-*-compat.js` tags became
the supabase-js UMD build plus [`js/uvn-compat.js`](js/uvn-compat.js), and the
`firebaseConfig` block became a guard. All 53 `db.ref` sites and 10 `auth` sites
are untouched.

That is deliberate. Rewriting 63 call sites by hand would be 63 chances to
break a working product, in a file nobody can exercise without real students,
real GPS and a real microphone. Instead `uvn-compat.js` presents the same two
objects and maps them onto the `aa_*` tables — so the app is unchanged and the
data is fully relational, with row-level security that Firebase rules could not
express.

| Firebase path | Postgres |
|---|---|
| `students/{uid}`, `lecturers/{uid}` | `aa_profiles` |
| `classes/{id}` | `aa_courses` (+ `roster`, and real `aa_enrolments`) |
| `sessions/{id}` | `aa_class_sessions` (+ `meta` for app-only fields) |
| `sessions/{id}/attendanceRecords/{sn}` | `aa_attendance`, keyed by uuid |
| `venues`, `timetables`, `notifications` | `aa_venues`, `aa_timetables`, `aa_notifications` |

Three things that needed more than a rename:

- **The check-in transaction.** Firebase aborted if the node existed. There is
  no INSERT or UPDATE policy on `aa_attendance` for any client — a student must
  not be able to write their own register row — so the commit is
  `aa_check_in()`, a definer function that does `ON CONFLICT … DO UPDATE …
  WHERE checked_in_at IS NULL`. No row back means already claimed, which is
  also how one phone checking in two students is caught.
- **Session ids.** The lecturer's device mints the id with `push()` and puts it
  straight into the QR code before any round trip, so the row must be created
  with *that* id. It is inserted directly and the register is seeded separately
  by `aa_seed_register()`.
- **Ad-hoc sessions.** The app allows a session with no class, so `course_id`
  is nullable and the policies handle that case.

`node test/compat.test.mjs` drives all 28 path patterns against a stubbed
client: every call site reaches a mapping, hits the intended table and filter,
and returns the shape the app reads.

## The acoustic layer inside the app

[`js/uvn-acoustic.js`](js/uvn-acoustic.js) adds the second layer to
`univen.html`. It is an ES module loaded after the app's classic script, so it
borrows the already-authenticated client from the compat layer instead of
opening a second session, and hands the app plain globals.

**Lecturer** — a *Room listening* panel sits under the live QR code. *Open
window* asks for the microphone once, creates an `aa_windows` row, and anchors
it by capturing alongside the students; a dial counts down to the shared
instant. *Match* invokes the `analyse-window` edge function, then fuses both
layers into the register. The student list is a live subscription, so it
repaints itself.

**Student** — after checking in, the result card offers *Keep listening for the
room*. The microphone needs a tap of its own: a permission prompt fired from a
timer is refused by every browser, and a mic that stays open through a lecture
deserves to be asked for plainly. A bar then shows each window as it is
captured, with a Stop that really releases the microphone.

The offer appears on a **borderline** check-in too — that is the case worth
having it for. A ±44 m fix in a concrete hall is `review` on its own; if the
phone clusters with the room it becomes `present` without anyone adjudicating.

Fusion is a second stage, not a seventh term in `scoreCheckIn`: the location
verdict is fixed at the door, acoustic evidence arrives during the lecture.
`fuseSession()` folds every analysed window per student — best band, worst-case
entropy, whether any cluster was anchored to the lecturer — and writes the
result through `aa_set_fused()`, which **refuses to touch a row a lecturer has
already ruled on by hand**.

## Two layers, one register

The UNIVEN app's location engine and this acoustic layer are being merged onto
one Supabase backend. They are kept as separate evidence, fused at the end,
because they fail in opposite conditions:

| | Location (GPS polygon + rotating QR) | Acoustic (this system) |
|---|---|---|
| Answers | is this phone at this venue? | is this phone in this *room*, now? |
| Strong when | outdoors, open sky, few students yet | mid-lecture, room busy, many devices |
| Blind when | indoors under concrete; adjacent halls; mock-location apps | first minutes of class; silent room; fewer than 3 devices |
| Defeated by | a mock-location app | nothing that also defeats GPS |

That last row is the point. A spoofed GPS fix does not make a phone hear the
room, and a recording of the room does not put a phone on campus. Their
agreement is worth more than either alone *because* the same trick cannot
produce both.

`js/fuse.js` combines them, and `node test/fuse.test.mjs` covers the cases that
matter — the disagreements:

- **The rescue.** A fix ±44 m in a concrete hall is `review` on its own. If the
  phone clustered with the room, it becomes `verified` without a lecturer
  having to adjudicate. This is the common case, and the main reason to run
  both.
- **The catch.** A perfect-looking fix that no device in the room corroborates
  drops to `review` — never to absent.
- **No double counting.** The location engine already spends 0.15 of its weight
  on peer *GPS* consensus. Acoustic clustering answers that same question
  better, so when acoustic evidence exists that weight is transferred, not
  added — otherwise two correlated signals masquerade as two independent ones.
  When the acoustic window is inconclusive the transfer does not happen, so a
  quiet room never costs a student credit they had already earned.
- **Partial presence is not absence.** Heard in one window of four means
  arrived late, not never there.
- **Neither layer can manufacture an absence.** The worst outcome of any
  disagreement is `review`, and a device that clustered with the room can never
  end as rejected — including one caught faking its location, which is a
  discipline question for a human, not an attendance one.

## Evidence floors

`test/matcher.js` is deployed verbatim as the edge function's matcher. Edit it
here, run the bench, redeploy — if the two drift, the bench is validating
something that is not deciding attendance.

The z-score in `pairScore` is measured against a background estimated from the
neighbourhood of the peak. When two devices barely match at all, that
neighbourhood is empty, the denominator collapses to `sqrt(0+1)`, and a handful
of coincidental matches reports as many sigma — a silent-room device drew 8.7σ
to the lecturer off 33 matches. No better statistic fixes this, because the
hashes themselves are correlated: two noise-dominated recordings pick similar
spurious peaks. So a pair must clear a minimum amount of evidence before it is
tested at all (`minMatches`, `minMatchRate`). In the bench, genuine co-presence
produced 2419–2672 matches and every out-of-room pair produced 105 or fewer.

Alignment sharpness falls with signal-to-noise, so the back of a hall smears
for the same reason relayed audio does. The relay check is therefore relative
(`relaySharpnessFraction`) — measured against the sharpness that room actually
produced, not a fixed constant.

## Known gap

**Anyone can sign up as a lecturer.** `aa_handle_new_user` takes the role
straight from signup metadata, so a student can create a lecturer account, make
a course, enrol any student number and mark attendance on it. Fixing this
changes live signup behaviour, so it is left alone until you decide how staff
accounts should be provisioned.

Also worth turning on: leaked-password protection in Auth settings, which the
project linter currently flags as disabled.
