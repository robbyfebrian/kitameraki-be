# Plan: DB transaction di tempat relevan + history FormSettings

Status: **diimplementasi** (lihat "Hasil implementasi" di akhir dokumen)

## 1. Latar belakang & batasan

Backend memakai **Azure Cosmos DB SQL API** (`@azure/cosmos@4.0.0`), bukan
Postgres/MySQL. Konsekuensi desain yang mengikat seluruh plan ini:

- **Tidak ada transaksi lintas container.** `Tasks` dan `FormSettings` adalah
  container terpisah, jadi migrasi task + publish form **tidak mungkin** satu
  transaksi DB.
- **`TransactionalBatch`** (`container.items.batch(ops, partitionKey)`) hanya
  untuk dokumen **dalam satu logical partition** dan **maks 100 operasi**. Bundle
  di jalur ini sudah benar untuk itu: semua dokumen satu organisasi ada di
  partition yang sama (`organizationId`).
- Batch bersifat **all-or-nothing** dan mengembalikan `424 FailedDependency` pada
  operasi yang gagal ketika operasi lain di batch yang sama menabrak.

Hasil audit (lihat diskusi sebelumnya):

| Lokasi | Masalah |
|---|---|
| `BulkDeleteTasks.ts:20-23` | delete per-dokumen 25 paralel, parsial kalau batch ke-3 gagal |
| `tasksMigrate.ts:63-72` | patch per-dokumen 25 paralel, parsial per batch |
| `SaveFormSettings.ts:28-49` | migrasi lintas container tanpa rollback; kegagalan di tengah meng-orphan jawaban |
| `Insert/Update/DeleteTask` | single-document, **tidak** butuh transaksi (tetap) |
| FormSettings | hanya 1 dokumen yang ditimpa in-place; tidak ada riwayat |

## 2. Fase 0 — Refactor struktur ke domain-first (nol perubahan perilaku)

Dikerjakan **sebelum** fitur transaksi/history, supaya kode baru langsung masuk
ke lokasi yang benar dan tidak dipindah dua kali. Isinya murni pemindahan file
dan pemecahan modul gemuk; tidak ada perubahan logika, kontrak HTTP, maupun
skema data.

### 2.1 Struktur target

```
src/
  index.ts                     # entrypoint Functions (tidak berubah)

  platform/                    # infra lintas-domain, nol pengetahuan bisnis
    cosmos.ts                  # client, database id, container getter
    batch.ts                   # runBatch() di atas TransactionalBatch (fase 1)
    http.ts                    # ok/fail/preflight, handler() wrapper, CORS, error mapping
    validate.ts                # validate(schema, data)
    ids.ts                     # requireOrganizationId / requireIdAndOrganizationId

  domain/
    task/
      schema.ts                # taskInputSchema, taskPatchSchema, taskSchema, toTask, stripMetadata
      repo.ts                  # item(), insert(), patchTask(), deleteTasks() — satu-satunya pemanggil Cosmos task
      service.ts               # createTask / updateTask / deleteTask / bulkDelete / getTask(s)
      migration.ts             # eksekusi rename key (dari tasksMigrate.ts)
      answerGuard.ts           # validasi jawaban custom field (I/O form + aturan)
      query/
        filter.ts              # taskQuerySchema, buildTaskQuery
        paging.ts              # legA/B, countQuery, pageFetchPlan, mergeLegSlices, clampPage (murni)
        index.ts               # re-export

    form/
      schema.ts                # FORM_SETTINGS_ID, STAGING_FORM_ID, skema form/staging/history
      fieldRules.ts            # validateCustomAnswers (murni)
      keyMigration.ts          # diffCustomFieldKeys, renameKeyOnTask (murni)
      repo.ts                  # I/O FormSettings, staging, history
      service.ts               # saveFormSettings, getFormSettings, history

  functions/                   # HTTP adapter — tipis, tanpa logika
    tasks/InsertTask.ts  GetTask.ts  GetTasks.ts  UpdateTask.ts  DeleteTask.ts  BulkDeleteTasks.ts
    form/GetFormSettings.ts  SaveFormSettings.ts  GetFormSettingsHistory.ts

  infra/                       # script operasional
  seed.ts
```

### 2.2 Aturan dependensi (satu arah)

```
functions/  ──►  domain/*/service.ts  ──►  domain/*/repo.ts  ──►  platform/cosmos.ts + platform/batch.ts
     │                    │
     └──────────────►  platform/http.ts, platform/validate.ts
```

