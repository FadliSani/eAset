/**
 * Pengurusan Aset & Inventori
 * Google Apps Script (API JSON) + Google Sheets sebagai pangkalan data.
 * Antara muka (folder web/) dihoskan di GitHub Pages dan memanggil API ini.
 *
 * Log masuk: pilih peranan + kata laluan. Setiap peranan mempunyai kata laluan
 * sendiri yang ditetapkan oleh Admin. Tidak perlu akaun Google.
 *
 *   Admin           - urus semua rekod, kata laluan dan log
 *   Pembantu Aset   - tambah/sunting rekod, rekod pemeriksaan, cetak label QR
 *   Pemeriksa Aset  - lihat butiran satu aset dengan mengimbas kod (tiada senarai)
 *
 * Semua kebenaran dikuatkuasakan DI SINI (server). UI hanya menyembunyikan butang.
 * Kata laluan disimpan sebagai hash (bersama salt) dalam Script Properties,
 * BUKAN dalam helaian.
 */

// ---------------------------------------------------------------------------
// Konfigurasi
// ---------------------------------------------------------------------------
const CFG = {
  APP_NAME: 'Pengurusan Aset',
  // Alamat GitHub Pages anda, cth. 'https://nama.github.io/eAset/'. Hanya untuk mengalihkan QR lama.
  FRONTEND_URL: '',
  SHEET_ASET: 'Aset',
  SHEET_LOG: 'Log',
  ID_PREFIX: 'AST-',
  ID_DIGITS: 5,
  STALE_DAYS: 365,        // "Lewat diperiksa" jika lebih lama daripada ini
  MIN_PASSWORD: 8,
  MAX_FAILS: 10,          // percubaan gagal dibenarkan dalam tetingkap di bawah
  FAIL_WINDOW_SEC: 600,   // 10 minit
  SESSION_SEC: 21600,     // 6 jam (had maksimum CacheService)
  CONDITIONS: ['A', 'B', 'C', 'D', 'E', 'F'],
  ROLES: {
    ADMIN: 'Admin',
    PEMBANTU: 'Pembantu Aset',
    PEMERIKSA: 'Pemeriksa Aset'
  }
};

const ALL_ROLES = [CFG.ROLES.ADMIN, CFG.ROLES.PEMBANTU, CFG.ROLES.PEMERIKSA];
const EDITORS = [CFG.ROLES.ADMIN, CFG.ROLES.PEMBANTU];
const ADMIN_ONLY = [CFG.ROLES.ADMIN];

// Susunan lajur dalam helaian "Aset" (mesti sama dengan 10 butiran yang diminta)
const ASET_HEADERS = [
  'ID',
  'Jenis Harta Modal',
  'Lokasi (Rekod)',
  'Lokasi (Sebenar)',
  'Kuantiti (Rekod)',
  'Kuantiti (Sebenar)',
  'Keadaan Harta Modal',
  'Tarikh Pendaftaran',
  'Tarikh Pemeriksaan Terakhir',
  'Catatan'
];
const ASET_KEYS = [
  'id', 'jenis', 'lokasiRekod', 'lokasiSebenar', 'kuantitiRekod',
  'kuantitiSebenar', 'keadaan', 'tarikhDaftar', 'tarikhPeriksa', 'catatan'
];
const LOG_HEADERS = ['Masa', 'Nama', 'Peranan', 'Tindakan', 'ID', 'Ringkasan'];

// Format teks ('@') menghalang input pengguna ditafsir sebagai formula Sheets.
const ASET_FORMATS = ['@', '@', '@', '@', '0', '0', '@', 'dd/mm/yyyy', 'dd/mm/yyyy', '@'];
const LOG_FORMATS = ['dd/mm/yyyy hh:mm:ss', '@', '@', '@', '@', '@'];

