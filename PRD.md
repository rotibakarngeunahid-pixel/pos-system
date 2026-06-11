# PRD — Investor Dashboard Roti Bakar Ngeunah (RBN)

| | |
|---|---|
| **Versi** | 1.0 |
| **Tanggal** | 11 Juni 2026 |
| **Status** | Siap dibangun (menunggu konfirmasi poin di Bab 14) |
| **Target pembaca** | AI builder / developer yang TIDAK punya akses ke codebase 4 sistem sumber |

> **Dokumen ini self-contained.** Semua nama tabel, kolom, tipe data, endpoint, format response, dan logika agregasi yang dibutuhkan untuk membangun dashboard sudah ditulis lengkap di sini, hasil pembacaan langsung dari codebase keempat sistem sumber. Builder TIDAK perlu (dan TIDAK boleh) mengubah kode sistem sumber.

---

## 0. Cara Membaca Dokumen

- `[ASUMSI]` — hal yang tidak bisa dipastikan 100% dari codebase; sudah diberi nilai default yang masuk akal.
- `[PERLU KONFIRMASI]` — hal yang harus ditanyakan ke pemilik (Super Admin) sebelum/saat implementasi. Daftar lengkapnya dikumpulkan di Bab 14.
- `[KEPUTUSAN]` — keputusan desain yang diambil dokumen ini beserta alasannya.
- **Kredensial Supabase publik** (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, project ID) **boleh dicantumkan di PRD** karena bersifat *public-facing* — dirancang Supabase untuk diekspos ke browser. Keamanannya dijamin RLS, bukan kerahasiaan key-nya.
- **JANGAN PERNAH** menulis **secret** (service role key, API key sistem sumber, password) di kode, PRD, commit, atau log. Secret dirujuk lewat **nama environment variable** saja (Bab 12).

---

## 1. Overview & Goals

### 1.1 Latar Belakang

RBN memiliki 4 sistem operasional yang berjalan terpisah:

| # | Sistem | Folder sumber | Teknologi | Database | Data yang dimiliki |
|---|---|---|---|---|---|
| 1 | **POS (kasir)** | `point_of_sales/` | PHP REST API di cPanel + frontend Vanilla JS PWA | MySQL (cPanel) | Transaksi penjualan per cabang, kas masuk/keluar, stok bahan versi POS |
| 2 | **Purchase Order** | `purchase_order/` | Express.js (Vercel) + React Vite | Supabase Postgres (project sendiri) | Pembelian bahan baku: item, kuantitas, harga asli, distribusi per outlet |
| 3 | **Inventori** | `inventori/` | Google Apps Script Web App | Google Sheets | Laporan stok harian bahan baku per outlet |
| 4 | **Staff Portal** | `staff_portal/` | Next.js (Vercel) | Supabase Postgres (project sendiri) | Data staff, absensi, potongan, gaji, pembayaran gaji |

Investor mendanai outlet tertentu (contoh: investor "Dwik" mendanai cabang "Buduk") dan butuh transparansi kondisi outletnya tanpa harus mengakses 4 sistem internal.

### 1.2 Goals

- **G1** — Investor (non-teknis) dapat login dan melihat: ringkasan, penjualan, stok, pembelian bahan baku, staff & gaji, dan arus kas **hanya untuk outlet yang di-mapping kepadanya**.
- **G2** — Harga pembelian bahan baku yang dilihat investor adalah **harga mark-up** yang diatur Super Admin. Harga asli **tidak boleh bocor** dalam bentuk apa pun (response API, HTML, network tab).
- **G3** — Satu tombol **"Tarik Data Terbaru"** menyinkronkan data dari keempat sistem sumber.
- **G4** — Super Admin mengelola akun investor, mapping investor→outlet, dan aturan mark-up dari panel admin.
- **G5** — Dashboard hanya **MEMBACA** dari sistem sumber. Tidak ada operasi tulis ke sistem lama, tidak ada perubahan skema/kode sistem lama.
- **G6** — Tampilan profesional, bahasa Indonesia ramah awam, responsif mobile & desktop.

### 1.3 Non-Goals (v1)

- Bukan data real-time; data diperbarui saat tombol sinkronisasi ditekan (atau cron opsional).
- Tidak ada notifikasi email/WA ke investor.
- Tidak ada export PDF/Excel (boleh jadi Fase 2).
- Tidak menampilkan pengeluaran operasional dari `cash_logs` POS (berisiko double-count dengan setoran; lihat §8.7).

### 1.4 Pengguna & Role

| Role | Jumlah | Hak |
|---|---|---|
| **Super Admin** | 1 (pemilik) | Semua data semua outlet + panel admin (kelola investor, mapping, mark-up, monitor sync) |
| **Investor** | N | Hanya data outlet yang di-mapping kepadanya. Tidak bisa melihat harga asli pembelian. Bisa menekan tombol sinkronisasi. |

---

## 2. Arsitektur & Tech Stack

### 2.1 Tech Stack `[KEPUTUSAN]`

| Lapisan | Pilihan | Alasan |
|---|---|---|
| Framework | **Next.js 15 (App Router) + TypeScript** | Konsisten dengan `staff_portal` (pola yang sudah terbukti di ekosistem RBN); API Routes untuk sync engine server-side; mudah deploy ke Vercel (semua sistem RBN lain juga di Vercel/cPanel). |
| UI | **Tailwind CSS + shadcn/ui** | Cepat, rapi, profesional, komponen siap pakai (Card, Table, Dialog, Tabs). |
| Grafik | **Recharts** | Ringan, mudah dibuat berbahasa Indonesia. |
| Database + Auth | **Supabase** (project baru, lihat §12) | Permintaan owner. Auth email/password bawaan + **RLS** untuk isolasi data per investor di level database, bukan hanya UI. |
| Deploy | **Vercel** | Sama dengan staff_portal & purchase_order. |

### 2.2 Model Data: Snapshot (ETL ringan), bukan live-query `[KEPUTUSAN]`

Dashboard **menyalin** data dari 4 sumber ke database Supabase milik dashboard sendiri saat sinkronisasi, lalu seluruh halaman investor membaca dari salinan lokal. Alasan:

1. **Inventori (Google Apps Script) lambat dan ber-rate-limit** (20 request/menit untuk endpoint data — lihat §3.3). Live query akan membuat halaman investor lambat/gagal.
2. **POS di shared hosting cPanel** — tidak boleh dibebani query investor langsung.
3. **Mark-up harga** harus dihitung server-side; harga asli disimpan terpisah di tabel yang tidak bisa diakses investor (lihat Bab 6).
4. **RLS lokal** menjamin isolasi per investor pada semua data.
5. Halaman jadi cepat (<2 detik) karena hanya query database sendiri.

### 2.3 Diagram Alur

```
┌─────────────┐   X-API-Key + RPC      ┌──────────────────────────────┐
│ POS (MySQL/ │ ◄───────────────────── │                              │
│ cPanel PHP) │   penjualan harian     │   /api/sync (server-side,    │
└─────────────┘                        │   service role — Next.js     │
┌─────────────┐   supabase-js (read)   │   API Route)                 │
│ PO Supabase │ ◄───────────────────── │                              │
└─────────────┘   pembelian + alokasi  │  1. tarik data 4 sumber      │
┌─────────────┐   ?action=api.v1.* &   │  2. upsert ke tabel snapshot │
│ Inventori   │ ◄───────────────────── │  3. hitung harga mark-up     │
│ (GAS/Sheets)│   stok terkini         │  4. catat sync_runs          │
└─────────────┘                        └──────────────┬───────────────┘
┌─────────────┐   supabase-js (read)                  │ upsert
│ Staff Portal│ ◄─────────────────────                ▼
│  Supabase   │   staff+absensi+gaji   ┌──────────────────────────────┐
└─────────────┘                        │  Supabase Dashboard (baru)   │
                                       │  tabel snapshot + RLS        │
                                       └──────────────┬───────────────┘
                                                      │ SELECT (anon key +
                                                      │ session login + RLS)
                                       ┌──────────────▼───────────────┐
                                       │  UI Next.js                  │
                                       │  Investor / Super Admin      │
                                       └──────────────────────────────┘
```

**Aturan keamanan arsitektur:**
- Semua kredensial sistem sumber (POS API key, service key PO/Staff, API key inventori) **hanya ada di server** (env tanpa prefix `NEXT_PUBLIC_`). Tidak pernah dikirim ke browser.
- Browser hanya memakai `NEXT_PUBLIC_SUPABASE_URL` + `NEXT_PUBLIC_SUPABASE_ANON_KEY` + session login → dibatasi RLS.
- Tabel harga asli (`purchases_raw`) **tidak punya policy untuk role `authenticated`** → hanya bisa diakses service role di server.

---

## 3. Sistem Sumber — Spesifikasi Integrasi Lengkap

> Bab ini adalah kontrak data. Semua nama tabel/kolom/endpoint di bawah disalin langsung dari codebase sumber.

### 3.1 POS (Penjualan) — PHP REST API di cPanel

#### 3.1.1 Koneksi

