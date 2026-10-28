// ErrorLogEndpointRequest
// A Cloudflare Worker that saves the raw text of every request as a .log file in a GitHub repo.
// The log file is plain text (exactly what the caller sent). The response is always JSON.

const SERVICE = "ErrorLogEndpointRequest";
const VERSION = "1.1.0";
const MAX_BODY_CHARS = 100 * 1024;

const json = (data, status = 200) =>
  new Response(JSON.stringify(data, null, 2), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-service": SERVICE,
    },
  });

// 20261028T211700123Z
const timeSnap = (d) => d.toISOString().replace(/[-:]/g, "").replace(".", "");

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

const toBase64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

async function commitLog(env, path, content, message) {
  const branch = env.GITHUB_BRANCH || "main";
  const res = await fetch(
    `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${path}`,
    {
      method: "PUT",
      headers: {
        authorization: `Bearer ${env.GITHUB_TOKEN}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": SERVICE,
        "content-type": "application/json",
      },
      body: JSON.stringify({ message, content: toBase64(content), branch }),
    }
  );
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`GitHub API ${res.status}: ${detail.slice(0, 300)}`);
  }
  return res.json();
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return json({ ok: true, service: SERVICE, version: VERSION });
    }

    if (env.LOG_API_KEY && request.headers.get("x-api-key") !== env.LOG_API_KEY) {
      return json({ ok: false, error: "unauthorized" }, 401);
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
      return json({ ok: false, error: "server_not_configured" }, 500);
    }

    const now = new Date();
    const id = randomId();
    const fileName = `${timeSnap(now)}-${id}Delta.log`;
    const path = `logs/${fileName}`;

    // The log file is the raw text the caller sent. With no body (e.g. GET),
    // it falls back to a single plain-text line describing the request.
    let text = "";
    if (request.method !== "GET" && request.method !== "HEAD") {
      text = await request.text();
    }
    let truncated = false;
    if (text.length > MAX_BODY_CHARS) {
      text = text.slice(0, MAX_BODY_CHARS);
      truncated = true;
    }
    if (text.trim() === "") {
      text = `${now.toISOString()} ${request.method} ${url.pathname}${url.search}`;
    }
    const content = text.endsWith("\n") ? text : text + "\n";

    try {
      const result = await commitLog(env, path, content, `log: ${fileName}`);
      return json(
        {
          ok: true,
          service: SERVICE,
          version: VERSION,
          id,
          file: path,
          bytes: new TextEncoder().encode(content).length,
          truncated,
          receivedAt: now.toISOString(),
          commit: result.commit?.sha ?? null,
        },
        201
      );
    } catch (err) {
      return json({ ok: false, error: "log_write_failed", detail: String(err.message) }, 502);
    }
  },
};
