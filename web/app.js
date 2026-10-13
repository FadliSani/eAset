(function () {
'use strict';

var ROLE = { ADMIN: 'Admin', PEMBANTU: 'Pembantu Aset', PEMERIKSA: 'Pemeriksa Aset' };
var COND = ['A', 'B', 'C', 'D', 'E', 'F'];
var ACTION_LABEL = {
  LIHAT: 'Lihat', TAMBAH: 'Tambah', UBAH: 'Ubah', PERIKSA: 'Pemeriksaan', PADAM: 'Padam',
  LOGIN: 'Log masuk', KATA_LALUAN: 'Tukar kata laluan'
};

var S = {
  boot: null, user: null, token: '', tab: null, current: null,
  assets: null, log: null, visible: [],
  q: '', fCond: '', fDiff: false, fStale: false,
  selected: new Set(), scanner: null
};
var pendingId = (new URLSearchParams(location.search).get('id') || '').trim().slice(0, 40);

// ---------- Utiliti ----------
var $ = function (s, el) { return (el || document).querySelector(s); };
var $$ = function (s, el) { return Array.prototype.slice.call((el || document).querySelectorAll(s)); };
function esc(v) {
  return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}
function isAdmin() { return S.user.peranan === ROLE.ADMIN; }
function canEdit() { return S.user.peranan !== ROLE.PEMERIKSA; }
function todayISO() {
  var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}
function fmtDate(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  return m ? m[3] + '/' + m[2] + '/' + m[1] : (iso || '—');
}
function daysSince(iso) {
  var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso || '');
  if (!m) return null;
  return Math.floor((Date.now() - new Date(+m[1], +m[2] - 1, +m[3]).getTime()) / 86400000);
}
function num(v) { return v == null || v === '' ? '—' : String(v); }
function norm(s) { return String(s || '').trim().toLowerCase(); }
function hasQtyDiff(a) { return a.kuantitiSebenar != null && a.kuantitiSebenar !== a.kuantitiRekod; }
function hasLocDiff(a) { return norm(a.lokasiSebenar) !== '' && norm(a.lokasiSebenar) !== norm(a.lokasiRekod); }
function hasDiff(a) { return hasQtyDiff(a) || hasLocDiff(a); }
function isStale(a) {
  var d = daysSince(a.tarikhPeriksa);
  return d === null || d > S.boot.staleDays;
}
function toast(msg, kind) {
  var t = $('#toast');
  t.textContent = msg;
  t.className = 'toast show ' + (kind || '');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.className = 'toast'; }, 3600);
}
function busy(btn, on, label) {
  if (!btn) return;
  if (on) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Menyimpan…'; btn.disabled = true; }
  else { btn.textContent = btn.dataset.label || btn.textContent; btn.disabled = false; }
}
var memToken = '';
function loadToken() { try { return localStorage.getItem('aset.token') || memToken; } catch (e) { return memToken; } }
function saveToken(t) {
  memToken = t || '';
  try { if (t) localStorage.setItem('aset.token', t); else localStorage.removeItem('aset.token'); } catch (e) { /* storan disekat */ }
}
function rawCall(fn, args) {
  // POST sebagai text/plain supaya tiada preflight CORS (Apps Script tidak menyokong OPTIONS).
  return fetch(ASET_CONFIG.API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({ fn: fn, args: args })
  }).then(function (r) {
    if (!r.ok) throw new Error('Pelayan membalas ' + r.status + '.');
    return r.json();
  }).then(function (res) {
    if (res && res.ok) return res.data;
    var err = new Error((res && res.error) || 'Ralat tidak diketahui.');
    err.code = res && res.code;
    throw err;
  }, function () {
    throw new Error('Tidak dapat menghubungi pelayan. Semak sambungan internet dan tetapan API_URL.');
  });
}
// Panggilan berpengesahan: token sesi dihantar sebagai hujah pertama.
function call(fn) {
  var args = [S.token].concat(Array.prototype.slice.call(arguments, 1));
  return rawCall(fn, args).catch(function (err) {
    if (err.code === 'AUTH') { handleAuthLost(); return new Promise(function () {}); }
    throw err;
  });
}
function qrSvg(text, cell) {
  var qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  return qr.createSvgTag({ cellSize: cell || 4, margin: 0, scalable: true });
}
function assetUrl(id) { return location.origin + location.pathname + '?id=' + encodeURIComponent(id); }
function extractId(text) {
  var t = String(text || '').trim();
  try {
    var id = new URL(t).searchParams.get('id');
    if (id) return id.trim();
  } catch (e) { /* bukan URL: guna teks sebagai ID */ }
  return t;
}
function upsertCache(a) {
  if (!S.assets) return;
  var i = S.assets.findIndex(function (x) { return x.id === a.id; });
  if (i >= 0) S.assets[i] = a; else S.assets.push(a);
}
function errorBlock(msg) {
  return '<div class="notice err"><b>Ada masalah</b><p>' + esc(msg) + '</p><button class="btn sm" data-act="retry">Cuba lagi</button></div>';
}