| Item | Nilai |
|---|---|
| Base URL | env `POS_API_URL`. Nilai produksi yang ditemukan di codebase: `https://api.rotibakarngeunah.my.id/api/api.php` (dipakai server PO) dan `https://pos.rotibakarngeunah.my.id` (default `SITE_URL` di `config.php`). `[PERLU KONFIRMASI]` mana yang kanonik; `[ASUMSI]` keduanya mengarah ke `api.php` yang sama. |
| Auth lapis 1 (wajib semua request) | Header `X-API-Key: <nilai>` — nilai = `API_SECRET_KEY` di file `.env` POS di server cPanel. Simpan di env dashboard `POS_API_KEY`. |
| Auth lapis 2 (khusus RPC integrasi) | Parameter `p_api_key` — key terpisah yang tersimpan di tabel MySQL `api_keys` POS (kolom `key_value`, harus `is_active=1`). Simpan di env dashboard `POS_INTEGRATION_API_KEY`. Cara membuatnya ada di §13 langkah 4. |
| Timezone | **WITA (Asia/Makassar, UTC+8)**. Semua parameter tanggal `YYYY-MM-DD` ditafsirkan sebagai tanggal kalender WITA. Response RPC integrasi sudah mengonversi `created_at` ke WITA. |
| Format error | HTTP 4xx/5xx dengan body `{"error":{"message":"...","code":"..."}}` |

#### 3.1.2 RPC yang dipakai dashboard

Format pemanggilan: `GET {POS_API_URL}/rpc/{nama_fungsi}?{param}` **atau** `POST {POS_API_URL}/rpc/{nama_fungsi}` dengan JSON body. Parameter query dan body digabung oleh server. Selalu sertakan header `X-API-Key`.

**A. `get_integration_summary` — agregat harian per cabang (sumber utama `sales_daily`)**

```
GET {POS_API_URL}/rpc/get_integration_summary
    ?p_api_key={POS_INTEGRATION_API_KEY}
    &p_branch_id=3            (opsional; id cabang POS, BIGINT)
    &p_date_from=2026-06-01   (opsional; tanggal WITA)
    &p_date_to=2026-06-10     (opsional)
Header: X-API-Key: {POS_API_KEY}
```

Response (200):
```json
{
  "success": true,
  "summary": {
    "total_penjualan": 12500000,
    "total_kas_keluar": 3400000,
    "jumlah_transaksi": 412,
    "selisih": 9100000
  },
  "per_cabang": [
    { "cabang": "Buduk", "total_penjualan": 12500000, "jumlah_transaksi": 412, "total_kas_keluar": 3400000 }
  ],
  "per_tanggal": [
    { "tanggal": "2026-06-10", "total_penjualan": 1250000, "total_kas_keluar": 0 }
  ]
}
```

Catatan: hanya transaksi `status='completed'` yang dihitung. `per_tanggal` sudah dalam tanggal WITA. Jika `p_branch_id` diisi, `per_tanggal` = harian untuk cabang itu saja → **panggil sekali per outlet ter-mapping** untuk mengisi `sales_daily`.

**B. `get_sales_integration` — detail per transaksi (sumber `sales_transactions`)**

```
GET {POS_API_URL}/rpc/get_sales_integration
    ?p_api_key=...&p_branch_id=...&p_date_from=...&p_date_to=...
    &p_limit=1000&p_offset=0
Header: X-API-Key: {POS_API_KEY}
```

Response (200):
```json
{
  "success": true,
  "data": [
    {
      "id": "8123",
      "created_at": "2026-06-10 18:42:11",
      "branch_name": "Buduk",
      "cashier": "Rina",
      "payment_method": "qris",
      "amount": 35000,
      "tanggal": "10 Jun 2026", "waktu": "18:42", "cabang": "Buduk",
      "kasir": "Rina", "metode_pembayaran": "qris", "total_penjualan": 35000
    }
  ],
  "summary": { "total_penjualan": 1250000 },
  "pagination": { "returned_count": 1000, "total_count": 2350, "has_more": true }
}
```

Loop pagination: naikkan `p_offset` += `p_limit` selama `pagination.has_more = true`. Field `created_at` sudah WITA (`YYYY-MM-DD HH:mm:ss`). Gunakan field kanonik (`id`, `created_at`, `branch_name`, `cashier`, `payment_method`, `amount`); field berbahasa Indonesia adalah duplikat legacy.

#### 3.1.3 API tabel generik POS (cadangan/lookup)

Gaya PostgREST di atas MySQL: `GET {POS_API_URL}/{nama_tabel}?{kolom}={op}.{nilai}&select=...&order={kolom}.{asc|desc}&limit=N&offset=M`.
Operator: `eq, neq, gt, gte, lt, lte, like, ilike, is, not, in`. Embedded join: `select=id,name,branches(name)`.

Dipakai dashboard hanya untuk lookup daftar cabang saat setup mapping:

```
GET {POS_API_URL}/branches?select=id,name,is_active&order=name.asc
Header: X-API-Key: {POS_API_KEY}
→ [ { "id": 1, "name": "Buduk", "is_active": 1 }, ... ]
```

#### 3.1.4 Tabel POS relevan (referensi; akses via API, bukan koneksi MySQL langsung)

- `branches` — `id BIGINT PK`, `name VARCHAR(255)`, `is_active TINYINT(1)`, `deleted_at DATETIME NULL`.
- `transactions` — `id INT PK`, `branch_id BIGINT`, `staff_id BIGINT`, `payment_method VARCHAR(50)`, `subtotal DECIMAL(15,2)`, `discount_amount DECIMAL(15,2)`, `total DECIMAL(15,2)`, `status ENUM('completed','voided','refunded')`, `created_at DATETIME`.
- `transaction_items` — `transaction_id`, `product_name`, `variant_name`, `quantity INT`, `price DECIMAL(12,2)`, `subtotal DECIMAL(12,2)` (untuk Fase 2: produk terlaris).
- `cash_logs` — kas masuk/keluar manual POS (`type ENUM('in','out')`, `amount`, `category_id`, `is_void`) — TIDAK dipakai v1 (lihat §8.7).
- `investor_branch_access`, `investor_feature_access` — fitur investor lama di dalam POS (`investor.html`); **tidak dipakai** dashboard baru, jangan disentuh.

### 3.2 Purchase Order (Pembelian Bahan Baku) — Supabase langsung

#### 3.2.1 Koneksi `[KEPUTUSAN]`

Dashboard membaca **langsung dari Supabase project milik sistem PO** memakai `@supabase/supabase-js` dengan service key (server-side only):

- env `PO_SUPABASE_URL` — salin dari `purchase_order/server/.env` variabel `SUPABASE_URL`.
- env `PO_SUPABASE_SERVICE_KEY` — salin dari variabel `SUPABASE_SERVICE_KEY` di file yang sama.

Alasan tidak memakai endpoint HTTP PO: endpoint publik yang ada (`GET /api/finance-portal/data`) hanya mengembalikan **agregat total per cabang**, sedangkan investor butuh **detail per item** (nama bahan, qty, harga) untuk halaman Pembelian dan untuk penerapan mark-up per item. Akses dibatasi **read-only secara konvensi**: sync engine HANYA boleh memanggil `.select()` ke project PO — tidak boleh ada `.insert/.update/.delete/.rpc` ke project PO.

Semua tabel PO ber-RLS `TO authenticated USING (true)` — service key melewati RLS (service role), anon key TIDAK bisa dipakai.

#### 3.2.2 Skema tabel PO (persis dari `purchase_order/supabase/*.sql`)

```sql
suppliers (
  id UUID PK, name TEXT, wa_number TEXT, is_active BOOLEAN, created_at TIMESTAMPTZ
)
materials (
  id UUID PK, code TEXT UNIQUE, name TEXT, brand TEXT, supplier_id UUID→suppliers,
  package_qty NUMERIC, package_unit TEXT, purchase_unit TEXT,
  price_per_purchase_unit NUMERIC, is_active BOOLEAN, created_at TIMESTAMPTZ
)
material_variants (
  id UUID PK, material_id UUID→materials, brand TEXT, supplier_id UUID,
  price_per_purchase_unit NUMERIC, is_active BOOLEAN
)
outlets (
  id UUID PK, name TEXT, is_active BOOLEAN, created_at TIMESTAMPTZ
)
order_sessions (
  id UUID PK, order_date DATE, status TEXT ('draft'|'sent'|'completed'),
  created_by UUID, created_at TIMESTAMPTZ, sent_at TIMESTAMPTZ
)
order_request_items (        -- permintaan qty per outlet per bahan per sesi
  id UUID PK, session_id UUID→order_sessions, outlet_id UUID→outlets,
  material_id UUID→materials, qty NUMERIC, UNIQUE(session_id, outlet_id, material_id)
)
purchase_orders (
  id UUID PK, session_id UUID→order_sessions, supplier_id UUID→suppliers,
  status TEXT,               -- 'pending'|'confirmed'|'received'|'received_partial'
  wa_sent_at TIMESTAMPTZ, total_estimated NUMERIC, total_actual NUMERIC,
  notes TEXT, created_at TIMESTAMPTZ
)
purchase_order_items (
  id UUID PK, po_id UUID→purchase_orders, material_id UUID→materials,
  supplier_id UUID→suppliers, variant_id UUID→material_variants,
  qty_ordered NUMERIC, qty_received NUMERIC, price_actual NUMERIC,
  subtotal_actual NUMERIC GENERATED ALWAYS AS (qty_received * price_actual) STORED,
  source TEXT DEFAULT 'ordered' CHECK (source IN ('ordered','adjustment')),
  adjustment_note TEXT, created_at TIMESTAMPTZ
)
purchase_item_branch_distribution (   -- distribusi fisik item PO ke outlet
  id UUID PK, po_item_id UUID→purchase_order_items, outlet_id UUID→outlets,
  qty NUMERIC, created_at TIMESTAMPTZ, UNIQUE(po_item_id, outlet_id)
)
purchase_report (            -- pembelian langsung dicatat per outlet (jalur kedua!)
  id UUID PK, outlet_id UUID→outlets, material_id UUID→materials,
  variant_id UUID, supplier_id UUID, qty NUMERIC CHECK (qty>0), unit TEXT,
  price_per_unit NUMERIC, date DATE, notes TEXT, created_at TIMESTAMPTZ
)
```