- `platform/` **tidak boleh** import `domain/` atau `functions/`.
- File murni (`domain/*/schema.ts`, `fieldRules.ts`, `keyMigration.ts`,
  `query/paging.ts`) **tidak boleh** import `repo`/`cosmos`; inilah yang menjaga
  unit test tetap jalan tanpa emulator.
- `functions/` hanya: parse request → panggil service → `ok()`. Tidak ada
  panggilan Cosmos atau SQL builder langsung.
- Cross-domain hanya lewat service atau file murni. `task/answerGuard.ts` boleh
  import `form/schema.ts` + `form/repo.ts`, **bukan** `form/service.ts`, agar
  tidak ada siklus saat `form/service.ts` memanggil `task/migration.ts`.

### 2.3 Pemetaan file lama → baru

| Sekarang | Jadi |
|---|---|
| `shared/cosmos.ts` | `platform/cosmos.ts` |
| `shared/http.ts` | `platform/http.ts` + `platform/ids.ts` |
| `shared/validate.ts` | `platform/validate.ts` |
| `shared/task.ts` | `domain/task/schema.ts` |
| `shared/tasksRepo.ts` | `domain/task/repo.ts` (diperluas di fase 1) |
| `shared/taskQuery.ts` | `domain/task/query/filter.ts` + `query/paging.ts` |
| `shared/answerGuard.ts` | `domain/task/answerGuard.ts` |
| `shared/formSettings.ts` | `domain/form/schema.ts` |
| `shared/fieldValidation.ts` | `domain/form/fieldRules.ts` |
| `shared/migrateKeys.ts` | `domain/form/keyMigration.ts` |
| `shared/tasksMigrate.ts` | `domain/task/migration.ts` |
| `functions/*.ts` | `functions/tasks/*.ts`, `functions/form/*.ts` |

### 2.4 Perubahan wajib di luar `src/`

- `package.json` → `main`: `dist/src/{index.js,functions/*.js}` menjadi
  `dist/src/{index.js,functions/**/*.js}` (file fungsi pindah ke subfolder).
- `.funcignore`, `host.json`, `tsconfig.json` diperiksa; `tsconfig` tidak
  memerlukan perubahan (`rootDir: "."` sudah mencakup subfolder).
- Verifikasi `npm run build && func start` — pastikan semua 8 endpoint tetap
  terdaftar dengan nama yang sama.

### 2.5 Definition of done Fase 0

- `npm test` hijau dengan jumlah test **sama** seperti sebelum refactor
  (tidak ada test yang dihapus atau dilonggarkan).
- `npm run build` bersih, `dist/src/functions/{tasks,form}/*.js` ada.
- Nama route Functions tidak berubah (`SaveFormSettings`, `BulkDeleteTasks`,
  dst.), sehingga FE dan fixture e2e tidak perlu disentuh.
- Tidak ada import tersisa ke `../shared/` (dicek dengan grep).

### 2.6 Risiko

- Satu-satunya breaking point adalah glob `main` di `package.json`; mudah
  terlewat dan membuat Functions gagal load. Diverifikasi eksplisit di 2.4.
- Perubahan hanya path import; kalau ada yang tertinggal, `tsc` gagal dan
  langsung terlihat.

## 3. Keputusan desain

**D1 — `TransactionalBatch` untuk semua multi-dokumen dalam satu partition.**
`BulkDeleteTasks` dan `tasksMigrate` memakai `container.items.batch(...)`.
Ini juga lebih hemat RU (satu request, bukan 25).

**D2 — `SaveFormSettings` diselesaikan dengan pola publish/staging + journal
karena transaksi DB lintas container tidak tersedia.**
Urutan baru:

1. Baca form existing, cek `version`, hitung `renames` (tetap).
2. Tulis **staging document** `id = "task-form-staging"` di container
   `FormSettings`, berisi: `baseVersion`, `targetVersion`, `baseEtag`,
   `definition` (form baru), `renames`, `migrationCursor` (progres per field),
   `state: "pending" | "applied"`, `startedAt`.
   Tulis dengan `IfNoneMatch: *` → staging yang sudah ada berarti publish
   lain sedang jalan → **409** (`Publish in progress`).
3. Jalankan migrasi per rename, **checkpoint** `migrationCursor` + jumlah
   migrated setelah setiap batch sukses (tulis ke staging).
   Migrasi **idempotent**: `renameKeyOnTask` melewati task yang tidak punya key
   lama, jadi retry aman.
