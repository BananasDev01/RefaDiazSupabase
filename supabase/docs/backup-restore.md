# Backup And Restore Runbook

This repository now includes operational backup tooling for:

- `public` schema data (`pg_dump` custom format, daily)
- Supabase Storage buckets (`products`, `brands`, `radiators`, `providers`, `car-models`, `vehicle-notes`) every 3 days
- Google Shared Drive as the external retention layer

Supabase managed backups remain the first option for fast point-in-time recovery on the current production project. The scripts in this repo add a portable backup path for disaster recovery into a different project.

## Files Added

- `.github/workflows/backup-db.yml`
- `.github/workflows/backup-storage.yml`
- `scripts/backups/db-backup.js`
- `scripts/backups/storage-backup.js`
- `scripts/backups/db-restore.js`
- `scripts/backups/storage-restore.js`
- `scripts/backups/google-drive.js`
- `scripts/backups/cadence-check.js`

## Required GitHub Secrets

- `DATABASE_URL`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `SHARED_DRIVE_ID`
- `GOOGLE_SERVICE_ACCOUNT_JSON`

Optional:

- `DRIVE_ROOT_FOLDER_ID`

`DRIVE_ROOT_FOLDER_ID` is useful if your Shared Drive root cannot be addressed directly with the drive id in your Google Workspace setup. If omitted, the scripts try to use `SHARED_DRIVE_ID` as the parent for the top-level `refadiaz-backups` folder.

## Backup Layout In Google Drive

Top-level folder:

```text
refadiaz-backups/
  db/YYYY/MM/DD/
    refadiaz-public-<timestamp>.dump
    manifest.json
  storage/YYYY/MM/DD/
    manifests/
      bucket-manifest.json
      run-manifest.json
    products/
      products-<timestamp>.tar.gz
      products-manifest.json
    brands/
      brands-<timestamp>.tar.gz
      brands-manifest.json
    radiators/
      radiators-<timestamp>.tar.gz
      radiators-manifest.json
    providers/
      providers-<timestamp>.tar.gz
      providers-manifest.json
    car-models/
      car-models-<timestamp>.tar.gz
      car-models-manifest.json
    vehicle-notes/
      vehicle-notes-<timestamp>.tar.gz
      vehicle-notes-manifest.json
```

Retention defaults:

- DB backups: 30 days
- Storage backups: 90 days

Cleanup only runs after a successful upload. Failed runs leave older backups untouched.

## Workflow Schedule

- DB backup: `08:00 UTC` daily, which maps to `02:00` in `America/Monterrey`
- Storage backup workflow trigger: `09:00 UTC` daily
- Storage backup execution: only every 3 days, enforced by `scripts/backups/cadence-check.js`

The storage cadence anchor is `2026-03-10`. Change `CADENCE_ANCHOR_DATE` in `.github/workflows/backup-storage.yml` if you want the 3-day cycle to start on a different date.

## Local Backup Commands

DB backup to local disk only:

```bash
DATABASE_URL="postgresql://..." \
node scripts/backups/db-backup.js --skip-upload true
```

Storage backup to local disk only:

```bash
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="..." \
node scripts/backups/storage-backup.js --skip-upload true
```

Both commands write into `.temp/backups/` by default.

## Disaster Recovery To A New Supabase Project

### 1. Create the destination project

Create a new Supabase project and collect:

- destination `DATABASE_URL`
- destination `SUPABASE_URL`
- destination `SUPABASE_SERVICE_ROLE_KEY`

### 2. Apply this repository schema first

Run migrations before restoring data:

```bash
supabase link --project-ref <new-project-ref>
supabase db push
```

This ensures tables, functions, policies, and constraints already exist.

### 3. Restore `public` data

From local dump:

```bash
DATABASE_URL="postgresql://..." \
node scripts/backups/db-restore.js --dump-file /absolute/path/refadiaz-public-20260310T080000Z.dump
```

From Google Drive folder:

```bash
DATABASE_URL="postgresql://..." \
SHARED_DRIVE_ID="<drive-id>" \
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
node scripts/backups/db-restore.js --drive-path db/2026/03/10
```

By default the restore script truncates existing `public` tables with `RESTART IDENTITY CASCADE` before `pg_restore`. That is intentional: a freshly migrated project may already contain seeded rows from migrations, and truncation prevents duplicate-key failures during data restore.

If you really need to keep current data, pass:

```bash
node scripts/backups/db-restore.js --dump-file /absolute/path/file.dump --skip-truncate true
```

### 4. Restore Storage buckets and images

From local backup artifacts:

```bash
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="..." \
node scripts/backups/storage-restore.js --source-dir /absolute/path/.temp/backups/storage/<timestamp>
```

From Google Drive folder:

```bash
SUPABASE_URL="https://<project-ref>.supabase.co" \
SUPABASE_SERVICE_ROLE_KEY="..." \
SHARED_DRIVE_ID="<drive-id>" \
GOOGLE_SERVICE_ACCOUNT_JSON="$(cat service-account.json)" \
node scripts/backups/storage-restore.js --drive-path storage/2026/03/10
```

The storage restore flow will:

1. read `bucket-manifest.json`
2. create missing buckets
3. download and extract each bucket archive
4. verify file checksums against the per-bucket manifest
5. upload each object back into Supabase Storage with upsert enabled

### 5. Validation Checklist

After restore, validate at least:

- one product with image data
- one brand with logo
- one vehicle note with images
- object counts per bucket against the manifest files
- DB dump checksum and storage archive checksums before restore

Recommended spot checks:

- call `GET /products?id=<id>`
- call `GET /brands?id=<id>`
- call `GET /vehicle-notes?id=<id>`

## Recovery Guidance

Use Supabase managed backups first when:

- the incident is limited to the current project
- point-in-time recovery is available on the plan
- you need the fastest rollback path

Use the repo backup scripts when:

- you need a portable copy outside Supabase
- you need to rebuild into a new project
- you need selective image recovery from archived Storage backups

## Notes And Limitations

- Phase 1 covers `public` plus Supabase Storage. It does not export `auth` as a portable restore artifact.
- Google Drive cleanup removes old files but does not try to delete empty folders.
- The backup scripts are dependency-free Node scripts; they expect `pg_dump`, `pg_restore`, `psql`, and `tar` to exist when relevant.
- The workflows install `postgresql-client` for the DB path. The storage workflow only needs Node and `tar`, which is already available on GitHub-hosted Ubuntu runners.