#### 3.2.3 Query sync (supabase-js, service key, dengan pagination `.range()` per 1000 baris)

```js
// 1) Item PO + relasi
po.from('purchase_order_items').select(`
  id, po_id, material_id, qty_ordered, qty_received, price_actual, subtotal_actual, source,
  material:materials(id, name, purchase_unit),
  po:purchase_orders(id, status, session_id, session:order_sessions(id, order_date)),
  branch_distributions:purchase_item_branch_distribution(outlet_id, qty)
`).order('id')

// 2) Permintaan per outlet (untuk prorata bila tidak ada distribusi fisik)
po.from('order_request_items').select(`
  id, qty, outlet_id, material_id, session_id,
  session:order_sessions(id, order_date)
`).gt('qty', 0).order('id')

// 3) Pembelian langsung per outlet
po.from('purchase_report').select(`
  id, outlet_id, material_id, qty, unit, price_per_unit, date, notes,
  material:materials(id, name)
`).gte('date', dateFrom).lte('date', dateTo).gt('qty', 0).order('id')

// 4) Master outlet PO (untuk setup mapping)
po.from('outlets').select('id, name, is_active').order('name')
```

#### 3.2.4 ALGORITMA alokasi pembelian per outlet (replikasi persis `server/services/financePortal.js`)

Pembelian masuk ke outlet lewat **dua jalur** yang HARUS dijumlahkan:

**Jalur A — Purchase Order (`purchase_order_items`):**

```
untuk setiap row item:
  1. po = row.po; LEWATI jika po.status NOT IN ('received','received_partial')
  2. tanggal_efektif = po.session.order_date; LEWATI jika di luar rentang sync
  3. subtotal_asli = row.subtotal_actual jika > 0,
                     selain itu row.qty_received * row.price_actual
     LEWATI jika subtotal_asli <= 0
  4. dist = row.branch_distributions dengan outlet_id terisi dan qty > 0
     total_dist = SUM(dist.qty)
  5. JIKA total_dist > 0  (ada distribusi fisik tercatat):
       untuk tiap d di dist:
         porsi      = d.qty / total_dist
         qty_outlet = row.qty_received * porsi
         subtotal_outlet_asli = subtotal_asli * porsi
  6. JIKA TIDAK (fallback prorata dari permintaan):
       key = (po.session_id, row.material_id)
       total_req = SUM(order_request_items.qty) untuk key tsb (semua outlet)
       LEWATI jika total_req <= 0
       untuk tiap outlet o pada key:
         porsi      = qty_req[o] / total_req
         qty_outlet = row.qty_received * porsi
         subtotal_outlet_asli = subtotal_asli * porsi
  7. harga_satuan_asli = subtotal_asli / row.qty_received   (NUMERIC, jangan dibulatkan)
  8. simpan 1 baris per (row.id, outlet) ke purchases_raw dengan
     source_ref = 'po:' || row.id || ':' || outlet_id   (kunci idempoten upsert)
```

**Jalur B — Purchase Report (`purchase_report`):** sudah per outlet, langsung:

```
subtotal_asli = qty * price_per_unit ; tanggal_efektif = date
source_ref = 'pr:' || id
```

### 3.3 Inventori (Stok Outlet) — Google Apps Script API v1

#### 3.3.1 Koneksi

| Item | Nilai |
|---|---|
| Base URL | env `INVENTORI_GAS_URL` — URL deployment GAS bentuk `https://script.google.com/macros/s/<DEPLOYMENT_ID>/exec`. Salin dari `purchase_order/server/.env` variabel `INVENTORI_GAS_URL` (sudah dipakai integrasi PO). |
| Auth | Parameter query `api_key=<key>` di SETIAP request. Key dibuat dari Admin Panel Inventori, di-hash SHA-256 di sheet `Api_Keys`, punya **scopes**. Simpan di env `INVENTORI_API_KEY`. Scope minimal untuk dashboard: `read:master`, `read:stock` (+ `read:report` jika riwayat dipakai). |
| HTTP client | **WAJIB follow redirect** (GAS me-redirect 302 ke `script.googleusercontent.com`). Method GET semua endpoint baca. |
| Rate limit (per menit per key) | `master` 30, `data` 20, `write` 10. Sync engine wajib men-throttle ≤ 15 request/menit dan menangani error `RATE_LIMITED` dengan retry + backoff 60 detik. |
| Pagination | `page` (mulai 1), `page_size` (maks **500**). Loop selama `meta.has_next = true`. |
| Timezone | Asia/Makassar; "tanggal pelaporan" memakai cutoff malam jam 03:00 (laporan sebelum jam 3 pagi dihitung milik hari sebelumnya). |

Format response SEMUA endpoint:
```json
// sukses
{ "status": "ok", "data": [ ... ], "meta": { "api_version":"v1", "request_id":"...", "generated_at":"...", "timezone":"Asia/Makassar", "page":1, "page_size":500, "total":123, "has_next":false } }
// gagal
{ "status": "error", "error": { "code": "UNAUTHORIZED|FORBIDDEN|RATE_LIMITED|INVALID_PARAM|INVALID_DATE|INVALID_ACTION|INTERNAL_ERROR", "message": "..." }, "meta": { ... } }
```

#### 3.3.2 Endpoint yang dipakai

**A. Daftar cabang (untuk setup mapping):**
```
GET {INVENTORI_GAS_URL}?action=api.v1.branches.list&api_key=...&page=1&page_size=500
→ data: [ { "cabang_id": "<string>", "nama_cabang": "Buduk", "aktif": true } ]
```
`cabang_id` adalah string bebas dari sheet `Master_Cabang` (bukan UUID/angka — jangan diasumsikan formatnya).

**B. Stok terkini per outlet (sumber utama halaman Stok):**
```
GET {INVENTORI_GAS_URL}?action=api.v1.stocks.latest&api_key=...
    &cabang_id=<id cabang inventori>      (filter per outlet ter-mapping)
    &as_of_date=2026-06-11                (opsional, default = tanggal pelaporan hari ini)
    &page=1&page_size=500
→ data per item:
{
  "as_of_date": "2026-06-11",
  "cabang_id": "...", "nama_cabang": "Buduk",
  "bahan_id": "...",  "nama_bahan": "Roti Tawar",
  "tipe": "foto",
  "stok_akhir": 12.5,              // null = belum pernah dilaporkan
  "stok_masuk_terakhir": 20,
  "stok_terbuang_terakhir": 0,
  "stok_transfer_terakhir": 0,
  "last_report_date": "2026-06-10",
  "last_report_timestamp": "2026-06-10T13:05:22.000Z"
}
```
Hasil mencakup SEMUA bahan yang ter-mapping aktif ke cabang itu (sheet `Mapping_Cabang_Bahan`), termasuk yang belum pernah dilaporkan (nilai null). **Tidak ada kolom satuan/unit dan tidak ada ambang stok minimum di API ini.**

**C. Agregat pemakaian (opsional, kartu ringkasan stok):**
```
GET ...?action=api.v1.stocks.summary&api_key=...&date_from=...&date_to=...
    &cabang_id=...&group_by=branch,material   (atau tambah ,date)
→ data: [ { "cabang_id":"..","nama_cabang":"..","bahan_id":"..","nama_bahan":"..",
            "total_stok_masuk":0,"total_stok_terbuang":0,"total_stok_transfer":0,
            "stok_akhir_terakhir":12.5,"jumlah_laporan":9 } ]
```

### 3.4 Staff Portal (Staff, Absensi, Gaji) — Supabase langsung

#### 3.4.1 Koneksi

- env `STAFF_SUPABASE_URL` — project Supabase staff portal: `https://qqzynzklswrzhprawnhc.supabase.co` (tertulis di `staff_portal/.env.example`; verifikasi dengan `.env.local`).
- env `STAFF_SUPABASE_SERVICE_KEY` — salin dari `staff_portal/.env.local` variabel `SUPABASE_SERVICE_ROLE_KEY`.
- **Wajib service key**: semua tabel ber-RLS `deny_anon` (policy `USING (false)` untuk role anon).
- Read-only secara konvensi (hanya `.select()`).

#### 3.4.2 Tabel & kolom yang dipakai

