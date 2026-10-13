# Pengurusan Aset (eAset)

Web app pengurusan aset. Antara muka statik di **GitHub Pages**; data kekal di **Google Sheets** melalui API Google Apps Script.

```
web/       -> antara muka (dideploy ke GitHub Pages)
backend/   -> Code.gs + appsscript.json (Apps Script, terikat pada Google Sheet)
legacy/    -> versi asal Apps Script HtmlService (rujukan sahaja)
```

## 1. Backend (Google Sheets + Apps Script)
1. Buka Google Sheet anda > **Extensions > Apps Script**.
2. Tampal `backend/Code.gs` (dan, di Project Settings, paparkan `appsscript.json` lalu salin `backend/appsscript.json`).
3. Jalankan menu **Aplikasi Aset > Sediakan helaian** (simpan kata laluan awal yang dipaparkan). Pilihan: **Masukkan data contoh**.
4. **Deploy > New deployment > Web app**: Execute as *Me*, Who has access *Anyone*. Salin URL `/exec`.
5. Selepas mengubah `Code.gs`, buat **New version** pada deployment yang sama.

## 2. Frontend
1. Edit `web/config.js`: tetapkan `API_URL` kepada URL `/exec` tadi.
2. Push ke GitHub (branch `main`), lalu **Settings > Pages > Source: GitHub Actions**. Workflow `.github/workflows/deploy.yml` akan menerbitkan folder `web/`.
3. Pilihan: tetapkan `FRONTEND_URL` dalam `Code.gs` kepada URL Pages supaya kod QR lama (pautan Apps Script) dialihkan.

Ujian setempat: `cd web && python3 -m http.server 8000`.

## Nota
- Kod QR kini menunjuk ke `https://<anda>.github.io/<repo>/?id=AST-00001`. Label lama perlu dicetak semula (atau guna `FRONTEND_URL`).
- Kebenaran dikuatkuasakan di server (Apps Script); kata laluan tidak pernah berada dalam repo atau helaian.
- `API_URL` bukan rahsia; keselamatan bergantung pada kata laluan peranan dan token sesi.