// ---------- Permulaan ----------
function tabsFor() {
  if (S.user.peranan === ROLE.ADMIN) {
    return [{ id: 'ringkasan', label: 'Ringkasan' }, { id: 'aset', label: 'Aset' }, { id: 'imbas', label: 'Imbas' },
            { id: 'kata', label: 'Kata laluan' }, { id: 'log', label: 'Log' }];
  }
  if (S.user.peranan === ROLE.PEMBANTU) return [{ id: 'aset', label: 'Aset' }, { id: 'imbas', label: 'Imbas' }];
  return [{ id: 'imbas', label: 'Imbas' }];
}
function renderChrome() {
  if (!S.user) { $('#who').innerHTML = ''; $('#navWrap').hidden = true; return; }
  $('#who').innerHTML = '<b>' + esc(S.user.nama || S.user.peranan) + '</b>' +
    (S.user.nama ? esc(S.user.peranan) + ' ' : '') + '<button type="button" class="link" data-act="logout">Log keluar</button>';
  var tabs = tabsFor();
  var wrap = $('#navWrap');
  if (tabs.length < 2) { wrap.hidden = true; return; }
  wrap.hidden = false;
  $('#nav').innerHTML = tabs.map(function (t) {
    return '<button type="button" data-act="tab" data-tab="' + t.id + '">' + t.label + '</button>';
  }).join('');
}
function markNav() {
  $$('#nav button').forEach(function (b) {
    if (b.dataset.tab === S.tab) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  });
}
function renderLogin(msg) {
  $('#navWrap').hidden = true;
  $('#who').innerHTML = '';
  var lastRole = '', lastName = '';
  try { lastRole = localStorage.getItem('aset.role') || ''; lastName = localStorage.getItem('aset.nama') || ''; } catch (e) { /* storan disekat */ }
  var roles = [ROLE.PEMERIKSA, ROLE.PEMBANTU, ROLE.ADMIN];
  $('#main').innerHTML =
    '<section class="login"><h1>Log masuk</h1>' +
    '<p class="muted">Pilih peranan anda dan masukkan kata laluan yang diberikan oleh Admin.</p>' +
    (msg ? '<div class="notice err" role="alert"><p>' + esc(msg) + '</p></div>' : '') +
    '<form id="loginForm" autocomplete="on">' +
      '<div class="field"><label for="l-role">Peranan</label><select id="l-role" name="role">' +
        roles.map(function (r) { return '<option' + (lastRole === r ? ' selected' : '') + '>' + r + '</option>'; }).join('') + '</select></div>' +
      '<div class="field"><label for="l-nama">Nama (pilihan)</label><input type="text" id="l-nama" name="nama" maxlength="60" autocomplete="name" value="' + esc(lastName) + '">' +
        '<small>Dicatat dalam log aktiviti. Nama ini tidak disahkan.</small></div>' +
      '<div class="field"><label for="l-pw">Kata laluan</label><input type="password" id="l-pw" name="password" required autocomplete="current-password"></div>' +
      '<button class="btn" type="submit" id="loginBtn">Log masuk</button>' +
    '</form></section>';
  $('#l-pw').focus();
}
function handleAuthLost() {
  stopScan();
  closeSheet();
  closeLabels();
  saveToken('');
  S.token = ''; S.user = null; S.assets = null; S.log = null; S.current = null;
  renderLogin('Sesi anda telah tamat. Log masuk semula.');
}
async function doLogin(f) {
  var btn = $('#loginBtn');
  // Guna f.elements: f.role akan mengembalikan sifat ARIA 'role' elemen, bukan kawalan borang.
  var role = f.elements.role.value, pw = f.elements.password.value, nama = f.elements.nama.value;
  try { localStorage.setItem('aset.role', role); localStorage.setItem('aset.nama', nama); } catch (e) { /* storan disekat */ }
  busy(btn, true, 'Memeriksa…');
  try {
    var data = await rawCall('apiLogin', [role, pw, nama]);
    saveToken(data.token);
    S.token = data.token;
    S.user = data.user;
    S.boot = data;
    await enterApp();
  } catch (e) {
    renderLogin(e.message);
  }
}
function doLogout() {
  rawCall('apiLogout', [S.token]).catch(function () { /* abaikan */ });
  stopScan();
  closeSheet();
  saveToken('');
  S.token = ''; S.user = null; S.assets = null; S.log = null; S.current = null;
  renderLogin();
}
async function enterApp() {
  S.assets = null; S.log = null; S.selected.clear();
  renderChrome();
  await go(tabsFor()[0].id);
  if (pendingId) { var id = pendingId; pendingId = ''; openAsset(id); }
}
async function boot() {
  try {
    S.token = loadToken();
    var data = await rawCall('apiInit', [S.token]);
    S.boot = data;
    if (!data.user) return renderLogin();
    S.user = data.user;
    await enterApp();
  } catch (e) {
    $('#main').innerHTML = errorBlock(e.message);
  }
}
async function go(tab) {
  await stopScan();
  S.tab = tab;
  markNav();
  var main = $('#main');
  main.innerHTML = '<p class="muted pad">Memuatkan…</p>';
  try {
    if (tab === 'imbas') return renderImbas();
    if (tab === 'ringkasan' || tab === 'aset') {
      if (!S.assets) S.assets = await call('apiListAssets');
      if (S.tab !== tab) return;
      return tab === 'aset' ? renderAset() : renderRingkasan();
    }
    if (tab === 'kata') return renderKata();
    if (tab === 'log') {
      S.log = await call('apiListLog', 200);
      if (S.tab !== tab) return;
      return renderLog();
    }
  } catch (e) {
    main.innerHTML = errorBlock(e.message);
  }
}
function refreshView() {
  if (S.tab === 'aset' && $('#list')) renderAsetList();
  else if (S.tab === 'ringkasan') renderRingkasan();
}