```sql
outlets (        -- outlet versi staff portal
  id UUID PK, name TEXT, active BOOLEAN,
  shift_mode INTEGER (1|2), shift1_start TIME, shift1_end TIME,
  shift2_start TIME, shift2_end TIME, lat NUMERIC, lng NUMERIC, ...
)
staff (
  id UUID PK, name TEXT, salary_per_shift NUMERIC(12,0), outlet_id UUID→outlets,
  active BOOLEAN, photo_url TEXT, phone TEXT, created_at TIMESTAMPTZ,
  deleted_at TIMESTAMPTZ,           -- exclude jika terisi
  pin_hash, ktp_no, ktp_photo_url, address   -- SENSITIF: JANGAN PERNAH disinkron
)
attendance (     -- 1 baris = 1 shift kerja
  id UUID PK, staff_id UUID→staff, staff_name TEXT,
  outlet_id UUID→outlets, outlet_name TEXT,
  date DATE, shift INTEGER (0=full,1,2), shift_type TEXT,
  checkin_time TIMESTAMPTZ, checkout_time TIMESTAMPTZ,
  status TEXT ('pending'|'present'|'absent'|'late'|'off'),
  late_minutes INTEGER, deduction NUMERIC(12,0), final_salary NUMERIC(12,0),
  paid_status BOOLEAN, payment_id UUID, missing_checkout_flag BOOLEAN,
  selfie_in, selfie_out             -- JANGAN disinkron (foto pribadi)
)
payments (       -- pembayaran gaji
  id UUID PK, staff_id UUID→staff, staff_name TEXT, amount NUMERIC(12,0),
  date_from DATE, date_to DATE, paid_at TIMESTAMPTZ, proof_url TEXT, note TEXT
)
```

#### 3.4.3 Formula gaji (SUDAH dihitung sistem sumber — JANGAN hitung ulang)

- `attendance.final_salary` = `staff.salary_per_shift` − `attendance.deduction`. Potongan dihitung staff portal dari menit keterlambatan melebihi toleransi (config `late_tolerance_minutes`, `late_deduction_per_minute`). **Dashboard cukup membaca `final_salary` dan `deduction` apa adanya.**
- Total gaji periode = `SUM(final_salary)` untuk baris `status IN ('present','late')`.
- Total dibayar = `SUM(payments.amount)` (payments terkait staff, bukan per outlet — `payments` tidak punya outlet_id; atribusikan ke outlet staff saat sync).
- Status pembayaran (replikasi `lib/payroll.ts`): `lunas` jika dibayar ≥ gaji; `belum_lunas` jika dibayar = 0; selain itu `sebagian`. Per-shift: kolom `attendance.paid_status`.

#### 3.4.4 Query sync

```js
sp.from('outlets').select('id, name, active').order('name')
sp.from('staff').select('id, name, outlet_id, active, photo_url, created_at')
  .is('deleted_at', null)
sp.from('attendance').select(
  'id, staff_id, staff_name, outlet_id, outlet_name, date, shift, shift_type, status, late_minutes, deduction, final_salary, paid_status, checkin_time, checkout_time, missing_checkout_flag'
).gte('date', dateFrom).lte('date', dateTo)
sp.from('payments').select('id, staff_id, staff_name, amount, date_from, date_to, paid_at, note')
  .gte('date_to', dateFrom)
```
Pagination `.range()` per 1000 baris.

---

## 4. Identitas Outlet Lintas Sistem

Keempat sistem mengidentifikasi outlet dengan cara berbeda — **ini masalah inti integrasi**:

| Sistem | Tabel/Sheet | Tipe ID | Contoh nama |
|---|---|---|---|
| POS | `branches.id` | BIGINT | "Buduk" |
| Purchase Order | `outlets.id` | UUID | "Buduk" |
| Inventori | `Master_Cabang` kolom `cabang_id` | TEXT (format bebas) | "Buduk" |
| Staff Portal | `outlets.id` | UUID | "Buduk" |

`[KEPUTUSAN]` Dashboard menyimpan **outlet kanonik** sendiri dengan kolom referensi ke ID masing-masing sistem. Super Admin mengisi mapping ini SEKALI di panel admin (dengan dropdown berisi daftar outlet hasil fetch live dari tiap sumber — endpoint lookup ada di §3.1.3, §3.2.3 query 4, §3.3.2-A, §3.4.4). Nama outlet antar sistem TIDAK boleh di-match otomatis by-string sebagai sumber kebenaran (hanya boleh sebagai saran default di UI).

Sinkronisasi **hanya menarik data outlet yang sudah ter-mapping**. Jika sebuah referensi sistem kosong (mis. outlet belum ada di staff portal), bagian data itu dilewati dan dicatat di hasil sync sebagai "dilewati: mapping belum diisi".

---

## 5. Skema Database Baru (Supabase project dashboard)

Semua tabel di schema `public`. Jalankan sebagai satu migration (`supabase/migrations/0001_init.sql`). Mata uang disimpan `NUMERIC(15,2)`, qty `NUMERIC(12,4)`, tanggal `DATE` (kalender WITA).

### 5.1 DDL

```sql
-- ── Identitas & akses ─────────────────────────────────────────────
CREATE TABLE profiles (
  id         UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name  TEXT NOT NULL,
  role       TEXT NOT NULL CHECK (role IN ('super_admin','investor')),
  is_active  BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE outlets (                -- outlet kanonik + mapping 4 sistem
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name             TEXT NOT NULL,                -- nama tampilan utk investor
  pos_branch_id    BIGINT,                       -- branches.id di POS
  po_outlet_id     UUID,                         -- outlets.id di Purchase Order
  inv_cabang_id    TEXT,                         -- cabang_id di Inventori (GAS)
  staff_outlet_id  UUID,                         -- outlets.id di Staff Portal
  is_active        BOOLEAN NOT NULL DEFAULT true,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE investor_outlet_access (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id UUID NOT NULL REFERENCES profiles(id) ON DELETE CASCADE,
  outlet_id  UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  UNIQUE (profile_id, outlet_id)
);

-- ── Sinkronisasi ──────────────────────────────────────────────────
CREATE TABLE sync_runs (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  triggered_by UUID REFERENCES profiles(id),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL DEFAULT 'running'
               CHECK (status IN ('running','success','partial','failed')),
  -- detail per sumber: {"pos":{"status":"success","rows":120,"ms":4100,"error":null}, ...}
  detail       JSONB NOT NULL DEFAULT '{}'
);

-- ── Penjualan (sumber: POS) ───────────────────────────────────────
CREATE TABLE sales_daily (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id   UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  date        DATE NOT NULL,
  total_sales NUMERIC(15,2) NOT NULL DEFAULT 0,
  trx_count   INTEGER NOT NULL DEFAULT 0,
  synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, date)
);

CREATE TABLE sales_transactions (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id      UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  pos_tx_id      TEXT NOT NULL,
  tx_time        TIMESTAMP NOT NULL,         -- waktu WITA apa adanya dari POS
  cashier_name   TEXT,
  payment_method TEXT,
  amount         NUMERIC(15,2) NOT NULL,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, pos_tx_id)
);

-- ── Stok (sumber: Inventori) ──────────────────────────────────────
CREATE TABLE stock_items (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id              UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  inv_bahan_id           TEXT NOT NULL,
  nama_bahan             TEXT NOT NULL,
  tipe                   TEXT,
  stok_akhir             NUMERIC(12,4),       -- null = belum pernah dilaporkan
  stok_masuk_terakhir    NUMERIC(12,4),
  stok_terbuang_terakhir NUMERIC(12,4),
  last_report_date       DATE,
  last_report_ts         TIMESTAMPTZ,
  synced_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (outlet_id, inv_bahan_id)
);

-- ── Pembelian (sumber: Purchase Order) ────────────────────────────
-- HARGA ASLI. Tidak ada policy utk authenticated → hanya service role.
CREATE TABLE purchases_raw (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id      UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  source_ref     TEXT NOT NULL UNIQUE,        -- 'po:<po_item_id>:<outlet_uuid>' | 'pr:<id>'
  source_type    TEXT NOT NULL CHECK (source_type IN ('po','purchase_report')),
  material_id    UUID,                        -- materials.id di PO (kunci aturan markup)
  material_name  TEXT NOT NULL,
  unit           TEXT,
  date           DATE NOT NULL,               -- tanggal efektif (lihat §3.2.4)
  qty            NUMERIC(12,4) NOT NULL,
  price_real     NUMERIC(15,4) NOT NULL,      -- harga satuan ASLI — RAHASIA
  subtotal_real  NUMERIC(15,2) NOT NULL,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- HARGA TAMPILAN (sudah di-markup). Inilah satu-satunya yang dilihat investor.
CREATE TABLE purchases_display (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  raw_id           UUID NOT NULL UNIQUE REFERENCES purchases_raw(id) ON DELETE CASCADE,
  outlet_id        UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  material_name    TEXT NOT NULL,
  unit             TEXT,
  date             DATE NOT NULL,
  qty              NUMERIC(12,4) NOT NULL,
  price_display    NUMERIC(15,2) NOT NULL,    -- harga satuan SETELAH markup
  subtotal_display NUMERIC(15,2) NOT NULL,
  markup_rule      TEXT NOT NULL,             -- 'default_percent'|'percent'|'fixed_amount'|'fixed_price'
  computed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE price_markups (                  -- aturan per bahan (admin only)
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id   UUID NOT NULL UNIQUE,         -- = materials.id di PO
  material_name TEXT NOT NULL,
  markup_type   TEXT NOT NULL CHECK (markup_type IN ('percent','fixed_amount','fixed_price')),
  markup_value  NUMERIC(15,4) NOT NULL CHECK (markup_value >= 0),
  is_active     BOOLEAN NOT NULL DEFAULT true,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE app_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
INSERT INTO app_settings (key, value) VALUES
  ('default_markup_percent', '0'),        -- WAJIB diubah admin saat setup (§6.2)
  ('sync_lookback_days', '90'),
  ('health_margin_sehat', '20'),          -- % margin utk badge "Sehat"
  ('health_margin_waspada', '5');

-- ── Staff & gaji (sumber: Staff Portal) ───────────────────────────
CREATE TABLE staff_members (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id       UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  source_staff_id UUID NOT NULL UNIQUE,        -- staff.id di staff portal
  name            TEXT NOT NULL,
  photo_url       TEXT,
  is_active       BOOLEAN NOT NULL DEFAULT true,
  joined_at       TIMESTAMPTZ,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE attendance_records (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id            UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE,
  source_attendance_id UUID NOT NULL UNIQUE,   -- attendance.id di staff portal
  source_staff_id      UUID NOT NULL,
  staff_name           TEXT NOT NULL,
  date                 DATE NOT NULL,
  shift                INTEGER NOT NULL,       -- 0=full, 1, 2
  status               TEXT NOT NULL,          -- pending|present|absent|late|off
  late_minutes         INTEGER NOT NULL DEFAULT 0,
  deduction            NUMERIC(15,2) NOT NULL DEFAULT 0,
  final_salary         NUMERIC(15,2) NOT NULL DEFAULT 0,
  paid_status          BOOLEAN NOT NULL DEFAULT false,
  checkin_time         TIMESTAMPTZ,
  checkout_time        TIMESTAMPTZ,
  synced_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_att_outlet_date ON attendance_records(outlet_id, date);

CREATE TABLE payroll_payments (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  outlet_id         UUID NOT NULL REFERENCES outlets(id) ON DELETE CASCADE, -- outlet staff saat sync
  source_payment_id UUID NOT NULL UNIQUE,
  source_staff_id   UUID NOT NULL,
  staff_name        TEXT NOT NULL,
  amount            NUMERIC(15,2) NOT NULL,
  date_from         DATE NOT NULL,
  date_to           DATE NOT NULL,
  paid_at           TIMESTAMPTZ NOT NULL,
  note              TEXT,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

### 5.2 RLS — isolasi per investor (WAJIB, ini inti keamanannya)

```sql
-- Helper: apakah user sekarang super admin?
CREATE OR REPLACE FUNCTION public.is_super_admin()
RETURNS BOOLEAN LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT EXISTS (
    SELECT 1 FROM profiles
    WHERE id = auth.uid() AND role = 'super_admin' AND is_active
  );
