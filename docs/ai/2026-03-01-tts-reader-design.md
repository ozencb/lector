# TTS Reader — Design

Minimalist web app for reading epubs with text-to-speech. Sentence-level focus view with auto-scroll.

## Stack

- **Frontend:** React + Vite, Radix UI, SCSS, TypeScript
- **Backend:** Node.js + Fastify, TypeScript
- **Storage:** SQLite (better-sqlite3), filesystem for epub/cover files
- **TTS:** Web Speech API (browser-native)
- **Monorepo:** pnpm workspaces
- **Deployment:** Docker + docker-compose

## Project Structure

```
tts-reader/
├── client/              # React + Vite SPA
│   ├── src/
│   │   ├── components/
│   │   ├── hooks/
│   │   ├── pages/
│   │   ├── services/   # API client, TTS engine wrapper
│   │   └── styles/     # SCSS
│   └── vite.config.ts
├── server/              # Fastify API
│   ├── src/
│   │   ├── routes/
│   │   ├── services/   # epub parser, sentence splitter
│   │   └── storage/    # file + DB management
│   └── tsconfig.json
├── shared/              # Shared types
├── Dockerfile           # Multi-stage build
├── docker-compose.yml
└── data/                # Persistent volume (DB + files)
```

## Data Model (SQLite)

```
books (id, title, author, cover_path, file_path, created_at)
chapters (id, book_id FK, index, title)
sentences (id, chapter_id FK, index, text)
progress (book_id PK FK, sentence_id FK, updated_at)
```

On epub upload: parse → extract chapters → split into sentences (using `sbd`) → store. Raw epub kept on disk.

## API Routes

```
POST   /api/books              # Upload epub, parse + store
GET    /api/books               # List library
GET    /api/books/:id           # Book metadata + chapter list
DELETE /api/books/:id           # Remove book + related data
GET    /api/chapters/:id        # Chapter with all sentences
GET    /api/books/:id/progress  # Current position
PUT    /api/books/:id/progress  # Update position
```

No auth — personal app. Epub files in `data/books/`, covers in `data/covers/`.

## Reading View

Single-sentence focused layout:
- Current sentence: full opacity, slightly larger font, centered
- Prev/next sentences: dimmed (opacity 0.3), smaller — toggleable to hide entirely
- Minimal header: back button, book title, chapter indicator
- Bottom controls: prev/play-pause/next, speed slider

Sentence transitions: subtle vertical slide/fade animation.
End of chapter → auto-advance to next chapter.

### TTS Flow

`useTTS` hook wraps Web Speech API. On play: speak current sentence → `end` event → advance → speak next. Progress saved to server debounced (every ~5s or on pause).

### Keyboard Shortcuts

- `Space` — play/pause
- `←` / `→` — prev/next sentence
- `[` / `]` — decrease/increase speed (0.5x–2.0x)

## Library View

Grid of book cards: cover image, title, author, progress bar.
- Click → open reading view, resume last position
- [+ Add] → file picker for epub upload
- Right-click/long-press → delete
- No cover → colored placeholder from title

## Deployment

Multi-stage Dockerfile: build client (Vite) → production Node.js image with server + built SPA.

```yaml
services:
  tts-reader:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    restart: unless-stopped
```

Single container, single volume. Fastify serves static SPA + API.
