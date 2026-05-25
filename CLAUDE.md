# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A NestJS 11 + Express API that wraps Google's **Gemini File Search** (managed RAG: upload → chunk/embed/index → query) and pulls source documents from **Google Drive** via a service account. The dark, Maintain-Technology-branded HTML console at `/` calls the same `/v1` API. Swagger UI at `/api`.

This project is a 1:1 backend clone of the NGM `gemini-file-search-api` — same controllers, same DTOs, same services. The only differences are the project name, the UI design system (Maintain dark/orange instead of editorial light/serif), and the localStorage / JS namespace (`MT.*` and `mt_*` keys instead of `GFS.*` and `gfs_*`).

## Commands

```powershell
npm install
npm run start:dev          # nest start --watch  (recommended dev mode)
npm run build              # nest build → dist/
npm run start:prod         # node dist/main
npm run lint               # eslint --fix
npm run format             # prettier
npm test                   # jest, *.spec.ts under src/
npm run test:cov           # with coverage
npm run test:e2e           # uses test/jest-e2e.json
# Single test:
npx jest src/path/to/file.spec.ts -t "test name"
```

Always start the server from the repo root — [app.controller.ts](src/app.controller.ts) reads `public/*.html` from `process.cwd()`.

## Environment & restart caveats

`.env` is loaded **once** by `ConfigModule.forRoot({ isGlobal: true })` at boot. `nest start --watch` watches `src/` only — **editing `.env` requires a manual restart**. Same for `service-account.json`: [DriveService](src/drive/drive.service.ts) reads it in its constructor; a new file at the repo root will not be picked up until restart.

Required env (see [.env.example](.env.example)):
- `KB_API_KEY` — gatekeeper for the app's own `/v1` routes. Missing/empty → guard throws **503**, not 401. Same env var name as the NGM `pinecone-ragapi` and `gemini-file-search-api` so one value can gate every NGM/MT RAG service.
- `GEMINI_API_KEY` — server-side default for Google calls. Per-request override via `x-gemini-key` header.
- `GEMINI_API_BASE` — defaults to `https://generativelanguage.googleapis.com/v1beta`.
- `GEMINI_MODEL` — answer model, defaults to `gemini-2.5-flash`.
- `GEMINI_EMBEDDING_MODEL` — blank = API default; `models/gemini-embedding-2` enables image indexing inside documents.
- `GOOGLE_SERVICE_ACCOUNT_JSON` (inline, single-line) **OR** `GOOGLE_SERVICE_ACCOUNT_FILE` (path, default `./service-account.json`). Inline takes precedence if both are set. Leave both blank to disable Drive; the rest of the API still works.

## Two-key auth — easy to confuse

The API has **two unrelated keys**.

| Key | Purpose | How it travels |
|---|---|---|
| `KB_API_KEY` | Gatekeeper for the app's own `/v1/*` routes | `x-api-key` header (or `?api_key=` query) → checked by [ApiKeyGuard](src/common/api-key.guard.ts) on every controller |
| `GEMINI_API_KEY` | Used by `GeminiService` to call Google | Server-side default; per-request override with `x-gemini-key` header, passed as the last `apiKey?` arg through every method on [GeminiService](src/gemini/gemini.service.ts) |

`ApiKeyGuard` is registered as a provider in [app.module.ts](src/app.module.ts) but **not globally bound** — controllers opt in with `@UseGuards(ApiKeyGuard)`. `/health` and all `/`, `/console`, `/configure`, `/documents` page routes are intentionally unguarded; everything under `/v1` is guarded.

## Architecture: how a file gets indexed and answered

1. **Create store** — `POST /v1/stores` → `GeminiService.createStore` → `POST {base}/fileSearchStores?key=…`. Response may be a long-running operation; the service detects this via `name.includes('operations/')` and falls through to `pollOperation`.
2. **Upload** — `POST /v1/stores/{id}/upload` (multipart) or via Drive sync. Critical: Gemini File Search does NOT accept a plain multipart form. [`uploadFile`](src/gemini/gemini.service.ts) does a **two-step resumable upload**:
   - Step 1: `POST {upload-base}/{store}:uploadToFileSearchStore` with `X-Goog-Upload-Command: start` → response carries the real upload URL in the `x-goog-upload-url` header.
   - Step 2: `POST` the raw bytes to that URL with `X-Goog-Upload-Command: upload, finalize`.
   - The finalize response is an operation → `pollOperation` (every 2 s, max 150 attempts ≈ 5 min; axios timeout 300 s).