$$;

-- Helper: daftar outlet milik user sekarang
CREATE OR REPLACE FUNCTION public.my_outlet_ids()
RETURNS SETOF UUID LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT outlet_id FROM investor_outlet_access WHERE profile_id = auth.uid();
$$;

-- Aktifkan RLS di SEMUA tabel
ALTER TABLE profiles               ENABLE ROW LEVEL SECURITY;
ALTER TABLE outlets                ENABLE ROW LEVEL SECURITY;
ALTER TABLE investor_outlet_access ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_runs              ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_daily            ENABLE ROW LEVEL SECURITY;
ALTER TABLE sales_transactions    ENABLE ROW LEVEL SECURITY;
ALTER TABLE stock_items            ENABLE ROW LEVEL SECURITY;
ALTER TABLE purchases_raw          ENABLE ROW LEVEL SECURITY;  -- TANPA policy = tertutup total
ALTER TABLE purchases_display      ENABLE ROW LEVEL SECURITY;
ALTER TABLE price_markups          ENABLE ROW LEVEL SECURITY;
ALTER TABLE app_settings           ENABLE ROW LEVEL SECURITY;
ALTER TABLE staff_members          ENABLE ROW LEVEL SECURITY;
ALTER TABLE attendance_records     ENABLE ROW LEVEL SECURITY;
ALTER TABLE payroll_payments       ENABLE ROW LEVEL SECURITY;

-- profiles: user lihat dirinya sendiri; super admin lihat semua
CREATE POLICY p_profiles_self  ON profiles FOR SELECT TO authenticated
  USING (id = auth.uid() OR is_super_admin());
CREATE POLICY p_profiles_admin ON profiles FOR ALL TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

-- outlets: investor lihat outlet miliknya (kolom mapping tdk sensitif); admin semua
CREATE POLICY p_outlets_read ON outlets FOR SELECT TO authenticated
  USING (id IN (SELECT my_outlet_ids()) OR is_super_admin());
CREATE POLICY p_outlets_admin ON outlets FOR ALL TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

-- investor_outlet_access: investor lihat mapping dirinya; admin kelola semua
CREATE POLICY p_ioa_read ON investor_outlet_access FOR SELECT TO authenticated
  USING (profile_id = auth.uid() OR is_super_admin());
CREATE POLICY p_ioa_admin ON investor_outlet_access FOR ALL TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

-- sync_runs: semua user login boleh lihat status sync
CREATE POLICY p_sync_read ON sync_runs FOR SELECT TO authenticated USING (true);

-- Pola sama untuk semua tabel data ber-outlet_id:
-- (ulangi untuk: sales_daily, sales_transactions, stock_items,
--  purchases_display, staff_members, attendance_records, payroll_payments)
CREATE POLICY p_sd_read ON sales_daily FOR SELECT TO authenticated
  USING (outlet_id IN (SELECT my_outlet_ids()) OR is_super_admin());
-- ... (buat policy SELECT identik untuk 6 tabel lainnya)

-- price_markups & app_settings: HANYA admin (investor tdk boleh tahu aturan markup)
CREATE POLICY p_markup_admin ON price_markups FOR ALL TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());
CREATE POLICY p_settings_admin ON app_settings FOR ALL TO authenticated
  USING (is_super_admin()) WITH CHECK (is_super_admin());

-- purchases_raw: SENGAJA tanpa policy apa pun.
-- RLS aktif + tidak ada policy = role authenticated & anon tidak bisa SELECT sama sekali.
-- Hanya service_role (server) yang bisa membaca/menulis.
```

**Catatan penting untuk builder:**
- Penulisan data snapshot dilakukan server-side dengan **service role key** (bypass RLS).
- INSERT/UPDATE/DELETE dari client TIDAK diberi policy pada tabel data → investor otomatis read-only.
- Uji wajib: login sebagai investor A, panggil PostgREST langsung (`/rest/v1/purchases_raw?select=*` dan `/rest/v1/sales_daily?outlet_id=eq.<outlet investor B>`) — keduanya harus kosong/ditolak.

---

## 6. Konfigurasi Harga Bahan untuk Investor (Panel Super Admin)

### 6.1 Prinsip & Alur

Super Admin **mengatur harga tampilan setiap bahan** dari panel `/admin/markup`. Alurnya:

1. Data pembelian bahan masuk ke `purchases_raw` saat sinkronisasi — berisi **harga asli** dari sistem PO.
2. `purchases_raw` **tertutup total untuk semua client** (lihat RLS §5.2); tidak ada jalur query yang bisa menghasilkan harga asli untuk role `authenticated`.
3. Super Admin membuka `/admin/markup` → melihat daftar semua bahan yang pernah dibeli + **preview harga asli & harga tampilan yang akan dilihat investor** → mengatur aturan harga per bahan.
4. Setelah aturan disimpan (atau tombol **"Terapkan Ulang Harga"** ditekan), server menghitung ulang `purchases_display` — tabel inilah **satu-satunya** yang dibaca investor.
5. Bila aturan berubah, tekan "Terapkan Ulang Harga" → harga investor ter-update tanpa perlu sync ulang.

### 6.2 Cara setting harga per bahan (pilih salah satu tipe)

Super Admin memilih tipe aturan per bahan di form `/admin/markup`:

| Tipe aturan | Arti | Contoh | Rumus `price_display` |
|---|---|---|---|
| **`fixed_price`** (Harga Tetap) | Harga satuan tampilan dikunci ke angka tertentu, terlepas harga asli | Roti Tawar selalu tampil Rp 5.000/pcs | `markup_value` |
| **`fixed_amount`** (Tambah Nominal) | Harga asli + tambahan tetap per satuan | Harga asli + Rp 1.000 | `price_real + markup_value` |
| **`percent`** (Persentase) | Harga asli × (1 + persen) | Naik 20% dari harga asli | `price_real × (1 + markup_value/100)` |
| (tanpa aturan) | Gunakan persen default global | Ikut setting `default_markup_percent` | `price_real × (1 + default_markup_percent/100)` |

**Urutan prioritas** jika ada beberapa aturan (ambil yang paling atas):
1. `fixed_price` aktif
2. `fixed_amount` aktif
3. `percent` aktif
4. default global dari `app_settings.default_markup_percent`

`subtotal_display = ROUND(price_display × qty, 2)`. Baris `purchase_report` memiliki `material_id` (kolom `purchase_report.material_id` di sistem PO) — gunakan kunci yang sama.

**Kolom `markup_rule` di `purchases_display`** mencatat tipe yang dipakai (`'fixed_price'|'fixed_amount'|'percent'|'default_percent'`) untuk keperluan audit internal admin (investor tidak melihat kolom ini).

**Peringatan wajib di UI admin:** jika `default_markup_percent = 0` DAN ada material tanpa aturan spesifik, tampilkan banner: *"X bahan belum punya aturan harga — harga asli akan tampil ke investor!"* beserta daftar materialnya. Ini satu-satunya celah kebocoran dan harus terlihat jelas.

### 6.3 Kapan dihitung ulang

- Otomatis setiap kali sinkronisasi (langkah 5 pipeline §7.2).
- Manual: tombol **"Terapkan Ulang Harga"** di `/admin/markup` (menghitung ulang semua `purchases_display` dari `purchases_raw` + aturan terbaru, server-side service role, tanpa perlu sinkronisasi data baru).

### 6.4 Uji anti-bocor (wajib lulus sebelum rilis)

- [ ] Response semua endpoint/page-props investor tidak mengandung field `price_real`/`subtotal_real` (cek dengan grep di payload).
- [ ] PostgREST langsung ke `purchases_raw` dengan JWT investor → `[]`/401.
- [ ] Setelah ubah aturan markup + terapkan ulang, harga di halaman Pembelian investor berubah konsisten.

---

## 7. Sinkronisasi Data (1 Tombol)

### 7.1 Kontrak

- Endpoint: `POST /api/sync` (Next.js Route Handler, berjalan server-side dengan service role).
- Boleh dipanggil oleh: **semua user login** (investor & admin). Wajib validasi session Supabase di server.
- Anti-spam: tolak (HTTP 429 + pesan ramah) jika ada `sync_runs.status='running'` ATAU sync sukses terakhir < 2 menit yang lalu.
- Response: `{ "run_id": "...", "status": "success|partial|failed", "detail": { per sumber } }`.
- UI: tombol "Tarik Data Terbaru" + spinner + teks "Sinkronisasi terakhir: {relative time WITA}" (dari `sync_runs` terakhir yang selesai). Saat `partial`, tampilkan sumber mana yang gagal dengan bahasa awam.
- `[OPSIONAL]` Cron Vercel tiap hari 03:30 WITA (`19:30 UTC`) memanggil endpoint yang sama dengan header `Authorization: Bearer {CRON_SECRET}`.

### 7.2 Pipeline (urutan eksekusi)

Rentang tanggal default: `hari_ini_WITA − sync_lookback_days` s.d. `hari_ini_WITA` (setting, default 90 hari). Semua langkah per-sumber dibungkus try/catch sendiri → kegagalan satu sumber tidak membatalkan sumber lain (`status='partial'`).

```
0. INSERT sync_runs (status running). Muat outlets ter-mapping + aktif.
1. POS     — per outlet (pos_branch_id terisi):
             a. rpc get_integration_summary(p_branch_id, p_date_from, p_date_to)
                → upsert sales_daily ON CONFLICT (outlet_id, date)
             b. rpc get_sales_integration (loop pagination 1000)
                → upsert sales_transactions ON CONFLICT (outlet_id, pos_tx_id)