// ---------- Ringkasan (Admin) ----------
function renderRingkasan() {
  var A = S.assets;
  var totalRekod = A.reduce(function (s, a) { return s + (a.kuantitiRekod || 0); }, 0);
  var checked = A.filter(function (a) { return a.kuantitiSebenar != null; }).length;
  var diff = A.filter(hasDiff);
  var stale = A.filter(isStale);
  var cond = {};
  COND.forEach(function (c) { cond[c] = 0; });
  A.forEach(function (a) { if (cond[a.keadaan] != null) cond[a.keadaan]++; });
  var attention = A.filter(function (a) { return hasDiff(a) || a.keadaan === 'E' || a.keadaan === 'F'; }).slice(0, 10);

  $('#main').innerHTML =
    '<div class="pagehead"><div><h1>Ringkasan</h1><p class="muted">Berdasarkan helaian Aset.</p></div>' +
    '<div class="actions"><button class="btn ghost" data-act="refresh">Muat semula</button></div></div>' +
    '<div class="ledger">' +
      '<div><span class="n">' + A.length + '</span><span class="t">Rekod aset</span><span class="s">Jumlah kuantiti rekod: ' + totalRekod + '</span></div>' +
      '<div><span class="n' + (diff.length ? ' warn' : '') + '">' + diff.length + '</span><span class="t">Ada perbezaan</span><span class="s">Daripada ' + checked + ' yang sudah disahkan</span></div>' +
      '<div><span class="n' + (stale.length ? ' warn' : '') + '">' + stale.length + '</span><span class="t">Lewat diperiksa</span><span class="s">Melebihi ' + S.boot.staleDays + ' hari atau belum pernah</span></div>' +
      '<div><span class="n">' + (cond.E + cond.F) + '</span><span class="t">Keadaan E dan F</span><span class="s">Perlu tindakan hapus kira atau baik pulih</span></div>' +
    '</div>' +
    '<section class="panel"><h2>Taburan keadaan</h2>' +
      '<div class="dist" role="img" aria-label="Taburan keadaan harta modal">' +
        COND.map(function (c) { return A.length && cond[c] ? '<i class="cond-' + c + '" style="width:' + (cond[c] / A.length * 100) + '%"></i>' : ''; }).join('') +
      '</div>' +
      '<div class="legend">' + COND.map(function (c) {
        return '<div class="cond-' + c + '"><i class="badge">' + c + '</i><b>' + cond[c] + '</b></div>';
      }).join('') + '</div></section>' +
    '<h2 class="section-title">Perlu perhatian</h2>' +
    (attention.length
      ? '<div class="list">' + headRow() + attention.map(function (a) { return rowHtml(a, false); }).join('') + '</div>'
      : '<div class="list"><div class="empty">Tiada perbezaan atau aset berkeadaan E dan F.</div></div>');
}

