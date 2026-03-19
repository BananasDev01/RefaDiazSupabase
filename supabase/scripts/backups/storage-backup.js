const fs = require("fs");
const path = require("path");
const { Readable } = require("stream");

const {
  csvToList,
  encodeStoragePath,
  ensureDirSync,
  fileSize,
  getGitSha,
  getOption,
  getRequiredEnv,
  getTimestampParts,
  parseArgs,
  parsePositiveInteger,
  relativePosix,
  runCommand,
  sha256File,
  writeJsonFile,
} = require("./common");
const {
  cleanupCategory,
  ensureFolderPath,
  getAccessToken,
  uploadFile,
} = require("./google-drive");

const DEFAULT_BUCKETS = [
  "products",
  "brands",
  "radiators",
  "providers",
  "car-models",
  "vehicle-notes",
];

async function storageRequest(url, serviceRoleKey, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      authorization: `Bearer ${serviceRoleKey}`,
      apikey: serviceRoleKey,
      ...(options.headers || {}),
    },
    body: options.body,
  });

  if (!response.ok) {
    throw new Error(`Supabase Storage request failed: ${response.status} ${await response.text()}`);
  }

  if (options.raw) {
    return response;
  }

  return response.json();
}

function isFolderEntry(entry) {
  return entry.id === null || entry.metadata === null;
}

async function listBucketObjects(baseUrl, serviceRoleKey, bucketId) {
  const objectPaths = [];
  const prefixes = [""];

  while (prefixes.length > 0) {
    const prefix = prefixes.shift();
    let offset = 0;

    while (true) {
      const payload = await storageRequest(
        `${baseUrl}/storage/v1/object/list/${bucketId}`,
        serviceRoleKey,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            prefix,
            limit: 1000,
            offset,
            sortBy: { column: "name", order: "asc" },
          }),
        }
      );

      for (const entry of payload) {
        const entryPath = prefix ? `${prefix}/${entry.name}` : entry.name;

        if (isFolderEntry(entry)) {
          prefixes.push(entryPath);
        } else {
          objectPaths.push({
            path: entryPath,
            metadata: entry.metadata,
            updatedAt: entry.updated_at,
            createdAt: entry.created_at,
            lastAccessedAt: entry.last_accessed_at,
          });
        }
      }

      if (payload.length < 1000) {
        break;
      }

      offset += payload.length;
    }
  }

  return objectPaths.sort((left, right) => left.path.localeCompare(right.path));
}

async function downloadObject(baseUrl, serviceRoleKey, bucketId, objectPath, destinationPath) {
  const response = await storageRequest(
    `${baseUrl}/storage/v1/object/authenticated/${bucketId}/${encodeStoragePath(objectPath)}`,
    serviceRoleKey,
    { raw: true }
  );

  if (!response.body) {
    throw new Error(`Supabase Storage download returned an empty body for ${bucketId}/${objectPath}`);
  }

  ensureDirSync(path.dirname(destinationPath));
  const output = fs.createWriteStream(destinationPath);
  const input = Readable.fromWeb(response.body);

  await new Promise((resolve, reject) => {
    input.pipe(output);
    input.on("error", reject);
    output.on("finish", resolve);
    output.on("error", reject);
  });
}

