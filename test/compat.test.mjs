// node test/compat.test.mjs
//
// Exercises every path pattern the UNIVEN app uses against js/uvn-compat.js,
// with a stubbed Supabase client. It cannot prove the data is right - only a
// signed-in session does that - but it does prove that all 53 call sites reach
// a mapping instead of throwing, that they hit the table and filter intended,
// and that what comes back is shaped the way the app reads it.

import fs from 'fs';
import vm from 'vm';

// ---------------------------------------------------------------- the stub
const calls = [];
let nextRows = [];

function builder(table) {
  const state = { table, filters: [], op: 'select' };
  const b = {
    select(cols) { state.cols = cols; return b; },
    eq(c, v) { state.filters.push(['eq', c, v]); return b; },
    neq(c, v) { state.filters.push(['neq', c, v]); return b; },
    gt(c, v) { state.filters.push(['gt', c, v]); return b; },
    ilike(c, v) { state.filters.push(['ilike', c, v]); return b; },
    in(c, v) { state.filters.push(['in', c, v]); return b; },
    is(c, v) { state.filters.push(['is', c, v]); return b; },
    not(c, o, v) { state.filters.push(['not', c, v]); return b; },
    or(s) { state.filters.push(['or', s]); return b; },
    order(c, o) { state.order = c; return b; },
    limit(n) { state.limit = n; return b; },
    update(v) { state.op = 'update'; state.payload = v; return b; },
    upsert(v) { state.op = 'upsert'; state.payload = v; return b; },
    insert(v) { state.op = 'insert'; state.payload = v; return b; },
    delete() { state.op = 'delete'; return b; },
    maybeSingle() { state.single = true; return b; },
    single() { state.single = true; return b; },
    then(res) {
      calls.push(state);
      const data = state.single ? (nextRows[0] ?? null) : nextRows;
      return Promise.resolve(res({ data, error: null }));
    }
  };
  return b;
}

const sandboxWindow = {
  crypto: { randomUUID: () => '11111111-2222-4333-8444-555555555555' },
  supabase: {
    createClient: () => ({
      from: t => builder(t),
      rpc: (fn, args) => { calls.push({ rpc: fn, args }); return Promise.resolve({ data: { id: 'S-NEW', committed: true }, error: null }); },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel: () => {},
      auth: {
        getSession: () => Promise.resolve({ data: { session: null } }),
        onAuthStateChange: () => {},
        signInWithPassword: () => Promise.resolve({ data: { user: { id: 'U1' } }, error: null }),
        signUp: () => Promise.resolve({ data: { user: { id: 'U1' } }, error: null }),
        signOut: () => Promise.resolve({}),
        updateUser: () => Promise.resolve({ data: {}, error: null })
      }
    })
  }
};

const ctx = vm.createContext(sandboxWindow);
ctx.window = ctx;
ctx.global = ctx;
vm.runInContext(fs.readFileSync('js/uvn-compat.js', 'utf8'), ctx);
const { db, auth } = ctx;

// ---------------------------------------------------------------- helpers
const last = () => calls[calls.length - 1];
const reset = (rows = []) => { calls.length = 0; nextRows = rows; };

let bad = 0;
async function check(name, fn) {
  reset(fn.rows || []);
  try {
    const r = await fn.run();
    const problems = fn.expect ? (fn.expect(r, calls) || []) : [];
    if (problems.length) { bad++; console.log('FAIL  ' + name + '\n        !! ' + problems.join('; ')); }
    else console.log('PASS  ' + name);
  } catch (e) {
    bad++;
    console.log('FAIL  ' + name + '\n        !! threw: ' + e.message);
  }
}

// ---------------------------------------------------------------- the paths

await check('students query by card barcode', {
  rows: [{ id: 'U1', role: 'student', display_name: 'A', student_number: '21001', card_barcode: 'BC1' }],
  run: () => db.ref('students').orderByChild('cardBarcode').equalTo('BC1').limitToFirst(1).once('value'),
  expect: (s, c) => {
    const p = [];
    if (c[0].table !== 'aa_profiles') p.push('table ' + c[0].table);
    if (!c[0].filters.some(f => f[1] === 'card_barcode' && f[2] === 'BC1')) p.push('no card_barcode filter');
    const v = s.val();
    if (!v || !v.U1 || v.U1.studentNumber !== '21001') p.push('bad shape: ' + JSON.stringify(v));
    return p;
  }
});

