import { FastifyInstance } from 'fastify';
import { readFileSync, existsSync, writeFileSync, mkdirSync, unlinkSync, createReadStream } from 'node:fs';
import { join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { getDb } from '../db.js';
import { enqueueBookGeneration, getBookTtsStatus, prioritizeBook } from '../services/tts-generator.js';

const TTS_SERVICE_URL = process.env.TTS_SERVICE_URL || 'http://localhost:5000';

export async function ttsRoutes(server: FastifyInstance) {
  // GET /api/tts/voices
  server.get('/api/tts/voices', async (_request, reply) => {
    try {
      const res = await fetch(`${TTS_SERVICE_URL}/voices`);
      const data = await res.json();
      return reply.send(data);
    } catch {
      return reply.status(502).send({ error: 'TTS service unavailable' });
    }
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

    if (row.status !== 'completed') {
      return reply.status(row.status === 'failed' ? 404 : 202).send({ reason: row.status });
    }

    const filePath = join('data', 'tts', `${row.hash}.ogg`);
    if (!existsSync(filePath)) {
      return reply.status(404).send({ error: 'Audio file missing' });
    }
    const buffer = readFileSync(filePath);
    return reply
      .header('Content-Type', 'audio/ogg')
      .header('Cache-Control', 'public, immutable, max-age=31536000')
      .send(buffer);
  });

  // GET /api/tts/demo/:voiceId — cached voice demo
  server.get<{ Params: { voiceId: string } }>('/api/tts/demo/:voiceId', async (request, reply) => {
    const { voiceId } = request.params;
    if (!/^[a-zA-Z0-9_-]+$/.test(voiceId)) {
      return reply.status(400).send({ error: 'Invalid voice ID' });
    }
    const demoDir = join('data', 'tts', 'demo');
    const cachePath = join(demoDir, `${voiceId}.ogg`);

    if (existsSync(cachePath)) {
      const buffer = readFileSync(cachePath);
      return reply
        .header('Content-Type', 'audio/ogg')
        .header('Cache-Control', 'public, immutable, max-age=31536000')
        .send(buffer);
    }

    const res = await fetch(`${TTS_SERVICE_URL}/demo/${voiceId}`);
    if (!res.ok) {
      return reply.status(res.status).send({ error: await res.text() });
    }

    const audioBuffer = Buffer.from(await res.arrayBuffer());
    mkdirSync(demoDir, { recursive: true });
    writeFileSync(cachePath, audioBuffer);

    return reply
      .header('Content-Type', 'audio/ogg')
      .header('Cache-Control', 'public, immutable, max-age=31536000')
      .send(audioBuffer);
  });

  // POST /api/books/:id/prioritize
  server.post<{ Params: { id: string } }>(
    '/api/books/:id/prioritize',
    async (request, reply) => {
      const db = getDb();
      const book = db.prepare('SELECT id, tts_status, tts_voice, tts_language FROM books WHERE id = ?')
        .get(request.params.id) as { id: string; tts_status: string; tts_voice: string; tts_language: string } | undefined;

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      if (book.tts_status === 'completed') {
        return reply.send({ status: 'already_completed' });
      }

      prioritizeBook(book.id, book.tts_voice, book.tts_language);
      return reply.send({ status: 'prioritized' });
    },
  );

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

  // GET /api/books/:id/download-audio
  server.get<{ Params: { id: string } }>(
    '/api/books/:id/download-audio',
    async (request, reply) => {
      const db = getDb();
      const book = db.prepare('SELECT id, title FROM books WHERE id = ?')
        .get(request.params.id) as { id: string; title: string } | undefined;

      if (!book) {
        return reply.status(404).send({ error: 'Book not found' });
      }

      const rows = db.prepare(`
        SELECT sa.hash
        FROM sentence_audio sa
        JOIN sentences s ON sa.sentence_id = s.id
        JOIN chapters c ON s.chapter_id = c.id
        WHERE c.book_id = ? AND sa.status = 'completed'
        ORDER BY c.idx, s.idx
      `).all(book.id) as Array<{ hash: string }>;

      if (rows.length === 0) {
        return reply.status(404).send({ error: 'No audio available' });
      }

      const ttsDir = resolve('data', 'tts');
      const tmpId = randomUUID();
      const listPath = join(ttsDir, `concat-${tmpId}.txt`);
      const outPath = join(ttsDir, `merged-${tmpId}.ogg`);

      const listContent = rows
        .map(r => `file '${r.hash}.ogg'`)
        .join('\n');
      writeFileSync(listPath, listContent);

      const execFileAsync = promisify(execFile);
      try {
        await execFileAsync('ffmpeg', [
          '-f', 'concat', '-safe', '0',
          '-i', listPath,
          '-c', 'copy',
          outPath,
        ]);
      } catch {
        unlinkSync(listPath);
        try { unlinkSync(outPath); } catch {}
        return reply.status(500).send({ error: 'Failed to merge audio' });
      }

      unlinkSync(listPath);

      const safeTitle = book.title.replace(/[^a-zA-Z0-9 _-]/g, '').trim() || 'audiobook';
      const stream = createReadStream(outPath);
      stream.on('end', () => { try { unlinkSync(outPath); } catch {} });

      return reply
        .header('Content-Type', 'audio/ogg')
        .header('Content-Disposition', `attachment; filename="${safeTitle}.ogg"`)
        .send(stream);
    },
  );
}