async function createArchive(sourceDir, archivePath) {
  ensureDirSync(path.dirname(archivePath));
  await runCommand("tar", ["-czf", archivePath, "-C", sourceDir, "."]);
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const supabaseUrl = getOption(options, "supabase-url", process.env.SUPABASE_URL || "");
  const serviceRoleKey = getOption(
    options,
    "service-role-key",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );
  const outputRoot = path.resolve(
    getOption(
      options,
      "output-dir",
      process.env.STORAGE_BACKUP_OUTPUT_DIR || ".temp/backups/storage"
    )
  );
  const timeZone = getOption(
    options,
    "time-zone",
    process.env.BACKUP_TIMEZONE || "America/Monterrey"
  );
  const retentionDays = parsePositiveInteger(
    getOption(options, "retention-days", process.env.STORAGE_RETENTION_DAYS || "90"),
    90
  );
  const skipUpload = getOption(options, "skip-upload", "false") === "true";
  const skipCleanup = getOption(options, "skip-cleanup", "false") === "true";
  const timestamp = getTimestampParts(timeZone);
  const runDir = path.join(outputRoot, timestamp.utcCompact);
  const stagingRoot = path.join(runDir, "staging");
  const manifestRoot = path.join(runDir, "manifests");
  const archiveRoot = path.join(runDir, "archives");
  const driveRootFolder = getOption(
    options,
    "drive-root-folder",
    process.env.DRIVE_ROOT_FOLDER || "refadiaz-backups"
  );
  const explicitDriveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID || "";
  const selectedBuckets = csvToList(
    getOption(options, "buckets", process.env.STORAGE_BUCKETS || ""),
    DEFAULT_BUCKETS
  );

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  ensureDirSync(stagingRoot);
  ensureDirSync(manifestRoot);
  ensureDirSync(archiveRoot);

  const allBuckets = await storageRequest(`${supabaseUrl}/storage/v1/bucket`, serviceRoleKey);
  const missingBuckets = selectedBuckets.filter(
    (bucketId) => !allBuckets.some((bucket) => bucket.id === bucketId)
  );

  const bucketConfigs = allBuckets
    .filter((bucket) => selectedBuckets.includes(bucket.id))
    .map((bucket) => ({
      id: bucket.id,
      name: bucket.name,
      public: bucket.public,
      fileSizeLimit: bucket.file_size_limit,
      allowedMimeTypes: bucket.allowed_mime_types,
    }))
    .sort((left, right) => left.id.localeCompare(right.id));

  const bucketManifestPayload = {
    generatedAt: timestamp.isoUtc,
    timeZone,
    gitSha: getGitSha(),
    buckets: bucketConfigs,
    missingBuckets,
  };
  const bucketManifestPath = path.join(manifestRoot, "bucket-manifest.json");
  const runManifest = {
    backupCategory: "storage",
    generatedAt: timestamp.isoUtc,
    timeZone,
    gitSha: getGitSha(),
    retentionDays,
    driveFolderPath: `${driveRootFolder}/storage/${timestamp.localDatePath}`,
    requestedBuckets: selectedBuckets,
    missingBuckets,
    buckets: [],
    status: "success",
  };

  if (bucketConfigs.length === 0) {
    throw new Error(
      `None of the requested storage buckets exist in this environment: ${selectedBuckets.join(", ")}`
    );
  }

  if (missingBuckets.length > 0) {
    process.stdout.write(
      `Skipping missing storage buckets: ${missingBuckets.join(", ")}\n`
    );
  }

  writeJsonFile(bucketManifestPath, bucketManifestPayload);

  for (const bucketConfig of bucketConfigs) {
    const bucketId = bucketConfig.id;
    const bucketStagingDir = path.join(stagingRoot, bucketId);
    const archiveFileName = `${bucketId}-${timestamp.utcCompact}.tar.gz`;
    const archivePath = path.join(archiveRoot, archiveFileName);
    const objectEntries = await listBucketObjects(supabaseUrl, serviceRoleKey, bucketId);
    const manifestEntries = [];

    ensureDirSync(bucketStagingDir);

    for (const objectEntry of objectEntries) {
      const destinationPath = path.join(bucketStagingDir, objectEntry.path);
      await downloadObject(supabaseUrl, serviceRoleKey, bucketId, objectEntry.path, destinationPath);
      manifestEntries.push({
        path: objectEntry.path,
        size: fileSize(destinationPath),
        sha256: await sha256File(destinationPath),
        createdAt: objectEntry.createdAt,
        updatedAt: objectEntry.updatedAt,
        lastAccessedAt: objectEntry.lastAccessedAt,
        metadata: objectEntry.metadata,
      });
    }

    await createArchive(bucketStagingDir, archivePath);

    const bucketManifestPath = path.join(manifestRoot, `${bucketId}-manifest.json`);
    const bucketManifest = {
      bucket: bucketConfig,
      generatedAt: timestamp.isoUtc,
      archive: {
        fileName: archiveFileName,
        size: fileSize(archivePath),
        sha256: await sha256File(archivePath),
      },
      objectCount: manifestEntries.length,
      totalBytes: manifestEntries.reduce((total, entry) => total + entry.size, 0),
      objects: manifestEntries,
    };

    writeJsonFile(bucketManifestPath, bucketManifest);
    runManifest.buckets.push({
      bucketId,
      objectCount: bucketManifest.objectCount,
      totalBytes: bucketManifest.totalBytes,
      archiveFileName,
      manifestFileName: path.basename(bucketManifestPath),
      stagingRelativePath: relativePosix(runDir, bucketStagingDir),
    });
  }

  const runManifestPath = path.join(manifestRoot, "run-manifest.json");
  writeJsonFile(runManifestPath, runManifest);

  if (skipUpload) {
    process.stdout.write(`Created local storage backup at ${runDir}\n`);
    return;
  }

  const accessToken = await getAccessToken();
  const sharedDriveId = process.env.SHARED_DRIVE_ID || "";
  const driveContextId = explicitDriveFolderId || getRequiredEnv("SHARED_DRIVE_ID");
  const backupRootFolder = explicitDriveFolderId
    ? { id: driveContextId }
    : await ensureFolderPath(accessToken, sharedDriveId, driveContextId, driveRootFolder);
  const baseFolder = await ensureFolderPath(
    accessToken,
    sharedDriveId,
    backupRootFolder.id,
    `storage/${timestamp.localDatePath}`
  );
  const manifestsFolder = await ensureFolderPath(
    accessToken,
    sharedDriveId,
    baseFolder.id,
    "manifests"
  );

  await uploadFile(
    accessToken,
    sharedDriveId,
    manifestsFolder.id,
    "bucket-manifest.json",
    bucketManifestPath,
    {
      mimeType: "application/json",
      appProperties: {
        backup_category: "storage",
        backup_date: timestamp.localDatePath,
        backup_type: "bucket-manifest",
      },
    }
  );
  await uploadFile(
    accessToken,
    sharedDriveId,
    manifestsFolder.id,
    "run-manifest.json",
    runManifestPath,
    {
      mimeType: "application/json",
      appProperties: {
        backup_category: "storage",
        backup_date: timestamp.localDatePath,
        backup_type: "run-manifest",
      },
    }
  );

  for (const bucketConfig of bucketConfigs) {
    const bucketFolder = await ensureFolderPath(
      accessToken,
      sharedDriveId,
      baseFolder.id,
      bucketConfig.id
    );
    const archiveFileName = `${bucketConfig.id}-${timestamp.utcCompact}.tar.gz`;
    const archivePath = path.join(archiveRoot, archiveFileName);
    const manifestPath = path.join(manifestRoot, `${bucketConfig.id}-manifest.json`);

    await uploadFile(
      accessToken,
      sharedDriveId,
      bucketFolder.id,
      archiveFileName,
      archivePath,
      {
        mimeType: "application/gzip",
        appProperties: {
          backup_category: "storage",
          backup_bucket: bucketConfig.id,
          backup_date: timestamp.localDatePath,
          backup_type: "archive",
        },
      }
    );
    await uploadFile(
      accessToken,
      sharedDriveId,
      bucketFolder.id,
      `${bucketConfig.id}-manifest.json`,
      manifestPath,
      {
        mimeType: "application/json",
        appProperties: {
          backup_category: "storage",
          backup_bucket: bucketConfig.id,
          backup_date: timestamp.localDatePath,
          backup_type: "manifest",
        },
      }
    );
  }

  if (!skipCleanup) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const deletedCount = await cleanupCategory(accessToken, backupRootFolder.id, "storage", cutoff);
    process.stdout.write(
      `Deleted ${deletedCount} expired storage backup files from Google Drive\n`
    );
  }

  process.stdout.write(`Uploaded storage backup to ${runManifest.driveFolderPath}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
