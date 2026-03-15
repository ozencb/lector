# Kokoro-82M TTS Integration Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace browser Web Speech API with server-side Kokoro-82M TTS via a Python FastAPI sidecar.

**Architecture:** Python FastAPI service synthesizes audio → Fastify orchestrates generation on book import → client plays cached OGG/Opus files via HTMLAudioElement with prefetch.

**Tech Stack:** Kokoro-82M, PyTorch (CPU), FastAPI, Uvicorn, Fastify, SQLite, React, Radix UI, Docker Compose

**Spec:** `docs/superpowers/specs/2026-03-15-kokoro-tts-design.md`

---

## Chunk 1: Foundation (Python Service + DB + Types)

### Task 1: Python TTS Service

**Files:**
- Create: `tts/main.py`
- Create: `tts/requirements.txt`
- Create: `tts/Dockerfile`

- [ ] **Step 1: Create `tts/requirements.txt`**

```
kokoro>=0.9
torch>=2.0
fastapi>=0.110
uvicorn>=0.27
soundfile>=0.12
```

- [ ] **Step 2: Create `tts/main.py`**

FastAPI app with three endpoints:

- `GET /health` — returns `{"status": "ready"}` once model is loaded
- `GET /voices` — returns available voices grouped by language from Kokoro's voice list
- `POST /synthesize` — accepts `{"text": str, "voice": str, "language": str}`, returns OGG/Opus audio bytes

Implementation notes:
- Load Kokoro pipeline once at module level (global, not per-request)
- Use `kokoro.KPipeline` for synthesis
- Write audio to a `BytesIO` buffer using `soundfile`, return as `Response(media_type="audio/ogg")`
- Kokoro voices follow a naming convention like `af_heart`, `am_michael` — the first letter is language code (`a`=American English, `b`=British English, `j`=Japanese, etc.), second letter is gender
- The `/voices` endpoint should introspect available voices and group by language
- Add basic request validation (non-empty text, valid voice ID)

- [ ] **Step 3: Create `tts/Dockerfile`**

```dockerfile
FROM python:3.11-slim

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY main.py .

EXPOSE 5000

CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "5000"]
```

- [ ] **Step 4: Verify Python service starts**

```bash
cd tts && pip install -r requirements.txt && uvicorn main:app --port 5000
```

Test: `curl http://localhost:5000/health` → `{"status":"ready"}`
Test: `curl http://localhost:5000/voices` → JSON with language-grouped voices
Test: `curl -X POST http://localhost:5000/synthesize -H 'Content-Type: application/json' -d '{"text":"Hello world","voice":"af_heart","language":"en"}' --output test.ogg`

- [ ] **Step 5: Commit**

```bash
git add tts/
git commit -m "feat: add Kokoro TTS Python service"
```

---

### Task 2: Database Schema + Shared Types

**Files:**
- Modify: `server/src/db.ts:14-47` (add new table + columns)
- Modify: `shared/src/types.ts` (add TTS types)

- [ ] **Step 1: Update `server/src/db.ts`**

Add to the schema init (`db.exec` block):
- `tts_status TEXT DEFAULT 'pending'`, `tts_voice TEXT`, `tts_language TEXT` columns on `books` table
  - Since SQLite uses `CREATE TABLE IF NOT EXISTS`, adding columns requires `ALTER TABLE` statements with `try/catch` or checking column existence. Use three separate `ALTER TABLE books ADD COLUMN ...` statements, each wrapped in try/catch (column already exists = no-op on re-run).
- New `sentence_audio` table:

```sql
CREATE TABLE IF NOT EXISTS sentence_audio (
  sentence_id TEXT PRIMARY KEY REFERENCES sentences(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
);
CREATE INDEX IF NOT EXISTS idx_sentence_audio_hash ON sentence_audio(hash);
```

- [ ] **Step 2: Update `shared/src/types.ts`**

Add these types:

```typescript
export interface TtsStatus {
  status: 'pending' | 'generating' | 'completed' | 'failed';
  total: number;
  completed: number;
  failed: number;
}

export interface TtsVoice {
  id: string;
  name: string;
}

export interface TtsVoiceMap {
  [language: string]: TtsVoice[];
}
```

Add to `Book` interface:
```typescript
ttsStatus: 'pending' | 'generating' | 'completed' | 'failed';
```