// ---------------------------------------------------------------------------
// Titik masuk web app (API JSON; antara muka dihoskan di GitHub Pages)
// ---------------------------------------------------------------------------
const API_FUNCTIONS = {
  apiInit: apiInit,
  apiLogin: apiLogin,
  apiLogout: apiLogout,
  apiSetPassword: apiSetPassword,
  apiGetAsset: apiGetAsset,
  apiListAssets: apiListAssets,
  apiSaveAsset: apiSaveAsset,
  apiRecordInspection: apiRecordInspection,
  apiDeleteAsset: apiDeleteAsset,
  apiListLog: apiListLog
};

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Pautan QR lama (…/exec?id=X) dihalakan ke antara muka baharu jika FRONTEND_URL ditetapkan. */
function doGet(e) {
  const id = e && e.parameter && e.parameter.id ? String(e.parameter.id).replace(/[^A-Za-z0-9._\-\/]/g, '').slice(0, 40) : '';
  if (CFG.FRONTEND_URL && id) {
    const url = CFG.FRONTEND_URL + '?id=' + encodeURIComponent(id);
    return HtmlService.createHtmlOutput(
      '<!DOCTYPE html><meta charset="utf-8"><p>Mengalihkan… <a target="_top" href="' + url + '">Klik di sini</a></p>' +
      '<script>window.top.location.href=' + JSON.stringify(url).replace(/</g, '\\u003c') + ';</script>'
    );
  }
  return json_({ ok: true, name: CFG.APP_NAME, message: 'API aktif. Gunakan POST.' });
}

/** Badan permintaan: {"fn": "apiXxx", "args": [...]}. Pengesahan dibuat dalam setiap fungsi (token sesi). */
function doPost(e) {
  try {
    const req = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const fn = Object.prototype.hasOwnProperty.call(API_FUNCTIONS, req.fn) ? API_FUNCTIONS[req.fn] : null;
    if (!fn) return json_({ ok: false, error: 'Permintaan tidak dikenali.' });
    return json_(fn.apply(null, Array.isArray(req.args) ? req.args : []));
  } catch (err) {
    return json_({ ok: false, error: String((err && err.message) || err) });
  }
}

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Aplikasi Aset')
    .addItem('Sediakan helaian (setup)', 'setup')
    .addItem('Masukkan data contoh', 'seedDemoData')
    .addItem('Tetapkan semula kata laluan Admin', 'resetAdminPassword')
    .addToUi();
}

// ---------------------------------------------------------------------------
// Persediaan (jalankan sekali)
// ---------------------------------------------------------------------------
function setup() {
  const ss = ss_();

  const aset = getOrCreateSheet_(ss, CFG.SHEET_ASET);
  prepareHeader_(aset, ASET_HEADERS);
  aset.getRange('A2:D').setNumberFormat('@');
  aset.getRange('E2:F').setNumberFormat('0');
  aset.getRange('G2:G').setNumberFormat('@');
  aset.getRange('H2:I').setNumberFormat('dd/mm/yyyy');
  aset.getRange('J2:J').setNumberFormat('@');
  aset.getRange('G2:G').setDataValidation(
    SpreadsheetApp.newDataValidation().requireValueInList(CFG.CONDITIONS, true).setAllowInvalid(false).build()
  );
  aset.getRange('E2:F').setDataValidation(
    SpreadsheetApp.newDataValidation().requireNumberGreaterThanOrEqualTo(0).setAllowInvalid(false).build()
  );
  aset.setColumnWidths(1, 1, 110);
  aset.setColumnWidths(2, 1, 240);
  aset.setColumnWidths(3, 2, 190);
  aset.setColumnWidths(5, 2, 110);
  aset.setColumnWidths(7, 3, 150);
  aset.setColumnWidth(10, 280);

  const log = getOrCreateSheet_(ss, CFG.SHEET_LOG);
  prepareHeader_(log, LOG_HEADERS);
  log.getRange('A2:A').setNumberFormat('dd/mm/yyyy hh:mm:ss');
  log.getRange('B2:F').setNumberFormat('@');
  log.setColumnWidth(1, 150);
  log.setColumnWidths(2, 2, 150);
  log.setColumnWidth(6, 420);

  // Kata laluan awal dijana rawak hanya untuk peranan yang belum mempunyainya.
  const created = initPasswords_();
  const lines = Object.keys(created).map(function (r) { return r + ': ' + created[r]; });
  showMessage_(
    'Helaian siap.' +
    (lines.length
      ? '\n\nKata laluan awal (dipaparkan sekali sahaja, simpan sekarang):\n\n' + lines.join('\n') +
        '\n\nLog masuk sebagai Admin dan tukar kata laluan di tab "Kata laluan".'
      : '\n\nKata laluan sedia ada tidak diubah.') +
    '\n\nSeterusnya: Deploy > New deployment > Web app.'
  );
}

