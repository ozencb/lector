import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db.js';
import { CircuitBreaker } from './circuit-breaker.js';
import type { TtsStatus } from '@tts-reader/shared';

const TTS_SERVICE_URL = process.env.TTS_SERVICE_URL || 'http://localhost:5000';
const TTS_CONCURRENCY = parseInt(process.env.TTS_CONCURRENCY || '2', 10);
const TTS_DIR = 'data/tts';
const BASE_TIMEOUT_MS = 15_000;
const TIMEOUT_PER_20_CHARS_MS = 1_000;
const MAX_RETRIES = 2;
const RETRY_BACKOFFS = [5_000, 10_000];

mkdirSync(TTS_DIR, { recursive: true });

const breaker = new CircuitBreaker({
  threshold: 3,
  cooldownMs: 60_000,
  healthUrl: `${TTS_SERVICE_URL}/health`,
});

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

  const bookRow = db.prepare(`SELECT title FROM books WHERE id = ?`).get(bookId) as { title: string } | undefined;
  const bookTitle = bookRow?.title ?? bookId;

  db.prepare(`UPDATE books SET tts_status = 'generating' WHERE id = ?`).run(bookId);
  console.log(`[tts] generating book="${bookTitle}" sentences=${sentences.length}`);

  const upsertAudio = db.prepare(`
    INSERT INTO sentence_audio (sentence_id, hash, status, file_size)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(sentence_id) DO UPDATE SET hash = excluded.hash, status = excluded.status, file_size = excluded.file_size
  `);

  const bookExists = db.prepare(`SELECT 1 FROM books WHERE id = ?`);
  let failedCount = 0;
  const inFlight = new Set<Promise<void>>();

  for (const sentence of sentences) {
    if (abort.signal.aborted) break;
    if (!bookExists.get(bookId)) break;

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

    const existing = db.prepare(`SELECT status FROM sentence_audio WHERE sentence_id = ?`)
      .get(sentence.id) as { status: string } | undefined;
    if (existing?.status === 'failed') continue;

    if (breaker.isOpen) {
      await Promise.all(inFlight);
      inFlight.clear();
      const recovered = await breaker.waitUntilClosed(abort.signal);
      if (!recovered) break;
    }

    if (inFlight.size >= TTS_CONCURRENCY) {
      await Promise.race(inFlight);
    }

    const task = processSentence(
      sentence, hash, filePath, voice, language, abort, upsertAudio, errorBehavior,
    ).then(result => {
      if (result === 'failed') failedCount++;
      if (result === 'stop') {
        db.prepare(`UPDATE books SET tts_status = 'failed' WHERE id = ?`).run(bookId);
        console.log(`[tts] stopped book="${bookTitle}" due to error_behavior=stop`);
        abort.abort();
      }
    });

    inFlight.add(task);
    task.finally(() => inFlight.delete(task));
  }

  await Promise.all(inFlight);

  if (!abort.signal.aborted) {
    db.prepare(`UPDATE books SET tts_status = 'completed' WHERE id = ?`).run(bookId);
    console.log(`[tts] completed book="${bookTitle}" total=${sentences.length} failed=${failedCount}`);
  }

  if (currentBookId === bookId) {
    currentAbort = null;
    currentBookId = null;
  }
}

async function processSentence(
  sentence: { id: string; text: string },
  hash: string,
  filePath: string,
  voice: string,
  language: string,
  abort: AbortController,
  upsertAudio: { run: (...args: unknown[]) => void },
  errorBehavior: string,
): Promise<'ok' | 'failed' | 'stop'> {
  const result = await synthesize(sentence.text, voice, language, abort.signal);
  if (abort.signal.aborted) return 'ok';

  if (result.type === 'success') {
    const buf = Buffer.from(result.data);
    upsertAudio.run(sentence.id, hash, 'completed', buf.length);
    writeFileSync(filePath, buf);
    breaker.recordSuccess();
    return 'ok';
  }

  if (result.type === 'permanent') {
    upsertAudio.run(sentence.id, hash, 'failed', 0);
    console.log(`[tts] failed sentence=${sentence.id} reason=bad_input text_length=${sentence.text.length}`);
    return errorBehavior === 'stop' ? 'stop' : 'failed';
  }

  breaker.recordFailure();
  const retry = await synthesize(sentence.text, voice, language, abort.signal);
  if (abort.signal.aborted) return 'ok';

  if (retry.type === 'success') {
    const buf = Buffer.from(retry.data);
    upsertAudio.run(sentence.id, hash, 'completed', buf.length);
    writeFileSync(filePath, buf);
    breaker.recordSuccess();
    return 'ok';
  }

  upsertAudio.run(sentence.id, hash, 'failed', 0);
  console.log(`[tts] failed sentence=${sentence.id} reason=transient_unrecoverable text_length=${sentence.text.length}`);
  return 'failed';
}

type SynthResult =
  | { type: 'success'; data: ArrayBuffer }
  | { type: 'transient' }
  | { type: 'permanent' };

async function synthesize(
  text: string,
  voice: string,
  language: string,
  signal: AbortSignal,
): Promise<SynthResult> {
  const timeoutMs = BASE_TIMEOUT_MS + Math.ceil(text.length / 20) * TIMEOUT_PER_20_CHARS_MS;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    if (signal.aborted) return { type: 'transient' };
    try {
      const res = await fetch(`${TTS_SERVICE_URL}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, language }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });

      if (res.ok) {
        return { type: 'success', data: await res.arrayBuffer() };
      }

      if (res.status >= 400 && res.status < 500) {
        return { type: 'permanent' };
      }

      // 5xx — transient, retry
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BACKOFFS[attempt], signal);
      }
    } catch {
      if (signal.aborted) return { type: 'transient' };
      // Connection/timeout error — transient
      if (attempt < MAX_RETRIES - 1) {
        await sleep(RETRY_BACKOFFS[attempt], signal);
      }
    }
  }

  return { type: 'transient' };
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });
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
