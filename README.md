# Kitameraki: backend

Azure Functions v4 (Node 20, TypeScript) HTTP API untuk task management. Task dan
pengaturan form per organisasi disimpan di Azure Cosmos DB (SQL API).

Repo ini membutuhkan frontend, ada di
[kitameraki-fe](https://github.com/robbyfebrian/kitameraki-fe). Urutannya menjalankan backend dulu,
lalu FE.

- [Quickstart](#quickstart)
- [Arsitektur](#arsitektur)
- [Struktur proyek](#struktur-proyek)
- [Environment variables](#environment-variables)
- [Seeding data](#seeding-data)
- [API reference](#api-reference)
- [Model data](#model-data)
- [Keputusan desain](#keputusan-desain)
- [Scaling](#scaling)
- [Testing](#testing)
- [Deploy produksi](#deploy-produksi)

## Quickstart

Tujuan seksi ini, menjalankan server backend di port 7071 dan menyambungkannya ke
frontend. Pilih satu jalur sesuai kondisimu. Jalur A untuk yang belum punya akun
Azure dan ingin semuanya lokal, jalur B untuk yang sudah punya akun Cosmos DB
asli.

> **Perlu dicatat.** CORS API ini diset ke `*` (semua origin), supaya frontend bisa
> memanggil API langsung dari dev server lokal (`http://localhost:3000`) tanpa
> proxy. Untuk keperluan lokal dan pengujian ini aman. Saat deploy produksi,
> batasi origin yang diizinkan, lihat bagian Keputusan desain.

### Jalur A. Lokal dengan emulator Cosmos (Docker)

Tidak perlu subscription Azure. Baris bertanda "(hanya sekali)" boleh dilewati
jika mesinmu sudah pernah melewati langkahnya.

```bash
# (hanya sekali) emulator Cosmos dalam Docker
docker compose up -d
curl -fk https://localhost:8081/_explorer/emulator.pem > /dev/null && echo "emulator up"

# (hanya sekali) dependensi, konfigurasi lokal, dan database
npm install
cp local.settings.example.json local.settings.json
./infra/init-db.sh

# (opsional, disarankan) 100 task contoh + form settings
npm run reseed

# jalankan API
npm start
```

Selesai, API aktif di `http://localhost:7071/api`.

**Kenapa ada dua perintah yang terlihat ganjil.**

- `cp local.settings.example.json local.settings.json` menyalin template
  (yang di-commit) menjadi file konfigurasi lokal (yang di-gitignore). File ini
  dibaca Azure Functions Core Tools saat host dimulai, dan isinya connection
  string Cosmos beserta nama database dan container. Intinya ini bagian
  "menunjuk ke mana databasenya". Template sudah berisi nilai emulator port
  8081, jadi jalur A langsung jalan tanpa edit.
- `./infra/init-db.sh` memakai connection string tadi untuk membuat database
  `TaskApp` dan tiga container (`Tasks`, `FormSettings`,
  `FormSettingsHistory`) dengan partition key `/organizationId`. Script memakai `createIfNotExists`, sehingga aman
  dijalankan ulang. Ia adalah setup awal, bukan bagian dari alur harian.

Mode develop cepat, jalankan `npm run watch` di satu terminal dan `func start` di
terminal lain, karena `npm start` membangun ulang tiap kali dipanggil.

### Jalur B. Cosmos DB asli di Azure

> **Disclaimer.** Jalur ini sebagian merupakan asumsi. Pengembangan dan pengujian
> BE sejauh ini hanya memakai Azure Cosmos emulator dalam Docker, sehingga langkah
> di bawah belum divalidasi ujung ke ujung.

```bash
# 1. (hanya sekali) akun Cosmos. Via script atau portal, pilih salah satu
./infra/provision-cosmos.sh [resource-group] [location] [account-name]

# 2. dependensi + konfigurasi
npm install
cp local.settings.example.json local.settings.json
# lalu edit local.settings.json
#    - COSMOS_CONNECTION_STRING -> Endpoint + Key akunmu (salin dari portal
#      atau dari output provision-cosmos.sh)
#    - hapus baris COSMOS_EMULATOR agar validasi TLS tidak dilonggarkan

# 3. (hanya sekali) database + container di akunmu
./infra/init-db.sh

# 4. (opsional) data contoh, lalu jalankan
npm run reseed
npm start
```

Sisi API tetap sama persis dengan jalur A, karena connection string sama-sama
dibaca dari `local.settings.json`. Kapan pun ingin berpindah antar emulator dan
akun asli, cukup ganti file itu.

### Menjalankan frontend (kedua jalur)

```bash
cd ../kitameraki-fe && npm install && npm run dev
```

Buka `http://localhost:3000`. FE secara default memanggil
`http://localhost:7071/api`, jadi tidak perlu konfigurasi tambahan. Untuk
lingkungan lain, ubah `NEXT_PUBLIC_API_BASE_URL` di FE, lihat
[README FE](https://github.com/robbyfebrian/kitameraki-fe).

| Perintah | Fungsi |
| --- | --- |
| `npm start` | Build bersih lalu host Functions di port 7071 |
| `npm run watch` | `tsc -w`, untuk dijalankan bersama `func start` |
| `npm test` | Vitest, tanpa database |
| `npm run reseed` | Wipe lalu tulis ulang 100 task dan form (via `infra/seed.sh`) |
| `npm run seed:clear` | Hapus task saja, form settings dipertahankan |
| `./infra/init-db.sh` | Buat database + container (aman dijalankan ulang) |
| `./infra/provision-cosmos.sh` | Provision akun Cosmos di Azure, butuh subscription |

Jika `npm start` melaporkan `address already in use`, host lain menduduki 7071.
Cari pelakunya dengan `lsof -nP -iTCP:7071 -sTCP:LISTEN`.

## Arsitektur

Kode dibagi per **lapisan**, bukan per jenis file: `platform/` (infra tanpa
pengetahuan bisnis), `domain/` (satu folder per domain: `task`, `form`), dan
`functions/` (adapter HTTP yang tipis). File murni dipisah dari I/O supaya
aturan bisnis bisa dites tanpa Cosmos.

```
HTTP  ──►  src/functions/tasks/*.ts, src/functions/form/*.ts
             │  requireOrganizationId()   validasi UUID partisi
             │  validate(Zod)             body & query sebelum menyentuh DB
             ▼
         src/domain/<domain>/service.ts     use-case: satu fungsi per aksi
             │
             ├─► schema.ts          kontrak domain (murni)
             ├─► query/             filter + paging (murni, task saja)
             ├─► fieldRules.ts      aturan jawaban form (murni, form saja)
             ├─► keyMigration.ts    diff rename key (murni, form saja)
             │
             ├─► answerGuard.ts     muat form, jalankan fieldRules
             ├─► migration.ts       rename key ke dokumen task (batch)
             └─► repo.ts            satu-satunya pemanggil container domain
                     │
                     ▼
                 src/platform/
                   cosmos.ts            client singleton + accessor container
                   batch.ts             TransactionalBatch (satu partisi, ≤100 op)
                   http.ts              CORS, preflight, mapping error, log 1 baris
                   ids.ts               guard organizationId / id
                   validate.ts          parse Zod → nilai bertipe
                     │
                     ▼
                 Azure Cosmos DB      partition key /organizationId
```

Aturan dependensi, satu arah tanpa siklus:

```
functions/ ──► domain/*/service.ts ──► domain/*/repo.ts ──► platform/cosmos.ts + batch.ts
     └────────► platform/http.ts, platform/ids.ts, platform/validate.ts
```

- `platform/` tidak mengimpor `domain/` atau `functions/`.
- File murni (`schema.ts`, `query/`, `fieldRules.ts`, `keyMigration.ts`) tidak
  mengimpor `repo`/`cosmos`, jadi tetap bisa diuji tanpa emulator.
- Route hanya memvalidasi input, memanggil satu service, dan membungkus hasil.
- Lintas domain hanya lewat service atau file murni. `task/answerGuard.ts`
  mengimpor `form/schema.ts` + `form/repo.ts`, bukan `form/service.ts`, agar
  tidak ada siklus saat publish memanggil `task/migration.ts`.

Alur satu request:

1. `handler()` membungkus setiap fungsi, yaitu menjawab `OPTIONS`, mengukur
   durasi, menangkap error, dan menulis satu baris log tanpa body.
2. Route memvalidasi `organizationId` (wajib UUID) dan body dengan skema Zod.
3. Route memanggil service domain; service memakai `repo` untuk I/O.
4. Dokumen Cosmos dibersihkan dari metadata sistem (`_rid`, `_etag`, …) dengan
   `stripMetadata` lalu diparse ulang ke kontrak sebelum dikirim.

Kenapa dipisah begini:

- **Kontrak tunggal.** Body request, dokumen tersimpan, dan seed divalidasi dengan
  skema Zod yang sama.
- **Kontrak dibagi dan harus sinkron.** Skema di `src/domain/` dan
  `kitameraki-fe/src/contracts/` menggambarkan data yang sama. Keduanya
  ditulis terpisah karena repo ini diasumsikan bisa dipisah menjadi
  microservice di kemudian hari, sehingga tidak boleh saling impor source.
  Perubahan bentuk data harus masuk ke kedua repo dalam satu perubahan. Bila
  kedua repo akhirnya disatukan menjadi monorepo, skema Zod-nya boleh dipindah
  ke paket shared dan diimpor dua sisi sehingga sinkronisasi jadi otomatis.
- **I/O tidak masuk ke logika.** Pembangun SQL, aturan validasi, dan diff rename
  murni, jadi bisa diuji tanpa database.
- **Error seragam.** `ValidationError` → 400, `ConflictError` → 409,
  Cosmos `429` → 429, `409`/`412` → 409, sisanya 500 generik (detail dicatat di
  server).

Tiga container, semuanya `partitionKey: /organizationId`:

| Container | Isi | Item id |
| --- | --- | --- |
| `Tasks` | Satu dokumen per task | `randomUUID()` |
| `FormSettings` | Satu dokumen form per organisasi + journal publish | `task-form`, `task-form-staging` |
| `FormSettingsHistory` | Satu snapshot per versi form yang dipublish | versi (`"4"`) |

## Struktur proyek

```
src/
  index.ts                 Setup host Functions (HTTP streaming)
  functions/               Adapter HTTP, satu file per route, tanpa logika bisnis
    tasks/                 InsertTask, GetTask, GetTasks, UpdateTask, DeleteTask,
                           BulkDeleteTasks
    form/                  GetFormSettings, SaveFormSettings, GetFormSettingsHistory
  domain/
    task/
      schema.ts            Kontrak Task (skema + mapping dokumen), murni
      repo.ts              Satu-satunya I/O task (termasuk batch delete)
      service.ts           Use-case task: list, page, get, create, update, delete
      migration.ts         Rename key ke dokumen task (batch transaksional)
      answerGuard.ts       Muat form, jalankan fieldRules (I/O)
      query/
        filter.ts          Kontrak query + pembangun WHERE, murni
        paging.ts          Leg A/B, COUNT, merge, clamp, murni
        index.ts           Re-export
    form/
      schema.ts            Kontrak form, journal publish, snapshot history, murni
      fieldRules.ts        Aturan jawaban custom field, murni
      keyMigration.ts      Diff rename key, murni
      repo.ts              I/O FormSettings, journal, history
      service.ts           Publish (journal → migrasi → finalisasi atomik), history
  platform/
    cosmos.ts              Client Cosmos + accessor container (I/O)
    batch.ts               TransactionalBatch: potong 100 op, mapping status
    http.ts                Helper respons, CORS, wrapper request, mapping error
    ids.ts                 Guard organizationId / id dari query string
    validate.ts            Parse Zod → nilai bertipe atau ValidationError
  seed.ts                  100 task (kurasi + filler) + form
  infra/
    cosmosTools.ts         Helper wipe/write untuk script
    reseed.ts              Entrypoint wipe + seed
    clear.ts               Entrypoint wipe saja
infra/
  init-db.sh               Buat database + container
  seed.sh                  Entrypoint reseed (wrapper src/infra)
  provision-cosmos.sh      Provision akun Cosmos di Azure
docker-compose.yml         Emulator Cosmos lokal
docs/
  DATA-MODEL.md            Kontrak data, siklus publish, batasan
  PLAN-transactions-and-history.md  Rencana & catatan desain fitur ini
```

`task.schema.json` sudah dihapus. Kontrak hidup di modul Zod (lihat
[docs/DATA-MODEL.md](docs/DATA-MODEL.md)).

## Environment variables

| Variable | Wajib | Default | Fungsi |
| --- | --- | --- | --- |
| `COSMOS_CONNECTION_STRING` | ya | - | Connection string Cosmos (gagal cepat jika kosong) |
| `COSMOS_DATABASE` | tidak | `TaskApp` | Nama database |
| `COSMOS_TASKS_CONTAINER` | tidak | `Tasks` | Nama container task |
| `COSMOS_FORM_SETTINGS_CONTAINER` | tidak | `FormSettings` | Nama container form |
| `COSMOS_FORM_SETTINGS_HISTORY_CONTAINER` | tidak | `FormSettingsHistory` | Nama container riwayat versi form |
| `COSMOS_EMULATOR` | tidak | - | `true` hanya untuk emulator (melonggarkan TLS) |

Connection string hanya dari environment, tidak pernah di-hardcode.
`local.settings.json` di-gitignore, sedangkan `local.settings.example.json`
adalah template yang di-commit. Di Azure, isi sebagai Application Settings (atau Key Vault reference).

## Seeding data

```bash
npm run reseed      # 100 task + form settings
npm run seed:clear  # wipe task organisasi seed, form dipertahankan
```

Seed di `src/seed.ts`: daftar task kurasi ditambah filler ter-generate sampai
total 100, supaya pagination dan daftar panjang bisa dicoba. Semua diparse lewat
skema live sebelum ditulis, jadi perubahan schema membuat seed gagal keras.
Script memakai koneksi Cosmos yang sama dengan API (`local.settings.json`) dan
`COSMOS_EMULATOR=true` untuk menerima sertifikat emulator.

## API reference

Semua route di bawah `/api`, format JSON, dan wajib membawa `organizationId`
(UUID) di query, selain itu 400. Kegagalan mengembalikan `{ "error": "..." }`.

| Method | Route | Query | Body | Sukses | Catatan |
| --- | --- | --- | --- | --- | --- |
| POST | `/api/InsertTask` | `organizationId` | `TaskInput` | 200, `Task` | `status` wajib, dan form FE selalu mengirimnya karena berbentuk select yang terisi `todo`. Server menetapkan `id` dan timestamps, dan jawaban custom field divalidasi ke form |
| GET | `/api/GetTasks` | `organizationId`, opsional `search`, `status` (`todo`\|`in-progress`\|`completed`\|`all`), `priority` (`low`\|`medium`\|`high`\|`all`), `due` (`any`\|`overdue`\|`week`\|`month`\|`none`), `sortKey` (`title`\|`dueDate`\|`requestedDate`), `sortDirection` (`asc`\|`desc`), `page` (≥1), `pageSize` (1–100) | - | Tanpa `page`: 200, `Task[]`. Dengan `page`: 200, `{ items, total, page, pageSize }` | Bentuk lama (seluruh partisi) dipertahankan untuk board dan builder. Parameter `page` mengaktifkan paging server |
| GET | `/api/GetTask` | `id`, `organizationId` | - | 200, `Task` / 404 | |
| POST | `/api/UpdateTask` | `id`, `organizationId` | partial `Task` | 200, `Task` | Patch `add` (upsert path), jadi field baru seperti `position` ikut tertulis. Custom field divalidasi pada hasil gabungan |
| DELETE | `/api/DeleteTask` | `id`, `organizationId` | - | 200 | |
| DELETE | `/api/BulkDeleteTasks` | `organizationId` | `string[]` (1–100 id) | 200 | Satu `TransactionalBatch` (all-or-nothing); 404 pada id yang sudah tidak ada diabaikan |
| GET | `/api/GetFormSettings` | `organizationId` | - | 200, `FormSettings` / 204 | 204 bila organisasi belum punya form |
| PUT | `/api/SaveFormSettings` | `organizationId` | `FormSettings` | 200, `{...FormSettings, migrations}` / 409 | Cek versi → tulis journal → migrasi jawaban → finalisasi atomik (definition + hapus journal) → snapshot history. 409 bila versi salah, publish lain masih jalan, atau kalah balapan `_etag` |
| GET | `/api/GetFormSettingsHistory` | `organizationId`, opsional `version` | - | 200, `{ items: FormSettingsHistory[] }` | Versi terbaru lebih dulu (default 20). `version` mempersempit ke satu snapshot |

Kode errornya, `400` validasi / `organizationId` tidak valid, `404` task tidak ada,
`409` versi form basi atau konflik Cosmos, `429` throttling Cosmos (coba lagi),
`500` tak terduga.

### GetTasks: dua jalur

| Request | SQL | Respons | Dipakai oleh |
| --- | --- | --- | --- |
| tanpa `page` | `SELECT * WHERE c.organizationId = @org` | `Task[]` | Board, form builder, migrasi |
| dengan `page` | filter + `COUNT` + halaman | `{ items, total, page, pageSize }` | Tabel task (search, filter, sort, pagination) |

Paging dengan sort yang bisa kosong (`dueDate`, `requestedDate`) memakai **dua
leg**: satu query terurut untuk task yang punya field tersebut, satu query
`createdAt DESC` untuk sisanya, lalu digabung dengan null di akhir
(`mergeLegSlices`). Cosmos `ORDER BY` hanya menerima path properti, tidak ada
`CASE`/`COALESCE`, sehingga satu query tidak bisa mengurutkan null dengan benar.
SQL-nya diuji lewat unit test (`taskQuery.test.ts`, 24 test) **dan** sudah
diverifikasi terhadap emulator Cosmos dengan data 100 task:

| Kasus | Hasil |
| --- | --- |
| `page=1&pageSize=12` | `total` 100, 12 item |
| `page=9&pageSize=12` | 4 item (halaman terakhir) |
| `page=99` | dijepit ke halaman terakhir |
| `search=safari` | 1 hasil |
| `status=completed` | 31 hasil |
| sort `dueDate` asc/desc | berurutan benar |
| halaman yang melintasi leg A/B | item tanpa `dueDate` tetap di akhir grupnya |
| sort `requestedDate` | berurutan dari `customFields["requested_at"]` |
| sort `title` | abjad A–Z |

Yang belum diuji adalah partisi puluhan ribu dokumen, dan sort `title` dengan kapitalisasi
campur (lihat batasan di bawah).

Batasan yang diketahui, sort `title` di Cosmos bersifat case-sensitive ordinal
sedangkan FE memakai lowercase, sehingga judul dengan kapitalisasi campur bisa
berurutan berbeda.

### Validasi jawaban form

`InsertTask` dan `UpdateTask` memuat form organisasi yang dipublish lalu
menjalankan `validateCustomAnswers`: required, tipe, min/max length, email, dan
batas tanggal. Tujuannya mencegah payload yang tidak melewati browser (curl, JSON
dock export, klien lain) menyimpan jawaban yang dilarang form. Field `disabled`
dikecualikan, sama seperti di FE. Bila organisasi belum punya form, validasi
dilewati.

**Rename key custom field** (`SaveFormSettings`): bila `key` sebuah custom field
berubah (dicocokkan lewat `field.id`), server menyalin nilai dari key lama ke key
baru di seluruh task organisasi **sebelum** form dipublish, dalam
`TransactionalBatch` maksimum 100 operasi. Progres dicatat di journal
`task-form-staging` setelah tiap batch, sehingga publish yang gagal bisa
dilanjutkan tanpa mengulang dari awal. Respons berisi
`migrations: [{ fieldId, key, renamedFrom, migratedTasks }]`.

Contoh:

```bash
ORG="8f14e45f-ceea-4c28-9d6f-2b1c0c4c9d10"

# Buat task. Status wajib, dan form FE mengirim todo secara default
curl -s -X POST "http://localhost:7071/api/InsertTask?organizationId=$ORG" \
  -H "Content-Type: application/json" \
  -d '{"title":"Write docs","status":"todo","description":"Cover local setup","priority":"high","tags":["docs"]}'

# Halaman tabel: search + filter + sort + page
curl -s "http://localhost:7071/api/GetTasks?organizationId=$ORG&page=1&pageSize=12&search=safari&sortKey=dueDate&sortDirection=asc"

# Bentuk lama (seluruh partisi) untuk board/builder
curl -s "http://localhost:7071/api/GetTasks?organizationId=$ORG"

curl -s "http://localhost:7071/api/GetTask?id=<taskId>&organizationId=$ORG"
curl -s -X POST "http://localhost:7071/api/UpdateTask?id=<taskId>&organizationId=$ORG" \
  -H "Content-Type: application/json" -d '{"status":"completed"}'
curl -s -X DELETE "http://localhost:7071/api/DeleteTask?id=<taskId>&organizationId=$ORG"

curl -s -X DELETE "http://localhost:7071/api/BulkDeleteTasks?organizationId=$ORG" \
  -H "Content-Type: application/json" -d '["<id1>","<id2>"]'

curl -s "http://localhost:7071/api/GetFormSettings?organizationId=$ORG"
curl -s -X PUT "http://localhost:7071/api/SaveFormSettings?organizationId=$ORG" \
  -H "Content-Type: application/json" -d @task-form.json

# Riwayat versi form (terbaru dulu), atau satu versi tertentu
curl -s "http://localhost:7071/api/GetFormSettingsHistory?organizationId=$ORG"
curl -s "http://localhost:7071/api/GetFormSettingsHistory?organizationId=$ORG&version=4"
```

Request ditolak:

```bash
curl -s "http://localhost:7071/api/GetTasks?organizationId=nope"
# {"error":"organizationId must be a UUID"}   (HTTP 400)
```

## Model data

Kontrak dibagi dengan FE, dan `src/domain/task/schema.ts`,
`domain/task/query/filter.ts`, serta `domain/form/schema.ts` harus tetap sinkron
dengan `kitameraki-fe/src/contracts/`.

**Task** mengandung field berikut.

- `id` (UUID, dibuat server)
- `organizationId` (partition key)
- `title` (maks 100)
- `description` (maks 1000, boleh kosong)
- `status` (wajib, form FE berbentuk select sehingga default `todo` selalu terkirim)
- `priority` (`low`, `medium`, `high`, boleh kosong)
- `dueDate` (ISO string, boleh kosong)
- `tags[]` (masing-masing maks 50)
- `customFields` (map `string` ke `string` atau `null`, jawaban field dinamis)
- `position` (urutan board, saat ini jarang dipakai karena reorder di FE bersifat visual lokal, field tetap ada di kontrak)
- `createdAt`, `updatedAt`

Contoh respons `GetTask` untuk satu task yang isinya lengkap, memakai seluruh
core field dan seluruh custom field aktif di form saat ini (`client_email`,
`department`, `requested_at`) dengan kombinasi nilai yang memang sering muncul
di data seed.

```json
{
  "id": "a1b2c3d4-e5f6-4a7b-8c9d-000000000024",
  "organizationId": "8f14e45f-ceea-4c28-9d6f-2b1c0c4c9d10",
  "title": "Vendor security review",
  "description": "Third-party data handling, retention windows, and subprocessors.",
  "status": "in-progress",
  "priority": "high",
  "dueDate": "2026-10-31T00:00:00.000Z",
  "tags": ["security", "legal", "vendor"],
  "customFields": {
    "client_email": "legal@acme.io",
    "department": "Security",
    "requested_at": "2026-11-01T10:00:00.000Z"
  },
  "createdAt": "2026-10-18T09:15:00.000Z",
  "updatedAt": "2026-10-24T11:03:00.000Z"
}
```

Dibaca dari sisi FE, `title` jadi baris judul, `status` dan `priority` jadi chip,
`dueDate` jadi label jatuh tempo, `tags` jadi badge, dan ketiga `customFields`
mengisi tiga kolom dinamis di tabel (Client Email, Department, Request date).
Pada task lain `priority`, `dueDate`, atau `requested_at` boleh kosong. Kolomnya
tetap ter-render, hanya isinya yang kosong.

**FormSettings** adalah satu dokumen per organisasi dengan id tetap `task-form`.
Isinya `version`, `title`, `description`, `coreFields[]`, `customFields[]` (ada
7 tipe, yaitu `text`, `textarea`, `select`, `tags`, `date`, `datetime`,
`email`), `rows[]` (maks dua field per baris), dan `updatedAt`.

Tiga skema task turun dari satu dasar, yaitu `taskInputSchema` (body create),
`taskPatchSchema` (patch parsial), dan `taskSchema` (dokumen dan respons).
Detail field, contoh dokumen, dan siklus publish ada di
[docs/DATA-MODEL.md](docs/DATA-MODEL.md).

## Keputusan desain

- **Partition key = `organizationId`.** Semua dokumen satu organisasi berada di
  satu logical partition, dan setiap query mengirim `partitionKey` sehingga Cosmos
  tidak fan-out.
- **Satu schema per entitas**, dipakai bersama request, dokumen tersimpan, dan
  seed.
- **Route tipis, lintas-potong terpusat.** CORS, mapping error, dan log ada di
  `platform/http.ts`; validasi id di `platform/ids.ts`.
- **I/O dipisah dari logika murni** agar pembangun SQL, aturan validasi, dan diff
  rename bisa dites tanpa DB.
- **Client Cosmos dibuat sekali** di `platform/cosmos.ts`, bukan per invocation.
- **Publish form dijurnal, finalisasi atomik.** Cosmos tidak punya transaksi
  lintas container, jadi migrasi jawaban (container `Tasks`) tidak bisa satu
  transaksi dengan publish definisi (container `FormSettings`). Alurnya:
  journal `task-form-staging` → migrasi batch 100 dengan checkpoint → satu
  `TransactionalBatch` di container `FormSettings` yang menukar definisi dan
  menghapus journal (all-or-nothing), lalu snapshot versi ke
  `FormSettingsHistory`. Journal yang tertinggal karena crash boleh dilanjutkan
  (migrasi idempotent) dan dianggap kedaluwarsa setelah 10 menit.
  Snapshot `FormSettingsHistory` ditulis tepat setelah commit finalisasi karena
  berada di container lain; kegagalan di langkah ini hanya di-log dan tidak
  membatalkan versi yang sudah dipublish.
- **Versi tetap dijaga optimistik.** Cek versi dilakukan sebelum journal dibuat,
  dan publish bersamaan dengan versi salah atau journal yang masih hidup
  menghasilkan 409, bukan saling menimpa.
- **Validasi jawaban di server** melengkapi validasi browser, bukan menggantikan
  UX-nya.
- **Indexing default** sudah mencakup filter equality `organizationId`.
- **CORS wildcard.** API anonim tanpa kredensial, jadi header
  `Access-Control-Allow-Origin: *` aman untuk lokal dan pengujian. Ini sengaja
  dipakai supaya FE bisa memanggil API langsung dari dev server tanpa proxy.
  Saat deploy produksi, ganti dengan allowlist origin yang sebenarnya. Tempat
  perubahannya ada di `src/platform/http.ts`.
- **Rate limiting di luar cakupan.** Tempat yang benar adalah gateway (APIM).
- **Tanpa autentikasi** karena tidak diminta brief. Semua route
  `authLevel: "anonymous"`. *Pertanyaan terbuka, apakah JWT dipasang di
  Functions atau auth diletakkan di API Management?* Akibatnya `publishedBy` pada
  snapshot history selalu `null`, karena belum ada identitas pemanggil.

## Scaling

- **Tabel sudah server-side.** `page`/`pageSize` (maks 100), `search`, filter,
  dan sort dikerjakan Cosmos, dan `COUNT` per request memberi `total` untuk
  pagination. Ini jalur yang dipakai tabel task.
- **Board dan builder masih memuat seluruh partisi.** `fetchAllTasks` sengaja
  tanpa `page`. Ini batas berikutnya bila satu organisasi punya ribuan task.
  Board bisa memakai query per status (3 request terpage) alih-alih satu partisi.
- **Paging offset, bukan cursor.** `page=N` memakai `OFFSET`. Halaman dalam masih
  murah di partisi kecil, tetapi terus memindai data sebelumnya. Bila daftar
  tumbuh jauh, pertimbangkan `continuationToken` Cosmos.
- **Sort nullable dua leg** berarti 2–3 query per halaman, jadi pastikan RU/s cukup.
- **Bulk delete** dibatasi 100 id dan dijalankan sebagai satu `TransactionalBatch`
  (batas Cosmos 100 operasi per batch, satu partisi).
- **Rename key membaca seluruh task organisasi**, O(n) per publish. Di atas
  puluhan ribu dokumen, pindahkan ke job background (Durable Functions).
- **Throughput.** Pantau RU/s dan bauran 429. Migrasi dan bulk delete memakai
  `TransactionalBatch` 100 operasi (batas Cosmos per batch dan per partition).
- **Auth.** Saat ditambahkan, `organizationId` harus berasal dari token, bukan
  query string dari klien.

## Testing

```bash
npm test    # Vitest, tanpa database
```

Cakupan: validasi input, guard `organizationId`/`id`, mapping dokumen
(`stripMetadata`, `toTask`), skema task, mapping error wrapper (400/409/429/500 +
CORS preflight), pembangun SQL/paging (`domain/task/query/paging.test.ts`),
aturan jawaban form (`domain/form/fieldRules.test.ts`), diff rename key
(`domain/form/keyMigration.test.ts`), skema journal & snapshot form
(`domain/form/schema.test.ts`), helper `TransactionalBatch`
(`platform/batch.test.ts`), dan **alur publish**
(`domain/form/service.test.ts`: versi bentrok, journal aktif, journal
kedaluwarsa, migrasi rename, finalisasi satu batch, gagal 412 tanpa mengubah
definisi). Berjalan langsung dari source TypeScript dengan container Cosmos
di-fake, tanpa emulator. Integration test otomatis terhadap emulator Cosmos
belum ada; SQL paging sudah diverifikasi manual (lihat
[GetTasks: dua jalur](#gettasks-dua-jalur)).

## Deploy produksi

Targetnya adalah Azure Function App. Set environment variable yang sama sebagai
Application Settings (sebaiknya connection string lewat Key Vault reference).

```bash
az login
./infra/provision-cosmos.sh [resource-group] [location] [account-name]
```

Script membuat akun Cosmos DB SQL serverless, database `TaskApp`, dan container
`Tasks` / `FormSettings` / `FormSettingsHistory` (partition key `/organizationId`), lalu mencetak
connection string.

Alternatif di VPS: `npm run build`, jalankan
`mcr.microsoft.com/azure-functions/node:4-node20` dengan `dist/` ter-mount dan
`COSMOS_CONNECTION_STRING` menunjuk akun asli (emulator hanya untuk development).
Pasang reverse proxy TLS, lalu set `NEXT_PUBLIC_API_BASE_URL` di frontend ke URL
`/api` hasil deploy.