// ---------- Senarai aset ----------
function headRow() {
  return '<div class="row head" aria-hidden="true"><span></span><span>ID</span><span>Jenis Harta Modal dan lokasi</span>' +
         '<span>Kuantiti (rekod / sebenar)</span><span>Keadaan</span><span>Pemeriksaan terakhir</span></div>';
}
function rowHtml(a, withSelect) {
  var stale = isStale(a);
  var locNote = hasLocDiff(a) ? ' → ' + esc(a.lokasiSebenar) : '';
  return '<div class="row' + (hasDiff(a) ? ' diff' : '') + '" role="button" tabindex="0" data-act="open" data-id="' + esc(a.id) + '">' +
    (withSelect === false
      ? '<span class="chk"></span>'
      : '<label class="chk" data-act="noop"><input type="checkbox" data-act="select" data-id="' + esc(a.id) + '"' + (S.selected.has(a.id) ? ' checked' : '') + ' aria-label="Pilih ' + esc(a.id) + '"></label>') +
    '<span class="id">' + esc(a.id) + '</span>' +
    '<span class="main"><strong>' + esc(a.jenis) + '</strong><small>' + esc(a.lokasiRekod) + locNote + '</small></span>' +
    '<span class="qty">' + num(a.kuantitiRekod) + ' / ' + num(a.kuantitiSebenar) + '</span>' +
    '<span class="cond"><i class="badge cond-' + esc(a.keadaan) + '">' + esc(a.keadaan) + '</i></span>' +
    '<span class="date' + (stale ? ' stale' : '') + '">' + (a.tarikhPeriksa ? fmtDate(a.tarikhPeriksa) : 'Belum diperiksa') + '</span>' +
  '</div>';
}
function filtered() {
  var q = S.q.trim().toLowerCase();
  return S.assets.filter(function (a) {
    if (S.fCond && a.keadaan !== S.fCond) return false;
    if (S.fDiff && !hasDiff(a)) return false;
    if (S.fStale && !isStale(a)) return false;
    if (q) {
      var hay = [a.id, a.jenis, a.lokasiRekod, a.lokasiSebenar, a.catatan].join(' ').toLowerCase();
      if (hay.indexOf(q) === -1) return false;
    }
    return true;
  });
}
function renderAset() {
  $('#main').innerHTML =
    '<div class="pagehead"><div><h1>Senarai aset</h1><p class="muted" id="count"></p></div>' +
    '<div class="actions"><button class="btn ghost" data-act="refresh">Muat semula</button><button class="btn" data-act="add">Tambah aset</button></div></div>' +
    '<div class="toolbar">' +
      '<input type="search" id="q" placeholder="Cari ID, jenis, lokasi atau catatan" value="' + esc(S.q) + '" aria-label="Cari aset">' +
      '<select id="fCond" aria-label="Tapis keadaan"><option value="">Semua keadaan</option>' +
        COND.map(function (c) { return '<option' + (S.fCond === c ? ' selected' : '') + '>' + c + '</option>'; }).join('') + '</select>' +
      '<label class="check"><input type="checkbox" id="fDiff"' + (S.fDiff ? ' checked' : '') + '> Ada perbezaan</label>' +
      '<label class="check"><input type="checkbox" id="fStale"' + (S.fStale ? ' checked' : '') + '> Lewat diperiksa</label>' +
    '</div>' +
    '<div class="selbar"><label class="check"><input type="checkbox" id="selAll"> Pilih semua yang dipaparkan</label>' +
    '<button class="btn ghost sm" data-act="labels-selected" id="btnLabels" disabled>Cetak label</button></div>' +
    '<div class="list" id="list"></div>';
  renderAsetList();
}
function renderAsetList() {
  var rows = filtered().sort(function (a, b) { return a.id.localeCompare(b.id, 'ms', { numeric: true }); });
  S.visible = rows;
  $('#count').textContent = rows.length + ' daripada ' + S.assets.length + ' rekod';
  var html;
  if (rows.length) html = headRow() + rows.map(function (a) { return rowHtml(a, true); }).join('');
  else if (!S.assets.length) html = '<div class="empty">Belum ada aset. Tambah aset pertama untuk bermula.<br><button class="btn" data-act="add">Tambah aset</button></div>';
  else html = '<div class="empty">Tiada aset sepadan dengan carian atau tapisan ini.</div>';
  $('#list').innerHTML = html;
  syncSelection();
}
function syncSelection() {
  var n = S.selected.size;
  var b = $('#btnLabels');
  if (b) { b.disabled = !n; b.textContent = n ? 'Cetak label (' + n + ')' : 'Cetak label'; }
  var sa = $('#selAll');
  if (sa) sa.checked = S.visible.length > 0 && S.visible.every(function (r) { return S.selected.has(r.id); });
}

// ---------- Butiran aset ----------
async function openAsset(id) {
  openSheet('<div class="pad muted">Memuatkan…</div>');
  try {
    var a = await call('apiGetAsset', id);
    S.current = a;
    upsertCache(a);
    showDetail(a);
  } catch (e) {
    openSheet(sheetTop('Aset tidak ditemui') + '<div class="notice err"><p>' + esc(e.message) + '</p></div>');
  }
}
function sheetTop(title) {
  return '<div class="sheet-top"><h2>' + esc(title) + '</h2><button type="button" class="btn ghost sm" data-act="close">Tutup</button></div>';
}
function pair(label, rec, act, diff) {
  return '<div class="pair' + (diff ? ' diff' : '') + '">' +
    '<div><span>' + label + ' (Rekod)</span><b>' + (rec == null || rec === '' ? '—' : esc(rec)) + '</b></div>' +
    '<div><span>' + label + ' (Sebenar)</span><b>' + (act == null || act === '' ? '<em>Belum direkod</em>' : esc(act)) + '</b></div>' +
    (diff ? '<p class="dn">Sebenar berbeza daripada rekod.</p>' : '') + '</div>';
}
function showDetail(a) {
  var d = daysSince(a.tarikhPeriksa);
  var checked = a.tarikhPeriksa
    ? fmtDate(a.tarikhPeriksa) + (d !== null ? ' (' + (d === 0 ? 'hari ini' : d + ' hari lalu') + ')' : '')
    : 'Belum pernah diperiksa';
  var html = sheetTop('Butiran aset') +
    '<article class="tag">' +
      '<div class="tag-head">' +
        '<div class="tag-main"><span class="idbig">' + esc(a.id) + '</span><h3>' + esc(a.jenis) + '</h3>' +
        '<span class="muted">Didaftarkan ' + fmtDate(a.tarikhDaftar) + '</span></div>' +
        '<div class="tag-side"><div class="stamp cond-' + esc(a.keadaan) + '" title="Keadaan Harta Modal">' + esc(a.keadaan) + '</div>Keadaan</div>' +
      '</div>' +
      '<div class="tag-body">' +
        pair('Lokasi', a.lokasiRekod, a.lokasiSebenar, hasLocDiff(a)) +
        pair('Kuantiti', a.kuantitiRekod, a.kuantitiSebenar, hasQtyDiff(a)) +
        '<div class="kv"><span>Tarikh Pemeriksaan Terakhir</span><b' + (isStale(a) ? ' class="stale"' : '') + '>' + esc(checked) + '</b></div>' +
        '<div class="kv"><span>Catatan</span><b class="pre">' + (a.catatan ? esc(a.catatan) : '—') + '</b></div>' +
      '</div>' +
      (canEdit()
        ? '<div class="tag-qr"><div class="qr">' + qrSvg(assetUrl(a.id)) + '</div><p>Kod QR ini membuka aset di dalam aplikasi. Boleh juga diimbas dengan kamera telefon.</p></div>'
        : '') +
    '</article>' +
    (canEdit()
      ? '<div class="actions-bar">' +
          '<button class="btn" data-act="inspect">Rekod pemeriksaan</button>' +
          '<button class="btn ghost" data-act="edit">Sunting</button>' +
          '<button class="btn ghost" data-act="label-one">Cetak label</button>' +
          (isAdmin() ? '<button class="btn danger" data-act="ask-delete">Padam</button>' : '') +
        '</div>'
      : '<p class="muted note">Paparan sahaja. Minta Pembantu Aset mengemas kini jika maklumat tidak tepat.</p>');
  openSheet(html);
}