Add to `BookUploadResponse` interface:
```typescript
ttsStatus: 'pending' | 'generating' | 'completed' | 'failed';
```

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Fix any type errors from the `Book` / `BookUploadResponse` changes rippling through `books.ts`, `api.ts`, `BookCard.tsx`, `LibraryPage.tsx`.

The key changes needed:
- `server/src/routes/books.ts`: add `ttsStatus` to `GET /api/books` query and response mapping, add `ttsStatus` to `POST /api/books` response
- `client/src/services/api.ts`: `uploadBook` function — no changes needed (types flow from shared)
- Components referencing `Book` type may need no changes if `ttsStatus` is just added to the interface

- [ ] **Step 4: Commit**

```bash
git add server/src/db.ts shared/src/types.ts server/src/routes/books.ts
git commit -m "feat: add TTS schema and shared types"
```

---

### Task 3: TTS Generator Service

**Files:**
- Create: `server/src/services/tts-generator.ts`

- [ ] **Step 1: Create `server/src/services/tts-generator.ts`**

This module manages background audio generation. Key responsibilities:

**Queue:** Sequential processing — one book at a time. Use a simple array queue + processing flag.

**Main function: `enqueueBookGeneration(bookId: string, voice: string, language: string)`**
- Push to queue, start processing if not already running

**Processing function: `processBook(bookId: string, voice: string, language: string)`**
- Get all sentences for the book (join sentences → chapters → books)
- Set book's `tts_status = 'generating'`
- For each sentence:
  - Compute hash: `crypto.createHash('sha256').update(text + voice + language).digest('hex').slice(0, 16)`
  - Check if `data/tts/{hash}.ogg` exists on disk → skip if so, insert `sentence_audio` row with `status = 'completed'`
  - Otherwise call `POST http://{TTS_SERVICE_URL}/synthesize` with `{text, voice, language}`
  - Retry up to 3 times with exponential backoff (1s, 2s, 4s) on synthesis failure. For connection errors (TTS service not yet ready), retry indefinitely with 5s intervals until the service responds — the model can take 30+ seconds to load on CPU
  - Write response bytes to `data/tts/{hash}.ogg`
  - Insert `sentence_audio` row with `status = 'completed'` (or `'failed'` after retries exhausted)
  - On failure: read user preference from request (passed into enqueue). If "stop" → set `tts_status = 'failed'`, abort. If "skip" → mark sentence failed, continue.
- On completion: set `tts_status = 'completed'`

**Helper: `getBookTtsStatus(bookId: string): TtsStatus`**
- Query counts from `sentence_audio` joined with `sentences`/`chapters` for the book

**Helper: `cleanupOrphanedAudio()`**
- Called after book deletion
- Find hashes in `data/tts/` that have no remaining `sentence_audio` rows → delete files

