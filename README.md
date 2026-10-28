# ErrorLogEndpointRequest

A Cloudflare Worker endpoint. Every request creates a new log file in a GitHub repo
(`logs/{TimeSnap}-{id}Delta.log`) and the response is always JSON. The GitHub token is stored
as a Cloudflare **secret**, so it never appears in the code or the repo.

## Step-by-step setup

### 1. Have a repo to store the logs
Create (or reuse) a GitHub repo, for example `ErrorLogReport`, and push it so it exists on GitHub
with a `main` branch (it needs at least one commit).

### 2. Create a fine-grained GitHub token
1. GitHub -> Settings -> Developer settings -> Personal access tokens -> **Fine-grained tokens** -> Generate new token.
2. Repository access: **Only select repositories** -> pick `ErrorLogReport`.
3. Permissions -> Repository permissions -> **Contents: Read and write**. Leave everything else off.
4. Set a short expiry (e.g. 90 days), generate, and copy the token (starts with `github_pat_`). You only see it once.

### 3. Install the project
```bash
npm install
npx wrangler login      # opens a browser to sign in to Cloudflare
```

### 4. Set your non-secret config
Edit `wrangler.toml` and set `GITHUB_OWNER` to your GitHub username (and `GITHUB_REPO` / `GITHUB_BRANCH` if different).

### 5. Store the secrets in Cloudflare
```bash
npx wrangler secret put GITHUB_TOKEN   # paste the github_pat_... token when prompted
npx wrangler secret put LOG_API_KEY    # paste any long random string; callers must send it
```
Generate a random key with: `openssl rand -hex 32`

Dashboard alternative: Workers & Pages -> your Worker -> Settings -> Variables and Secrets -> Add -> type **Secret**.

### 6. (Optional) Test locally
```bash
cp .dev.vars.example .dev.vars   # fill in real values; this file is git-ignored
npm run dev
curl -X POST http://localhost:8787/report -H "x-api-key: YOUR_KEY" -d '{"error":"boom"}'
```

### 7. Deploy
```bash
npm run deploy
```
Wrangler prints your URL, like `https://error-log-endpoint-request.<your-subdomain>.workers.dev`.

### 8. Send a request
```bash
curl -X POST https://error-log-endpoint-request.<your-subdomain>.workers.dev/report \
  -H "x-api-key: YOUR_KEY" \
  -H "content-type: application/json" \
  -d '{"error":"Something failed","code":500}'
```

## JSON responses

Success (`201`):
```json
{
  "ok": true,
  "service": "ErrorLogEndpointRequest",
  "version": "1.0.0",
  "id": "a1b2c3",
  "file": "logs/20261028T211700123Z-a1b2c3Delta.log",
  "receivedAt": "2026-10-28T21:17:00.123Z",
  "commit": "<sha>"
}
```

Errors: `401 {"ok":false,"error":"unauthorized"}`, `500 {"ok":false,"error":"server_not_configured"}`,
`502 {"ok":false,"error":"log_write_failed",...}`. `GET /health` returns `{"ok":true,...}` and writes no log.

## Security notes
- Never put the token in `wrangler.toml`, the code, or git. Only `wrangler secret put` or `.dev.vars` (ignored).
- The token only has Contents access to the one log repo. Rotate it before it expires.
- `LOG_API_KEY` stops strangers from filling your repo with logs. Without it, anyone who finds the URL can write logs.
- Headers like `authorization`, `cookie` and `x-api-key` are redacted before logging; bodies are cut at 10 KB.
