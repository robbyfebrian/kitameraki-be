# Model data

Dua container Cosmos DB (SQL API), keduanya ber-partition key `/organizationId`.
Sumber kebenaran adalah skema Zod di `src/domain/`. Ia dibagi dengan
`kitameraki-fe/src/contracts/`, dan keduanya harus tetap sinkron. `task.schema.json` sudah
dihapus agar tidak ada dua sumber kebenaran.

| Container | Dokumen | Item id | Partisi |
| --- | --- | --- | --- |
| `Tasks` | Satu per task | `randomUUID()` | `organizationId` |
| `FormSettings` | Satu per organisasi | tetap `task-form` | `organizationId` |

## Alur data

```
FormSettings                     Task
  coreFields[]   ──────────┐       title, description, status, priority,
  customFields[] ──────────┼──────► dueDate, tags
     key, type, label      │       │
     required, visible     │       └─ customFields { <key>: value | null }
     width, order          │            ▲
  rows[]  (layout)         │            │ nilai disimpan per `key` field
     [id, fieldIds[]]      │            │
                           ▼            │
                    DynamicForm  ───────┘
```

- **Pemisahan peran.** `FormSettings` menentukan bentuk form dan kolom tabel,
  dan `Task` hanya menyimpan nilai.
- **Nilai custom field disimpan per `key`** di `Task.customFields`, bukan di
  array. Karena itu rename key butuh migrasi (lihat di bawah).
- **Jawaban divalidasi di dua sisi.** Klien memvalidasi untuk UX, server
  memvalidasi ulang lewat `domain/task/answerGuard.ts` + `domain/form/fieldRules.ts` saat
  `InsertTask`/`UpdateTask`, supaya payload yang tidak melewati browser tidak
  bisa menyimpan jawaban yang dilarang form. `UpdateTask` menilai hasil gabungan
  (dokumen tersimpan + patch), bukan patch parsial.

## Task

`src/domain/task/schema.ts`

```ts
taskSchema = {
  id: string                       // UUID, dibuat server
  organizationId: string           // partition key, dari query
  title: string                    // 1..100
  description?: string             // <= 1000
  status: "todo" | "in-progress" | "completed"   // wajib, FE default todo
  priority?: "low" | "medium" | "high"
  dueDate?: string                 // ISO string
  tags?: string[]                  // tiap tag <= 50
  customFields: Record<string, string | null>    // default {}
  position?: number                // urutan di board
  createdAt?: string
  updatedAt?: string
}
```

Tiga skema turunan dari satu dasar:

| Skema | Dipakai | Perbedaan |
| --- | --- | --- |
| `taskInputSchema` | Body `InsertTask` | Wajib `title` dan `status`, sisanya opsional, tidak ada `id`/timestamp |
| `taskPatchSchema` | Body `UpdateTask` | Turunan parsial dari input, patch boleh sebagian |
| `taskSchema` | Dokumen tersimpan + respons | Menambah `id`, `organizationId`, wajib `status`, default `customFields` |

Catatan perilaku validasi

- `status` wajib ada di request, dan server menolak status yang tidak dikenal
  dengan 400. Form FE selalu mengirimnya karena berbentuk select yang sudah
  terisi `todo`, jadi tidak ada jalur normal yang mengirim status kosong.
- `customFields` boleh `null` untuk menandai "dikosongkan", berbeda dari key yang
  tidak ada ("tidak pernah diisi").
- `position` hanya dipakai board, dan saat ini jarang ditulis karena reorder di FE bersifat visual lokal. Task tanpa `position` diurutkan paling akhir.

Metadata sistem Cosmos (`_rid`, `_etag`, `_ts`, `_self`, `_attachments`)
dibuang oleh `stripMetadata()` sebelum respons dikirim, lalu hasilnya diparse
ulang dengan `taskSchema` (`toTask`). Jadi bentuk respons dijamin sama dengan
kontrak meskipun dokumen di DB punya field ekstra.

## FormSettings

`src/domain/form/schema.ts`