2. PO      — sekali untuk semua outlet (po_outlet_id terisi):
             a. tarik purchase_order_items + order_request_items + purchase_report (§3.2.3)
             b. jalankan algoritma alokasi §3.2.4
             c. upsert purchases_raw ON CONFLICT (source_ref)
3. INVENTORI — per outlet (inv_cabang_id terisi):
             a. api.v1.stocks.latest?cabang_id=... (loop page, throttle ≤15 req/mnt)
             b. DELETE stock_items outlet tsb lalu INSERT ulang
                (stok = snapshot penuh, bukan incremental)
4. STAFF   — sekali:
             a. outlets+staff → upsert staff_members (outlet via staff_outlet_id mapping)
             b. attendance (rentang tanggal) → upsert attendance_records
                ON CONFLICT (source_attendance_id)
             c. payments → upsert payroll_payments ON CONFLICT (source_payment_id)
5. MARKUP  — hitung ulang purchases_display untuk semua purchases_raw
             pada rentang tanggal yang tersentuh (atau semua, datanya kecil).
6. UPDATE sync_runs: finished_at, status, detail JSONB
   {"pos":{"status":"success","rows":1234,"ms":5100,"error":null},
    "po":{...},"inventori":{...},"staff":{...},"markup":{...}}
```

Timeout per sumber: 60 detik POS/PO/Staff, 120 detik Inventori (GAS lambat). Total target < 4 menit. `[ASUMSI]` volume data: ≤ ~10 outlet, ≤ ~3.000 transaksi/bulan/outlet — muat dalam satu invocation Vercel (maxDuration 300 di plan Pro; jika Hobby, batasi lookback 30 hari). `[PERLU KONFIRMASI]` plan Vercel.

---

## 8. Spesifikasi Halaman

Konvensi umum:
- Semua angka uang: format `Rp 1.234.567` (id-ID, tanpa desimal).
- Semua tanggal: `10 Jun 2026` / relative ("2 jam lalu"), zona WITA.
- Pemilih global di header: **dropdown outlet** (jika user punya >1 outlet; default outlet pertama) + **pemilih periode** (Bulan Ini ▾ | 7 Hari | 30 Hari | Pilih Bulan | Rentang Custom).
- Setiap halaman punya: skeleton loading, empty state berinstruksi ("Belum ada data — tekan 'Tarik Data Terbaru'"), error state dengan tombol coba lagi.
- Navigasi investor: Ringkasan · Penjualan · Pembelian · Stok · Staff · Arus Kas. (Sidebar desktop, bottom-nav mobile.)
- Route group: `(investor)` untuk halaman investor, `(admin)` untuk admin. Middleware redirect: belum login → `/login`; investor membuka `/admin/*` → 404/redirect.

### 8.1 `/login`

Email + password (Supabase Auth `signInWithPassword`). Tanpa link daftar (registrasi publik DIMATIKAN — lihat §9.3). Error berbahasa ramah: "Email atau kata sandi salah." Setelah login: investor → `/`, super admin → `/admin`.

### 8.2 `/` — Ringkasan (Overview)

| Komponen | Isi | Sumber |
|---|---|---|
| Kartu "Penjualan Hari Ini" | `SUM(sales_daily.total_sales)` tanggal hari ini + Δ% vs kemarin | `sales_daily` |
| Kartu "Penjualan Bulan Ini" | SUM bulan berjalan + Δ% vs bulan lalu (periode sama) | `sales_daily` |
| Kartu "Pembelian Bulan Ini" | `SUM(purchases_display.subtotal_display)` bulan berjalan | `purchases_display` |
| Kartu "Biaya Gaji Bulan Ini" | `SUM(attendance_records.final_salary)` `status IN ('present','late')` bulan berjalan | `attendance_records` |
| Kartu "Arus Kas Bersih Bulan Ini" | penjualan − pembelian − gaji (rumus §8.7) dengan warna hijau/merah | gabungan |
| Badge "Kesehatan Outlet" | margin = arus kas bersih ÷ penjualan bulan berjalan. `Sehat` ≥ `health_margin_sehat`% · `Waspada` ≥ `health_margin_waspada`% · `Perlu Perhatian` di bawahnya · `Belum Ada Data` jika penjualan 0. Ambang dari `app_settings`. | gabungan |
| Grafik garis "Penjualan 30 Hari" | harian | `sales_daily` |
| Grafik batang "Arus Kas 6 Bulan" | masuk vs keluar per bulan | gabungan |
| Panel "Stok Perlu Perhatian" | item `stok_akhir = 0 / null` + 5 stok terendah `[ASUMSI: tidak ada ambang minimum dari API inventori]` | `stock_items` |
| Footer | "Data per: {sync terakhir}" + tombol **Tarik Data Terbaru** | `sync_runs` |

### 8.3 `/stok` — Stok Outlet

Tabel: Nama Bahan · Stok Akhir · Tanggal Laporan Terakhir · status badge (`Stok Kosong` merah jika 0; `Belum Dilaporkan` abu jika null; `Laporan Lama` kuning jika `last_report_date` < hari ini − 2). Pencarian nama bahan; sort; ringkasan atas: total jenis bahan, jumlah kosong, laporan terakhir. Sumber: `stock_items` (outlet aktif). Tidak menampilkan harga apa pun.

### 8.4 `/pembelian` — Pembelian Bahan Baku

- Tabel per item: Tanggal · Nama Bahan · Qty (+unit) · **Harga Satuan** (= `price_display`) · **Subtotal** (= `subtotal_display`).
- Ringkasan periode: total pembelian, jumlah item, top 5 bahan terbesar nilainya (pie/bar kecil).
- Grouping default per tanggal (accordion).
- **DILARANG** menampilkan/mem-fetch `price_real`. Sumber HANYA `purchases_display`.

### 8.5 `/penjualan` — Penjualan Outlet

- Grafik garis penjualan harian periode terpilih (`sales_daily`).
- Kartu: total penjualan, jumlah transaksi, rata-rata per transaksi, rata-rata per hari.
- Breakdown metode pembayaran (dari `sales_transactions.payment_method`, donut chart).
- Tabel transaksi (paginated 50/halaman, terbaru dulu): Waktu · Kasir · Metode · Total. Sumber `sales_transactions`.

### 8.6 `/staff` — Staff Outlet

- Daftar kartu staff aktif (`staff_members`): foto (fallback inisial), nama.
- Klik staff → detail: riwayat absensi per bulan (`attendance_records`: tanggal, shift — label "Shift 1/2/Full", status badge, menit telat, potongan, gaji shift) + ringkasan gaji periode: Total Gaji (`SUM final_salary`), Sudah Dibayar (`SUM payroll_payments.amount` yang beririsan periode), Status (Lunas/Sebagian/Belum — aturan §3.4.3).
- Ringkasan outlet: total biaya gaji periode, jumlah staff aktif, total shift.
- Privasi: tidak ada PIN, KTP, alamat, selfie (memang tidak disinkron).

### 8.7 `/arus-kas` — Arus Kas (Cash Flow)

**Formula (tulis juga di UI sebagai tooltip "ⓘ Bagaimana dihitung?"):**

```
Kas Masuk (per hari, per outlet)  = total penjualan POS hari itu
                                    (sales_daily.total_sales; hanya transaksi selesai)
Kas Keluar (per hari, per outlet) = Pembelian bahan baku (harga tampilan/mark-up)
                                    (SUM purchases_display.subtotal_display pada tanggal itu)
                                  + Biaya gaji shift hari itu
                                    (SUM attendance_records.final_salary,
                                     status IN ('present','late'))
Arus Kas Bersih = Kas Masuk − Kas Keluar
Saldo Berjalan  = penjumlahan kumulatif Arus Kas Bersih sejak awal periode tampilan
```

`[KEPUTUSAN]` Basis **akrual**: gaji dihitung pada tanggal shift (bukan tanggal transfer `payments.paid_at`) dan pembelian pada tanggal order/penerimaan — supaya cocok dengan periode penjualan. Pengeluaran operasional dari `cash_logs` POS TIDAK dimasukkan v1 karena kategori campur (termasuk "Setoran Tunai" yang bukan biaya) → `[PERLU KONFIRMASI]` apakah perlu di Fase 2 dengan filter kategori.

UI: toggle **Harian | Bulanan**; grafik batang masuk (hijau) vs keluar (merah) + garis saldo; tabel: Periode · Kas Masuk · Pembelian · Gaji · Arus Kas Bersih · Saldo Berjalan; baris total.

### 8.8 Panel Super Admin (`/admin/*`)

| Route | Fungsi |
|---|---|
| `/admin` | Ringkasan semua outlet (tabel: outlet, penjualan bulan ini, arus kas, sync terakhir) + tombol sync. |
| `/admin/investor` | CRUD akun investor: buat (nama, email, password awal — via server route `supabase.auth.admin.createUser({email, password, email_confirm:true})` + insert `profiles` role `investor`), nonaktifkan (`is_active=false` + `auth.admin.updateUserById` ban), reset password. Mapping outlet per investor (checkbox daftar `outlets`) → tabel `investor_outlet_access`. |
| `/admin/outlet` | CRUD outlet kanonik + form mapping 4 kolom referensi. Tiap kolom = dropdown hasil fetch live dari sumber (server route memanggil §3.1.3 / §3.2.3-q4 / §3.3.2-A / §3.4.4-outlets). Saran auto-match by nama (case-insensitive) boleh, tapi admin yang mengkonfirmasi. |
| `/admin/markup` | **Panel Konfigurasi Harga Bahan** (lihat §6 untuk detail lengkap). Terdiri dari: (1) Setting global `default_markup_percent` — persentase default untuk bahan yang belum diatur; (2) Tabel semua bahan yang pernah dibeli (DISTINCT material_id dari `purchases_raw`, query server-side service role): kolom = Nama Bahan · Harga Asli Terakhir · Harga Tampilan Sekarang · Tipe Aturan · Nilai · Aksi; (3) Form per bahan: pilih tipe (`Harga Tetap / Tambah Nominal / Persentase`) + isi nilai + simpan → langsung terapkan; (4) Banner peringatan merah jika ada bahan tanpa aturan dan default = 0% (§6.2); (5) Tombol **"Terapkan Ulang Harga"** — menghitung ulang seluruh `purchases_display` sesuai aturan terbaru tanpa perlu sync. Harga asli (kolom preview admin) hanya muncul di halaman ini dan TIDAK pernah dikirim ke client investor. |
| `/admin/sync` | Riwayat `sync_runs` (status, durasi, error per sumber) + tombol sync manual. |

Halaman admin mengambil data via server components/route handlers dengan pengecekan `is_super_admin` di server (bukan hanya client).

---

## 9. Auth & Role

### 9.1 Mekanisme

- **Supabase Auth** email + password, session cookie via `@supabase/ssr` (pola sama dengan `staff_portal`).
- Tabel `profiles` (§5.1) menyimpan role. Sumber kebenaran otorisasi = `profiles.role` + RLS (§5.2), **bukan** state di client.
- Middleware Next.js: lindungi semua route kecuali `/login`; cek role untuk `(admin)`.
- Server-side guard tambahan di setiap route handler admin & `/api/sync`.

### 9.2 Seed Super Admin (tanpa hardcode)

Script `scripts/seed-admin.mjs`, dijalankan manual sekali (`node scripts/seed-admin.mjs`):

1. Baca env: `SUPER_ADMIN_EMAIL`, `SUPER_ADMIN_PASSWORD`, `SUPER_ADMIN_NAME`, `NEXT_PUBLIC_SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`. Gagal dengan pesan jelas jika ada yang kosong.
2. Idempoten: jika user dengan email tsb sudah ada → hanya pastikan `profiles.role='super_admin'` dan `is_active=true`.
3. Buat user via `supabase.auth.admin.createUser({ email, password, email_confirm: true })` + insert `profiles`.
4. **Tidak pernah** mencetak password ke stdout/log.

### 9.3 Pengaturan Supabase Auth (manual, di dashboard Supabase)

- **Matikan signup publik** (Authentication → Sign In / Up → Disable new user signups). Tanpa ini siapa pun bisa membuat akun `authenticated` dan RLS `sync_runs`/`profiles self` bisa tersentuh.
- Matikan provider OAuth yang tidak dipakai. Email confirmation tidak diperlukan (akun dibuat admin dengan `email_confirm: true`).

### 9.4 Isolasi data investor — ringkasan jaminan

| Lapisan | Mekanisme |
|---|---|
| Database | RLS: semua tabel data difilter `outlet_id IN my_outlet_ids()` (§5.2) |
| Harga asli | `purchases_raw` tanpa policy → tak terbaca client mana pun |
| Server | Route admin & sync memverifikasi session + role di server |
| UI | Navigasi/halaman admin tidak dirender untuk investor (lapisan kosmetik saja, bukan keamanan) |

---

## 10. UI/UX Guidelines

- **Bahasa**: Indonesia, ramah awam. Hindari jargon: "Penjualan" bukan "Revenue", "Kas Masuk/Keluar" bukan "Inflow/Outflow", "Tarik Data Terbaru" bukan "Sync".
- **Tipografi/komponen**: shadcn/ui default + font Inter. Hierarki: angka besar untuk metrik utama, label kecil abu-abu.
- **Warna**: latar terang bersih; hijau (#16a34a) untuk masuk/positif, merah (#dc2626) untuk keluar/negatif, kuning untuk peringatan. Logo/aksen brand RBN `[PERLU KONFIRMASI]` (default: oranye roti bakar #ea580c sebagai warna aksen).
- **Responsif**: mobile-first. Mobile: bottom navigation 5-6 ikon + halaman scroll tunggal; tabel berubah jadi kartu bertumpuk. Desktop: sidebar kiri tetap.
- **Grafik**: Recharts; tooltip bahasa Indonesia + format Rupiah; sumbu tanggal pendek ("10 Jun"); maksimal 2 seri per grafik agar mudah dibaca.
- **Empty/loading/error**: skeleton; pesan kosong selalu beri tindakan ("Tekan 'Tarik Data Terbaru'"); error tampilkan bahasa manusia, bukan stack trace.
- **Aksesibilitas dasar**: kontras AA, target sentuh ≥ 44px, fokus terlihat.

---

## 11. Non-Functional Requirements

| Area | Ketentuan |
|---|---|
| Keamanan | Semua secret hanya di env server; tidak ada secret di repo/commit/log. RLS sesuai §5.2. Rate limit `/api/sync` (§7.1). Pengujian anti-bocor §6.4 wajib lulus. |
| Read-only ke sumber | Konektor sumber hanya melakukan operasi baca (GET / `.select()`). Tidak ada tulisan apa pun ke POS/PO/Inventori/Staff Portal. |
| Kinerja | Halaman investor < 2 detik (baca snapshot lokal + index §5.1). Sync total < 4 menit. |
| Ketahanan sync | Kegagalan satu sumber → `partial`, sumber lain tetap tersimpan; error per sumber tercatat di `sync_runs.detail`. |
| Zona waktu | Seluruh logika tanggal memakai Asia/Makassar (WITA). Server (Vercel) berjalan UTC — selalu konversi eksplisit (pakai `date-fns-tz` atau `Intl`). |
| Privasi staf | Kolom sensitif staff portal (pin_hash, ktp_no, ktp_photo_url, address, selfie, lat/lng) tidak pernah ditarik. |
| Browser | Chrome/Safari/Firefox terbaru + Android WebView modern. |
| Kualitas kode | TypeScript strict; minimal unit test untuk: resolusi mark-up (§6.2), alokasi pembelian (§3.2.4), formula arus kas (§8.7), status pembayaran gaji (§3.4.3). |

---

## 12. Environment Variables — `.env.example`

Builder wajib membuat file `.env.example` persis berisi nama-nama berikut (nilai kosong/placeholder). Nilai asli diberikan owner via `.env.local` / Vercel env — **tidak pernah di-commit**.

```bash
# ── Supabase milik dashboard (project baru) ──────────────────────
# NEXT_PUBLIC_* bersifat public-facing — aman dicantumkan di PRD & dibaca browser.
# Service role key = SECRET, hanya di server, jangan commit.
NEXT_PUBLIC_SUPABASE_URL=https://tfartajyiucohogwtrwh.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=          # anon/publishable key — salin dari dashboard.supabase.co → Project Settings → API → anon public
SUPABASE_SERVICE_ROLE_KEY=              # service role — SERVER ONLY, jangan commit

# ── Sumber 1: POS (cPanel PHP API) ───────────────────────────────
POS_API_URL=                            # https://api.rotibakarngeunah.my.id/api/api.php  [PERLU KONFIRMASI domain]
POS_API_KEY=                            # = API_SECRET_KEY di .env POS (header X-API-Key)
POS_INTEGRATION_API_KEY=                # key dari tabel api_keys POS (param p_api_key)

# ── Sumber 2: Purchase Order (Supabase project PO) ───────────────
PO_SUPABASE_URL=                        # salin dari purchase_order/server/.env → SUPABASE_URL
PO_SUPABASE_SERVICE_KEY=                # salin dari purchase_order/server/.env → SUPABASE_SERVICE_KEY

# ── Sumber 3: Inventori (Google Apps Script) ─────────────────────
INVENTORI_GAS_URL=                      # salin dari purchase_order/server/.env → INVENTORI_GAS_URL
INVENTORI_API_KEY=                      # API key inventori scope read:master,read:stock

# ── Sumber 4: Staff Portal (Supabase project staff) ──────────────
STAFF_SUPABASE_URL=                     # https://qqzynzklswrzhprawnhc.supabase.co
STAFF_SUPABASE_SERVICE_KEY=             # salin dari staff_portal/.env.local → SUPABASE_SERVICE_ROLE_KEY

# ── Seed Super Admin (hanya untuk scripts/seed-admin.mjs) ────────
SUPER_ADMIN_EMAIL=
SUPER_ADMIN_PASSWORD=
SUPER_ADMIN_NAME=

# ── Opsional ─────────────────────────────────────────────────────
CRON_SECRET=                            # jika cron harian diaktifkan
```

Catatan: Supabase kini juga memakai format key baru (`sb_publishable_...` / `sb_secret_...`); keduanya valid — gunakan yang tersedia di dashboard project.

---

## 13. Setup & Deployment — Langkah demi Langkah

### 13.1 Untuk builder (urutan implementasi)

- [ ] 1. Inisialisasi repo Next.js 15 + TS + Tailwind + shadcn/ui; struktur: `app/(investor)/...`, `app/(admin)/admin/...`, `app/login`, `app/api/sync`, `lib/sources/{pos,po,inventori,staff}.ts`, `lib/markup.ts`, `lib/allocation.ts`, `scripts/seed-admin.mjs`, `supabase/migrations/0001_init.sql`.
- [ ] 2. Tulis migration §5 lengkap (semua tabel + RLS + seed `app_settings`) dan jalankan ke project Supabase dashboard.
- [ ] 3. Implement konektor 4 sumber persis kontrak Bab 3 (termasuk pagination, throttle GAS, follow-redirect).
- [ ] 4. Implement alokasi §3.2.4 + mark-up §6 + pipeline §7.2 (+unit test §11).
- [ ] 5. Implement auth + middleware + seed script (Bab 9).
- [ ] 6. Bangun halaman Bab 8 (investor dulu, lalu admin).
- [ ] 7. Jalankan uji §6.4 + uji isolasi RLS §5.2 + smoke test sync end-to-end.
- [ ] 8. Push ke `https://github.com/rotibakarngeunahid-pixel/investor-dashboard` (token dari owner; pastikan `.env*` masuk `.gitignore`).

### 13.2 Untuk owner (langkah MANUAL yang harus Anda lakukan sendiri)

**A. Menyiapkan kredensial sumber:**

- [ ] 1. **POS — key integrasi (`POS_INTEGRATION_API_KEY`)**: buka phpMyAdmin cPanel → database POS → tabel `api_keys` → INSERT baris baru: `name` = `investor-dashboard`, `key_value` = string acak panjang (≥ 40 karakter, generate dari password manager), `is_active` = 1. (Atau melalui menu API Keys di `admin.html` POS jika tersedia.) Nilai `POS_API_KEY` (header) salin dari file `.env` di folder API POS di cPanel (variabel `API_SECRET_KEY`).
- [ ] 2. **Inventori — API key**: buka Admin Panel Inventori (`admin-panel-standalone.html` / URL GAS `?page=admin`) → menu Integrasi/API Keys → buat key baru dengan scope `read:master` + `read:stock` → salin nilainya (hanya tampil sekali).
- [ ] 3. **PO & Staff Portal**: salin nilai dari file env yang sudah ada di komputer Anda (lihat komentar di §12). Jangan kirim lewat chat/email; tempel langsung ke Vercel/`.env.local`.

**B. Setup project & deploy:**

- [ ] 4. Pastikan migration SQL sudah dijalankan di Supabase project dashboard (SQL Editor → tempel isi `supabase/migrations/0001_init.sql` → Run), bila builder belum menjalankannya.
- [ ] 5. Supabase → Authentication → **disable new user signups** (§9.3).
- [ ] 6. Vercel → import repo GitHub → isi SEMUA env §12 (Production + Preview) → deploy.
- [ ] 7. Di komputer lokal (sekali): isi `.env.local`, jalankan `node scripts/seed-admin.mjs` untuk membuat akun Super Admin Anda.
- [ ] 8. Login sebagai Super Admin → `/admin/outlet`: buat outlet + isi mapping 4 sistem per outlet.
- [ ] 9. `/admin/markup`: set `default_markup_percent` global → lalu atur harga per bahan (pilih tipe Harga Tetap / Tambah Nominal / Persentase untuk setiap bahan) → klik **"Terapkan Ulang Harga"**. **Lakukan SEBELUM membuat akun investor** agar harga asli tidak sempat tampil ke investor.
- [ ] 10. `/admin/sync`: tekan "Tarik Data Terbaru", pastikan 4 sumber hijau.
- [ ] 11. `/admin/investor`: buat akun investor + mapping outlet → kirim kredensial ke investor lewat jalur pribadi.

**C. Keamanan berkala:**

- [ ] 12. Rotasi `POS_INTEGRATION_API_KEY` & API key inventori tiap ±6 bulan (buat key baru → update env Vercel → nonaktifkan key lama).
- [ ] 13. Jika service key PO/Staff pernah ter-ekspos, rotate dari dashboard Supabase masing-masing project (Settings → API) lalu update env PO server / staff portal / dashboard ini.

### 13.3 UAT (uji terima oleh owner)

- [ ] Login investor hanya melihat outlet miliknya (coba ganti-ganti URL/outlet).
- [ ] Harga di halaman Pembelian = harga mark-up (bandingkan dengan PO asli).
- [ ] Angka penjualan cocok dengan laporan POS untuk 1 tanggal sampel.
- [ ] Total gaji staff cocok dengan staff portal untuk 1 bulan sampel.
- [ ] Arus kas = penjualan − (pembelian markup + gaji) untuk 1 bulan sampel.
- [ ] Tombol sinkronisasi: status loading, waktu terakhir ter-update, anti-spam 2 menit.
- [ ] Tampilan rapi di HP (layar ≤ 400px) dan desktop.

---

## 14. Daftar [PERLU KONFIRMASI] (jawab sebelum/saat implementasi)

| # | Pertanyaan | Dampak | Default bila tidak dijawab |
|---|---|---|---|
| 1 | Base URL POS kanonik: `https://api.rotibakarngeunah.my.id/api/api.php` atau `https://pos.rotibakarngeunah.my.id/api/api.php`? | nilai env `POS_API_URL` | Pakai `api.` (yang sudah terbukti dipakai server PO) |
| 2 | Plan Vercel (Hobby/Pro)? Hobby membatasi durasi function → lookback sync perlu diturunkan ke 30 hari | konfigurasi `sync_lookback_days` & `maxDuration` | Anggap Hobby, lookback 30 hari |
| 3 | Apakah pengeluaran operasional dari `cash_logs` POS perlu masuk arus kas (Fase 2, dengan filter kategori)? | cakupan §8.7 | Tidak dimasukkan |
| 4 | Berapa `default_markup_percent` global? (0% = harga asli tampil bila bahan belum diatur!) | §6.2 | 0% + banner peringatan keras di admin |
| 5 | Warna aksen brand / logo RBN untuk dashboard? | §10 | Oranye #ea580c, nama "RBN Investor" |
| 6 | Apakah investor boleh memicu sinkronisasi, atau hanya admin? | §7.1 | Boleh (dengan anti-spam 2 menit) |
| 7 | Riwayat absensi yang ditampilkan ke investor: cukup ringkasan gaji, atau detail per shift termasuk menit telat & potongan? | §8.6 | Detail per shift (tanpa data pribadi) |

---

*Dokumen ini dibuat dari analisis langsung file-file: `point_of_sales/api/api.php`, `point_of_sales/api/config.php`, `point_of_sales/sql/cpanel_mysql_schema.sql`, `purchase_order/supabase/*.sql`, `purchase_order/server/routes|services/*.js`, `inventori/backend.inventori.gs`, `staff_portal/supabase/migrations/*.sql`, `staff_portal/lib/payroll.ts`, beserta file `.env.example` masing-masing sistem.*