**Config:**
- `TTS_SERVICE_URL` from `process.env.TTS_SERVICE_URL || 'http://localhost:5000'`
- `mkdirSync('data/tts', { recursive: true })` on module load

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add server/src/services/tts-generator.ts
git commit -m "feat: add TTS generation service with queue"
```

---

### Task 4: Server Routes + Book Upload Changes

**Files:**
- Create: `server/src/routes/tts.ts`
- Modify: `server/src/routes/books.ts:26-134` (upload), `server/src/routes/books.ts:219-239` (delete)
- Modify: `server/src/index.ts:8-9,54-55` (register routes)

- [ ] **Step 1: Create `server/src/routes/tts.ts`**

Three endpoints:

**`GET /api/tts/voices`**
- Proxy to Python service: `fetch(TTS_SERVICE_URL + '/voices')`
- Return JSON response

**`GET /api/books/:id/tts-status`**
- Call `getBookTtsStatus(bookId)` from tts-generator
- Return `{ status, total, completed, failed }`

**`GET /api/tts/:sentenceId`**
- Look up `sentence_audio` row by `sentence_id`
- If not found → 404
- If `status = 'failed'` → `404` with `{ reason: 'failed' }`
- If `status = 'completed'` → read `data/tts/{hash}.ogg`, return with:
  - `Content-Type: audio/ogg`
  - `Cache-Control: public, immutable, max-age=31536000`

**`POST /api/books/:id/regenerate`**
- Re-triggers TTS generation for a book (used by retry button on failed books)
- Resets all `sentence_audio` rows with `status = 'failed'` to `'pending'`
- Sets book `tts_status = 'pending'`
- Calls `enqueueBookGeneration(bookId, book.tts_voice, book.tts_language, errorBehavior)`
- Returns `{ status: 'queued' }`

- [ ] **Step 2: Modify `POST /api/books` in `books.ts`**

After `const data = await request.file()`:
- Parse additional multipart fields from the request. Use `data.fields` to get `voice` and `language` values. Fastify multipart makes these available as `data.fields.voice` and `data.fields.language`.
- These are optional — if not provided, use defaults (e.g., `'af_heart'` and `'en'`).

In the `insertBook.run()` call:
- Add `tts_voice` and `tts_language` columns to the INSERT
- Set `tts_status = 'pending'`

After `insertAll()` and before returning the response:
- Call `enqueueBookGeneration(bookId, voice, language, errorBehavior)` (import from tts-generator)
- `errorBehavior` is passed as a multipart field too (default: `'skip'`)

Update the response to include `ttsStatus: 'pending'`.

Update the `GET /api/books` query to also select `b.tts_status` and map it to `ttsStatus` in the response.

Update the `GET /api/books/:id` query similarly.

- [ ] **Step 3: Modify `DELETE /api/books/:id` in `books.ts`**

After `db.prepare('DELETE FROM books WHERE id = ?').run(book.id)`:
- Call `cleanupOrphanedAudio()` (import from tts-generator)

- [ ] **Step 4: Register TTS routes in `index.ts`**

Add import: `import { ttsRoutes } from './routes/tts.js';`
Add registration: `server.register(ttsRoutes);`

Also add static serving for TTS audio directory (optional — since we're serving via the route handler with custom headers, this isn't needed).

- [ ] **Step 5: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 6: Commit**

```bash
git add server/src/routes/tts.ts server/src/routes/books.ts server/src/index.ts
git commit -m "feat: add TTS routes and wire up book upload"
```

---

## Chunk 2: Client Changes

### Task 5: Client API Service Updates

**Files:**
- Modify: `client/src/services/api.ts`

- [ ] **Step 1: Modify existing `uploadBook` and add new API functions**

Replace the existing `uploadBook` function (it currently only sends `file`):

```typescript
export function uploadBook(file: File, voice?: string, language?: string, errorBehavior?: string): Promise<BookUploadResponse> {
  const form = new FormData();
  form.append('file', file);
  if (voice) form.append('voice', voice);
  if (language) form.append('language', language);
  if (errorBehavior) form.append('errorBehavior', errorBehavior);
  return request<BookUploadResponse>('/api/books', {
    method: 'POST',
    body: form,
  });
}

export function getTtsStatus(bookId: string): Promise<TtsStatus> {
  return request<TtsStatus>(`/api/books/${bookId}/tts-status`);
}

export function getTtsVoices(): Promise<TtsVoiceMap> {
  return request<TtsVoiceMap>('/api/tts/voices');
}

export function getTtsAudioUrl(sentenceId: string): string {
  return `${BASE_URL}/api/tts/${sentenceId}`;
}

