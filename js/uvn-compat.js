/* js/uvn-compat.js — the UNIVEN app, on Supabase.
 *
 * The app talks to `db.ref(path)` and `auth` in 63 places spread through
 * 4,700 lines. Rewriting those by hand would mean 63 chances to break a
 * working product, in a file that cannot be exercised without real students,
 * real GPS and a real microphone.
 *
 * So this presents the same two objects, and maps them onto the aa_* tables.
 * The app above is untouched; the data underneath is fully relational —
 * proper tables, foreign keys, and row-level security that Firebase rules
 * could not express. A student can read their own attendance and nothing
 * else: not the class list, not another student's fix, and above all not
 * anyone's acoustic landmarks.
 *
 * Deliberately a classic script, not a module: the app's own <script> is
 * classic and runs immediately, so `db` and `auth` have to be globals that
 * already exist by then. Hence the UMD build of supabase-js.
 */
(function (global) {
  'use strict';

  var SUPABASE_URL = 'https://rbnnbmduwrvokhbkezyh.supabase.co';
  var SUPABASE_KEY = 'sb_publishable_Ddn7Hew9PxMs0ozk7wP0XQ_ZePJsncq';

  if (!global.supabase || !global.supabase.createClient) {
    throw new Error('supabase-js (UMD) must load before uvn-compat.js');
  }
  var sb = global.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: true, autoRefreshToken: true }
  });
  global.sb = sb;

  var ms  = function (t) { return t ? new Date(t).getTime() : null; };
  var iso = function (t) { return t ? new Date(t).toISOString() : null; };
  var uuid = function () {
    return (global.crypto && global.crypto.randomUUID)
      ? global.crypto.randomUUID()
      : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
          var r = Math.random() * 16 | 0;
          return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
        });
  };
  function ok(res) { if (res.error) throw new Error(res.error.message); return res.data; }

  /* ---------------------------------------------------------------- snapshot
     Firebase hands back a snapshot, not a value. The app calls .val(),
     .exists() and .forEach() on it, so those are what this provides. */
  function snap(value, key) {
    return {
      key: key === undefined ? null : key,
      val: function () { return value === undefined ? null : value; },
      exists: function () { return value !== null && value !== undefined; },
      numChildren: function () {
        return (value && typeof value === 'object') ? Object.keys(value).length : 0;
      },
      child: function (k) { return snap(value ? value[k] : null, k); },
      forEach: function (cb) {
        if (!value || typeof value !== 'object') return;
        Object.keys(value).forEach(function (k) { cb(snap(value[k], k)); });
      }
    };
  }

  /* ------------------------------------------------------------- profiles */

  function profileOut(r) {
    if (!r) return null;
    return {
      uid: r.id,
      name: r.display_name,
      studentNumber: r.student_number,
      email: r.email,
      cardBarcode: r.card_barcode,
      photoData: r.photo_data,
      mustChangePassword: !!r.must_change_password,
      role: r.role,
      createdAt: ms(r.created_at)
    };
  }
  function profileIn(v, role) {
    var p = {};
    if (v.name !== undefined) p.display_name = v.name;
    if (v.email !== undefined) p.email = v.email;
    if (v.studentNumber !== undefined) p.student_number = v.studentNumber;
    if (v.cardBarcode !== undefined) p.card_barcode = v.cardBarcode;
    if (v.photoData !== undefined) p.photo_data = v.photoData;
    if (v.mustChangePassword !== undefined) p.must_change_password = !!v.mustChangePassword;
    if (role) p.role = role;
    return p;
  }

  /* -------------------------------------------------------------- courses */

  function courseOut(r) {
    if (!r) return null;
    var students = {};
    (r.roster || []).forEach(function (n) { students[n] = true; });
    return {
      lecturerId: r.lecturer_id,
      lecturerName: r.lecturer_name,
      className: r.title,
      moduleCode: r.code,
      students: students,
      studentCount: (r.roster || []).length,
      createdAt: ms(r.created_at)
    };
  }

  /* ------------------------------------------------------------- sessions */

  function sessionOut(r, records) {
    if (!r) return null;
    var m = r.meta || {};
    return {
      moduleCode: m.moduleCode || (r.aa_courses && r.aa_courses.code) || '',
      venue: r.venue,
      venueName: m.venueName || r.venue,
      venueId: r.venue_id,
      venuePolygon: r.venue_polygon,
      sessionTime: m.sessionTime,
      createdAt: ms(r.started_at),
      expiresAt: ms(r.expires_at),
      lecturerId: m.lecturerId,
      lecturerName: m.lecturerName,
      lat: r.lat, lng: r.lng,
      radiusMeters: r.radius_meters,
      requireReflection: !!m.requireReflection,
      reflectionMinWords: r.reflection_min_words,
      reflectionPrompt: m.reflectionPrompt,
      classId: r.course_id,
      className: m.className || (r.aa_courses && r.aa_courses.title),
      allowedStudents: r.allowed_students,
      liveToken: r.live_token,
      absentees: r.absentees,
      joinCode: r.join_code,
      status: r.status,
      attendanceRecords: records || {}
    };
  }

  function sessionIn(v) {
    var meta = {};
    ['moduleCode', 'sessionTime', 'lecturerId', 'lecturerName', 'requireReflection',
     'reflectionPrompt', 'className', 'venueName'].forEach(function (k) {
      if (v[k] !== undefined) meta[k] = v[k];
    });
    var row = { meta: meta };
    if (v.venue !== undefined) row.venue = v.venueName || v.venue;
    if (v.venueId !== undefined) row.venue_id = v.venueId;
    if (v.venuePolygon !== undefined) row.venue_polygon = v.venuePolygon;
    if (v.lat !== undefined) row.lat = v.lat;
    if (v.lng !== undefined) row.lng = v.lng;
    if (v.radiusMeters !== undefined) row.radius_meters = v.radiusMeters;
    if (v.expiresAt !== undefined) row.expires_at = iso(v.expiresAt);
    if (v.reflectionMinWords !== undefined) row.reflection_min_words = v.reflectionMinWords;
    if (v.allowedStudents !== undefined) row.allowed_students = v.allowedStudents;
    if (v.absentees !== undefined) row.absentees = v.absentees;
    return row;
  }

  function recordOut(r) {
    var p = r.aa_profiles || {};
    var rec = {
      name: p.display_name,
      uid: r.student_id,
      studentNumber: p.student_number,
      timestamp: ms(r.checked_in_at),
      gps: r.gps,
      status: r.status === 'present' ? 'present'
            : r.status === 'review' ? 'pending-review'
            : r.status === 'absent' ? 'rejected'
            : r.status,
      deviceId: r.device_id,
      verification: r.verification,
      reflection: r.reflection,
      reflectionWordCount: r.reflection_word_count,
      fused: r.fused,
      acousticWindows: r.windows_analysed
        ? { present: r.windows_present, analysed: r.windows_analysed } : null
    };
    return rec;
  }

  var SESSION_COLS =
    'id, course_id, title, venue, join_code, status, started_at, ended_at, ' +
    'venue_id, lat, lng, radius_meters, venue_polygon, live_token, expires_at, ' +
    'reflection_min_words, absentees, meta, allowed_students, aa_courses(code,title)';
  var REC_COLS =
    'class_session_id, student_id, status, gps, verification, device_id, ' +
    'reflection, reflection_word_count, checked_in_at, fused, windows_present, ' +
    'windows_analysed, aa_profiles!aa_attendance_student_id_fkey(display_name,student_number)';

  /** registers for a set of sessions, keyed the way the app expects */
  async function registersFor(ids) {
    var out = {};
    ids.forEach(function (id) { out[id] = {}; });
    if (!ids.length) return out;
    var rows = ok(await sb.from('aa_attendance').select(REC_COLS)
      .in('class_session_id', ids));
    rows.forEach(function (r) {
      if (!r.checked_in_at) return;              // seeded, never used
      var sn = (r.aa_profiles && r.aa_profiles.student_number) || r.student_id;
      out[r.class_session_id][sn] = recordOut(r);
    });
    return out;
  }

  /* --------------------------------------------------------------- reads */

  async function read(parts, q) {
    var head = parts[0];

    // ---- students / lecturers
    if (head === 'students' || head === 'lecturers') {
      var role = head === 'students' ? 'student' : 'lecturer';
      if (parts.length === 1) {
        var sel = sb.from('aa_profiles').select('*').eq('role', role);
        if (q.order === 'cardBarcode') sel = sel.eq('card_barcode', q.equal);
        else if (q.order === 'studentNumber') sel = sel.ilike('student_number', String(q.equal));
        if (q.first) sel = sel.limit(q.first);
        var rows = ok(await sel);
        var map = {};
        rows.forEach(function (r) { map[r.id] = profileOut(r); });
        return snap(Object.keys(map).length ? map : null, head);
      }
      var one = ok(await sb.from('aa_profiles').select('*').eq('id', parts[1]).maybeSingle());
      var val = profileOut(one);
      if (parts.length === 3 && val) val = val[parts[2]];
      return snap(val === undefined ? null : val, parts[parts.length - 1]);
    }

    // ---- classes
    if (head === 'classes') {
      if (parts.length === 1) {
        var csel = sb.from('aa_courses').select('*');
        if (q.order === 'lecturerId') csel = csel.eq('lecturer_id', q.equal);
        var crows = ok(await csel);
        var cmap = {};
        crows.forEach(function (r) { cmap[r.id] = courseOut(r); });
        return snap(Object.keys(cmap).length ? cmap : null, 'classes');
      }
      var c = ok(await sb.from('aa_courses').select('*').eq('id', parts[1]).maybeSingle());
      return snap(courseOut(c), parts[1]);
    }

    // ---- sessions
    if (head === 'sessions') {
      if (parts.length === 1) {
        var ssel = sb.from('aa_class_sessions').select(SESSION_COLS);
        if (q.order === 'expiresAt' && q.start !== undefined)
          ssel = ssel.gt('expires_at', iso(q.start));
        if (q.order === 'lecturerId' && q.equal !== undefined)
          ssel = ssel.eq('meta->>lecturerId', q.equal);
        ssel = ssel.order('started_at', { ascending: false }).limit(q.last || q.first || 200);
        var srows = ok(await ssel);
        var regs = await registersFor(srows.map(function (r) { return r.id; }));
        var smap = {};
        srows.forEach(function (r) { smap[r.id] = sessionOut(r, regs[r.id]); });
        return snap(Object.keys(smap).length ? smap : null, 'sessions');
      }
      var s = ok(await sb.from('aa_class_sessions').select(SESSION_COLS)
        .eq('id', parts[1]).maybeSingle());
      if (!s) return snap(null, parts[1]);
      var reg = (await registersFor([s.id]))[s.id];
      var obj = sessionOut(s, reg);
      var v = obj;
      for (var i = 2; i < parts.length; i++) v = v ? v[parts[i]] : null;
      return snap(v === undefined ? null : v, parts[parts.length - 1]);
    }

    // ---- venues
    if (head === 'venues') {
      if (parts.length === 1) {
        var vrows = ok(await sb.from('aa_venues').select('*').order('name'));
        var vmap = {};
        vrows.forEach(function (r) {
          vmap[r.id] = { name: r.name, polygon: r.polygon, centroid: r.centroid,
                         radiusMeters: r.radius_meters, createdAt: ms(r.created_at) };
        });
        return snap(Object.keys(vmap).length ? vmap : null, 'venues');
      }
      var vone = ok(await sb.from('aa_venues').select('*').eq('id', parts[1]).maybeSingle());
      return snap(vone ? { name: vone.name, polygon: vone.polygon,
                           centroid: vone.centroid, radiusMeters: vone.radius_meters,
                           createdAt: ms(vone.created_at) } : null, parts[1]);
    }

    // ---- timetables
    if (head === 'timetables') {
      var tsel = sb.from('aa_timetables').select('*');
      if (q.order === 'lecturerId') tsel = tsel.eq('lecturer_id', q.equal);
      var trows = ok(await tsel);
      var tmap = {};
      trows.forEach(function (r) {
        tmap[r.id] = Object.assign({}, r.payload, {
          lecturerId: r.lecturer_id, classId: r.course_id,
          venueId: r.venue_id, title: r.title, createdAt: ms(r.created_at) });
      });
      return snap(Object.keys(tmap).length ? tmap : null, 'timetables');
    }

    // ---- notifications
    if (head === 'notifications') {
      var nsel = sb.from('aa_notifications').select('*');
      if (q.order === 'postedByUid') nsel = nsel.eq('posted_by', q.equal);
      nsel = nsel.order('created_at', { ascending: false }).limit(q.last || q.first || 30);
      var nrows = ok(await nsel);
      var nmap = {};
      nrows.reverse().forEach(function (r) {
        nmap[r.id] = Object.assign({
          title: r.title, body: r.body, postedByUid: r.posted_by,
          createdAt: ms(r.created_at) }, r.meta || {});
      });
      return snap(Object.keys(nmap).length ? nmap : null, 'notifications');
    }

    throw new Error('uvn-compat: no mapping for path "' + parts.join('/') + '"');
  }

  /* --------------------------------------------------------------- writes */

  async function write(parts, value, mode) {
    var head = parts[0];

    // ---- profiles
    if (head === 'students' || head === 'lecturers') {
      var role = head === 'students' ? 'student' : 'lecturer';
      var uid = parts[1];
      if (parts.length === 3) {                      // students/{uid}/field
        var f = {};
        f[parts[2]] = mode === 'remove' ? null : value;
        return ok(await sb.from('aa_profiles').update(profileIn(f, null)).eq('id', uid));
      }
      if (mode === 'set') {
        var row = profileIn(value, role);
        row.id = uid;
        return ok(await sb.from('aa_profiles').upsert(row).select().single());
      }
      return ok(await sb.from('aa_profiles').update(profileIn(value, null)).eq('id', uid));
    }

    // ---- classes
    if (head === 'classes') {
      var cid = parts[1];
      if (mode === 'remove') return ok(await sb.from('aa_courses').delete().eq('id', cid));
      var roster = Object.keys(value.students || {});
      var crow = {
        id: cid,
        lecturer_id: value.lecturerId,
        lecturer_name: value.lecturerName,
        title: value.className,
        code: (value.moduleCode || 'CLASS').toUpperCase(),
        roster: roster
      };
      var saved = ok(await sb.from('aa_courses').upsert(crow).select().single());
      // Enrolment is what RLS actually keys on. Numbers with no account yet
      // stay on the roster and are enrolled when they sign up.
      for (var i = 0; i < roster.length; i++) {
        try { await sb.rpc('aa_enrol_by_number', { p_course: saved.id, p_number: roster[i] }); }
        catch (e) { /* no account yet - the roster remembers them */ }
      }
      return saved;
    }

    // ---- sessions
    if (head === 'sessions') {
      var sid = parts[1];
      if (parts.length === 3) {                      // sessions/{id}/field
        var patch = {};
        if (parts[2] === 'liveToken') patch.live_token = value;
        else if (parts[2] === 'expiresAt') patch.expires_at = iso(value);
        else if (parts[2] === 'absentees') patch.absentees = value;
        else patch = sessionIn((function () { var o = {}; o[parts[2]] = value; return o; })());
        return ok(await sb.from('aa_class_sessions').update(patch).eq('id', sid));
      }
      if (parts.length === 4 && parts[2] === 'attendanceRecords') {
        // lecturer confirming or rejecting a flagged check-in
        var sn = parts[3];
        var studentId = await studentIdFor(sid, sn);
        var status = value.status === 'present' ? 'present'
                   : value.status === 'rejected' ? 'absent' : 'review';
        return ok(await sb.rpc('aa_override_attendance', {
          p_session: sid, p_student: studentId, p_status: status,
          p_note: value.reviewedBy ? 'reviewed by ' + value.reviewedBy : null }));
      }
      if (mode === 'set') {
        // The id came from push() and is already inside the QR code, so the
        // row must be created with exactly that id - not one the server picks.
        // Seeding the register from the class list is a separate step because
        // aa_attendance has no insert policy for clients.
        var row = sessionIn(value);
        row.id = sid;
        row.course_id = value.classId || null;
        row.title = value.className || value.moduleCode || 'Class';
        row.venue = value.venueName || value.venue || '';
        row.status = 'open';
        var saved = ok(await sb.from('aa_class_sessions').insert(row).select().single());
        try { await sb.rpc('aa_seed_register', { p_session: sid }); }
        catch (e) { /* ad-hoc session, or an empty class list */ }
        return saved;
      }
      return ok(await sb.from('aa_class_sessions')
        .update(sessionIn(value)).eq('id', sid));
    }

    // ---- venues
    if (head === 'venues') {
      var vid = parts[1];
      if (mode === 'remove') return ok(await sb.from('aa_venues').delete().eq('id', vid));
      var vrow = { name: value.name, polygon: value.polygon, centroid: value.centroid };
      if (value.radiusMeters !== undefined) vrow.radius_meters = value.radiusMeters;
      if (mode === 'set') { vrow.id = vid; return ok(await sb.from('aa_venues').upsert(vrow).select().single()); }
      return ok(await sb.from('aa_venues').update(vrow).eq('id', vid));
    }

    // ---- timetables
    if (head === 'timetables') {
      var tid = parts[1];
      if (mode === 'remove') return ok(await sb.from('aa_timetables').delete().eq('id', tid));
      var payload = Object.assign({}, value);
      delete payload.lecturerId; delete payload.classId; delete payload.venueId;
      var trow = {
        lecturer_id: value.lecturerId, course_id: value.classId || null,
        venue_id: value.venueId || null,
        title: value.title || value.moduleCode || 'Class', payload: payload
      };
      if (mode === 'set') { trow.id = tid; return ok(await sb.from('aa_timetables').upsert(trow).select().single()); }
      return ok(await sb.from('aa_timetables').update(trow).eq('id', tid));
    }

    // ---- notifications
    if (head === 'notifications') {
      var nid = parts[1];
      if (mode === 'remove') return ok(await sb.from('aa_notifications').delete().eq('id', nid));
      var meta = {};
      ['audience', 'postedBy', 'isOfficial'].forEach(function (k) {
        if (value[k] !== undefined) meta[k] = value[k];
      });
      var nrow = { id: nid, title: value.title, body: value.body || '',
                   posted_by: value.postedByUid, meta: meta };
      return ok(await sb.from('aa_notifications').upsert(nrow).select().single());
    }

    throw new Error('uvn-compat: no write mapping for "' + parts.join('/') + '"');
  }

  var snCache = {};
  async function studentIdFor(sessionId, studentNumber) {
    var key = sessionId + '|' + studentNumber;
    if (snCache[key]) return snCache[key];
    var rows = ok(await sb.from('aa_attendance')
      .select('student_id, aa_profiles!aa_attendance_student_id_fkey(student_number)')
      .eq('class_session_id', sessionId));
    rows.forEach(function (r) {
      if (r.aa_profiles) snCache[sessionId + '|' + r.aa_profiles.student_number] = r.student_id;
    });
    if (!snCache[key]) throw new Error('no register row for ' + studentNumber);
    return snCache[key];
  }

  /* ----------------------------------------------------------- the ref API */

  function makeRef(parts, q) {
    q = q || {};
    var self = {
      key: parts[parts.length - 1],
      orderByChild: function (f) { return makeRef(parts, Object.assign({}, q, { order: f })); },
      equalTo:      function (v) { return makeRef(parts, Object.assign({}, q, { equal: v })); },
      startAt:      function (v) { return makeRef(parts, Object.assign({}, q, { start: v })); },
      limitToLast:  function (n) { return makeRef(parts, Object.assign({}, q, { last: n })); },
      limitToFirst: function (n) { return makeRef(parts, Object.assign({}, q, { first: n })); },
      child:        function (k) { return makeRef(parts.concat(String(k).split('/')), {}); },

      once:   function () { return read(parts, q); },
      set:    function (v) { return write(parts, v, 'set'); },
      update: function (v) { return write(parts, v, 'update'); },
      remove: function () { return write(parts, null, 'remove'); },

      push: function (v) {
        var id = uuid();
        var child = makeRef(parts.concat(id), {});
        if (v !== undefined) return child.set(v).then(function () { return child; });
        return child;
      },

      /* Only ever used on a register row. The original aborted when the node
         already existed; here the server decides, which is also what stops one
         phone checking in two students. */
      transaction: async function (fn) {
        var wanted = fn(null);
        if (!wanted) return { committed: false, snapshot: snap(null) };
        var sid = parts[1];
        var res = await sb.rpc('aa_check_in', {
          p_session: sid,
          p_status: wanted.status === 'present' ? 'present' : 'review',
          p_gps: wanted.gps || null,
          p_verification: wanted.verification || null,
          p_device: wanted.deviceId || null,
          p_reflection: wanted.reflection || null,
          p_words: wanted.reflectionWordCount || null
        });
        if (res.error) throw new Error(res.error.message);
        return { committed: !!(res.data && res.data.committed), snapshot: snap(wanted) };
      },

      /* Firebase pushed changes for free; here it is an explicit subscription,
         which at least makes the cost visible. */
      on: function (event, cb) {
        var fire = function () { read(parts, q).then(cb).catch(function () {}); };
        fire();
        
        var ch = sb.channel('uvn:' + parts.join(':') + ':' + uuid())
          .on('postgres_changes',
              { event: '*', schema: 'public', table: 'aa_attendance' }, fire)
          .on('postgres_changes',
              { event: '*', schema: 'public', table: 'aa_class_sessions' }, fire)
          .subscribe();
        self._channel = ch;
        return cb;
      },
      off: function () { if (self._channel) sb.removeChannel(self._channel); }
    };
    return self;
  }

  var db = { ref: function (path) { return makeRef(String(path).split('/').filter(Boolean), {}); } };

  /* ----------------------------------------------------------------- auth */

  function userShim(u) {
    if (!u) return null;
    return {
      uid: u.id,
      email: u.email,
      updatePassword: async function (p) { ok(await sb.auth.updateUser({ password: p })); },
      updateEmail: async function (e) { ok(await sb.auth.updateUser({ email: e })); }
    };
  }

  var auth = {
    currentUser: null,
    createUserWithEmailAndPassword: async function (email, password) {
      var res = await sb.auth.signUp({ email: email, password: String(password) });
      if (res.error) throw new Error(res.error.message);
      if (!res.data.user) throw new Error('Check your email to confirm the account, then log in.');
      auth.currentUser = userShim(res.data.user);
      return { user: auth.currentUser };
    },
    signInWithEmailAndPassword: async function (email, password) {
      var res = await sb.auth.signInWithPassword({ email: email, password: String(password) });
      if (res.error) throw new Error(res.error.message);
      auth.currentUser = userShim(res.data.user);
      return { user: auth.currentUser };
    },
    signOut: function () { auth.currentUser = null; return sb.auth.signOut(); },
    onAuthStateChanged: function (cb) {
      sb.auth.getSession().then(function (r) {
        auth.currentUser = userShim(r.data.session && r.data.session.user);
        cb(auth.currentUser);
      });
      sb.auth.onAuthStateChange(function (_e, session) {
        auth.currentUser = userShim(session && session.user);
        cb(auth.currentUser);
      });
    }
  };

  global.db = db;
  global.auth = auth;
  global.uvnCompat = { sb: sb, snap: snap, read: read, write: write };
})(window);