// ---------- Borang aset ----------
function segHtml(name, val) {
  return '<div class="seg" role="radiogroup" aria-label="Keadaan Harta Modal">' + COND.map(function (c, i) {
    return '<label class="cond-' + c + '"><input type="radio" name="' + name + '" value="' + c + '"' +
      (val === c ? ' checked' : '') + (i === 0 ? ' required' : '') + '><span>' + c + '</span></label>';
  }).join('') + '</div>';
}
function openForm(a) {
  var isNew = !a;
  var v = a || { id: '', jenis: '', lokasiRekod: '', lokasiSebenar: '', kuantitiRekod: null, kuantitiSebenar: null,
                 keadaan: '', tarikhDaftar: todayISO(), tarikhPeriksa: '', catatan: '' };
  openSheet(sheetTop(isNew ? 'Tambah aset' : 'Sunting aset') +
    '<form id="assetForm" data-new="' + (isNew ? 1 : 0) + '" autocomplete="off">' +
      '<div class="field"><label for="f-id">ID</label>' +
        '<input type="text" id="f-id" name="id" maxlength="40" value="' + esc(v.id) + '"' + (isNew ? ' placeholder="Dijana automatik jika dikosongkan"' : ' readonly') + '>' +
        '<small>' + (isNew ? 'Isi hanya jika aset sudah mempunyai nombor pendaftaran.' : 'ID tidak boleh diubah.') + '</small></div>' +
      '<div class="field"><label for="f-jenis">Jenis Harta Modal</label><input type="text" id="f-jenis" name="jenis" required value="' + esc(v.jenis) + '"></div>' +
      '<div class="cols">' +
        '<div class="field"><label for="f-lr">Lokasi (Rekod)</label><input type="text" id="f-lr" name="lokasiRekod" required value="' + esc(v.lokasiRekod) + '"></div>' +
        '<div class="field"><label for="f-ls">Lokasi (Sebenar)</label><input type="text" id="f-ls" name="lokasiSebenar" value="' + esc(v.lokasiSebenar) + '"></div>' +
      '</div>' +
      '<div class="cols">' +
        '<div class="field"><label for="f-kr">Kuantiti (Rekod)</label><input type="number" id="f-kr" name="kuantitiRekod" min="0" step="1" inputmode="numeric" required value="' + esc(v.kuantitiRekod) + '"></div>' +
        '<div class="field"><label for="f-ks">Kuantiti (Sebenar)</label><input type="number" id="f-ks" name="kuantitiSebenar" min="0" step="1" inputmode="numeric" value="' + esc(v.kuantitiSebenar) + '"></div>' +
      '</div>' +
      '<div class="field"><span class="lbl">Keadaan Harta Modal</span>' + segHtml('keadaan', v.keadaan) + '</div>' +
      '<div class="cols">' +
        '<div class="field"><label for="f-td">Tarikh Pendaftaran</label><input type="date" id="f-td" name="tarikhDaftar" required value="' + esc(v.tarikhDaftar) + '"></div>' +
        '<div class="field"><label for="f-tp">Tarikh Pemeriksaan Terakhir</label><input type="date" id="f-tp" name="tarikhPeriksa" value="' + esc(v.tarikhPeriksa) + '"></div>' +
      '</div>' +
      '<div class="field"><label for="f-c">Catatan</label><textarea id="f-c" name="catatan">' + esc(v.catatan) + '</textarea></div>' +
      '<div class="form-actions"><button class="btn" type="submit" id="saveBtn">Simpan</button>' +
      '<button type="button" class="btn ghost" data-act="' + (isNew ? 'close' : 'back-detail') + '">Batal</button></div>' +
    '</form>');
  var first = $(isNew ? '#f-id' : '#f-jenis');
  if (first) first.focus();
}
async function saveAsset(f) {
  var data = Object.fromEntries(new FormData(f));
  var isNew = f.dataset.new === '1';
  var btn = $('#saveBtn');
  busy(btn, true);
  try {
    var saved = await call('apiSaveAsset', data, isNew);
    upsertCache(saved);
    S.current = saved;
    toast(isNew ? 'Aset ditambah.' : 'Perubahan disimpan.', 'ok');
    showDetail(saved);
    refreshView();
  } catch (e) {
    toast(e.message, 'err');
    busy(btn, false);
  }
}

