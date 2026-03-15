# Server-Side TTS with Kokoro-82M — Design Spec

Replace browser Web Speech API with server-side Kokoro-82M for higher quality, cross-browser consistent text-to-speech.

## Architecture Overview

```
┌─────────┐     HTTP      ┌──────────┐    HTTP     ┌─────────────┐
│  Client  │ ◄──────────► │  Fastify  │ ──────────► │  Python TTS  │
│  (React) │              │  Server   │             │  (FastAPI)   │
└─────────┘               └────┬──────┘             └──────┬──────┘
                               │                           │
                          ┌────▼──────┐              ┌─────▼─────┐
                          │  SQLite   │              │ Kokoro-82M │
                          │  + disk   │              │  (PyTorch) │
                          └───────────┘              └───────────┘
```

- **Python TTS service:** FastAPI sidecar in Docker Compose, port 5000 (internal only)
- **Audio format:** OGG/Opus
- **Audio storage:** `data/tts/{hash}.ogg` on shared volume
- **Speed control:** Client-side via `Audio.playbackRate` — audio generated at 1x, cache reusable across speed changes

## Python TTS Service (`tts/`)

**Stack:** FastAPI + Kokoro-82M + PyTorch (CPU) + Uvicorn

**Endpoints:**

| Method | Path | Request | Response |
|--------|------|---------|----------|
| `POST /synthesize` | `{ text, voice, language }` | OGG/Opus audio bytes |
| `GET /voices` | — | `{ [language]: [{ id, name }] }` |
| `GET /health` | — | `{ status: "ready" }` |

Model loaded once on startup, kept in memory (~330MB).

**Container:** `tts/Dockerfile`, Python 3.11. Exposed on port 5000, accessible only within Docker network.

## Database Changes

**New columns on `books`:**

| Column | Type | Purpose |
|--------|------|---------|
| `tts_status` | `TEXT DEFAULT 'pending'` | `pending` / `generating` / `completed` / `failed` |
| `tts_voice` | `TEXT` | Kokoro voice ID for this book |
| `tts_language` | `TEXT` | Language code for this book |

**New table:**

```sql
sentence_audio (
  sentence_id TEXT PRIMARY KEY REFERENCES sentences(id) ON DELETE CASCADE,
  hash TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | completed | failed
  voice TEXT NOT NULL,
  language TEXT NOT NULL
)
```

Audio files stored at `data/tts/{hash}.ogg`. Hash = deterministic function of `(text, voice, language)`. Duplicate sentences across books share the same audio file.

## Audio Generation Pipeline

**Trigger:** On book import, after epub parsing completes.

**Flow:**
1. Epub parsed, sentences stored (existing behavior)
2. Book record created with `tts_status = 'generating'`, `tts_voice`, `tts_language`
3. Upload response returns immediately (generation is background, non-blocking)
4. For each sentence in chapter order:
   - Compute hash from `(text, voice, language)`
   - Skip if `data/tts/{hash}.ogg` already exists (deduplication)
   - Call `POST http://tts:5000/synthesize`
   - Write audio to `data/tts/{hash}.ogg`
   - Insert/update `sentence_audio` row with `status = 'completed'`
5. On completion: set `tts_status = 'completed'`
6. On failure: behavior depends on user setting (skip or stop)

**Error handling** is user-configurable via settings:
- **Skip:** mark sentence as `failed`, continue. Book completes with partial audio.
- **Stop:** halt generation, set `tts_status = 'failed'`.

## API Changes

**Modified:**

| Endpoint | Change |
|----------|--------|
| `POST /api/books` | Accepts `voice` and `language` fields alongside epub file |

**New:**

| Method | Path | Purpose |
|--------|------|---------|
| `GET /api/tts/:sentenceId` | Serve cached audio file for a sentence |
| `GET /api/books/:id/tts-status` | `{ status, total, completed, failed }` |
| `GET /api/tts/voices` | Proxy to Python service `/voices` |

`GET /api/tts/:sentenceId` returns:
- `200` + audio if ready
- `404` if not yet generated
- `410` if generation failed

## Client Changes

### `useTTS` Hook — Full Rewrite

Remove all Web Speech API code. New implementation:
- Play audio via `HTMLAudioElement`
- Prefetch next 3-5 sentences using `fetch()` (browser caches responses)
- Speed applied via `audio.playbackRate` (linear, no dampening needed)
- On `ended` event → advance sentence, play from prefetch cache
- Prefetch window slides forward with each advance

### ReaderPage

- Remove browser voice picker
- Keep speed picker, wire to `audio.playbackRate`
- Remove `adjustRate()` dampening function
- Remove 50ms Chrome `speechSynthesis` workaround
- Add indicator when audio not yet available (book still generating)

### New Components

**`SettingsPanel.tsx`** — modal accessible from header:

| Setting | Type | Default |
|---------|------|---------|
| Default language | Dropdown | English |
| Default voice | Dropdown (filtered by language) | First available |
| Skip voice/language on import | Toggle | Off |
| On generation failure | Dropdown: "Skip" / "Stop" | Skip |

Settings stored in `localStorage`.

**`ImportModal.tsx`** — shown on epub upload (unless "skip" is enabled):
- Language picker → voice picker (filtered by language)
- Defaults pre-filled from settings
- Confirm → upload with voice/language

### BookCard Changes

- Show TTS generation progress (progress bar or percentage)
- States: generating, completed, failed
- Retry button on failed books

### Library Page

- Import flow shows `ImportModal` before upload (unless skipped via settings)
- Settings button in header opens `SettingsPanel`

## Removed

- `speechSynthesis` API usage entirely
- Browser voice list / voice picker in reader
- `adjustRate()` dampening function
- 50ms Chrome workaround delay
- `VOICE_STORAGE_KEY` localStorage handling

## Project Structure (New/Modified Files)

```
lector/
├── tts/                              # NEW
│   ├── Dockerfile
│   ├── requirements.txt
│   └── main.py
├── server/src/
│   ├── routes/
│   │   ├── books.ts                  # MODIFIED
│   │   ├── chapters.ts               # UNCHANGED
│   │   └── tts.ts                    # NEW
│   ├── services/
│   │   └── tts-generator.ts          # NEW
│   ├── db.ts                         # MODIFIED
│   └── index.ts                      # MODIFIED
├── client/src/
│   ├── hooks/
│   │   └── useTTS.ts                 # REWRITTEN
│   ├── components/
│   │   ├── SettingsPanel.tsx          # NEW
│   │   ├── SettingsPanel.module.scss  # NEW
│   │   ├── ImportModal.tsx            # NEW
│   │   ├── ImportModal.module.scss    # NEW
│   │   ├── BookCard.tsx              # MODIFIED
│   │   └── BookCard.module.scss      # MODIFIED
│   ├── pages/
│   │   ├── ReaderPage.tsx            # MODIFIED
│   │   └── LibraryPage.tsx           # MODIFIED
│   └── services/
│       └── api.ts                    # MODIFIED
├── shared/src/
│   └── types.ts                      # MODIFIED
├── docker-compose.yml                # MODIFIED
└── data/
    └── tts/                          # NEW (runtime, git-ignored)
```

## Docker Compose

```yaml
services:
  lector:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/server/data
    depends_on:
      tts:
        condition: service_healthy
    environment:
      - TTS_SERVICE_URL=http://tts:5000

  tts:
    build: ./tts
    volumes:
      - ./data:/app/data
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:5000/health"]
      interval: 10s
      timeout: 5s
      retries: 5
    restart: unless-stopped
```

Shared `data/` volume so Fastify can serve audio files generated by the Python service.