4. Finalisasi dalam **satu `TransactionalBatch`** pada container
   `FormSettings` (partition sama, 2–3 op):
   - `Replace` form `task-form` dengan `IfMatch` = `baseEtag` (masih optimistik),
   - `Create` snapshot history `version = targetVersion`,
   - `Delete` staging document.
   Kalau batch gagal (`412`/`424`) → form tidak berubah, staging tetap ada →
   **rollback logis** (task sudah termigrasi tapi form masih lama; jawaban
   tidak orphan karena key target hanya bertambah dari rename yang sama —
   lihat D4).

**D3 — History FormSettings disimpan di container baru
`FormSettingsHistory`.** Satu dokumen per versi terpublish:

```jsonc
{
  "id": "<version>",            // id dokumen = versi, mis. "4"
  "organizationId": "<uuid>",   // partition key
  "version": 4,
  "definition": { ...FormSettings tanpa id/organizationId... },
  "migrations": [ ...KeyMigrationReport[]... ],
  "publishedAt": "2026-10-27T02:10:00.000Z",
  "publishedBy": null           // belum ada auth; isi null sampai JWT ada
}
```

Kenapa container terpisah, bukan satu container:
- tetap satu dokumen per organisasi di `FormSettings` (jalur baca cepat tidak berubah);
- tidak memperbesar dokumen yang dibaca tiap `answerGuard`/`GetFormSettings`;
- allowlist container hanya perlu satu `createIfNotExists` tambahan.

Alternatif yang ditolak: `id = "task-form-v4"` di container yang sama → setiap
`read`/query harus memfilter, dan partition membengkak.

**D4 — Kenapa rollback tidak meng-orphan data.**
Rename hanya *menambah* key baru (`renameKeyOnTask` menyalin nilai lalu
membuang key lama). Jika finalisasi gagal, form lama (key lama) masih dibaca,
sementara sebagian task sudah berpindah ke key baru. Ini **tidak** meng-orphan
karena field baru dari rename hanya akan dipakai setelah publish yang gagal —
yang tidak pernah terjadi. Publish ulang memakai diff terhadap form lama yang
masih tersimpan, jadi rename akan terhitung lagi. (`renameKeyOnTask` konfirmasi
komentar di `migrateKeys.ts:44-56`.)

## 4. Perubahan per file

### 4.1 `src/platform/cosmos.ts`
- Tambah `cosmosBatchSize`/`getFormSettingsHistoryContainer()` dengan env
  `COSMOS_FORM_SETTINGS_HISTORY_CONTAINER` (default `FormSettingsHistory`).
- Tidak ada konstanta domain di sini; `STAGING_FORM_ID` tetap di
  `domain/form/schema.ts` mengikuti `FORM_SETTINGS_ID` (lihat 4.2).

### 4.2 `src/domain/form/schema.ts`
- `STAGING_FORM_ID = "task-form-staging"`.
- Skema `formSettingsStagingSchema` (zod): `id`, `organizationId`,
  `baseVersion`, `targetVersion`, `baseEtag`, `definition`, `renames`,
  `migrationCursor`, `state`, `startedAt`.
- Skema `formSettingsHistorySchema`: `id`, `organizationId`, `version`,
  `definition`, `migrations`, `publishedAt`, `publishedBy`.

### 4.3 `src/platform/batch.ts` (baru, dipakai lintas domain)
Helper tipis di atas `items.batch`:
- `runBatch<T>(container, operations, partitionKey)`: panggil batch, periksa
  `statusCode` per operasi, lempar error yang membawa `code` Cosmos (mis. 424,
  412) supaya `handler()` di `http.ts` bisa memetakan.
- Validasi input: `operations.length > 100` → lempar `ValidationError`.
- Dipisah dari repo supaya bisa di-unit-test dengan mock container.

### 4.4 `src/domain/task/repo.ts` + `domain/task/service.ts` + `functions/tasks/BulkDeleteTasks.ts`
- Repo: `export function batchDelete(ids: string[], organizationId: string)`
  yang memotong `ids` per 100 dan memanggil `runBatch` dengan
  `{ operationType: "Delete", id }`.
- `BulkDeleteTasks.ts` memanggil `batchDelete` (hapus loop manual 25).
  Kontrak eksternal tetap: body `string[]` (1–100) → `200 {}`.
