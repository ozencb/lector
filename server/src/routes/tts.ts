import { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getDb } from '../db.js';
import { enqueueBookGeneration, getBookTtsStatus } from '../services/tts-generator.js';

const TTS_SERVICE_URL = process.env.TTS_SERVICE_URL || 'http://localhost:5000';

export async function ttsRoutes(server: FastifyInstance) {
  // GET /api/tts/voices
  server.get('/api/tts/voices', async (_request, reply) => {
    const res = await fetch(`${TTS_SERVICE_URL}/voices`);
    const data = await res.json();
    return reply.send(data);
  });

  // GET /api/books/:id/tts-status
  server.get<{ Params: { id: string } }>('/api/books/:id/tts-status', async (request, reply) => {
    const status = getBookTtsStatus(request.params.id);
    return reply.send(status);
  });

  // GET /api/tts/:sentenceId
  server.get<{ Params: { sentenceId: string } }>('/api/tts/:sentenceId', async (request, reply) => {
    const db = getDb();
    const row = db.prepare('SELECT sentence_id, hash, status FROM sentence_audio WHERE sentence_id = ?')
      .get(request.params.sentenceId) as { sentence_id: string; hash: string; status: string } | undefined;

    if (!row) {
      return reply.status(404).send({ error: 'Not found' });
    }

    if (row.status === 'failed') {
      return reply.status(404).send({ reason: 'failed' });
    }

    const filePath = join('data', 'tts', `${row.hash}.ogg`);
    const buffer = readFileSync(filePath);
    return reply
      .header('Content-Type', 'audio/ogg')
      .header('Cache-Control', 'public, immutable, max-age=31536000')
      .send(buffer);
  });

  // POST /api/books/:id/regenerate
  server.post<{ Params: { id: string }; Querystring: { errorBehavior?: string } }>(
    '/api/books/:id/regenerate',
    async (request, reply) => {
      const db = getDb();
      const book = db.prepare('SELECT id, tts_voice, tts_language FROM books WHERE id = ?')
        .get(request.params.id) as { id: string; tts_voice: string; tts_language: string } | undefined;

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      // Reset failed sentence_audio rows to pending
      db.prepare(`
        UPDATE sentence_audio SET status = 'pending'
        WHERE status = 'failed' AND sentence_id IN (
          SELECT s.id FROM sentences s
          JOIN chapters c ON s.chapter_id = c.id
          WHERE c.book_id = ?
        )
      `).run(book.id);

      db.prepare(`UPDATE books SET tts_status = 'pending' WHERE id = ?`).run(book.id);

      const errorBehavior = request.query.errorBehavior || 'skip';
      enqueueBookGeneration(book.id, book.tts_voice, book.tts_language, errorBehavior);

      return reply.send({ status: 'queued' });
    },
  );
}