```ts
formSettingsSchema = {
  id: "task-form"                  // literal, satu dokumen per organisasi
  organizationId: string
  version: number                  // optimistic concurrency, naik 1 tiap save
  title: string
  description: string
  coreFields: CoreField[]          // field bawaan task
  customFields: FormField[]        // field tambahan
  rows: { id: string, fieldIds: string[] }[]   // layout, maks 2 per baris
  updatedAt: string
}
```

### CoreField

Field bawaan Task. Tidak bisa dihapus, hanya disembunyikan/diubah labelnya.

| Field | Keterangan |
| --- | --- |
| `key` | Salah satu: `title`, `description`, `status`, `priority`, `dueDate`, `tags` |
| `label` | Teks yang tampil |
| `visible` | `false` = disembunyikan dari form |
| `width` | `1` (setengah baris) atau `2` (penuh) |
| `order` | Urutan bersama custom field (opsional, kompatibilitas data lama) |

### FormField (custom field)

| Field | Wajib | Keterangan |
| --- | --- | --- |
| `id` | ya | Identitas stabil, dipakai sebagai kunci migrasi saat rename |
| `key` | ya | Kunci di `Task.customFields` |
| `label` | ya | Label tampil |
| `type` | ya | `text`, `textarea`, `select`, `tags`, `date`, `datetime`, `email` |
| `required` | ya | Divalidasi di klien dan di server, field `disabled` dikecualikan |
| `width` | ya | `1` atau `2` |
| `active` | ya | Field yang dihapus dari builder tidak benar-benar dihapus, hanya diset `active: false` (soft delete). Nilai yang sudah tersimpan di `Task.customFields` tetap ada dan ikut terbaca saat field diaktifkan kembali, dan field `active: false` dikecualikan dari validasi |
| `order` | tidak | Urutan pada daftar gabungan |
| `placeholder`, `description`, `defaultValue` | tidak | Tampilan |
| `validationMessage` | tidak | Pesan error kustom |
| `disabled`, `readOnly` | tidak | Field tidak bisa diisi, nilai lama tetap disimpan |
| `prefix`, `suffix` | tidak | Untuk `text`/`email` |
| `minLength`, `maxLength` | tidak | Untuk `text` |
| `minDate`, `maxDate`, `disablePast`, `disableFuture` | tidak | Untuk `date`/`datetime` |
| `timeFormat` | tidak | `12h` atau `24h`, hanya untuk tampilan, input tetap mengikuti locale browser |
| `options` | tidak | Untuk `select`/`tags` |

Urutan kanoniknya, `coreFields` dan `customFields` disatukan menjadi satu
daftar yang bisa diurutkan ulang. `order` dipakai bila ada, kalau tidak memakai urutan array.

### Rows

`rows[]` menyimpan layout baris. `fieldIds` mengacu ke `customFields[].id` dan
`coreFields[].key`, maksimal dua field per baris. Preview, create dialog, dan
edit drawer di FE memakai renderer yang sama (`DynamicForm`).

## Siklus save dan versi

```
GET  GetFormSettings ──► 200 { version: N }  atau  204 (belum ada)
          │
          ▼ (user edit + publish)
PUT  SaveFormSettings  { version: N, ... }
          │
          ├─ version != N  ─────────────────────────► 409 (edit lain menang)
          ├─ journal publish masih hidup, bukan stale ► 409 (publish berjalan)
          ├─ diff customFields by id → rename
          │     └─ tulis journal task-form-staging { renames, cursor }
          │     └─ migrate jawaban per batch 100 + checkpoint cursor
          ├─ satu TransactionalBatch di container FormSettings:
          │     replace { version: N+1 } + delete journal
          │     gagal 412/409 ──────────────────────► 409 (definisi tidak berubah)
          └─ upsert snapshot FormSettingsHistory (version N+1)
                (container terpisah, di luar batch)
                     ─────────────────────────────► 200 { ..., migrations[] }
```

Rename dideteksi dari `field.id` (bukan dari label), sehingga label bebas berubah tanpa
menyentuh data. Field yang hilang dari definisi tidak ikut dimigrasi, nilainya
tetap di dokumen sehingga penambahan kembali key yang sama "menghidupkan" jawaban
lama.

### Kenapa dijurnal