// ---------- Rekod pemeriksaan ----------
function openInspect(a) {
  openSheet(sheetTop('Rekod pemeriksaan') +
    '<p class="muted" style="margin-bottom:14px"><span class="mono">' + esc(a.id) + '</span><br>' + esc(a.jenis) + '</p>' +
    '<form id="inspectForm" data-id="' + esc(a.id) + '" autocomplete="off">' +
      '<div class="field"><label for="i-lok">Lokasi (Sebenar)</label>' +
        '<input type="text" id="i-lok" name="lokasiSebenar" required value="' + esc(a.lokasiSebenar) + '">' +
        '<button type="button" class="link" data-act="fill" data-target="i-lok" data-value="' + esc(a.lokasiRekod) + '">Sama seperti rekod: ' + esc(a.lokasiRekod) + '</button></div>' +
      '<div class="field"><label for="i-kuan">Kuantiti (Sebenar)</label>' +
        '<input type="number" id="i-kuan" name="kuantitiSebenar" min="0" step="1" inputmode="numeric" required value="' + esc(a.kuantitiSebenar) + '">' +
        '<button type="button" class="link" data-act="fill" data-target="i-kuan" data-value="' + esc(a.kuantitiRekod) + '">Sama seperti rekod: ' + num(a.kuantitiRekod) + '</button></div>' +
      '<div class="field"><span class="lbl">Keadaan Harta Modal</span>' + segHtml('keadaan', a.keadaan) + '</div>' +
      '<div class="field"><label for="i-cat">Catatan</label><textarea id="i-cat" name="catatan">' + esc(a.catatan) + '</textarea></div>' +
      '<p class="muted" style="font-size:14px;margin-bottom:12px">Tarikh Pemeriksaan Terakhir akan ditetapkan kepada hari ini.</p>' +
      '<div class="form-actions"><button class="btn" type="submit" id="saveBtn">Simpan pemeriksaan</button>' +
      '<button type="button" class="btn ghost" data-act="back-detail">Batal</button></div>' +
    '</form>');
  $('#i-lok').focus();
}
async function saveInspection(f) {
  var data = Object.fromEntries(new FormData(f));
  var btn = $('#saveBtn');
  busy(btn, true);
  try {
    var saved = await call('apiRecordInspection', f.dataset.id, data);
    upsertCache(saved);
    S.current = saved;
    toast('Pemeriksaan direkod.', 'ok');
    showDetail(saved);
    refreshView();
  } catch (e) {
    toast(e.message, 'err');
    busy(btn, false);
  }
}

// ---------- Padam ----------
function askDelete(a) {
  openSheet(sheetTop('Padam aset?') +
    '<div class="notice"><p>Rekod <b class="mono">' + esc(a.id) + '</b> (' + esc(a.jenis) + ') akan dipadam daripada Google Sheets. ' +
    'Anda boleh memulihkannya melalui sejarah versi Sheets, bukan daripada aplikasi ini.</p></div>' +
    '<div class="form-actions"><button class="btn solid-danger" data-act="do-delete">Ya, padam</button>' +
    '<button class="btn ghost" data-act="back-detail">Batal</button></div>');
}
async function doDelete(btn) {
  var id = S.current.id;
  busy(btn, true, 'Memadam…');
  try {
    await call('apiDeleteAsset', id);
    S.assets = (S.assets || []).filter(function (x) { return x.id !== id; });
    S.selected.delete(id);
    closeSheet();
    toast('Aset dipadam.', 'ok');
    refreshView();
  } catch (e) {
    toast(e.message, 'err');
    busy(btn, false);
  }
}

