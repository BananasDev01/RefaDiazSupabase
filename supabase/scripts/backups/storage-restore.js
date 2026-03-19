const fs = require("fs");
const path = require("path");

const {
  csvToList,
  ensureDirSync,
  getOption,
  getRequiredEnv,
  listFilesRecursively,
  parseArgs,
  readJsonFile,
  runCommand,
  sha256File,
} = require("./common");
const {
  downloadFileToPath,
  findFileByName,
  findFolderPath,
  getAccessToken,
} = require("./google-drive");

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

  if (options.allow409 && response.status === 409) {
    return null;
  }

  if (!response.ok) {
    throw new Error(`Supabase Storage request failed: ${response.status} ${await response.text()}`);
  }

  if (options.raw) {
    return response;
  }

  return response.json();
}

async function resolveArtifacts(options) {
  const sourceDir = getOption(options, "source-dir", "");

  if (sourceDir) {
    const resolvedSourceDir = path.resolve(sourceDir);
    return {
      rootDir: resolvedSourceDir,
      manifestDir: path.join(resolvedSourceDir, "manifests"),
      archiveDir: path.join(resolvedSourceDir, "archives"),
    };
  }

  const drivePath = getOption(options, "drive-path", "");

  if (!drivePath) {
    throw new Error("Provide --source-dir or --drive-path");
  }

  const tempRoot = path.resolve(
    getOption(options, "workdir", process.env.STORAGE_RESTORE_WORKDIR || ".temp/backups/storage-restore")
  );
  const manifestDir = path.join(tempRoot, "manifests");
  const archiveDir = path.join(tempRoot, "archives");
  const explicitDriveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID || "";
  const sharedDriveId = process.env.SHARED_DRIVE_ID || "";
  const driveContextId = explicitDriveFolderId || getRequiredEnv("SHARED_DRIVE_ID");
  const driveRootFolder = getOption(
    options,
    "drive-root-folder",
    process.env.DRIVE_ROOT_FOLDER || "refadiaz-backups"
  );
  const accessToken = await getAccessToken();
  const backupRootFolder = explicitDriveFolderId
    ? { id: driveContextId }
    : await findFolderPath(accessToken, sharedDriveId, driveContextId, driveRootFolder);
  const drivePathFromRoot = explicitDriveFolderId ? drivePath : `${driveRootFolder}/${drivePath}`;
  const baseFolder = await findFolderPath(
    accessToken,
    sharedDriveId,
    explicitDriveFolderId ? backupRootFolder.id : driveContextId,
    drivePathFromRoot
  );

  if (!baseFolder) {
    throw new Error(`Drive folder not found: ${drivePathFromRoot}`);
  }

  const manifestsFolder = await findFolderPath(
    accessToken,
    sharedDriveId,
    baseFolder.id,
    "manifests"
  );

  if (!manifestsFolder) {
    throw new Error(`Drive manifests folder not found in ${drivePath}`);
  }

  ensureDirSync(manifestDir);
  ensureDirSync(archiveDir);

  const bucketManifestFile = await findFileByName(
    accessToken,
    sharedDriveId,
    manifestsFolder.id,
    "bucket-manifest.json"
  );

  if (!bucketManifestFile) {
    throw new Error(`bucket-manifest.json not found in ${drivePath}`);
  }

  await downloadFileToPath(
    accessToken,
    bucketManifestFile.id,
    path.join(manifestDir, "bucket-manifest.json")
  );

  const bucketManifest = readJsonFile(path.join(manifestDir, "bucket-manifest.json"));

  for (const bucket of bucketManifest.buckets) {
    const bucketFolder = await findFolderPath(
      accessToken,
      sharedDriveId,
      baseFolder.id,
      bucket.id
    );

    if (!bucketFolder) {
      throw new Error(`Bucket folder not found in drive backup: ${bucket.id}`);
    }

    const files = [
      `${bucket.id}-manifest.json`,
    ];
    const bucketFiles = await Promise.all(
      files.map((fileName) => findFileByName(accessToken, sharedDriveId, bucketFolder.id, fileName))
    );
    const manifestFile = bucketFiles[0];

    if (!manifestFile) {
      throw new Error(`Missing manifest for bucket ${bucket.id}`);
    }

    await downloadFileToPath(
      accessToken,
      manifestFile.id,
      path.join(manifestDir, manifestFile.name)
    );

    const bucketManifestPayload = readJsonFile(path.join(manifestDir, manifestFile.name));
    const archiveFile = await findFileByName(
      accessToken,
      sharedDriveId,
      bucketFolder.id,
      bucketManifestPayload.archive.fileName
    );

    if (!archiveFile) {
      throw new Error(`Missing archive for bucket ${bucket.id}`);
    }

    await downloadFileToPath(
      accessToken,
      archiveFile.id,
      path.join(archiveDir, archiveFile.name)
    );
  }

  return {
    rootDir: tempRoot,
    manifestDir,
    archiveDir,
  };
}