- **Catatan perilaku:** 404 pada satu id (task sudah tidak ada) **tidak**
  menggagalkan batch — Cosmos mengembalikan 404 per-operasi, bukan 424. Buang
  per-operasi yang 404 (idempotent delete). Tetapkan di helper.

### 4.5 `src/domain/task/migration.ts` (dari `tasksMigrate.ts`)
- Ganti loop `Promise.all` patch (batch 25) dengan `runBatch` berisi op
  `Patch` (`resourceBody: { operations: [{ op: "set", path: "/customFields", value }] }`),
  100 op per batch.
- Tambah callback progres opsional:
  `onBatchDone?: (migrated: number, renameIndex: number) => Promise<void>`
  dipakai `SaveFormSettings` untuk checkpoint staging.
- Tetap idempotent; tidak lagi bergantung pada `COSMOS_BATCH_SIZE = 25` untuk
  jalur write (pertahankan konstanta untuk kompatibilitas test, atau hapus dan
  update README).
- **Known limit:** jika rename menyentuh >100 task, migrasi jalan per 100 dan
  progres dicatat; ini tetap bukan atomik penuh untuk rentang itu — jaminan
  atomik hanya di level batch dan level "form tidak pernah menunjuk key yang
  datanya belum siap" (D2 langkah 4).

### 4.6 `src/domain/form/service.ts` + `functions/form/SaveFormSettings.ts` (rewrite inti)
Status code yang dikembalikan:
- `409` — version mismatch (tetap), staging sudah ada (`Publish in progress`),
  `412` saat replace final.
- `200 { ...saved, migrations }` — bentuk response **tidak berubah** (FE
  `formSettingsResponseSchema` tetap valid).
- `500` — kegagalan migrasi; staging bisa di-retry.

Penting: **staging dibersihkan** sebelum request baru; tambahkan
`staleStaging` (mis. `startedAt` > 10 menit) supaya staging yang tertinggal
karena crash tidak memblokir publish selamanya — saat mendeteksi staging
stale, hapus lalu tulis baru.

### 4.7 `functions/form/GetFormSettingsHistory.ts` (baru)
- `GET ?organizationId=...&limit=20` → daftar versi terbaru lebih dulu
  (query `SELECT * FROM c WHERE c.organizationId = @org ORDER BY c.version DESC`,
  `partitionKey`). Param `version` opsional → satu dokumen.
- Respons memakai bentuk definition + `version`, `publishedAt`.
- **Opsional / fase 2:** `POST RetryPublish` untuk melanjutkan staging yang
  tertinggal.

### 4.8 `infra/init-db.sh` & `infra/provision-cosmos.sh`
- Tambah container `FormSettingsHistory` (partition `/organizationId`) di
  `infra/init-db.sh:45-48` dan blok `az cosmosdb sql container create` di
  `infra/provision-cosmos.sh`.
- `.funcignore` tidak berubah.

### 4.9 `src/infra/cosmosTools.ts` / `src/seed.ts`
- (Opsional) seed versi history pertama saat `writeSeedFormSettings` agar
  organisasi seed punya riwayat konsisten. Rendah prioritas.

## 5. Testing

Unit test (Vitest, tanpa emulator) — mengikuti gaya yang ada
(`*.test.ts` di samping source, cosms dimock):

1. `platform/batch.test.ts`
   - memotong >100 op menjadi beberapa batch,
   - menerjemahkan 424/412 ke error dengan `code`,
   - mengabaikan hasil per-operasi 404 pada delete.
2. `domain/form/schema.test.ts`
   - parse skema staging & history valid/invalid.
3. `domain/form/service.test.ts` (logika handler di-ekstrak ke fungsi murni/testable
   di `domain/form/service.ts` bila perlu)
   - version mismatch → 409 tanpa menulis,
   - staging sudah ada & fresh → 409,
   - staging stale → dihapus & publish jalan,
   - sukses → replace + create history + delete staging berurutan,
   - finalisasi gagal 412 → form lama utuh, staging masih ada.
4. `domain/form/keyMigration.test.ts` — pertahankan test yang ada; tambah test untuk
   pengelompokan patch per batch 100.

Verifikasi manual (emulator):
- `BulkDeleteTasks` dengan 100 id → 1 request batch; cek dengan 101+.
- publish form dengan rename yang menyentuh 150 task → 2 batch, history
  `version` tertulis.