3. **Search** — `POST /v1/search` → `POST {base}/models/{model}:generateContent` with body `{ contents: [{parts:[{text}]}], tools: [{file_search: { file_search_store_names: [name], metadata_filter? }}] }`. Response is parsed: `candidates[0].content.parts[].text` → `answer`; `candidates[0].groundingMetadata.groundingChunks[].retrievedContext` → deduped `citations` (title, page, ≤320-char snippet).

`upload-base` is derived from `GEMINI_API_BASE` by inserting `/upload` after the host (`…googleapis.com/v1beta` → `…googleapis.com/upload/v1beta`).

## Architecture: Drive ingest

[`DriveService`](src/drive/drive.service.ts) authenticates a service account at construction. If creds are missing/invalid, `this.drive` stays `null` and `this.configError` holds a human message; every API call goes through `requireDrive()` which throws **503** carrying that message. Inspect `GET /v1/drive/status` first to see whether Drive is wired up and which service-account email needs the share.

`listFiles(folderId)` is **recursive** — BFS-walks every subfolder under the root, paginates (`pageSize: 1000`), supports shared drives. `classify(meta)` then picks per-file:
- **`export`** — Google Docs/Sheets/Slides/Drawings → PDF/XLSX/PDF/PNG (see `GOOGLE_EXPORT` map). `downloadFile` calls `drive.files.export`.
- **`skip`** — any other `application/vnd.google-apps.*`, anything in `SKIP_EXTENSIONS` (video/audio/archives/executables), or files larger than 100 MB (File Search hard limit).
- **`download`** — everything else; pulled via `drive.files.get` with `alt: 'media'`.

Operator prerequisites: the Drive folder must be shared with the service account's `client_email`, and the Drive API must be enabled in the GCP project.

[`POST /v1/drive/sync`](src/controllers/drive.controller.ts) orchestrates the ingest: list → classify → optionally truncate to `limit` → optionally `dryRun` → either reuse `store` or `createStore` → for each non-skip file: `drive.downloadFile()` → `gemini.uploadFile()`. **Per-file failures are caught and reported**, not fatal to the batch — the response contains `uploaded`, `failed`, `skipped`, and a `results[]` array per file.

## Error handling convention

Both services centralize upstream errors in a private `fail(context, err)` that maps Google's HTTP status onto a NestJS `HttpException` with the same status (when 4xx/5xx). Both default to **502 BAD_GATEWAY** when the upstream status is missing. This is why callers see meaningful codes (e.g. 403 if a folder isn't shared) rather than generic 500s — don't replace these with bare try/catch.

## Frontend

The frontend is split across `public/index.html` (landing), `public/console.html` (Ask + Sync + Activity), `public/configure.html` (keys + stores + upload), and `public/documents.html` (2-column documents browser with sticky side drawer).

Shared chrome lives in [public/css/site.css](public/css/site.css) and [public/js/site.js](public/js/site.js) (the `MT.*` namespace). Both keys are stored in `localStorage` (`mt_kbKey`, `mt_geminiKey`); the configure page hydrates them and `MT.headers()` reads them on every request. localStorage keys are prefixed `mt_` (rather than the NGM project's `gfs_`) so the same browser can hold separate credentials for both apps.

The design system follows the **Maintain Technology brand** — deep slate-navy `#0E1622` canvas, vibrant orange `#FF5A1F` accent, all-caps Manrope display headlines, JetBrains Mono labels, numbered cards, no rounded corners, borders not shadows, orange CTA accent bar at the page foot. The canonical reference is `.claude/skills/maintain-design-system/SKILL.md`.

## Conventions worth respecting

- Global `ValidationPipe({ whitelist: true, transform: true })` — extra fields on request bodies are silently dropped. Add a field to the relevant DTO in `src/dto/` before expecting it server-side.
- `GeminiService.normalizeStoreName` accepts both bare IDs and full `fileSearchStores/...` names — pass whichever the user gives; don't pre-strip.
- The optional `x-gemini-key` override threads through every controller as the last argument. If you add a new Gemini-backed endpoint, plumb `@Headers('x-gemini-key') geminiKey?: string` and forward it.
- The Markdown renderer in `public/js/site.js` uses `__MT_CB_N__` / `__MT_IC_N__` placeholders for fenced and inline code so common pharmacology / chemistry terms (e.g. `IC50`, `CB1`) never collide with the extract-restore pattern.