Cosmos DB tidak punya transaksi lintas container: migrasi jawaban menulis ke
container `Tasks`, sedangkan definisi form hidup di `FormSettings`. Tanpa
journal, kegagalan di tengah migrasi akan meninggalkan sebagian jawaban sudah
dipindah ke key baru sementara form lama (key lama) masih dipublish — jawaban itu
jadi tidak terbaca.

Journal `task-form-staging` (di container `FormSettings`, partition organisasi
yang sama) mencatat definisi yang dimaksud, daftar rename, dan `cursor` progres.
Finalisasi mengganti definisi dan menghapus journal dalam **satu
`TransactionalBatch`**, jadi hasilnya all-or-nothing. Bila migrasi gagal,
publish ulang melanjutkan dari `cursor` (rename bersifat additive dan
idempotent). Journal yang lebih tua dari 10 menit dianggap kedaluwarsa supaya
worker yang crash tidak memblokir publish selamanya.

### Riwayat versi

Setiap versi yang berhasil dipublish ditulis sebagai satu dokumen di container
`FormSettingsHistory` (`id` = versi, partition `organizationId`):

```jsonc
{
  "id": "4",
  "organizationId": "<uuid>",
  "version": 4,
  "definition": { "version": 4, "title": "...", "coreFields": [...], "customFields": [...], "rows": [...] },
  "migrations": [{ "fieldId": "c1", "key": "client_mail", "renamedFrom": "client_email", "migratedTasks": 12 }],
  "publishedAt": "2026-10-27T02:10:00.000Z",
  "publishedBy": null
}
```

`GET /api/GetFormSettingsHistory` mengembalikan 20 versi terbaru, atau satu
snapshot bila `version` dikirim. Snapshot ditulis tepat setelah finalisasi
commit; kegagalan menulis snapshot dicatat di log tetapi tidak menggagalkan
publish yang sudah tersimpan.

## Contoh dokumen

`Tasks`:

```json
{
  "id": "a1b2c3d4-e5f6-4a7b-8c9d-000000000001",
  "organizationId": "8f14e45f-ceea-4c28-9d6f-2b1c0c4c9d10",
  "title": "Migrate onboarding checklist",
  "description": "Update 14 legacy steps and remove the duplicated welcome email.",
  "status": "in-progress",
  "priority": "high",
  "dueDate": "2026-10-24T00:00:00.000Z",
  "tags": ["onboarding", "legacy", "copy"],
  "customFields": {
    "client_email": "sara.k@acme.io",
    "department": "Platform",
    "requested_at": "2026-10-23T09:30:00.000Z"
  },
  "createdAt": "2026-10-01T09:15:00.000Z",
  "updatedAt": "2026-10-01T09:15:00.000Z"
}
```

`FormSettings`:

```json
{
  "id": "task-form",
  "organizationId": "8f14e45f-ceea-4c28-9d6f-2b1c0c4c9d10",
  "version": 15,
  "title": "Task Form",
  "description": "Fields are applied to every task.",
  "coreFields": [
    { "key": "title", "label": "Title", "visible": true, "width": 2 },
    { "key": "status", "label": "Status", "visible": true, "width": 1 }
  ],
  "customFields": [
    {
      "id": "c1",
      "key": "client_email",
      "label": "Client Email",
      "type": "email",
      "required": true,
      "width": 1,
      "active": true
    }
  ],
  "rows": [{ "id": "row-1", "fieldIds": ["c1"] }],
  "updatedAt": "2026-10-27T02:10:00.000Z"
}
```

## Migrasi & batasan

- **Rename key** mengganti nama key pada dokumen task (nilai disalin, key lama
  dihapus). Definisi form punya riwayat, tetapi nilai jawaban task tidak: hanya
  key barunya yang tersimpan, jadi backup tetap disarankan sebelum publish besar.
- **Tipe field tidak bisa diubah** setelah ada nilai task, dijaga di UI, bukan
  di server.
- **Field dihapus/nonaktif** tidak memvalidasi nilai tersimpan, tetapi nilai tetap ada.
- **Integration test otomatis terhadap Cosmos belum ada.** SQL paging paling
  rumit sudah diverifikasi manual pada emulator dengan data 100 task (lihat
  README, subbab GetTasks dua jalur), sedangkan sisanya dijamin unit test.