export function regenerateBookAudio(bookId: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/books/${bookId}/regenerate`, {
    method: 'POST',
  });
}
```

Add `TtsStatus` and `TtsVoiceMap` to the import from `@tts-reader/shared`.

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add client/src/services/api.ts
git commit -m "feat: add TTS API client functions"
```

---

### Task 6: Rewrite `useTTS` Hook + Update ReaderPage

**Files:**
- Rewrite: `client/src/hooks/useTTS.ts`
- Modify: `client/src/pages/ReaderPage.tsx`

These must be done together to keep typecheck passing.

- [ ] **Step 1: Rewrite `useTTS.ts`**

Complete rewrite. New interface:

```typescript
interface UseTTSOptions {
  sentenceId: string | undefined;
  prefetchIds?: string[];
  onEnd: () => boolean | void;
}
```

Returns: `{ isPlaying, play, pause, speed, setSpeed }`

Remove: `voices`, `selectedVoice`, `setVoice` (no longer needed — voice is set at import time).

Implementation:
- Use `HTMLAudioElement` for playback (create once, reuse)
- `play()`:
  - Set `audio.src = getTtsAudioUrl(sentenceId)`
  - Set `audio.playbackRate = speed`
  - Call `audio.play()`
- `pause()`:
  - Call `audio.pause()`
- On `audio.ended` event → call `onEnd()`, same logic as before
- **Prefetch:** when `sentenceId` changes while playing, prefetch next N sentences
  - ReaderPage passes the next 3-5 sentence IDs via `prefetchIds`
  - Prefetch via `fetch(getTtsAudioUrl(id))` — browser caches the response due to immutable Cache-Control
  - On 404: retry after 3 seconds (sentence not yet generated)
- Speed persistence: keep `SPEED_STORAGE_KEY` in localStorage (same as current)
- Remove: `VOICE_STORAGE_KEY`, `adjustRate()`, `speechSynthesis` usage, Chrome 50ms workaround

- [ ] **Step 2: Update ReaderPage to match new hook interface**

Changes:
- Update `useTTS` call:
  ```typescript
  const tts = useTTS({
    sentenceId: currentSentence?.id,
    prefetchIds: chapter?.sentences
      .slice(sentenceIdx + 1, sentenceIdx + 6)
      .map(s => s.id),
    onEnd: () => {
      if (isAtEndRef.current) return false;
      goToSentence('next');
    },
  });
  ```
- Remove voice picker button and dialog (lines ~439-482, the `SpeakerLoudIcon` button and voice picker `Dialog.Root`)
- Remove `voicePickerOpen` state
- Remove `SpeakerLoudIcon` import
- Keep speed picker — it now controls `audio.playbackRate` (same interface, no changes needed)
- Update keyboard shortcut speed cap from `2.0` to `3.0` to match the `SPEED_OPTIONS` array range
- Add TTS availability indicator: if book's `ttsStatus !== 'completed'`, show a banner like "Audio generating..." above the sentence area
- When a sentence has no audio (404 from prefetch), show a subtle indicator

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

Must pass — both files updated together.

- [ ] **Step 4: Commit**

```bash
git add client/src/hooks/useTTS.ts client/src/pages/ReaderPage.tsx
git commit -m "feat: rewrite useTTS and ReaderPage for Kokoro audio playback"
```

---

### Task 7: Settings Panel Component

**Files:**
- Create: `client/src/components/SettingsPanel.tsx`
- Create: `client/src/components/SettingsPanel.module.scss`

- [ ] **Step 1: Create `SettingsPanel.tsx`**

A Radix Dialog containing:
- **Default language** dropdown — populated from `getTtsVoices()` (language keys)
- **Default voice** dropdown — filtered by selected language
- **Skip import dialog** toggle (Radix Switch)
- **On generation failure** dropdown: "Skip failed sentences" / "Stop generation"

All settings read/written to localStorage:
- `tts-default-language` (string, default: `'en'`)
- `tts-default-voice` (string, default: `''` = first available)
- `tts-skip-import-dialog` (boolean string, default: `'false'`)
- `tts-error-behavior` (string: `'skip'` | `'stop'`, default: `'skip'`)

Props:
```typescript
interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}
```

Fetch voices on mount via `getTtsVoices()`. Cache the result.

Follow existing dialog styling patterns from ReaderPage (`.dialogOverlay`, `.dialogContent`, etc.).

- [ ] **Step 2: Create `SettingsPanel.module.scss`**

Style the dialog matching existing patterns. Include:
- `.settingsRow` — flex row with label + control
- `.select` — styled select dropdown
- Reuse dialog overlay/content patterns from `ReaderPage.module.scss`

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/SettingsPanel.tsx client/src/components/SettingsPanel.module.scss
git commit -m "feat: add settings panel component"
```

---

### Task 8: Import Modal Component

**Files:**
- Create: `client/src/components/ImportModal.tsx`
- Create: `client/src/components/ImportModal.module.scss`

- [ ] **Step 1: Create `ImportModal.tsx`**

Radix Dialog shown after user selects an epub file (before upload).

Props:
```typescript
interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (voice: string, language: string) => void;
}
```

Content:
- Language dropdown (from `getTtsVoices()`)
- Voice dropdown (filtered by language)
- Pre-filled from localStorage defaults (`tts-default-language`, `tts-default-voice`)
- "Import" button → calls `onConfirm(voice, language)`
- "Cancel" button → closes modal

