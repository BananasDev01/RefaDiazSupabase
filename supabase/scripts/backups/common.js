const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");

function parseArgs(argv) {
  const positional = [];
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];

    if (!current.startsWith("--")) {
      positional.push(current);
      continue;
    }

    const [rawKey, inlineValue] = current.slice(2).split("=");
    const nextValue = inlineValue === undefined ? argv[i + 1] : undefined;
    const consumesNext =
      inlineValue === undefined && nextValue && !nextValue.startsWith("--");

    options[rawKey] = inlineValue ?? (consumesNext ? nextValue : "true");

    if (consumesNext) {
      i += 1;
    }
  }

  return { positional, options };
}

function getOption(options, key, fallbackValue = undefined) {
  return Object.prototype.hasOwnProperty.call(options, key)
    ? options[key]
    : fallbackValue;
}

function getRequiredEnv(name) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

function getRequiredAnyEnv(names) {
  for (const name of names) {
    if (process.env[name]) {
      return process.env[name];
    }
  }

  throw new Error(`Missing required environment variable. Expected one of: ${names.join(", ")}`);
}

function ensureDirSync(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function writeJsonFile(filePath, payload) {
  ensureDirSync(path.dirname(filePath));
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2) + "\n", "utf8");
}

function readJsonFile(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function sha256Buffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function sha256File(filePath) {
  const hash = crypto.createHash("sha256");
  const input = fs.createReadStream(filePath);

  return new Promise((resolve, reject) => {
    input.on("data", (chunk) => hash.update(chunk));
    input.on("error", reject);
    input.on("end", () => resolve(hash.digest("hex")));
  });
}

function getTimestampParts(timeZone) {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(
    formatter.formatToParts(now).map((part) => [part.type, part.value])
  );
  const utcCompact = now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

  return {
    isoUtc: now.toISOString(),
    utcCompact,
    localDatePath: `${parts.year}/${parts.month}/${parts.day}`,
    localCompact: `${parts.year}${parts.month}${parts.day}T${parts.hour}${parts.minute}${parts.second}`,
  };
}

function getGitSha() {
  return (
    process.env.GITHUB_SHA ||
    process.env.VERCEL_GIT_COMMIT_SHA ||
    process.env.COMMIT_SHA ||
    null
  );
}

function fileSize(filePath) {
  return fs.statSync(filePath).size;
}

function relativePosix(fromPath, toPath) {
  return path.relative(fromPath, toPath).split(path.sep).join("/");
}

function listFilesRecursively(rootDir) {
  if (!fs.existsSync(rootDir)) {
    return [];
  }

  const results = [];
  const stack = [rootDir];

  while (stack.length > 0) {
    const current = stack.pop();
    const entries = fs.readdirSync(current, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);

      if (entry.isDirectory()) {
        stack.push(entryPath);
      } else if (entry.isFile()) {
        results.push(entryPath);
      }
    }
  }

  return results.sort();
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: { ...process.env, ...(options.env || {}) },
      stdio: options.stdio || "inherit",
    });

    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code}`));
        return;
      }

      resolve();
    });
  });
}

function csvToList(value, fallback = []) {
  if (!value) {
    return fallback;
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parsePositiveInteger(rawValue, fallbackValue) {
  if (rawValue === undefined || rawValue === null || rawValue === "") {
    return fallbackValue;
  }

  const parsed = Number.parseInt(String(rawValue), 10);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Expected a positive integer, received: ${rawValue}`);
  }

  return parsed;
}

function encodeStoragePath(objectPath) {
  return objectPath
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

module.exports = {
  csvToList,
  encodeStoragePath,
  ensureDirSync,
  fileSize,
  getGitSha,
  getOption,
  getRequiredAnyEnv,
  getRequiredEnv,
  getTimestampParts,
  listFilesRecursively,
  parseArgs,
  parsePositiveInteger,
  readJsonFile,
  relativePosix,
  runCommand,
  sha256Buffer,
  sha256File,
  writeJsonFile,
};
