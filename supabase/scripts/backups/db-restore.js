const path = require("path");

const {
  ensureDirSync,
  getOption,
  getRequiredAnyEnv,
  getRequiredEnv,
  parseArgs,
  runCommand,
} = require("./common");
const {
  downloadFileToPath,
  findFileByName,
  findFolderPath,
  getAccessToken,
} = require("./google-drive");

async function resolveDumpFile(options) {
  const localDump = getOption(options, "dump-file", "");

  if (localDump) {
    return path.resolve(localDump);
  }

  const drivePath = getOption(options, "drive-path", "");

  if (!drivePath) {
    throw new Error("Provide --dump-file or --drive-path");
  }

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
  const dumpFolder = await findFolderPath(
    accessToken,
    sharedDriveId,
    explicitDriveFolderId ? backupRootFolder.id : driveContextId,
    drivePathFromRoot
  );

  if (!dumpFolder) {
    throw new Error(`Drive folder not found: ${drivePathFromRoot}`);
  }

  const dumpName = getOption(options, "dump-name", "");
  const dumpFile = dumpName
    ? await findFileByName(accessToken, sharedDriveId, dumpFolder.id, dumpName)
    : null;
  let selectedDump = dumpFile;

  if (!selectedDump) {
    const manifest = await findFileByName(accessToken, sharedDriveId, dumpFolder.id, "manifest.json");

    if (!manifest) {
      throw new Error(`No dump manifest found in ${drivePath}`);
    }

    const tempDir = path.resolve(
      getOption(options, "workdir", process.env.DB_RESTORE_WORKDIR || ".temp/backups/db-restore")
    );
    const localManifestPath = path.join(tempDir, "manifest.json");
    ensureDirSync(tempDir);
    await downloadFileToPath(accessToken, manifest.id, localManifestPath);
    const dumpFileName = require("./common").readJsonFile(localManifestPath).dump.fileName;
    selectedDump = await findFileByName(accessToken, sharedDriveId, dumpFolder.id, dumpFileName);
  }

  if (!selectedDump) {
    throw new Error(`No dump file found in ${drivePath}`);
  }

  const tempDir = path.resolve(
    getOption(options, "workdir", process.env.DB_RESTORE_WORKDIR || ".temp/backups/db-restore")
  );
  const localDumpPath = path.join(tempDir, selectedDump.name);
  ensureDirSync(tempDir);
  await downloadFileToPath(accessToken, selectedDump.id, localDumpPath);
  return localDumpPath;
}

async function main() {
  const { options } = parseArgs(process.argv.slice(2));
  const databaseUrl = getOption(options, "database-url", process.env.DATABASE_URL || "");
  const skipTruncate = getOption(options, "skip-truncate", "false") === "true";
  const dumpFilePath = await resolveDumpFile(options);

  if (!databaseUrl) {
    getRequiredAnyEnv(["PGHOST", "PGDATABASE", "PGUSER", "PGPASSWORD"]);
  }

  if (!skipTruncate) {
    const truncateSql = [
      "DO $$",
      "DECLARE table_list text;",
      "BEGIN",
      "  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ' ORDER BY tablename)",
      "    INTO table_list",
      "    FROM pg_tables",
      "   WHERE schemaname = 'public';",
      "  IF table_list IS NOT NULL THEN",
      "    EXECUTE 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY CASCADE';",
      "  END IF;",
      "END $$;",
    ].join("\n");
    const psqlArgs = ["-v", "ON_ERROR_STOP=1", "-c", truncateSql];

    if (databaseUrl) {
      psqlArgs.push(databaseUrl);
    }

    await runCommand("psql", psqlArgs);
  }

  const restoreArgs = [
    "--data-only",
    "--schema=public",
    "--disable-triggers",
    "--no-owner",
    "--no-privileges",
    "--single-transaction",
  ];

  if (databaseUrl) {
    restoreArgs.push("--dbname", databaseUrl);
  }

  restoreArgs.push(dumpFilePath);
  await runCommand("pg_restore", restoreArgs);
  process.stdout.write(`Restored DB dump from ${dumpFilePath}\n`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