/** Untuk pemilik helaian: jana kata laluan Admin baharu jika terlupa. */
function resetAdminPassword() {
  const p = randomPassword_();
  setPassword_(CFG.ROLES.ADMIN, p);
  showMessage_('Kata laluan Admin baharu:\n\n' + p + '\n\nSemua sesi Admin telah ditamatkan.');
}

function seedDemoData() {
  const sh = getSheet_(CFG.SHEET_ASET);
  const demo = [
    ['Komputer riba Dell Latitude 5440', 'Pejabat Pentadbiran', 'Pejabat Pentadbiran', 4, 4, 'B', '2023-03-14', '2026-02-10', 'Lengkap dengan beg.'],
    ['Pencetak Canon imageRUNNER', 'Bilik Fail', 'Bilik Mesyuarat Utama', 1, 1, 'C', '2021-07-01', '2025-05-20', 'Dialihkan ke bilik mesyuarat tanpa kemas kini rekod.'],
    ['Kerusi eksekutif', 'Bilik Pengarah', 'Bilik Pengarah', 6, 5, 'D', '2019-11-12', '2026-01-08', 'Satu kerusi rosak, menunggu hapus kira.'],
    ['Projektor Epson EB-X49', 'Bilik Mesyuarat Utama', '', 2, null, 'A', '2024-05-02', '', ''],
    ['Penyaman udara Daikin 2.0HP', 'Bilik Server', 'Bilik Server', 1, 1, 'F', '2015-08-19', '2024-09-30', 'Tidak berfungsi. Cadangan lupus.']
  ];
  withLock_(function () {
    demo.forEach(function (d) {
      const a = normalizeAsset_({
        jenis: d[0], lokasiRekod: d[1], lokasiSebenar: d[2], kuantitiRekod: d[3],
        kuantitiSebenar: d[4], keadaan: d[5], tarikhDaftar: d[6], tarikhPeriksa: d[7], catatan: d[8]
      });
      a.id = nextId_(readIds_(sh));
      writeRow_(sh, sh.getLastRow() + 1, assetToRow_(a), ASET_FORMATS);
    });
  });
}

// ---------------------------------------------------------------------------
// Kata laluan & sesi
// ---------------------------------------------------------------------------
function toHex_(bytes) {
  return bytes.map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function hash_(password, salt) {
  return toHex_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256, salt + '|' + password, Utilities.Charset.UTF_8
  ));
}

function setPassword_(role, password) {
  const props = PropertiesService.getScriptProperties();
  const salt = Utilities.getUuid();
  props.setProperty('pw:' + role, salt + ':' + hash_(password, salt));
  // Naikkan versi: semua sesi lama bagi peranan ini menjadi tidak sah.
  props.setProperty('ver:' + role, String(Number(props.getProperty('ver:' + role) || 0) + 1));
}

function checkPassword_(role, password) {
  const stored = PropertiesService.getScriptProperties().getProperty('pw:' + role);
  if (!stored) return false;
  const i = stored.indexOf(':');
  return hash_(password, stored.slice(0, i)) === stored.slice(i + 1);
}

function randomPassword_() {
  const h = Utilities.getUuid().replace(/-/g, '');
  return h.slice(0, 4) + '-' + h.slice(4, 8) + '-' + h.slice(8, 12);
}

function initPasswords_() {
  const props = PropertiesService.getScriptProperties();
  const created = {};
  ALL_ROLES.forEach(function (r) {
    if (!props.getProperty('pw:' + r)) {
      const p = randomPassword_();
      setPassword_(r, p);
      created[r] = p;
    }
  });
  return created;
}

