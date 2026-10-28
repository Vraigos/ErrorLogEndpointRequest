# ErrorLogEndpointRequest

A POST-only Cloudflare Worker. You send a **JSON** request; it saves the text as a **raw .log file**
in a GitHub repo and answers in **plain text** (never JSON). The GitHub token is stored as a
Cloudflare **secret**, so it never appears in the code or the repo.

## Request

`POST` to any path, body is JSON:

| Field | Required | Meaning |
|---|---|---|
| `Log` | yes | The text saved in the log file. If it is not a string (an object, say) it is saved as formatted JSON text. |
| `UseFolder` | no | Folder or path inside the log root, e.g. `"checkout"` or `"app/errors/payments"`. Created automatically. Letters, numbers, `. _ -` and `/`, any number of levels. |
| `UseFileName` | no | File name without extension (`.log` is added). Letters, numbers, `. _ -`. |

Field names are not case-sensitive.

```bash
curl -X POST https://<your-worker>.workers.dev/ \
  -H "content-type: application/json" \
  -d '{"UseFolder":"checkout","UseFileName":"payment","Log":"ERROR card declined (code 402)"}'
```

Add `-H "x-api-key: YOUR_KEY"` if you set the `LOG_API_KEY` secret.

## Where the file goes

`{LogRoot}/{UseFolder}/{file}.log`, with `LogRoot` = `logs` by default.

## Site config (config.json)

```json
{
  "TimeSnap": true,
  "LogRoot": "logs"
}
```

These are site settings. They **cannot be changed by an HTTP request**. Edit `config.json`, push, and the Worker redeploys.

| `TimeSnap` | File name | Repeat requests |
|---|---|---|
| `true` (default) | `20261029T043700123Z-{UseFileName}.log` (or `...-{random id}.log` when no name) | Every request makes a new file |
| `false` | `{UseFileName}.log` (or `{random id}.log` when no name) | Requests with the same folder and name **append** to one file |

## Response (plain text)

Success, status `201`:
```
OK
file: logs/checkout/20261029T043700123Z-payment.log
mode: created
bytes: 33
time: 2026-10-29T04:37:00.123Z
commit: <sha>
```

Errors are also plain text, starting with `ERROR <status> <reason>`:
`405` not POST, `401` wrong or missing key, `400` bad JSON / missing `Log` / bad `UseFolder` or `UseFileName`,
`413` body over 100 KB, `500` not configured, `502` GitHub write failed.

## Setup (step by step)

1. **Log repo**: create a GitHub repo (e.g. `ErrorLogReport`) with a `main` branch (at least one commit).
2. **Token**: GitHub -> Settings -> Developer settings -> Fine-grained tokens -> Generate new token.
   Only select repositories -> your log repo. Permissions -> **Contents: Read and write**. Short expiry. Copy it.
3. **Install**: `npm install` then `npx wrangler login`.
4. **Variables** (plain text, in `wrangler.toml` or the dashboard): `GITHUB_OWNER`, `GITHUB_REPO`, `GITHUB_BRANCH`.
5. **Secrets**: `npx wrangler secret put GITHUB_TOKEN`, and optionally `npx wrangler secret put LOG_API_KEY`
   (dashboard: Worker -> Settings -> Variables and Secrets -> type Secret).
6. **Deploy**: `npm run deploy`, or connect the GitHub repo in Cloudflare so every push redeploys.
7. **Local test**: copy `.dev.vars.example` to `.dev.vars`, fill it in, run `npm run dev`.

## Security notes
- Never put the token in `wrangler.toml`, the code, or git. Use `wrangler secret put` or `.dev.vars` (git-ignored).
- The token only has Contents access to the one log repo. Rotate it before it expires.
- Without `LOG_API_KEY`, anyone who finds the URL can write logs into your repo.
- Only the `Log` text is saved. Headers (including the API key) are never written to the log.
- Folder and file names are validated, so requests cannot write outside the log root.
- The log repo is public unless you make it private. Don't log passwords or tokens.
