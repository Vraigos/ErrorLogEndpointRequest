// ErrorLogEndpointRequest
// A Cloudflare Worker that writes one log file to a GitHub repo for every request,
// and always answers in JSON.

const SERVICE = "ErrorLogEndpointRequest";
const VERSION = "1.0.0";
const MAX_BODY_BYTES = 10 * 1024;
const REDACTED_HEADERS = new Set([
  "authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "cf-access-jwt-assertion",
]);

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

const safeHeaders = (headers) => {
  const out = {};
  for (const [k, v] of headers) out[k] = REDACTED_HEADERS.has(k.toLowerCase()) ? "[redacted]" : v;
  return out;
};

async function readBody(request) {
  if (request.method === "GET" || request.method === "HEAD") return null;
  const text = await request.text();
  return text.length > MAX_BODY_BYTES ? text.slice(0, MAX_BODY_BYTES) + "...[truncated]" : text;
}

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

    const entry = {
      id,
      receivedAt: now.toISOString(),
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: safeHeaders(request.headers),
      body: await readBody(request),
      cf: {
        country: request.cf?.country ?? null,
        colo: request.cf?.colo ?? null,
        asn: request.cf?.asn ?? null,
      },
    };

    try {
      const result = await commitLog(
        env,
        path,
        JSON.stringify(entry, null, 2) + "\n",
        `log: ${fileName}`
      );
      return json(
        {
          ok: true,
          service: SERVICE,
          version: VERSION,
          id,
          file: path,
          receivedAt: entry.receivedAt,
          commit: result.commit?.sha ?? null,
        },
        201
      );
    } catch (err) {
      return json({ ok: false, error: "log_write_failed", detail: String(err.message) }, 502);
    }
  },
};