function createSession_(nama, peranan) {
  const ver = Number(PropertiesService.getScriptProperties().getProperty('ver:' + peranan) || 0);
  const token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put(
    's:' + token, JSON.stringify({ nama: nama, peranan: peranan, ver: ver }), CFG.SESSION_SEC
  );
  return token;
}

function currentUser_(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const raw = CacheService.getScriptCache().get('s:' + token);
  if (!raw) return null;
  const s = JSON.parse(raw);
  const ver = Number(PropertiesService.getScriptProperties().getProperty('ver:' + s.peranan) || 0);
  if (s.ver !== ver || ALL_ROLES.indexOf(s.peranan) === -1) return null;
  return { nama: s.nama, peranan: s.peranan };
}

/** Bungkus API: semak sesi & peranan, tangkap ralat, pulangkan {ok, data|error, code}. */
function run_(token, allowedRoles, fn) {
  try {
    const user = currentUser_(token);
    if (!user) return { ok: false, code: 'AUTH', error: 'Sesi tamat. Sila log masuk semula.' };
    if (allowedRoles && allowedRoles.indexOf(user.peranan) === -1) {
      return { ok: false, code: 'FORBIDDEN', error: 'Anda tidak mempunyai kebenaran untuk tindakan ini.' };
    }
    return { ok: true, data: fn(user) };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

// ---------------------------------------------------------------------------
// API untuk klien (google.script.run)
// ---------------------------------------------------------------------------
/** Tanpa pengesahan: pulangkan tetapan dan pengguna semasa jika token masih sah. */
function apiInit(token) {
  try {
    return {
      ok: true,
      data: {
        user: currentUser_(token),
        staleDays: CFG.STALE_DAYS
      }
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function apiLogin(role, password, nama) {
  try {
    if (ALL_ROLES.indexOf(role) === -1) throw new Error('Peranan tidak sah.');
    const cache = CacheService.getScriptCache();
    const fails = Number(cache.get('fails') || 0);
    if (fails >= CFG.MAX_FAILS) {
      throw new Error('Terlalu banyak percubaan gagal. Cuba lagi dalam beberapa minit.');
    }
    if (!checkPassword_(role, String(password || ''))) {
      cache.put('fails', String(fails + 1), CFG.FAIL_WINDOW_SEC);
      Utilities.sleep(1000);
      throw new Error('Kata laluan salah.');
    }
    const user = { nama: str_(nama).slice(0, 60), peranan: role };
    const token = createSession_(user.nama, user.peranan);
    log_(user, 'LOGIN', '', '');
    return {
      ok: true,
      data: { token: token, user: user, staleDays: CFG.STALE_DAYS }
    };
  } catch (err) {
    return { ok: false, error: String((err && err.message) || err) };
  }
}

function apiLogout(token) {
  try {
    if (typeof token === 'string' && token.length <= 100) CacheService.getScriptCache().remove('s:' + token);
  } catch (err) { /* abaikan */ }
  return { ok: true, data: true };
}

/** Admin: tetapkan kata laluan satu peranan. Sesi peranan itu ditamatkan. */
function apiSetPassword(token, role, password) {
  return run_(token, ADMIN_ONLY, function (user) {
    if (ALL_ROLES.indexOf(role) === -1) throw new Error('Peranan tidak sah.');
    const pw = String(password || '');
    if (pw.length < CFG.MIN_PASSWORD) throw new Error('Kata laluan mesti sekurang-kurangnya ' + CFG.MIN_PASSWORD + ' aksara.');
    if (pw.length > 100) throw new Error('Kata laluan terlalu panjang.');
    ALL_ROLES.forEach(function (r) {
      if (r !== role && checkPassword_(r, pw)) {
        throw new Error('Kata laluan ini sudah digunakan oleh peranan lain. Pilih yang berbeza.');
      }
    });
    setPassword_(role, pw);
    log_(user, 'KATA_LALUAN', '', role);
    if (role === user.peranan) {
      // Elakkan Admin terkeluar sendiri apabila menukar kata laluan Admin.
      CacheService.getScriptCache().remove('s:' + token);
      return { token: createSession_(user.nama, user.peranan) };
    }
    return {};
  });
}

/** Semua peranan: lihat satu aset mengikut ID (hasil imbasan). */
function apiGetAsset(token, id) {
  return run_(token, ALL_ROLES, function (user) {
    const key = String(id || '').trim();
    if (!key) throw new Error('ID aset kosong.');
    const a = findAsset_(key);
    if (!a) throw new Error('Aset dengan ID "' + key + '" tidak ditemui.');
    log_(user, 'LIHAT', a.id, '');
    return a;
  });
}

/** Admin & Pembantu Aset: senarai penuh. Pemeriksa Aset tidak boleh. */
function apiListAssets(token) {
  return run_(token, EDITORS, function () {
    const sh = getSheet_(CFG.SHEET_ASET);
    const last = sh.getLastRow();
    if (last < 2) return [];
    return sh.getRange(2, 1, last - 1, ASET_HEADERS.length).getValues()
      .map(rowToAsset_)
      .filter(function (a) { return a.id !== ''; });
  });
}

function apiSaveAsset(token, payload, isNew) {
  return run_(token, EDITORS, function (user) {
    const a = normalizeAsset_(payload);
    let before = null;

    withLock_(function () {
      const sh = getSheet_(CFG.SHEET_ASET);
      if (isNew) {
        const ids = readIds_(sh);
        if (!a.id) {
          a.id = nextId_(ids);
        } else if (ids.some(function (x) { return x.toLowerCase() === a.id.toLowerCase(); })) {
          throw new Error('ID "' + a.id + '" sudah wujud.');
        }
        if (!a.tarikhDaftar) a.tarikhDaftar = todayISO_();
        writeRow_(sh, sh.getLastRow() + 1, assetToRow_(a), ASET_FORMATS);
      } else {
        if (!a.id) throw new Error('ID diperlukan untuk menyunting.');
        const row = findRow_(sh, a.id);
        if (!row) throw new Error('Aset "' + a.id + '" tidak ditemui.');
        before = rowToAsset_(sh.getRange(row, 1, 1, ASET_HEADERS.length).getValues()[0]);
        a.id = before.id; // kekalkan ID asal (termasuk huruf besar/kecil)
        writeRow_(sh, row, assetToRow_(a), ASET_FORMATS);
      }
    });

    log_(user, isNew ? 'TAMBAH' : 'UBAH', a.id, isNew ? a.jenis : diff_(before, a));
    return a;
  });
}

/** Rekod pemeriksaan: kemas kini butiran "Sebenar" dan tetapkan tarikh pemeriksaan hari ini. */
function apiRecordInspection(token, id, p) {
  return run_(token, EDITORS, function (user) {
    p = p || {};
    const lokasi = str_(p.lokasiSebenar);
    const kuantiti = intOrNull_(p.kuantitiSebenar, 'Kuantiti (Sebenar)');
    const keadaan = str_(p.keadaan).toUpperCase();
    if (!lokasi) throw new Error('Lokasi (Sebenar) diperlukan.');
    if (kuantiti === null) throw new Error('Kuantiti (Sebenar) diperlukan.');
    if (CFG.CONDITIONS.indexOf(keadaan) === -1) throw new Error('Keadaan Harta Modal mesti A hingga F.');

    let before, after;
    withLock_(function () {
      const sh = getSheet_(CFG.SHEET_ASET);
      const row = findRow_(sh, id);
      if (!row) throw new Error('Aset "' + id + '" tidak ditemui.');
      before = rowToAsset_(sh.getRange(row, 1, 1, ASET_HEADERS.length).getValues()[0]);
      after = Object.assign({}, before, {
        lokasiSebenar: lokasi,
        kuantitiSebenar: kuantiti,
        keadaan: keadaan,
        catatan: p.catatan === undefined ? before.catatan : str_(p.catatan),
        tarikhPeriksa: todayISO_()
      });
      writeRow_(sh, row, assetToRow_(after), ASET_FORMATS);
    });

    log_(user, 'PERIKSA', after.id, diff_(before, after));
    return after;
  });
}

function apiDeleteAsset(token, id) {
  return run_(token, ADMIN_ONLY, function (user) {
    let removed;
    withLock_(function () {
      const sh = getSheet_(CFG.SHEET_ASET);
      const row = findRow_(sh, id);
      if (!row) throw new Error('Aset "' + id + '" tidak ditemui.');
      removed = rowToAsset_(sh.getRange(row, 1, 1, ASET_HEADERS.length).getValues()[0]);
      sh.deleteRow(row);
    });
    log_(user, 'PADAM', removed.id, removed.jenis);
    return removed.id;
  });
}

function apiListLog(token, limit) {
  return run_(token, ADMIN_ONLY, function () {
    const sh = getSheet_(CFG.SHEET_LOG);
    const last = sh.getLastRow();
    if (last < 2) return [];
    const n = Math.min(Math.max(Number(limit) || 200, 1), 1000, last - 1);
    const tz = Session.getScriptTimeZone();
    return sh.getRange(last - n + 1, 1, n, LOG_HEADERS.length).getValues().reverse().map(function (r) {
      return {
        masa: r[0] instanceof Date ? Utilities.formatDate(r[0], tz, 'dd/MM/yyyy HH:mm') : String(r[0]),
        nama: String(r[1]),
        peranan: String(r[2]),
        tindakan: String(r[3]),
        id: String(r[4]),
        ringkasan: String(r[5])
      };
    });
  });
}

// ---------------------------------------------------------------------------
// Lapisan data
// ---------------------------------------------------------------------------
function ss_() {
  const active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;
  const id = PropertiesService.getScriptProperties().getProperty('SS_ID');
  if (!id) throw new Error('Spreadsheet tidak ditemui. Bind skrip ke Google Sheets atau tetapkan Script Property SS_ID.');
  return SpreadsheetApp.openById(id);
}

function getSheet_(name) {
  const sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Helaian "' + name + '" tiada. Jalankan menu Aplikasi Aset > Sediakan helaian.');
  return sh;
}

function getOrCreateSheet_(ss, name) {
  return ss.getSheetByName(name) || ss.insertSheet(name);
}

function prepareHeader_(sh, headers) {
  const range = sh.getRange(1, 1, 1, headers.length);
  range.setValues([headers]);
  range.setFontWeight('bold').setFontColor('#FFFFFF').setBackground('#0F4C5C').setVerticalAlignment('middle');
  sh.setFrozenRows(1);
}

function showMessage_(text) {
  try {
    SpreadsheetApp.getUi().alert(text);
  } catch (err) {
    Logger.log(text); // dijalankan dari editor skrip: tiada UI, lihat Execution log
  }
}

function withLock_(fn) {
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try { return fn(); } finally { lock.releaseLock(); }
}

function writeRow_(sh, row, values, formats) {
  if (row > sh.getMaxRows()) sh.insertRowsAfter(sh.getMaxRows(), Math.max(20, row - sh.getMaxRows()));
  const rng = sh.getRange(row, 1, 1, values.length);
  rng.setNumberFormats([formats]); // tetapkan format dahulu supaya '=...' kekal teks
  rng.setValues([values]);
}

function readIds_(sh) {
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, 1).getValues().map(function (r) { return String(r[0]).trim(); });
}

function findRow_(sh, id) {
  const want = String(id || '').trim().toLowerCase();
  if (!want) return 0;
  const ids = readIds_(sh);
  for (let i = 0; i < ids.length; i++) {
    if (ids[i].toLowerCase() === want) return i + 2;
  }
  return 0;
}

function findAsset_(id) {
  const sh = getSheet_(CFG.SHEET_ASET);
  const row = findRow_(sh, id);
  return row ? rowToAsset_(sh.getRange(row, 1, 1, ASET_HEADERS.length).getValues()[0]) : null;
}

function nextId_(existingIds) {
  const re = new RegExp('^' + CFG.ID_PREFIX + '(\\d+)$', 'i');
  let max = 0;
  existingIds.forEach(function (id) {
    const m = re.exec(id);
    if (m) max = Math.max(max, Number(m[1]));
  });
  return CFG.ID_PREFIX + String(max + 1).padStart(CFG.ID_DIGITS, '0');
}

function log_(user, action, id, note) {
  try {
    withLock_(function () {
      const sh = getSheet_(CFG.SHEET_LOG);
      writeRow_(
        sh, sh.getLastRow() + 1,
        [new Date(), user.nama || '', user.peranan, action, id || '', String(note || '').slice(0, 500)],
        LOG_FORMATS
      );
    });
  } catch (err) {
    console.warn('Log gagal: ' + err);
  }
}

// ---------------------------------------------------------------------------
// Penukaran & pengesahan data
// ---------------------------------------------------------------------------
function str_(v) { return v === null || v === undefined ? '' : String(v).trim(); }

function intOrNull_(v, label) {
  if (v === '' || v === null || v === undefined) return null;
  const x = Number(v);
  if (!isFinite(x) || x < 0 || Math.floor(x) !== x) throw new Error(label + ' mesti nombor bulat 0 atau lebih.');
  return x;
}

function normalizeAsset_(p) {
  p = p || {};
  const a = {
    id: str_(p.id),
    jenis: str_(p.jenis),
    lokasiRekod: str_(p.lokasiRekod),
    lokasiSebenar: str_(p.lokasiSebenar),
    kuantitiRekod: intOrNull_(p.kuantitiRekod, 'Kuantiti (Rekod)'),
    kuantitiSebenar: intOrNull_(p.kuantitiSebenar, 'Kuantiti (Sebenar)'),
    keadaan: str_(p.keadaan).toUpperCase(),
    tarikhDaftar: str_(p.tarikhDaftar),
    tarikhPeriksa: str_(p.tarikhPeriksa),
    catatan: str_(p.catatan)
  };
  if (!a.jenis) throw new Error('Jenis Harta Modal diperlukan.');
  if (!a.lokasiRekod) throw new Error('Lokasi (Rekod) diperlukan.');
  if (a.kuantitiRekod === null) throw new Error('Kuantiti (Rekod) diperlukan.');
  if (CFG.CONDITIONS.indexOf(a.keadaan) === -1) throw new Error('Keadaan Harta Modal mesti A hingga F.');
  if (a.id && !/^[A-Za-z0-9._\-\/]{1,40}$/.test(a.id)) {
    throw new Error('ID hanya boleh mengandungi huruf, nombor, titik, sempang atau garis condong (maksimum 40 aksara).');
  }
  parseDate_(a.tarikhDaftar);
  parseDate_(a.tarikhPeriksa);
  return a;
}

function assetToRow_(a) {
  return [
    a.id, a.jenis, a.lokasiRekod, a.lokasiSebenar,
    a.kuantitiRekod === null ? '' : a.kuantitiRekod,
    a.kuantitiSebenar === null ? '' : a.kuantitiSebenar,
    a.keadaan, parseDate_(a.tarikhDaftar), parseDate_(a.tarikhPeriksa), a.catatan
  ];
}

function rowToAsset_(r) {
  const num = function (v) { return v === '' || v === null || v === undefined ? null : Number(v); };
  return {
    id: String(r[0]).trim(),
    jenis: String(r[1]),
    lokasiRekod: String(r[2]),
    lokasiSebenar: String(r[3]),
    kuantitiRekod: num(r[4]),
    kuantitiSebenar: num(r[5]),
    keadaan: String(r[6]).trim().toUpperCase(),
    tarikhDaftar: fmtDate_(r[7]),
    tarikhPeriksa: fmtDate_(r[8]),
    catatan: String(r[9])
  };
}

function fmtDate_(v) {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  return v ? String(v) : '';
}

function parseDate_(s) {
  if (!s) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) throw new Error('Format tarikh tidak sah: ' + s);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function todayISO_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

function diff_(a, b) {
  const out = [];
  ASET_KEYS.forEach(function (k, i) {
    const x = a[k] === null || a[k] === undefined ? '' : String(a[k]);
    const y = b[k] === null || b[k] === undefined ? '' : String(b[k]);
    if (x !== y) out.push(ASET_HEADERS[i] + ': ' + x + ' → ' + y);
  });
  return out.join('; ').slice(0, 500);
}