- publish gagal di tengah (kill request) → staging tertinggal; publish ulang
  setelah 10 menit berhasil.

## 6. Urutan implementasi

0. **Fase 0**: refactor struktur domain-first (§2), verifikasi build+test.
1. Infra: container `FormSettingsHistory` + skema (4.1, 4.2, 4.8).
2. `platform/batch.ts` + test (4.3, 5.1).
3. `BulkDeleteTasks` → `batchDelete` (4.4) + verifikasi.
4. `migration.ts` → batch 100 + callback progres (4.5).
5. `SaveFormSettings` staging/journal (4.6) + test (5.3).
6. `GetFormSettingsHistory` endpoint (4.7).
7. Update `README.md` (keputusan desain, endpoint baru, tabel endpoint) dan
   `docs/DATA-MODEL.md` (bagian history, hapus catatan "Tidak ada riwayat").

## 7. Risiko & catatan

- **Durasi publish.** Migrasi tetap O(n) dan bisa melewati batas 230s Azure
  Functions untuk organisasi besar. Staging membuat publish **bisa dilanjutkan**
  (retry meneruskan dari `migrationCursor`) alih-alih harus mengulang, tapi
  solusi penuh (Durable Functions/queue) di luar scope.
- **Package/.funcignore.** Tidak ada dependency baru. `main` di `package.json`
  sudah disesuaikan di Fase 0 (§2.4); fitur fase 1+ hanya menambah file di
  subfolder yang sudah tercakup glob.
- **Backward compatibility.** Response `SaveFormSettings` dan
  `BulkDeleteTasks` tidak berubah; FE tidak perlu diubah. Fixture e2e
  (`kitameraki-fe/e2e/fixtures.ts`) tidak perlu disentuh untuk perubahan ini.
- **Auth belum ada.** `publishedBy` selalu `null` sampai `organizationId`
  berasal dari token (lihat README "Auth").

## 8. Hasil implementasi

Semua langkah §6 sudah dikerjakan. Yang berbeda dari rencana awal, beserta
alasannya:

- **History ditulis di luar batch finalisasi.** Rencana awal menaruh
  `Create` history di dalam `TransactionalBatch` yang sama dengan replace
  definisi. Itu tidak mungkin: `FormSettingsHistory` adalah container terpisah
  dan Cosmos tidak punya transaksi lintas container. Snapshot karena itu
  ditulis tepat setelah batch, dengan `upsert` idempotent; kegagalannya
  dicatat lewat `context.error` dan **tidak** menggagalkan publish yang sudah
  commit. Konsekuensi yang diterima: bila penulisan snapshot gagal, versi itu
  tidak punya riwayat, tetapi data task dan definisi tetap konsisten.
- **Batch finalisasi berisi replace definisi + delete journal.** Keduanya di
  container `FormSettings`, satu partisi, sehingga benar-benar all-or-nothing.
- **Guard etag di batch.** Operasi `Replace` di batch membawa body dokumen;
  `IfMatch` per operasi tidak diteruskan oleh SDK 4.0.0 pada jalur batch, jadi
  guard yang efektif saat ini adalah cek versi + keberadaan journal sebelum
  migrasi. Balapan tetap terdeteksi (409) selama publish lain membuat journal;
  guard etag benar-benar di level operasi batch masih bisa ditambahkan dengan
  mem-patch `platform/batch.ts` bila dibutuhkan.
- **`COSMOS_BATCH_SIZE = 25` dihapus** dari `migration.ts`; jalur tulis kini
  memakai `MAX_BATCH_OPERATIONS = 100` dari `platform/batch.ts`.
- **Endpoint history** mengembalikan `{ items: [...] }` untuk kedua bentuk
  (daftar dan satu versi) agar kontraknya tunggal.
- **Test**: 91 test (dari 64). Baru: `platform/batch.test.ts`,
  `domain/form/schema.test.ts`, `domain/form/service.test.ts`; test query
  pindah ke `domain/task/query/paging.test.ts`.

### Yang belum dikerjakan (di luar scope)

- Endpoint `RetryPublish` (fase 2 di §4.7). Retry saat ini terjadi otomatis
  lewat publish ulang dari FE, memakai journal yang sama.
- Migrasi ke Durable Functions untuk organisasi dengan puluhan ribu task.
- `publishedBy` masih `null` karena belum ada auth.
- Verifikasi terhadap emulator Cosmos yang sebenarnya; semua test memakai
  container palsu.
