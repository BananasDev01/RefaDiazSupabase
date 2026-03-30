const http = require("http");
const crypto = require("crypto");

const clientId =
  "537549394840-ct3cfuojdgqlrsqrcmmtn285rktj25fe.apps.googleusercontent.com";
const clientSecret = "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";
const redirectUri = "http://127.0.0.1:8765/callback";
const scope = "https://www.googleapis.com/auth/drive";

const state = crypto.randomBytes(16).toString("hex");

const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
authUrl.searchParams.set("client_id", clientId);
authUrl.searchParams.set("redirect_uri", redirectUri);
authUrl.searchParams.set("response_type", "code");
authUrl.searchParams.set("scope", scope);
authUrl.searchParams.set("access_type", "offline");
authUrl.searchParams.set("prompt", "consent");
authUrl.searchParams.set("state", state);

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://127.0.0.1:8765");

  if (url.pathname !== "/callback") {
    res.writeHead(404);
    res.end("Not found");
    return;
  }

  if (url.searchParams.get("state") !== state) {
    res.writeHead(400);
    res.end("Invalid state");
    server.close();
    return;
  }

  const code = url.searchParams.get("code");

  if (!code) {
    res.writeHead(400);
    res.end("Missing code");
    server.close();
    return;
  }

  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        code,
        client_id: clientId,
        client_secret: clientSecret,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    const payload = await tokenResponse.json();

    res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
    res.end("Autorización completada. Regresa a la terminal.");

    console.log("\nACCESS TOKEN:\n");
    console.log(payload.access_token || "");
    console.log("\nREFRESH TOKEN:\n");
    console.log(payload.refresh_token || "");
    console.log("\nGuarda REFRESH TOKEN en GitHub como GOOGLE_OAUTH_REFRESH_TOKEN\n");
  } catch (error) {
    console.error(error);
  } finally {
    setTimeout(() => server.close(), 500);
  }
});

server.listen(8765, "127.0.0.1", () => {
  console.log("\nAbre esta URL en tu navegador:\n");
  console.log(authUrl.toString());
  console.log("\nEsperando callback en http://127.0.0.1:8765/callback ...\n");
});
