# mt-filestore-kb

**Maintain Technology — File Store Knowledge Base API.**

A NestJS 11 API + dark-themed web console for **Gemini File Search** — Google's managed RAG service. Index documents (uploaded directly or pulled from a Google Drive folder), then ask grounded questions and get answers with citations.

Same API surface as the NGM `gemini-file-search-api`, restyled in the Maintain Technology design system (deep slate-navy, vibrant orange, all-caps Manrope display, JetBrains Mono labels).

- **Home** — `GET /` — developer reference & landing.
- **Console** — `GET /console` — ask questions, sync Drive, view activity.
- **Documents** — `GET /documents` — sortable / filterable browser of a store's documents (2-column with side detail drawer).
- **Configure** — `GET /configure` — keys, stores, direct file upload.
- **Swagger docs** — `GET /api` — interactive API reference.
- **Health** — `GET /health` — liveness check (no key needed).
- **API** — `/v1/*` — protected by the `x-api-key` header (`KB_API_KEY`).

---

## How Gemini File Search actually works

There is **no "Google Drive key"** you hand to Gemini. File Search does not connect to Drive. It is a managed store you push files *into*. The pipeline is three stages:

```
Google Drive ──► Drive API ──► Gemini File Search store ──► generateContent
  (your data)   download files   upload + chunk + embed     query with the
                                  + index (Google hosts)     file_search tool
```

This API does all three for you:

1. **Create a store** — `POST /v1/stores`
2. **Add documents** — upload files (`POST /v1/stores/{id}/upload`) or sync a Drive folder (`POST /v1/drive/sync`)
3. **Search** — `POST /v1/search` runs `generateContent` with the `file_search` tool and returns the answer plus citations.

Docs reference: <https://ai.google.dev/gemini-api/docs/file-search>

---

## Setup

### 1. Install

```powershell
cd mt-filestore-kb
npm install
```

### 2. Configure `.env`

Copy `.env.example` to `.env` and fill in:

| Variable | Purpose |
|---|---|
| `KB_API_KEY` | Clients must send this in the `x-api-key` header. Same env var name as the NGM pinecone-ragapi and gemini-file-search-api. |
| `GEMINI_API_KEY` | Your Gemini key (used server-side). |
| `GEMINI_MODEL` | Answer model — default `gemini-2.5-flash`. |
| `GEMINI_EMBEDDING_MODEL` | Optional; `models/gemini-embedding-2` for image indexing. |
| `GOOGLE_SERVICE_ACCOUNT_FILE` | Path to the Drive service-account JSON. |

Generate a `KB_API_KEY`:

```powershell
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

### 3. (Optional) Enable Google Drive

Drive endpoints stay disabled until you add a **service account**:

1. Open <https://console.cloud.google.com/> → create or pick a project.
2. Enable the Drive API: <https://console.cloud.google.com/apis/library/drive.googleapis.com>
3. **IAM & Admin → Service Accounts → Create service account.**
4. On the new account → **Keys → Add key → Create new key → JSON.** Download it.
5. Save that file as `service-account.json` in this folder (or point `GOOGLE_SERVICE_ACCOUNT_FILE` at it). On Railway, paste the JSON into `GOOGLE_SERVICE_ACCOUNT_JSON` as a single line.
6. **Share** the Google Drive folder you want to index with the service account's email address (`...@...iam.gserviceaccount.com`) — Viewer access is enough. `GET /v1/drive/status` shows that email.

### 4. Run

```powershell
npm run start:dev      # watch mode
# or
npm run build && npm run start:prod
```

Then open <http://localhost:3000> (console) or <http://localhost:3000/api> (Swagger).

---

## Endpoints

All `/v1` endpoints require the `x-api-key` header. An optional `x-gemini-key` header overrides the server's Gemini key per request.

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/health` | Health check (no key needed). |
| `POST` | `/v1/stores` | Create a File Search store. |
| `GET` | `/v1/stores` | List stores. |
| `GET` | `/v1/stores/{id}` | Get one store. |
| `DELETE` | `/v1/stores/{id}` | Delete a store (`?force=true`). |
| `GET` | `/v1/stores/{id}/documents` | List indexed documents. |
| `POST` | `/v1/stores/{id}/upload` | Upload + index a file (multipart). |
| `POST` | `/v1/search` | Ask a question grounded in a store. |
| `GET` | `/v1/drive/status` | Check Drive service-account config. |
| `GET` | `/v1/drive/files?folderId=` | Preview files in a Drive folder. |
| `POST` | `/v1/drive/sync` | Ingest a Drive folder into a store. |

### Example: search

```bash
curl -X POST http://localhost:3000/v1/search \
  -H "x-api-key: YOUR_KB_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "store": "fileSearchStores/abc123", "query": "Summarise the rescue plan." }'
```

---

## Deploying to Railway

1. Push to GitHub and link the repo in Railway (or `railway init` + `railway up` via CLI).
2. Set environment variables in the Railway dashboard:
   - `KB_API_KEY`
   - `GEMINI_API_KEY`
   - `GOOGLE_SERVICE_ACCOUNT_JSON` (inline JSON — file path won't work on Railway)
3. Railway auto-provides `PORT`. Health check is configured on `/health` in `railway.json`.

---

## Notes

- Supported files: PDF, Word, Excel, PowerPoint, text, Markdown, HTML, CSV, JSON, and source code. Audio/video and files over 100 MB are skipped.
- Costs: indexing is charged once (~$0.15 / 1M tokens); storage is free; the free tier holds up to 1 GB.
- `npm run start` must be run from this folder so `public/index.html` resolves.
- Visual styling follows the Maintain Technology design system documented in `.claude/skills/maintain-design-system/SKILL.md`.