await check('students query by student number', {
  rows: [{ id: 'U1', role: 'student', student_number: '21001', email: 'a@b.c' }],
  run: () => db.ref('students').orderByChild('studentNumber').equalTo('21001').limitToFirst(1).once('value'),
  expect: (s, c) => c[0].filters.some(f => f[1] === 'student_number') ? [] : ['no student_number filter']
});

await check('students/{uid} read maps to app shape', {
  rows: [{ id: 'U1', role: 'student', display_name: 'A B', student_number: '21001',
           must_change_password: true, photo_data: 'x' }],
  run: () => db.ref('students/U1').once('value'),
  expect: s => {
    const v = s.val(), p = [];
    if (v.name !== 'A B') p.push('name');
    if (v.mustChangePassword !== true) p.push('mustChangePassword');
    if (v.uid !== 'U1') p.push('uid');
    return p;
  }
});

await check('students/{uid}/mustChangePassword set', {
  run: () => db.ref('students/U1/mustChangePassword').set(false),
  expect: (_, c) => {
    const p = [];
    if (last().op !== 'update') p.push('op ' + last().op);
    if (last().payload.must_change_password !== false) p.push('payload ' + JSON.stringify(last().payload));
    return p;
  }
});

await check('students/{uid}/photoData remove', {
  run: () => db.ref('students/U1/photoData').remove(),
  expect: () => last().payload.photo_data === null ? [] : ['payload ' + JSON.stringify(last().payload)]
});

await check('lecturers/{uid} set creates a lecturer profile', {
  run: () => db.ref('lecturers/U2').set({ name: 'Dr X', email: 'x@y.z', createdAt: 1 }),
  expect: () => {
    const p = [];
    if (last().op !== 'upsert') p.push('op ' + last().op);
    if (last().payload.role !== 'lecturer') p.push('role ' + last().payload.role);
    return p;
  }
});

await check('classes by lecturer maps roster to students map', {
  rows: [{ id: 'C1', lecturer_id: 'U2', title: 'Systems', code: 'CSC2621',
           roster: ['21001', '21002'], created_at: new Date().toISOString() }],
  run: () => db.ref('classes').orderByChild('lecturerId').equalTo('U2').once('value'),
  expect: (s, c) => {
    const p = [];
    if (c[0].table !== 'aa_courses') p.push('table ' + c[0].table);
    const v = s.val().C1;
    if (v.className !== 'Systems') p.push('className');
    if (v.moduleCode !== 'CSC2621') p.push('moduleCode');
    if (!v.students['21001'] || v.studentCount !== 2) p.push('students map: ' + JSON.stringify(v.students));
    return p;
  }
});

await check('classes push + set writes roster and enrols', {
  rows: [{ id: 'C-NEW' }],
  run: async () => {
    const r = db.ref('classes').push();
    await r.set({ lecturerId: 'U2', lecturerName: 'Dr X', className: 'N',
                  moduleCode: 'abc123', students: { '21001': true }, createdAt: 1 });
    return r;
  },
  expect: (r, c) => {
    const p = [];
    if (!r.key) p.push('push gave no key');
    const up = c.find(x => x.op === 'upsert');
    if (!up) p.push('no upsert');
    else {
      if (up.payload.code !== 'ABC123') p.push('code not upper: ' + up.payload.code);
      if (!Array.isArray(up.payload.roster)) p.push('roster not array');
    }
    if (!c.some(x => x.rpc === 'aa_enrol_by_number')) p.push('did not enrol');
    return p;
  }
});

await check('classes/{id} remove', {
  run: () => db.ref('classes/C1').remove(),
  expect: () => last().op === 'delete' ? [] : ['op ' + last().op]
});

// The id minted by push() goes straight into the QR code, so the row has to
// be created with that exact id or the code students scan points at nothing.
await check('a session is created with the id that went into the QR code', {
  run: async () => {
    const r = db.ref('sessions').push();
    await r.set({
      moduleCode: 'CSC2621', venue: 'Hall A', classId: 'C1', className: 'Systems',
      lecturerId: 'U2', lecturerName: 'Dr X', lat: -23, lng: 30, radiusMeters: 50,
      createdAt: 1, expiresAt: 2, attendanceRecords: {} });
    return r;
  },
  expect: (r, c) => {
    const p = [];
    const ins = c.find(x => x.op === 'insert' && x.table === 'aa_class_sessions');
    if (!ins) return ['session was never inserted'];
    if (ins.payload.id !== r.key) p.push('row id ' + ins.payload.id + ' != QR id ' + r.key);
    if (ins.payload.course_id !== 'C1') p.push('course lost');
    if (ins.payload.lat !== -23) p.push('lat lost');
    if (!ins.payload.meta || ins.payload.meta.lecturerId !== 'U2') p.push('meta lost');
    if (!c.some(x => x.rpc === 'aa_seed_register')) p.push('register never seeded');
    return p;
  }
});

