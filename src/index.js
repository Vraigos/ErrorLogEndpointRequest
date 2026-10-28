// ErrorLogEndpointRequest
// POST-only Cloudflare Worker.
//   Request : JSON  { "UseFolder": "...", "UseFileName": "...", "Log": "..." }
//   Saved   : the Log text as a raw .log text file in a GitHub repo
//   Response: plain text (never JSON)
//
// Site settings (TimeSnap, LogRoot) come from config.json. They cannot be changed over HTTP;
// change config.json and redeploy.

import config from "../config.json";

const SERVICE = "ErrorLogEndpointRequest";
const VERSION = "2.0.0";
const MAX_BODY_CHARS = 100 * 1024;

const TIME_SNAP = config.TimeSnap !== false; // default true
const LOG_ROOT = typeof config.LogRoot === "string" && config.LogRoot ? config.LogRoot : "logs";

const text = (body, status = 200, headers = {}) =>
  new Response(String(body).replace(/\n?$/, "\n"), {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-service": SERVICE,
      ...headers,
    },
  });

// 20261029T043700123Z
const timeSnap = (d) => d.toISOString().replace(/[-:]/g, "").replace(".", "");

const randomId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(3)), (b) =>
    b.toString(16).padStart(2, "0")
  ).join("");

const toBase64 = (s) => {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
};

const fromBase64 = (b64) => {
  const bin = atob(b64.replace(/\s/g, ""));
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
};

// Case-insensitive key lookup so UseFolder / usefolder / useFolder all work.
const pick = (obj, name) => {
  const key = Object.keys(obj).find((k) => k.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : obj[key];
};

// "a/b/c" -> "a/b/c". Returns "" if empty, null if invalid.
function cleanFolder(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string") return null;
  const parts = v.replace(/\\/g, "/").split("/").map((s) => s.trim()).filter(Boolean);
  for (const p of parts) {
    if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]{0,63}$/.test(p)) return null; // no leading dot, no ".."
  }
  return parts.join("/");
}

// Returns "" if empty, null if invalid. A trailing ".log" is ignored (we add it).
function cleanName(v) {
  if (v === undefined || v === null || v === "") return "";
  if (typeof v !== "string") return null;
  const n = v.trim().replace(/\.log$/i, "");
  return /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/.test(n) ? n : null;
}

const encodePath = (p) => p.split("/").map(encodeURIComponent).join("/");

async function gh(env, method, path, body) {
  const url = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${encodePath(path)}`;
  const branch = env.GITHUB_BRANCH || "main";
  return fetch(method === "GET" ? `${url}?ref=${encodeURIComponent(branch)}` : url, {
    method,
    headers: {
      authorization: `Bearer ${env.GITHUB_TOKEN}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
      "user-agent": SERVICE,
      "content-type": "application/json",
    },
    body: body ? JSON.stringify({ ...body, branch }) : undefined,
  });
}

// Creates the file. If `append` is true and the file already exists, adds to the end of it.
async function writeLog(env, path, content, append) {
  let sha;
  let finalContent = content;
  let mode = "created";

  if (append) {
    const existing = await gh(env, "GET", path);
    if (existing.ok) {
      const data = await existing.json();
      sha = data.sha;
      const old = fromBase64(data.content || "");
      finalContent = old + (old === "" || old.endsWith("\n") ? "" : "\n") + content;
      mode = "appended";
    } else if (existing.status !== 404) {
      throw new Error(`GitHub API ${existing.status}: ${(await existing.text()).slice(0, 300)}`);
    }
  }

  const res = await gh(env, "PUT", path, {
    message: `log: ${path}`,
    content: toBase64(finalContent),
    ...(sha ? { sha } : {}),
  });
  if (!res.ok) {
    throw new Error(`GitHub API ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  const result = await res.json();
  return { mode, commit: result.commit?.sha ?? "", bytes: new TextEncoder().encode(finalContent).length };
}

export default {
  async fetch(request, env) {
    if (request.method !== "POST") {
      return text("ERROR 405 method_not_allowed\nOnly POST is accepted.", 405, { allow: "POST" });
    }

    if (env.LOG_API_KEY && request.headers.get("x-api-key") !== env.LOG_API_KEY) {
      return text("ERROR 401 unauthorized", 401);
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO) {
      return text("ERROR 500 server_not_configured", 500);
    }

    const raw = await request.text();
    if (raw.length > MAX_BODY_CHARS) {
      return text(`ERROR 413 body_too_large\nMax ${MAX_BODY_CHARS} characters.`, 413);
    }

    let payload;
    try {
      payload = JSON.parse(raw);
    } catch {
      return text("ERROR 400 invalid_json\nThe request body must be a JSON object.", 400);
    }
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
      return text("ERROR 400 invalid_json\nThe request body must be a JSON object.", 400);
    }

    const logValue = pick(payload, "Log");
    if (logValue === undefined || logValue === null || logValue === "") {
      return text('ERROR 400 missing_log\nSend the text to save in the "Log" field.', 400);
    }
    const logText = typeof logValue === "string" ? logValue : JSON.stringify(logValue, null, 2);

    const folder = cleanFolder(pick(payload, "UseFolder"));
    if (folder === null) {
      return text(
        `ERROR 400 invalid_UseFolder\nUse letters, numbers, . _ - and "/" for sub-folders.`,
        400
      );
    }
    const name = cleanName(pick(payload, "UseFileName"));
    if (name === null) {
      return text("ERROR 400 invalid_UseFileName\nUse letters, numbers, . _ - (max 100 characters).", 400);
    }

    const now = new Date();
    const id = randomId();
    // TimeSnap on  (default): 20261029T043700123Z-name.log   (every request is a new file)
    // TimeSnap off          : name.log                        (repeat requests append to the file)
    const base = TIME_SNAP ? `${timeSnap(now)}-${name || id}` : name || id;
    const path = [LOG_ROOT, folder, `${base}.log`].filter(Boolean).join("/");
    const content = logText.endsWith("\n") ? logText : logText + "\n";

    try {
      const r = await writeLog(env, path, content, !TIME_SNAP);
      return text(
        [`OK`, `file: ${path}`, `mode: ${r.mode}`, `bytes: ${r.bytes}`, `time: ${now.toISOString()}`, `commit: ${r.commit}`].join("\n"),
        201
      );
    } catch (err) {
      return text(`ERROR 502 log_write_failed\n${String(err.message)}`, 502);
    }
  },
};
