import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db.js';
import type { TtsStatus } from '@tts-reader/shared';

const TTS_SERVICE_URL = process.env.TTS_SERVICE_URL || 'http://localhost:5000';
const TTS_DIR = 'data/tts';

mkdirSync(TTS_DIR, { recursive: true });

interface QueueItem {
  bookId: string;
  voice: string;
  language: string;
  errorBehavior: string;
}

const queue: QueueItem[] = [];
let processing = false;

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

  const sentences = db.prepare(`
    SELECT s.id, s.text
    FROM sentences s
    JOIN chapters c ON s.chapter_id = c.id
    WHERE c.book_id = ?
    ORDER BY c.idx, s.idx
  `).all(bookId) as Array<{ id: string; text: string }>;

  db.prepare(`UPDATE books SET tts_status = 'generating' WHERE id = ?`).run(bookId);

  const upsertAudio = db.prepare(`
    INSERT INTO sentence_audio (sentence_id, hash, status)
    VALUES (?, ?, ?)
    ON CONFLICT(sentence_id) DO UPDATE SET hash = excluded.hash, status = excluded.status
  `);

  for (const sentence of sentences) {
    const hash = createHash('sha256')
      .update(sentence.text + voice + language)
      .digest('hex')
      .slice(0, 16);
    const filePath = join(TTS_DIR, `${hash}.ogg`);

    if (existsSync(filePath)) {
      upsertAudio.run(sentence.id, hash, 'completed');
      continue;
    }

    const result = await synthesize(sentence.text, voice, language);

    if (result) {
      writeFileSync(filePath, Buffer.from(result));
      upsertAudio.run(sentence.id, hash, 'completed');
    } else {
      upsertAudio.run(sentence.id, hash, 'failed');
      if (errorBehavior === 'stop') {
        db.prepare(`UPDATE books SET tts_status = 'failed' WHERE id = ?`).run(bookId);
        return;
      }
    }
  }

  db.prepare(`UPDATE books SET tts_status = 'completed' WHERE id = ?`).run(bookId);
}

async function synthesize(
  text: string,
  voice: string,
  language: string,
): Promise<ArrayBuffer | null> {
  const maxRetries = 3;
  const backoffs = [1000, 2000, 4000];

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      const res = await fetch(`${TTS_SERVICE_URL}/synthesize`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, voice, language }),
      });

      if (res.ok) {
        return await res.arrayBuffer();
      }

      // Non-ok response — retry with backoff
      if (attempt < maxRetries - 1) {
        await sleep(backoffs[attempt]);
      }
    } catch {
      // Connection error — retry indefinitely with 5s interval
      await sleep(5000);
      attempt--; // Don't count connection errors toward retry limit
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