async function createBucketIfNeeded(baseUrl, serviceRoleKey, bucketConfig) {
  await storageRequest(`${baseUrl}/storage/v1/bucket`, serviceRoleKey, {
    method: "POST",
    allow409: true,
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      id: bucketConfig.id,
      name: bucketConfig.name || bucketConfig.id,
      public: bucketConfig.public,
      file_size_limit: bucketConfig.fileSizeLimit,
      allowed_mime_types: bucketConfig.allowedMimeTypes,
    }),
  });
}

async function uploadObject(baseUrl, serviceRoleKey, bucketId, objectPath, filePath) {
  const response = await fetch(
    `${baseUrl}/storage/v1/object/${bucketId}/${objectPath.split("/").map(encodeURIComponent).join("/")}`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${serviceRoleKey}`,
        apikey: serviceRoleKey,
        "x-upsert": "true",
        "content-type": "application/octet-stream",
      },
      body: fs.readFileSync(filePath),
    }
  );

  if (!response.ok) {
    throw new Error(
      `Failed to upload ${bucketId}/${objectPath}: ${response.status} ${await response.text()}`
    );
  }
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const supabaseUrl = getOption(options, "supabase-url", process.env.SUPABASE_URL || "");
  const serviceRoleKey = getOption(
    options,
    "service-role-key",
    process.env.SUPABASE_SERVICE_ROLE_KEY || ""
  );

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const artifacts = await resolveArtifacts(options);
  const extractionRoot = path.join(artifacts.rootDir, "extracted");
  const bucketManifest = readJsonFile(path.join(artifacts.manifestDir, "bucket-manifest.json"));
  const selectedBuckets = csvToList(getOption(options, "buckets", process.env.STORAGE_BUCKETS || ""));
  const bucketConfigs = selectedBuckets.length > 0
    ? bucketManifest.buckets.filter((bucket) => selectedBuckets.includes(bucket.id))
    : bucketManifest.buckets;

  ensureDirSync(extractionRoot);

  for (const bucketConfig of bucketConfigs) {
    const manifestPath = path.join(artifacts.manifestDir, `${bucketConfig.id}-manifest.json`);
    const bucketPayload = readJsonFile(manifestPath);
    const archivePath = path.join(artifacts.archiveDir, bucketPayload.archive.fileName);
    const extractionDir = path.join(extractionRoot, bucketConfig.id);

    await createBucketIfNeeded(supabaseUrl, serviceRoleKey, bucketConfig);
    ensureDirSync(extractionDir);
    await runCommand("tar", ["-xzf", archivePath, "-C", extractionDir]);

    const extractedFiles = listFilesRecursively(extractionDir);

    for (const objectEntry of bucketPayload.objects) {
      const expectedPath = path.join(extractionDir, objectEntry.path);

      if (!fs.existsSync(expectedPath)) {
        throw new Error(`Missing extracted file for ${bucketConfig.id}/${objectEntry.path}`);
      }

      const currentHash = await sha256File(expectedPath);

      if (currentHash !== objectEntry.sha256) {
        throw new Error(
          `Checksum mismatch for ${bucketConfig.id}/${objectEntry.path}: expected ${objectEntry.sha256}, got ${currentHash}`
        );
      }
    }

    for (const filePath of extractedFiles) {
      const objectPath = path.relative(extractionDir, filePath).split(path.sep).join("/");
      await uploadObject(supabaseUrl, serviceRoleKey, bucketConfig.id, objectPath, filePath);
    }
  }

  process.stdout.write("Storage restore completed\n");
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
