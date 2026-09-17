// js/ui.js - tiny shared helpers. No framework, on purpose.

export const $ = id => document.getElementById(id);

export function show(el, on = true) {
  const n = typeof el === 'string' ? $(el) : el;
  if (n) n.classList.toggle('hide', !on);
}

export function msg(el, text, kind = 'ok') {
  const n = typeof el === 'string' ? $(el) : el;
  n.className = 'msg ' + kind;
  n.textContent = text;
  show(n, true);
}

export function clearMsg(el) { show(el, false); }

export const esc = s => String(s == null ? '' : s).replace(/[&<>"]/g,
  c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export const pill = band => `<span class="pill ${esc(band)}">${esc(band)}</span>`;

export const time = iso => iso
  ? new Date(iso).toLocaleString(undefined,
      { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })
  : '-';

/** attendance status -> the colour band the stylesheet knows about */
export const statusBand = s => ({
  present: 'high', review: 'medium', not_recorded: 'none',
  absent: 'low', excused: 'medium'
}[s] || 'none');

export function table(node, headers, rows) {
  const n = typeof node === 'string' ? $(node) : node;
  n.innerHTML =
    '<tr>' + headers.map(h => '<th>' + esc(h) + '</th>').join('') + '</tr>' +
    (rows.length
      ? rows.map(r => '<tr>' + r.map(c => '<td>' + c + '</td>').join('') + '</tr>').join('')
      : '<tr><td colspan="' + headers.length + '" class="empty">Nothing yet.</td></tr>');
}

/** Build a CSV in memory and hand it to the browser. Nothing is uploaded. */
export function downloadCsv(filename, headers, rows) {
  const cell = v => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const body = [headers, ...rows].map(r => r.map(cell).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([body], { type: 'text/csv' }));
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** page chrome: who is signed in, and the way out */
export function header(profile, onSignOut) {
  const bar = document.querySelector('header.bar .who');
  if (!bar) return;
  bar.innerHTML = esc(profile.display_name) +
    (profile.student_number ? ' &middot; ' + esc(profile.student_number) : '') +
    ' <button class="link" id="signout">sign out</button>';
  $('signout').onclick = onSignOut;
}
