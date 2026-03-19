const fs = require("fs");
const crypto = require("crypto");
const path = require("path");
const { Readable } = require("stream");

function escapeQueryValue(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

function getServiceAccountCredentials() {
  const rawJson =
    process.env.GOOGLE_SERVICE_ACCOUNT_JSON ||
    (process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64
      ? Buffer.from(process.env.GOOGLE_SERVICE_ACCOUNT_JSON_B64, "base64").toString("utf8")
      : "");

  if (!rawJson) {
    throw new Error(
      "Missing GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_JSON_B64"
    );
  }

  const credentials = JSON.parse(rawJson);

  if (!credentials.client_email || !credentials.private_key) {
    throw new Error("Google service account JSON must include client_email and private_key");
  }

  return credentials;
}

function getOAuthRefreshTokenCredentials() {
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET || "";
  const refreshToken = process.env.GOOGLE_OAUTH_REFRESH_TOKEN || "";

  if (!clientId || !clientSecret || !refreshToken) {
    return null;
  }

  return {
    clientId,
    clientSecret,
    refreshToken,
  };
}

function base64UrlEncode(value) {
  return Buffer.from(value)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function getAccessToken() {
  const oauthCredentials = getOAuthRefreshTokenCredentials();

  if (oauthCredentials) {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: oauthCredentials.clientId,
        client_secret: oauthCredentials.clientSecret,
        refresh_token: oauthCredentials.refreshToken,
        grant_type: "refresh_token",
      }),
    });

    if (!response.ok) {
      throw new Error(`Unable to obtain Google OAuth access token: ${await response.text()}`);
    }

    const payload = await response.json();
    return payload.access_token;
  }

  const credentials = getServiceAccountCredentials();
  const nowInSeconds = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: credentials.client_email,
    scope: "https://www.googleapis.com/auth/drive",
    aud: "https://oauth2.googleapis.com/token",
    exp: nowInSeconds + 3600,
    iat: nowInSeconds,
  };
  const unsignedToken = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(
    JSON.stringify(claimSet)
  )}`;
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsignedToken);
  signer.end();
  const signature = signer
    .sign(credentials.private_key)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
  const assertion = `${unsignedToken}.${signature}`;
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });

  if (!response.ok) {
    throw new Error(`Unable to obtain Google service account access token: ${await response.text()}`);
  }

  const payload = await response.json();
  return payload.access_token;
}

function buildDriveUrl(pathname, query = {}, upload = false) {
  const baseUrl = upload
    ? "https://www.googleapis.com/upload/drive/v3"
    : "https://www.googleapis.com/drive/v3";
  const url = new URL(`${baseUrl}${pathname}`);

  Object.entries(query).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") {
      url.searchParams.set(key, value);
    }
  });

  return url;
}

async function driveRequest(accessToken, pathname, options = {}) {
  const response = await fetch(
    buildDriveUrl(pathname, options.query, options.upload),
    {
      method: options.method || "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        ...(options.headers || {}),
      },
      body: options.body,
      duplex: options.duplex,
    }
  );

  if (!response.ok) {
    throw new Error(`Google Drive request failed: ${response.status} ${await response.text()}`);
  }

  if (options.raw) {
    return response;
  }

  if (response.status === 204) {
    return null;
  }

  return response.json();
}

function isFolder(item) {
  return item.mimeType === "application/vnd.google-apps.folder";
}

async function listFiles(accessToken, extraQuery) {
  let pageToken = undefined;
  const files = [];

  do {
    const payload = await driveRequest(accessToken, "/files", {
      query: {
        corpora: "allDrives",
        includeItemsFromAllDrives: "true",
        supportsAllDrives: "true",
        pageSize: "1000",
        pageToken,
        q: extraQuery,
        fields: "nextPageToken,files(id,name,mimeType,parents,createdTime,appProperties,size)",
      },
    });

    files.push(...(payload.files || []));
    pageToken = payload.nextPageToken;
  } while (pageToken);

  return files;
}

async function findChildFolder(accessToken, driveId, parentId, folderName) {
  const query = [
    `'${escapeQueryValue(parentId)}' in parents`,
    `name = '${escapeQueryValue(folderName)}'`,
    "mimeType = 'application/vnd.google-apps.folder'",
    "trashed = false",
  ].join(" and ");
  const folders = await listFiles(accessToken, query);
  return folders[0] || null;
}

async function createFolder(accessToken, driveId, parentId, folderName) {
  return driveRequest(accessToken, "/files", {
    method: "POST",
    query: { supportsAllDrives: "true" },
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      name: folderName,
      mimeType: "application/vnd.google-apps.folder",
      parents: [parentId],
    }),
  });
}

async function findOrCreateFolder(accessToken, driveId, parentId, folderName) {
  const existing = await findChildFolder(accessToken, driveId, parentId, folderName);

  if (existing) {
    return existing;
  }

  return createFolder(accessToken, driveId, parentId, folderName);
}

async function findFolderPath(accessToken, driveId, rootParentId, relativePath) {
  const segments = relativePath.split("/").map((segment) => segment.trim()).filter(Boolean);
  let current = { id: rootParentId, name: "" };

  for (const segment of segments) {
    const child = await findChildFolder(accessToken, driveId, current.id, segment);

    if (!child) {
      return null;
    }

    current = child;
  }

  return current;
}

async function ensureFolderPath(accessToken, driveId, rootParentId, relativePath) {
  const segments = relativePath.split("/").map((segment) => segment.trim()).filter(Boolean);
  let current = { id: rootParentId, name: "" };

  for (const segment of segments) {
    current = await findOrCreateFolder(accessToken, driveId, current.id, segment);
  }

  return current;
}

async function uploadFile(accessToken, driveId, parentId, fileName, filePath, options = {}) {
  const metadata = {
    name: fileName,
    parents: [parentId],
  };

  if (options.mimeType) {
    metadata.mimeType = options.mimeType;
  }

  if (options.appProperties) {
    metadata.appProperties = options.appProperties;
  }

  const fileSize = fs.statSync(filePath).size;
  const sessionResponse = await driveRequest(accessToken, "/files", {
    method: "POST",
    upload: true,
    raw: true,
    query: {
      uploadType: "resumable",
      supportsAllDrives: "true",
    },
    headers: {
      "content-type": "application/json; charset=UTF-8",
      "x-upload-content-type": options.mimeType || "application/octet-stream",
      "x-upload-content-length": String(fileSize),
    },
    body: JSON.stringify(metadata),
  });
  const uploadUrl = sessionResponse.headers.get("location");

  if (!uploadUrl) {
    throw new Error(`Google Drive resumable session missing location header for ${fileName}`);
  }

  const uploadResponse = await fetch(uploadUrl, {
    method: "PUT",
    headers: {
      authorization: `Bearer ${accessToken}`,
      "content-length": String(fileSize),
      "content-type": options.mimeType || "application/octet-stream",
    },
    body: fs.createReadStream(filePath),
    duplex: "half",
  });

  if (!uploadResponse.ok) {
    throw new Error(`Google Drive upload failed for ${fileName}: ${await uploadResponse.text()}`);
  }

  return uploadResponse.json();
}

async function deleteFile(accessToken, fileId) {
  await driveRequest(accessToken, `/files/${fileId}`, {
    method: "DELETE",
    query: { supportsAllDrives: "true" },
  });
}

async function cleanupCategory(accessToken, driveId, category, olderThanIso) {
  const rootFolderId = driveId;
  const files = [];
  const queue = [rootFolderId];

  while (queue.length > 0) {
    const parentId = queue.shift();
    const children = await listChildren(accessToken, driveId, parentId);

    for (const child of children) {
      if (isFolder(child)) {
        queue.push(child.id);
        continue;
      }

      files.push(child);
    }
  }

  const filteredFiles = files.filter((file) => {
    const createdTime = file.createdTime || "";
    const backupCategory = file.appProperties?.backup_category || "";
    return createdTime < olderThanIso && backupCategory === category;
  });

  for (const file of filteredFiles) {
    await deleteFile(accessToken, file.id);
  }

  return filteredFiles.length;
}

async function findFileByName(accessToken, driveId, parentId, fileName) {
  const query = [
    `'${escapeQueryValue(parentId)}' in parents`,
    `name = '${escapeQueryValue(fileName)}'`,
    "trashed = false",
  ].join(" and ");
  const files = await listFiles(accessToken, query);
  return files[0] || null;
}

async function listChildren(accessToken, driveId, parentId) {
  const query = [`'${escapeQueryValue(parentId)}' in parents`, "trashed = false"].join(" and ");
  return listFiles(accessToken, query);
}

async function downloadFileToPath(accessToken, fileId, destinationPath) {
  const response = await fetch(
    buildDriveUrl(`/files/${fileId}`, {
      alt: "media",
      supportsAllDrives: "true",
    }),
    {
      headers: {
        authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!response.ok) {
    throw new Error(`Google Drive download failed: ${response.status} ${await response.text()}`);
  }

  if (!response.body) {
    throw new Error(`Google Drive download returned an empty body for file ${fileId}`);
  }

  await fs.promises.mkdir(path.dirname(destinationPath), { recursive: true });
  const output = fs.createWriteStream(destinationPath);
  const input = Readable.fromWeb(response.body);

  await new Promise((resolve, reject) => {
    input.pipe(output);
    input.on("error", reject);
    output.on("finish", resolve);
    output.on("error", reject);
  });
}

module.exports = {
  cleanupCategory,
  downloadFileToPath,
  ensureFolderPath,
  findFileByName,
  findFolderPath,
  getAccessToken,
  listChildren,
  uploadFile,
};
