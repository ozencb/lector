import { FastifyInstance } from 'fastify';
import { writeFileSync, mkdirSync, unlinkSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import { EPub } from 'epub2';
import sbd from 'sbd';
import { getDb } from '../db.js';
import type { Book, BookDetail, BookUploadResponse } from '@tts-reader/shared';

function stripHtml(html: string): string {
  return html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

export async function booksRoutes(server: FastifyInstance) {
  server.post('/api/books', async (request, reply) => {
    const data = await request.file();
    if (!data) {
      return reply.status(400).send({ error: 'No file uploaded' });
    }

    const filename = data.filename || '';
    if (!filename.endsWith('.epub')) {
      return reply.status(400).send({ error: 'File must be an epub' });
    }

    const bookId = uuidv4();
    const booksDir = join('data', 'books');
    const coversDir = join('data', 'covers');
    mkdirSync(booksDir, { recursive: true });
    mkdirSync(coversDir, { recursive: true });

    const epubPath = join(booksDir, `${bookId}.epub`);
    const fileBuffer = await data.toBuffer();
    writeFileSync(epubPath, fileBuffer);

    let epub: EPub;
    try {
      epub = await EPub.createAsync(epubPath);
    } catch {
      return reply.status(400).send({ error: 'Failed to parse epub file' });
    }

    const title = epub.metadata?.title || 'Untitled';
    const author = epub.metadata?.creator || 'Unknown';

    // Extract cover image if present
    let coverPath: string | null = null;
    const coverId = epub.metadata?.cover;
    if (coverId && epub.manifest[coverId]) {
      try {
        const [imageBuffer, mimeType] = await epub.getImageAsync(coverId);
        const ext = mimeType === 'image/png' ? 'png' : 'jpg';
        const coverFilename = `${bookId}.${ext}`;
        writeFileSync(join(coversDir, coverFilename), imageBuffer);
        coverPath = `/api/covers/${coverFilename}`;
      } catch {
        // No cover, that's fine
      }
    }

    // Parse chapters from spine (async step — collect all data first)
    const spine = epub.flow;
    const parsedChapters: { title: string; sentences: string[] }[] = [];

    for (const spineItem of spine) {
      if (!spineItem.id) continue;
      let chapterHtml: string;
      try {
        chapterHtml = await epub.getChapterAsync(spineItem.id);
      } catch {
        continue;
      }
      const plainText = stripHtml(chapterHtml);
      if (!plainText) continue;
      const sentences = sbd.sentences(plainText).filter((s: string) => s.trim().length > 0);
      if (sentences.length === 0) continue;
      parsedChapters.push({
        title: spineItem.title || `Chapter ${parsedChapters.length + 1}`,
        sentences,
      });
    }

    // Insert all data in a single synchronous transaction
    const db = getDb();
    const insertBook = db.prepare(
      'INSERT INTO books (id, title, author, cover_path, file_path, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    );
    const insertChapter = db.prepare(
      'INSERT INTO chapters (id, book_id, idx, title) VALUES (?, ?, ?, ?)'
    );
    const insertSentence = db.prepare(
      'INSERT INTO sentences (id, chapter_id, idx, text) VALUES (?, ?, ?, ?)'
    );

    let totalChapters = 0;
    let totalSentences = 0;

    const insertAll = db.transaction(() => {
      insertBook.run(bookId, title, author, coverPath, epubPath, Date.now());
      for (const chapter of parsedChapters) {
        const chapterId = uuidv4();
        insertChapter.run(chapterId, bookId, totalChapters, chapter.title);
        totalChapters++;
        for (let sentIdx = 0; sentIdx < chapter.sentences.length; sentIdx++) {
          insertSentence.run(uuidv4(), chapterId, sentIdx, chapter.sentences[sentIdx]);
          totalSentences++;
        }
      }
    });

    insertAll();

    const response: BookUploadResponse = {
      id: bookId,
      title,
      author,
      coverPath,
      totalChapters,
      totalSentences,
      ttsStatus: 'pending',
    };

    return reply.status(201).send(response);
  });

  // GET /api/books - list all books with progress
  server.get('/api/books', async () => {
    const db = getDb();
    const rows = db.prepare(`
      SELECT
        b.id, b.title, b.author, b.cover_path, b.created_at, b.tts_status,
        (SELECT COUNT(*) FROM chapters c WHERE c.book_id = b.id) AS total_chapters,
        (SELECT COUNT(*) FROM sentences s JOIN chapters c ON s.chapter_id = c.id WHERE c.book_id = b.id) AS total_sentences,
        (
          SELECT CASE WHEN p.sentence_id IS NOT NULL THEN
            (
              SELECT (
                (SELECT SUM(sc2) FROM (
                  SELECT COUNT(*) AS sc2 FROM sentences s2 JOIN chapters c2 ON s2.chapter_id = c2.id
                  WHERE c2.book_id = b.id AND (c2.idx < pc.idx OR (c2.idx = pc.idx AND s2.idx <= ps.idx))
                ))
              ) * 100.0 /
              NULLIF((SELECT COUNT(*) FROM sentences s3 JOIN chapters c3 ON s3.chapter_id = c3.id WHERE c3.book_id = b.id), 0)
            )
          ELSE NULL END
          FROM progress p
          JOIN sentences ps ON ps.id = p.sentence_id
          JOIN chapters pc ON pc.id = ps.chapter_id
          WHERE p.book_id = b.id
        ) AS progress
      FROM books b
      ORDER BY b.created_at DESC
    `).all() as Array<{
      id: string; title: string; author: string; cover_path: string | null;
      created_at: number; tts_status: string; total_chapters: number; total_sentences: number;
      progress: number | null;
    }>;

    const books: Book[] = rows.map(r => ({
      id: r.id,
      title: r.title,
      author: r.author,
      coverPath: r.cover_path,
      createdAt: r.created_at,
      totalChapters: r.total_chapters,
      totalSentences: r.total_sentences,
      progress: r.progress !== null ? r.progress / 100 : null,
      ttsStatus: r.tts_status as Book['ttsStatus'],
    }));

    return books;
  });

  // GET /api/books/:id - single book with chapters
  server.get<{ Params: { id: string } }>('/api/books/:id', async (request, reply) => {
    const db = getDb();
    const book = db.prepare('SELECT id, title, author, cover_path FROM books WHERE id = ?').get(request.params.id) as
      { id: string; title: string; author: string; cover_path: string | null } | undefined;

    if (!book) {
      return reply.status(404).send({ error: 'Book not found' });
    }

    const chapters = db.prepare(`
      SELECT c.id, c.book_id, c.idx, c.title,
        (SELECT COUNT(*) FROM sentences s WHERE s.chapter_id = c.id) AS sentence_count
      FROM chapters c WHERE c.book_id = ? ORDER BY c.idx
    `).all(request.params.id) as Array<{
      id: string; book_id: string; idx: number; title: string; sentence_count: number;
    }>;

    const detail: BookDetail = {
      id: book.id,
      title: book.title,
      author: book.author,
      coverPath: book.cover_path,
      chapters: chapters.map(c => ({
        id: c.id,
        bookId: c.book_id,
        idx: c.idx,
        title: c.title,
        sentenceCount: c.sentence_count,
      })),
    };

    return detail;
  });

  // DELETE /api/books/:id
  server.delete<{ Params: { id: string } }>('/api/books/:id', async (request, reply) => {
    const db = getDb();
    const book = db.prepare('SELECT id, cover_path, file_path FROM books WHERE id = ?').get(request.params.id) as
      { id: string; cover_path: string | null; file_path: string } | undefined;

    if (!book) {
      return reply.status(404).send({ error: 'Book not found' });
    }

    // Delete from DB (cascades to chapters, sentences, progress)
    db.prepare('DELETE FROM books WHERE id = ?').run(book.id);

    // Clean up files
    try { unlinkSync(book.file_path); } catch { /* already gone */ }
    if (book.cover_path) {
      const coverFile = book.cover_path.replace('/api/covers/', '');
      try { unlinkSync(join('data', 'covers', coverFile)); } catch { /* already gone */ }
    }

    return reply.status(204).send();
  });
}
