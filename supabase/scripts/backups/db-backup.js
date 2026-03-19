const path = require("path");

const {
  ensureDirSync,
  fileSize,
  getGitSha,
  getOption,
  getRequiredAnyEnv,
  getRequiredEnv,
  getTimestampParts,
  parseArgs,
  parsePositiveInteger,
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

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const databaseUrl = getOption(options, "database-url", process.env.DATABASE_URL || "");
  const outputRoot = path.resolve(
    getOption(options, "output-dir", process.env.DB_BACKUP_OUTPUT_DIR || ".temp/backups/db")
  );
  const timeZone = getOption(
    options,
    "time-zone",
    process.env.BACKUP_TIMEZONE || "America/Monterrey"
  );
  const retentionDays = parsePositiveInteger(
    getOption(options, "retention-days", process.env.DB_RETENTION_DAYS || "30"),
    30
  );
  const skipUpload = getOption(options, "skip-upload", "false") === "true";
  const skipCleanup = getOption(options, "skip-cleanup", "false") === "true";
  const timestamp = getTimestampParts(timeZone);
  const runDir = path.join(outputRoot, timestamp.utcCompact);
  const dumpFileName = `refadiaz-public-${timestamp.utcCompact}.dump`;
  const dumpFilePath = path.join(runDir, dumpFileName);
  const manifestFilePath = path.join(runDir, "manifest.json");
  const driveRootFolder = getOption(
    options,
    "drive-root-folder",
    process.env.DRIVE_ROOT_FOLDER || "refadiaz-backups"
  );
  const explicitDriveFolderId = process.env.GOOGLE_DRIVE_FOLDER_ID || process.env.DRIVE_ROOT_FOLDER_ID || "";

  ensureDirSync(runDir);

  const pgDumpArgs = [
    "--format=custom",
    "--compress=9",
    "--data-only",
    "--schema=public",
    "--no-owner",
    "--no-privileges",
    "--file",
    dumpFilePath,
  ];

  if (databaseUrl) {
    pgDumpArgs.push(databaseUrl);
  } else {
    getRequiredAnyEnv(["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]);
  }

  await runCommand("pg_dump", pgDumpArgs);

  const dumpSha256 = await sha256File(dumpFilePath);
  const manifest = {
    backupCategory: "db",
    generatedAt: timestamp.isoUtc,
    timeZone,
    gitSha: getGitSha(),
    dump: {
      fileName: dumpFileName,
      relativePath: `db/${timestamp.localDatePath}/${dumpFileName}`,
      size: fileSize(dumpFilePath),
      sha256: dumpSha256,
      format: "custom",
      pgDumpArgs: [
        "--format=custom",
        "--compress=9",
        "--data-only",
        "--schema=public",
        "--no-owner",
        "--no-privileges",
      ],
    },
    upload: {
      destination: "google-drive",
      driveFolderPath: `${driveRootFolder}/db/${timestamp.localDatePath}`,
    },
    retentionDays,
    status: "success",
  };

  writeJsonFile(manifestFilePath, manifest);

  if (skipUpload) {
    process.stdout.write(`Created local DB backup at ${runDir}\n`);
    return;
  }

  const accessToken = await getAccessToken();
  const sharedDriveId = process.env.SHARED_DRIVE_ID || "";
  const driveContextId = explicitDriveFolderId || getRequiredEnv("SHARED_DRIVE_ID");
  const backupRootFolder = explicitDriveFolderId
    ? { id: driveContextId }
    : await ensureFolderPath(accessToken, sharedDriveId, driveContextId, driveRootFolder);
  const targetFolder = await ensureFolderPath(
    accessToken,
    sharedDriveId,
    backupRootFolder.id,
    `db/${timestamp.localDatePath}`
  );

  await uploadFile(accessToken, sharedDriveId, targetFolder.id, dumpFileName, dumpFilePath, {
    mimeType: "application/octet-stream",
    appProperties: {
      backup_category: "db",
      backup_date: timestamp.localDatePath,
      backup_type: "dump",
    },
  });
  await uploadFile(accessToken, sharedDriveId, targetFolder.id, "manifest.json", manifestFilePath, {
    mimeType: "application/json",
    appProperties: {
      backup_category: "db",
      backup_date: timestamp.localDatePath,
      backup_type: "manifest",
    },
  });

  if (!skipCleanup) {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString();
    const deletedCount = await cleanupCategory(accessToken, backupRootFolder.id, "db", cutoff);
    process.stdout.write(`Deleted ${deletedCount} expired DB backup files from Google Drive\n`);
  }

  process.stdout.write(`Uploaded DB backup to ${manifest.upload.driveFolderPath}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
