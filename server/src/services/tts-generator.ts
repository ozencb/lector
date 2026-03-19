import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db.js';
import type { TtsStatus } from '@tts-reader/shared';

const TTS_SERVICE_URL = process.env.TTS_SERVICE_URL || 'http://localhost:5000';
const TTS_DIR = 'data/tts';
const SYNTHESIS_TIMEOUT_MS = 30_000;
const MAX_CONNECTION_RETRIES = 10;

mkdirSync(TTS_DIR, { recursive: true });

interface QueueItem {
  bookId: string;
  voice: string;
  language: string;
  errorBehavior: string;
}

const queue: QueueItem[] = [];
let processing = false;
let currentAbort: AbortController | null = null;
let currentBookId: string | null = null;

export function enqueueBookGeneration(
  bookId: string,
  voice: string,
  language: string,
  errorBehavior: string = 'skip',
): void {
  queue.push({ bookId, voice, language, errorBehavior });
  if (!processing) {
    void startProcessing();
  }
}

export function prioritizeBook(
  bookId: string,
  voice: string,
  language: string,
  errorBehavior: string = 'skip',
): void {
  // Already generating this book — nothing to do
  if (currentBookId === bookId) return;

  // Remove from queue if already queued
  const idx = queue.findIndex(q => q.bookId === bookId);
  if (idx !== -1) queue.splice(idx, 1);

  // If something is currently generating, abort it and re-queue at front
  if (currentAbort && currentBookId) {
    const db = getDb();
    db.prepare(`UPDATE books SET tts_status = 'pending' WHERE id = ?`).run(currentBookId);
    // Find the interrupted book's info to re-queue
    const interrupted = db.prepare(`SELECT tts_voice, tts_language FROM books WHERE id = ?`)
      .get(currentBookId) as { tts_voice: string; tts_language: string } | undefined;
    currentAbort.abort();
    if (interrupted) {
      queue.unshift({ bookId: currentBookId, voice: interrupted.tts_voice, language: interrupted.tts_language, errorBehavior: 'skip' });
    }
  }

  // Queue the priority book at front
  queue.unshift({ bookId, voice, language, errorBehavior });
  if (!processing) {
    void startProcessing();
  }
}

async function startProcessing(): Promise<void> {
  processing = true;
  while (queue.length > 0) {
    const item = queue.shift()!;
    await processBook(item.bookId, item.voice, item.language, item.errorBehavior);
  }
  processing = false;
}

async function processBook(
  bookId: string,
  voice: string,
  language: string,
  errorBehavior: string,
): Promise<void> {
  const db = getDb();
  const abort = new AbortController();
  currentAbort = abort;
  currentBookId = bookId;

  const sentences = db.prepare(`
    SELECT s.id, s.text
    FROM sentences s
    JOIN chapters c ON s.chapter_id = c.id
    WHERE c.book_id = ?
    ORDER BY c.idx, s.idx
  `).all(bookId) as Array<{ id: string; text: string }>;

  db.prepare(`UPDATE books SET tts_status = 'generating' WHERE id = ?`).run(bookId);

  const upsertAudio = db.prepare(`
    INSERT INTO sentence_audio (sentence_id, hash, status, file_size)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(sentence_id) DO UPDATE SET hash = excluded.hash, status = excluded.status, file_size = excluded.file_size
  `);

  const bookExists = db.prepare(`SELECT 1 FROM books WHERE id = ?`);

  for (const sentence of sentences) {
    if (abort.signal.aborted) return;
    if (!bookExists.get(bookId)) return;

    const hash = createHash('sha256')
      .update(sentence.text + voice + language)
      .digest('hex')
      .slice(0, 16);
    const filePath = join(TTS_DIR, `${hash}.ogg`);

    if (existsSync(filePath)) {
      const fileSize = statSync(filePath).size;
      upsertAudio.run(sentence.id, hash, 'completed', fileSize);
      continue;
    }

    const result = await synthesize(sentence.text, voice, language, abort.signal);

    if (abort.signal.aborted) return;

    if (result) {
      const buf = Buffer.from(result);
      writeFileSync(filePath, buf);
      upsertAudio.run(sentence.id, hash, 'completed', buf.length);
    } else {
      upsertAudio.run(sentence.id, hash, 'failed', 0);
      if (errorBehavior === 'stop') {
        db.prepare(`UPDATE books SET tts_status = 'failed' WHERE id = ?`).run(bookId);
        return;
      }
    }
  }

  if (!abort.signal.aborted) {
    db.prepare(`UPDATE books SET tts_status = 'completed' WHERE id = ?`).run(bookId);
  }

  if (currentBookId === bookId) {
    currentAbort = null;
    currentBookId = null;
  }
}

