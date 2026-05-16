import { FastifyInstance } from 'fastify';
import { getDb } from '../db.js';
import type { ChapterDetail, Progress } from '@tts-reader/shared';

export async function chaptersRoutes(server: FastifyInstance) {
  // GET /api/chapters/:id - chapter with all sentences
  server.get<{ Params: { id: string } }>('/api/chapters/:id', async (request, reply) => {
    const db = getDb();
    const chapter = db.prepare(
      'SELECT id, book_id, idx, title FROM chapters WHERE id = ?'
    ).get(request.params.id) as { id: string; book_id: string; idx: number; title: string } | undefined;

    if (!chapter) {
      return reply.status(404).send({ error: 'Chapter not found' });
    }

    const sentences = db.prepare(
      'SELECT id, idx, text FROM sentences WHERE chapter_id = ? ORDER BY idx'
    ).all(chapter.id) as Array<{ id: string; idx: number; text: string }>;

    const detail: ChapterDetail = {
      id: chapter.id,
      bookId: chapter.book_id,
      idx: chapter.idx,
      title: chapter.title,
      sentences: sentences.map(s => ({ id: s.id, idx: s.idx, text: s.text })),
    };

    return detail;
  });

  // GET /api/books/:id/progress
  server.get<{ Params: { id: string } }>('/api/books/:id/progress', async (request, reply) => {
    const db = getDb();
    const book = db.prepare('SELECT id FROM books WHERE id = ?').get(request.params.id) as { id: string } | undefined;
    if (!book) {
      return reply.status(404).send({ error: 'Book not found' });
    }

    const row = db.prepare(`
      SELECT p.book_id, p.sentence_id, s.chapter_id, c.idx AS chapter_idx, s.idx AS sentence_idx, p.updated_at
      FROM progress p
      JOIN sentences s ON s.id = p.sentence_id
      JOIN chapters c ON c.id = s.chapter_id
      WHERE p.book_id = ?
    `).get(request.params.id) as {
      book_id: string; sentence_id: string; chapter_id: string;
      chapter_idx: number; sentence_idx: number; updated_at: number;
    } | undefined;

    if (!row) {
      return reply.status(404).send({ error: 'No progress saved' });
    }

    const progress: Progress = {
      bookId: row.book_id,
      sentenceId: row.sentence_id,
      chapterId: row.chapter_id,
      chapterIdx: row.chapter_idx,
      sentenceIdx: row.sentence_idx,
      updatedAt: row.updated_at,
    };

    return progress;
  });

  // PUT /api/books/:id/progress
  server.put<{ Params: { id: string }; Body: { sentenceId: string } }>('/api/books/:id/progress', async (request, reply) => {
    return upsertProgress(request.params.id, request.body, reply);
  });

  // POST /api/books/:id/progress (needed for navigator.sendBeacon on page unload)
  server.post<{ Params: { id: string }; Body: { sentenceId: string } }>('/api/books/:id/progress', async (request, reply) => {
    return upsertProgress(request.params.id, request.body, reply);
  });
}

async function upsertProgress(
  bookId: string,
  body: { sentenceId: string } | undefined,
  reply: import('fastify').FastifyReply,
) {
  const db = getDb();
  const { sentenceId } = body || {};

  if (!sentenceId || typeof sentenceId !== 'string') {
    return reply.status(400).send({ error: 'sentenceId is required' });
  }

  const sentence = db.prepare(`
    SELECT s.id, s.idx, s.chapter_id, c.idx AS chapter_idx, c.book_id
    FROM sentences s
    JOIN chapters c ON c.id = s.chapter_id
    WHERE s.id = ?
  `).get(sentenceId) as {
    id: string; idx: number; chapter_id: string; chapter_idx: number; book_id: string;
  } | undefined;

  if (!sentence || sentence.book_id !== bookId) {
    return reply.status(400).send({ error: 'Invalid sentenceId' });
  }

  const now = Date.now();
  db.prepare(`
    INSERT INTO progress (book_id, sentence_id, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(book_id) DO UPDATE SET sentence_id = excluded.sentence_id, updated_at = excluded.updated_at
  `).run(bookId, sentenceId, now);

  const progress: Progress = {
    bookId,
    sentenceId,
    chapterId: sentence.chapter_id,
    chapterIdx: sentence.chapter_idx,
    sentenceIdx: sentence.idx,
    updatedAt: now,
  };

  return progress;
}