// ---------- Imbas ----------
function renderImbas() {
  $('#main').innerHTML =
    '<section class="scan">' +
      '<div class="pagehead"><div><h1>Imbas aset</h1></div></div>' +
      '<div class="viewfinder"><div id="reader"></div><div class="vf-idle" id="vfIdle">Tekan “Mula imbas” dan halakan kamera ke kod pada label aset.</div></div>' +
      '<div class="scan-actions">' +
      '<button class="btn" data-act="scan-toggle" id="scanBtn">Mula imbas</button>' +
      '<label class="btn ghost" for="scanFile">Imbas daripada foto</label>' +
      '<input type="file" id="scanFile" accept="image/*" capture="environment" hidden></div>' +
      '<form id="manual" class="manual"><label for="manualId">Atau taip ID aset</label>' +
      '<div class="inline"><input type="text" id="manualId" name="manualId" placeholder="Contoh: AST-00001" autocomplete="off" maxlength="40"><button class="btn" type="submit">Cari</button></div></form>' +
      '<p class="hint">' + (S.user.peranan === ROLE.PEMERIKSA
        ? 'Anda boleh melihat butiran aset yang diimbas. Anda tidak boleh mengubah rekod.'
        : 'Selepas imbasan, anda boleh merekod pemeriksaan atau menyunting aset.') + '</p>' +
    '</section>';
}
function setScanBtn() {
  var b = $('#scanBtn');
  if (b) b.textContent = S.scanner ? 'Henti imbas' : 'Mula imbas';
  var idle = $('#vfIdle');
  if (idle) idle.hidden = !!S.scanner;
}
function scanConfig() {
  return { fps: 10, qrbox: function (w, h) { var m = Math.floor(Math.min(w, h) * 0.7); return { width: m, height: m }; } };
}
function cameraApiMissing() {
  return !window.isSecureContext || !(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}
async function tryStart(facing) {
  var sc = new Html5Qrcode('reader');
  S.scanner = sc; // ditetapkan dahulu supaya imbasan pertama tidak terlepas
  try {
    await sc.start({ facingMode: facing }, scanConfig(), onDecoded, function () {});
  } catch (e) {
    S.scanner = null;
    try { sc.clear(); } catch (_) { /* tiada apa-apa */ }
    throw e;
  }
}
// Terjemah ralat kamera kepada punca dan tindakan yang boleh dibuat pengguna.
function cameraProblem(e) {
  var raw = String((e && ((e.name ? e.name + ': ' : '') + (e.message || ''))) || e || '');
  var found = /(NotAllowedError|PermissionDeniedError|NotFoundError|DevicesNotFoundError|NotReadableError|TrackStartError|OverconstrainedError|SecurityError|AbortError)/.exec(raw);
  var code = found ? found[1] : 'Tidak diketahui';
  var text;
  if (cameraApiMissing()) {
    code = 'TiadaAPIKamera';
    text = 'Pelayar ini tidak menyediakan akses kamera untuk halaman ini. Buka pautan dalam Chrome atau Safari, bukan dalam pelayar dalam aplikasi seperti WhatsApp atau Telegram.';
  } else if (/NotAllowed|PermissionDenied|Security/.test(code)) {
    text = 'Akses kamera disekat. Jika pelayar tidak pernah bertanya, ia menyekat kamera dalam bingkai halaman ini. Jika anda pernah menolak, benarkan kamera di tetapan laman lalu muat semula.';
  } else if (/NotFound|DevicesNotFound/.test(code)) {
    text = 'Tiada kamera dikesan pada peranti ini.';
  } else if (/NotReadable|TrackStart|Abort/.test(code)) {
    text = 'Kamera sedang digunakan oleh aplikasi lain. Tutup aplikasi itu dan cuba lagi.';
  } else {
    text = 'Kamera tidak dapat dibuka.';
  }
  return { code: code, text: text + ' Anda masih boleh guna “Imbas daripada foto”, kamera telefon untuk mengimbas kod QR, atau taip ID.' };
}
async function startScan() {
  if (S.scanner) return;
  var idle = $('#vfIdle');
  try {
    if (cameraApiMissing()) throw new Error('TiadaAPIKamera');
    try {
      await tryStart('environment');
    } catch (e1) {
      if (/NotAllowed|PermissionDenied|Security/.test(String(e1))) throw e1; // disekat: jangan cuba lagi
      await tryStart('user'); // komputer riba biasanya hanya ada kamera hadapan
    }
    setScanBtn();
  } catch (e) {
    S.scanner = null;
    setScanBtn();
    var p = cameraProblem(e);
    if (idle) { idle.hidden = false; idle.innerHTML = esc(p.text) + '<br><small>Kod ralat: ' + esc(p.code) + '</small>'; }
    toast('Kamera tidak dapat dibuka.', 'err');
  }
}
async function stopScan() {
  var sc = S.scanner;
  S.scanner = null;
  if (!sc) return;
  try { await sc.stop(); } catch (e) { /* sudah berhenti */ }
  try { sc.clear(); } catch (e) { /* tiada apa-apa */ }
  setScanBtn();
}
async function onDecoded(text) {
  if (!S.scanner) return;
  await stopScan();
  if (navigator.vibrate) navigator.vibrate(60);
  openAsset(extractId(text));
}
async function scanFromFile(file) {
  if (!file) return;
  await stopScan();
  var sc = new Html5Qrcode('reader');
  try {
    var text = await sc.scanFile(file, false);
    openAsset(extractId(text));
  } catch (e) {
    toast('Kod tidak dapat dibaca daripada foto. Cuba foto yang lebih jelas dan dekat.', 'err');
  } finally {
    try { sc.clear(); } catch (e) { /* tiada apa-apa */ }
  }
}

// ---------- Label QR ----------
function openLabels(list) {
  if (!list.length) return;
  closeSheet();
  $('#labelGrid').innerHTML = list.map(function (a) {
    return '<div class="lbl"><div class="qr">' + qrSvg(assetUrl(a.id), 3) + '</div>' +
      '<div class="t"><b>' + esc(a.id) + '</b><span>' + esc(a.jenis) + '</span><small>' + esc(a.lokasiRekod) + '</small></div></div>';
  }).join('');
  $('#labelCount').textContent = list.length + ' label';
  $('#labels').hidden = false;
  document.body.classList.add('noscroll');
}
function closeLabels() {
  $('#labels').hidden = true;
  document.body.classList.remove('noscroll');
}

// ---------- Kata laluan (Admin) ----------
function renderKata() {
  $('#main').innerHTML =
    '<div class="pagehead"><div><h1>Kata laluan</h1>' +
    '<p class="muted">Setiap peranan mempunyai kata laluan sendiri. Menukar kata laluan melog keluar semua pengguna peranan itu.</p></div></div>' +
    [ROLE.ADMIN, ROLE.PEMBANTU, ROLE.PEMERIKSA].map(function (r, i) {
      return '<form class="panel pwform" data-role="' + esc(r) + '" autocomplete="off">' +
        '<h2>' + esc(r) + '</h2>' +
        '<div class="field"><label for="pw-' + i + '">Kata laluan baharu</label>' +
        '<input type="password" id="pw-' + i + '" name="pw" minlength="8" required autocomplete="new-password">' +
        '<small>Sekurang-kurangnya 8 aksara dan berbeza daripada peranan lain.</small></div>' +
        '<button class="btn" type="submit">Simpan</button></form>';
    }).join('');
}
async function savePassword(f) {
  var btn = f.querySelector('button[type=submit]');
  busy(btn, true);
  try {
    var res = await call('apiSetPassword', f.dataset.role, f.elements.pw.value);
    if (res && res.token) { saveToken(res.token); S.token = res.token; }
    f.reset();
    toast('Kata laluan ' + f.dataset.role + ' dikemas kini.', 'ok');
  } catch (e) {
    toast(e.message, 'err');
  }
  busy(btn, false);
}

// ---------- Log (Admin) ----------
function renderLog() {
  var L = S.log;
  $('#main').innerHTML =
    '<div class="pagehead"><div><h1>Log aktiviti</h1><p class="muted">200 rekod terkini, yang terbaru dahulu.</p></div>' +
    '<div class="actions"><button class="btn ghost" data-act="refresh">Muat semula</button></div></div>' +
    '<div class="list"><div class="lrow head"><span>Masa</span><span>Nama</span><span>Peranan</span><span>Tindakan</span><span>Butiran</span></div>' +
    (L.length ? L.map(function (r) {
      return '<div class="lrow"><span class="mono">' + esc(r.masa) + '</span><span>' + esc(r.nama || '—') + '</span><span>' + esc(r.peranan) +
        '</span><span><b>' + esc(ACTION_LABEL[r.tindakan] || r.tindakan) + '</b></span><span>' +
        (r.id ? '<span class="mono">' + esc(r.id) + '</span> ' : '') + esc(r.ringkasan) + '</span></div>';
    }).join('') : '<div class="empty">Log masih kosong.</div>') + '</div>';
}

// ---------- Panel sisi ----------
function openSheet(html) {
  $('#sheetBody').innerHTML = html;
  $('#layer').hidden = false;
  document.body.classList.add('noscroll');
  $('#sheet').scrollTop = 0;
}
function closeSheet() {
  $('#layer').hidden = true;
  $('#sheetBody').innerHTML = '';
  if ($('#labels').hidden) document.body.classList.remove('noscroll');
}

// ---------- Peristiwa ----------
document.addEventListener('click', function (e) {
  var t = e.target.closest('[data-act]');
  if (!t) return;
  var act = t.dataset.act;
  var id = t.dataset.id;
  switch (act) {
    case 'tab': go(t.dataset.tab); break;
    case 'close': closeSheet(); break;
    case 'noop': break;
    case 'retry': S.user ? go(S.tab) : boot(); break;
    case 'refresh': S.assets = null; go(S.tab); break;
    case 'open': openAsset(id); break;
    case 'select':
      if (t.checked) S.selected.add(id); else S.selected.delete(id);
      syncSelection();
      break;
    case 'add': openForm(null); break;
    case 'edit': openForm(S.current); break;
    case 'inspect': openInspect(S.current); break;
    case 'back-detail': showDetail(S.current); break;
    case 'ask-delete': askDelete(S.current); break;
    case 'do-delete': doDelete(t); break;
    case 'fill': $('#' + t.dataset.target).value = t.dataset.value; break;
    case 'label-one': openLabels([S.current]); break;
    case 'labels-selected':
      openLabels((S.assets || []).filter(function (a) { return S.selected.has(a.id); }));
      break;
    case 'print-labels':
      try { window.print(); } catch (err) { toast('Tekan Ctrl+P (atau Cmd+P) untuk mencetak.', 'err'); }
      break;
    case 'close-labels': closeLabels(); break;
    case 'scan-toggle': S.scanner ? stopScan() : startScan(); break;
    case 'logout': doLogout(); break;
  }
});

$('#layer').addEventListener('click', function (e) { if (e.target === this) closeSheet(); });

document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape') {
    if (!$('#labels').hidden) closeLabels();
    else if (!$('#layer').hidden) closeSheet();
    return;
  }
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('.row[data-act]')) {
    e.preventDefault();
    e.target.click();
  }
});

document.addEventListener('input', function (e) {
  if (e.target.id === 'q') { S.q = e.target.value; renderAsetList(); }
});

document.addEventListener('change', function (e) {
  var el = e.target;
  if (el.id === 'fCond') { S.fCond = el.value; renderAsetList(); }
  else if (el.id === 'fDiff') { S.fDiff = el.checked; renderAsetList(); }
  else if (el.id === 'fStale') { S.fStale = el.checked; renderAsetList(); }
  else if (el.id === 'selAll') {
    S.visible.forEach(function (r) { if (el.checked) S.selected.add(r.id); else S.selected.delete(r.id); });
    renderAsetList();
  } else if (el.id === 'scanFile') {
    var file = el.files && el.files[0];
    el.value = '';
    scanFromFile(file);
  }
});

document.addEventListener('submit', function (e) {
  var f = e.target;
  e.preventDefault();
  if (f.id === 'assetForm') saveAsset(f);
  else if (f.id === 'inspectForm') saveInspection(f);
  else if (f.id === 'loginForm') doLogin(f);
  else if (f.classList.contains('pwform')) savePassword(f);
  else if (f.id === 'manual') {
    var id = f.elements.manualId.value.trim();
    if (id) openAsset(id);
  }
});

boot();
})();