await check('a session with no class still inserts, with a null course', {
  run: () => db.ref('sessions').push().set({ moduleCode: 'X', venue: 'V', createdAt: 1 }),
  expect: (_, c) => {
    const ins = c.find(x => x.op === 'insert' && x.table === 'aa_class_sessions');
    if (!ins) return ['not inserted'];
    return ins.payload.course_id === null ? [] : ['course_id ' + ins.payload.course_id];
  }
});

await check('sessions/{id}/liveToken set', {
  run: () => db.ref('sessions/S1/liveToken').set({ value: 'abc', at: 123 }),
  expect: () => last().payload.live_token?.value === 'abc' ? [] : ['payload ' + JSON.stringify(last().payload)]
});

await check('sessions/{id}/expiresAt set', {
  run: () => db.ref('sessions/S1/expiresAt').set(1700000000000),
  expect: () => last().payload.expires_at ? [] : ['no expires_at']
});

await check('sessions/{id}/absentees set', {
  run: () => db.ref('sessions/S1/absentees').set(['21001']),
  expect: () => Array.isArray(last().payload.absentees) ? [] : ['no absentees']
});

await check('sessions list embeds the register keyed by student number', {
  rows: [{ id: 'S1', course_id: 'C1', venue: 'Hall A', meta: { moduleCode: 'CSC2621' },
           started_at: new Date().toISOString(), status: 'open' }],
  run: () => db.ref('sessions').orderByChild('createdAt').limitToLast(80).once('value'),
  expect: (s, c) => {
    const p = [];
    if (c[0].table !== 'aa_class_sessions') p.push('table ' + c[0].table);
    if (!c.some(x => x.table === 'aa_attendance')) p.push('register never fetched');
    const v = s.val().S1;
    if (v.moduleCode !== 'CSC2621') p.push('moduleCode');
    if (typeof v.attendanceRecords !== 'object') p.push('attendanceRecords missing');
    return p;
  }
});

await check('sessions by lecturer filters on the json field', {
  run: () => db.ref('sessions').orderByChild('lecturerId').equalTo('U2').once('value'),
  expect: (_, c) => c[0].filters.some(f => f[1] === 'meta->>lecturerId')
    ? [] : ['filter was ' + JSON.stringify(c[0].filters)]
});

await check('active sessions filter on expiry', {
  run: () => db.ref('sessions').orderByChild('expiresAt').startAt(Date.now()).once('value'),
  expect: (_, c) => c[0].filters.some(f => f[0] === 'gt' && f[1] === 'expires_at')
    ? [] : ['filter was ' + JSON.stringify(c[0].filters)]
});

await check('check-in transaction calls aa_check_in and reports committed', {
  run: () => db.ref('sessions/S1/attendanceRecords/21001').transaction(cur => {
    if (cur !== null) return;
    return { name: 'A', uid: 'U1', timestamp: 1, gps: { lat: 1, lng: 2 },
             status: 'present', deviceId: 'd1',
             verification: { tier: 'verified', score: 0.8 } };
  }),
  expect: (r, c) => {
    const p = [];
    const rpc = c.find(x => x.rpc === 'aa_check_in');
    if (!rpc) return ['aa_check_in never called'];
    if (rpc.args.p_status !== 'present') p.push('status ' + rpc.args.p_status);
    if (rpc.args.p_device !== 'd1') p.push('device lost');
    if (!rpc.args.p_verification) p.push('verification lost');
    if (r.committed !== true) p.push('committed not reported');
    return p;
  }
});

await check('a review-tier check-in is sent as review', {
  run: () => db.ref('sessions/S1/attendanceRecords/21001').transaction(() => ({
    status: 'pending-review', deviceId: 'd1', gps: {}, verification: { tier: 'review' } })),
  expect: (_, c) => c.find(x => x.rpc === 'aa_check_in').args.p_status === 'review'
    ? [] : ['status not review']
});