- [ ] **Step 2: Create `ImportModal.module.scss`**

Match existing modal patterns.

- [ ] **Step 3: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add client/src/components/ImportModal.tsx client/src/components/ImportModal.module.scss
git commit -m "feat: add import modal for voice/language selection"
```

---

### Task 9: BookCard + LibraryPage Changes

> **Note:** The old Task 10 (ReaderPage changes) has been merged into Task 6 to avoid typecheck breakage between commits.

**Files:**
- Modify: `client/src/components/BookCard.tsx`
- Modify: `client/src/components/BookCard.module.scss`
- Modify: `client/src/pages/LibraryPage.tsx`

- [ ] **Step 1: Update `BookCard.tsx`**

Add TTS status indicator below the progress bar:
- `ttsStatus === 'generating'` → show "Generating audio..." with a small spinner or progress text
- `ttsStatus === 'completed'` → show nothing (or a subtle checkmark)
- `ttsStatus === 'failed'` → show "Audio failed" with a retry button
- `ttsStatus === 'pending'` → show "Audio pending..."

For generating state: poll `getTtsStatus(book.id)` every 5 seconds to update progress display. Show `"{completed}/{total} sentences"`.

Add retry button for failed books — calls `regenerateBookAudio(book.id)` (from `api.ts`) and refreshes the book list.

- [ ] **Step 2: Update `BookCard.module.scss`**

Add styles for:
- `.ttsStatus` — small text below progress bar
- `.ttsRetry` — small retry button
- `.ttsSpinner` — reuse existing spinner pattern

- [ ] **Step 3: Update `LibraryPage.tsx`**

Changes:
- Import `ImportModal` and `SettingsPanel`
- Add state for `importModalOpen`, `settingsOpen`, `pendingFile`
- Modify `handleUpload`:
  - When file selected, check localStorage `tts-skip-import-dialog`
  - If skip: call `uploadBook(file, defaultVoice, defaultLanguage, errorBehavior)` directly
  - If not skip: set `pendingFile = file`, open ImportModal
- Add `handleImportConfirm(voice, language)`:
  - Call `uploadBook(pendingFile, voice, language, errorBehavior)`
  - Close modal, refresh books
- Add settings gear button in header (next to ThemeToggle)
- Render `<ImportModal>` and `<SettingsPanel>` in JSX

- [ ] **Step 4: Run typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add client/src/components/BookCard.tsx client/src/components/BookCard.module.scss client/src/pages/LibraryPage.tsx
git commit -m "feat: add TTS status to book cards and import flow"
```

---

## Chunk 3: Docker + Integration

### Task 10: Docker Compose + Dockerfile

**Files:**
- Modify: `docker-compose.yml`
- Create: `tts/Dockerfile` (already done in Task 1, verify)

- [ ] **Step 1: Update `docker-compose.yml`**

```yaml
services:
  lector:
    image: ghcr.io/ozencb/lector:latest
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/server/data
    environment:
      - NODE_ENV=production
      - TTS_SERVICE_URL=http://tts:5000

  tts:
    build: ./tts
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 10s
      timeout: 5s
      retries: 10
    restart: unless-stopped
```

Notes:
- `retries: 10` because model loading can take 30+ seconds on CPU.
- Service renamed from `tts-reader` to `lector` (matches the app rename in commit `a350b0d`). Breaking change for users of the old compose file.

- [ ] **Step 2: Update `.gitignore`**

Add `data/tts/` if not already covered by `data/`.

- [ ] **Step 3: Verify full Docker Compose startup**

```bash
docker compose build && docker compose up
```

Verify:
- TTS service starts and `/health` returns ready
- Lector starts and can reach TTS service
- Upload an epub → audio generation starts
- Audio files appear in `data/tts/`

- [ ] **Step 4: Commit**

```bash
git add docker-compose.yml .gitignore
git commit -m "feat: add TTS service to Docker Compose"
```

---

### Task 11: Final Typecheck + Cleanup

- [ ] **Step 1: Full typecheck**

```bash
npx tsc --noEmit
```

Fix any remaining type errors.

- [ ] **Step 2: Remove dead code**

- Delete any remaining Web Speech API references
- Remove unused imports

- [ ] **Step 3: Commit**

```bash
git add -u
git commit -m "chore: cleanup dead Web Speech API code"
```