async function synthesize(
  text: string,
  voice: string,
  language: string,
  signal: AbortSignal,
): Promise<ArrayBuffer | null> {
  const maxRetries = 3;
  const backoffs = [1000, 2000, 4000];
  let connectionRetries = 0;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    if (signal.aborted) return null;
    try {
      const res = await fetch(`${TTS_SERVICE_URL}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, language }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(SYNTHESIS_TIMEOUT_MS)]),
      });

      if (res.ok) {
        return await res.arrayBuffer();
      }

      if (attempt < maxRetries - 1) {
        await sleep(backoffs[attempt]);
      }
    } catch (err) {
      if (signal.aborted) return null;
      // Connection/timeout error — retry with exponential backoff, capped
      connectionRetries++;
      if (connectionRetries >= MAX_CONNECTION_RETRIES) return null;
      const delay = Math.min(5000 * Math.pow(2, connectionRetries - 1), 60_000);
      await sleep(delay);
      attempt--; // Don't count connection errors toward response-retry limit
    }
  }

  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function getBookTtsStatus(bookId: string): TtsStatus {
  const db = getDb();

  const book = db.prepare(`SELECT tts_status FROM books WHERE id = ?`).get(bookId) as
    | { tts_status: string }
    | undefined;

  const counts = db.prepare(`
    SELECT
      COUNT(s.id) as total,
      COUNT(CASE WHEN sa.status = 'completed' THEN 1 END) as completed,
      COUNT(CASE WHEN sa.status = 'failed' THEN 1 END) as failed
    FROM sentences s
    JOIN chapters c ON s.chapter_id = c.id
    LEFT JOIN sentence_audio sa ON sa.sentence_id = s.id
    WHERE c.book_id = ?
  `).get(bookId) as { total: number; completed: number; failed: number };

  return {
    status: (book?.tts_status ?? 'pending') as TtsStatus['status'],
    total: counts.total,
    completed: counts.completed,
    failed: counts.failed,
  };
}

export function resumeInterruptedGenerations(): void {
  const db = getDb();
  const interrupted = db.prepare(
    `SELECT id, tts_voice, tts_language FROM books WHERE tts_status IN ('generating', 'pending') AND tts_voice IS NOT NULL`
  ).all() as Array<{ id: string; tts_voice: string; tts_language: string }>;

  for (const book of interrupted) {
    enqueueBookGeneration(book.id, book.tts_voice, book.tts_language);
  }
}

export function cleanupOrphanedAudio(): void {
  const db = getDb();

  const knownHashes = new Set(
    (db.prepare(`SELECT DISTINCT hash FROM sentence_audio`).all() as Array<{ hash: string }>).map(
      (r) => r.hash,
    ),
  );

  let files: string[];
  try {
    files = readdirSync(TTS_DIR);
  } catch {
    return;
  }

  for (const file of files) {
    if (!file.endsWith('.ogg')) continue;
    const hash = file.slice(0, -4);
    if (!knownHashes.has(hash)) {
      unlinkSync(join(TTS_DIR, file));
    }
  }
}