await check('lecturer resolving a flagged record overrides it', {
  rows: [{ student_id: 'U1', aa_profiles: { student_number: '21001' } }],
  run: () => db.ref('sessions/S1/attendanceRecords/21001')
    .update({ status: 'rejected', reviewedBy: 'Dr X', reviewedAt: 1 }),
  expect: (_, c) => {
    const rpc = c.find(x => x.rpc === 'aa_override_attendance');
    if (!rpc) return ['no override rpc'];
    return rpc.args.p_status === 'absent' ? [] : ['status ' + rpc.args.p_status];
  }
});

await check('venues push', {
  rows: [{ id: 'V1' }],
  run: () => db.ref('venues').push({ name: 'Hall A', polygon: [], centroid: { lat: 1, lng: 2 }, createdAt: 1 }),
  expect: (_, c) => {
    const up = c.find(x => x.op === 'upsert');
    return up && up.table === 'aa_venues' ? [] : ['no venue upsert'];
  }
});

await check('venues read maps polygon and centroid', {
  rows: [{ id: 'V1', name: 'Hall A', polygon: [{ lat: 1, lng: 2 }], centroid: { lat: 1, lng: 2 }, radius_meters: 60 }],
  run: () => db.ref('venues').once('value'),
  expect: s => {
    const v = s.val().V1;
    return (v && v.name === 'Hall A' && v.radiusMeters === 60) ? [] : ['shape ' + JSON.stringify(v)];
  }
});

await check('venues/{id} update and remove', {
  run: async () => { await db.ref('venues/V1').update({ name: 'B' }); return db.ref('venues/V1').remove(); },
  expect: (_, c) => {
    const p = [];
    if (!c.some(x => x.op === 'update' && x.table === 'aa_venues')) p.push('no update');
    if (!c.some(x => x.op === 'delete' && x.table === 'aa_venues')) p.push('no delete');
    return p;
  }
});

await check('timetables by lecturer, push and remove', {
  rows: [{ id: 'T1', lecturer_id: 'U2', payload: { days: ['Mon'] }, title: 'X' }],
  run: async () => {
    const s = await db.ref('timetables').orderByChild('lecturerId').equalTo('U2').once('value');
    await db.ref('timetables').push({ lecturerId: 'U2', classId: 'C1', days: ['Mon'] });
    await db.ref('timetables/T1').remove();
    return s;
  },
  expect: (s, c) => {
    const p = [];
    if (!s.val() || !s.val().T1 || s.val().T1.days[0] !== 'Mon') p.push('payload not flattened');
    if (!c.some(x => x.op === 'upsert' && x.table === 'aa_timetables')) p.push('no upsert');
    if (!c.some(x => x.op === 'delete' && x.table === 'aa_timetables')) p.push('no delete');
    return p;
  }
});

await check('notifications push and read', {
  rows: [{ id: 'N1', title: 'T', body: 'B', posted_by: 'U2',
           created_at: new Date().toISOString(), meta: { audience: 'all', postedBy: 'Dr X' } }],
  run: async () => {
    await db.ref('notifications').push({ title: 'T', body: 'B', audience: 'all',
      postedBy: 'Dr X', postedByUid: 'U2', isOfficial: true, createdAt: 1 });
    return db.ref('notifications').orderByChild('createdAt').limitToLast(3).once('value');
  },
  expect: (s, c) => {
    const p = [];
    const up = c.find(x => x.op === 'upsert' && x.table === 'aa_notifications');
    if (!up) p.push('no upsert');
    else if (up.payload.meta.audience !== 'all') p.push('meta lost');
    const v = s.val().N1;
    if (!v || v.postedBy !== 'Dr X') p.push('meta not merged back: ' + JSON.stringify(v));
    return p;
  }
});

await check('notifications by poster', {
  run: () => db.ref('notifications').orderByChild('postedByUid').equalTo('U2').limitToLast(20).once('value'),
  expect: (_, c) => c[0].filters.some(f => f[1] === 'posted_by') ? [] : ['no posted_by filter']
});

await check('auth sign-in returns a firebase-shaped credential', {
  run: () => auth.signInWithEmailAndPassword('a@b.c', 'x'),
  expect: r => r.user && r.user.uid === 'U1' ? [] : ['shape ' + JSON.stringify(r)]
});

await check('auth exposes updatePassword / updateEmail on currentUser', {
  run: async () => {
    await auth.signInWithEmailAndPassword('a@b.c', 'x');
    await auth.currentUser.updatePassword('newpass');
    await auth.currentUser.updateEmail('n@b.c');
    return true;
  }
});

console.log('\n' + (bad ? bad + ' failing' : 'all paths map cleanly'));
process.exit(bad ? 1 : 0);
