import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let db: Database.Database;

export function initDb(dbPath = 'data/tts-reader.db'): Database.Database {
  mkdirSync(dirname(dbPath), { recursive: true });

  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS books (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      author TEXT,
      cover_path TEXT,
      file_path TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS chapters (
      id TEXT PRIMARY KEY,
      book_id TEXT NOT NULL REFERENCES books(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      title TEXT
    );

    CREATE TABLE IF NOT EXISTS sentences (
      id TEXT PRIMARY KEY,
      chapter_id TEXT NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      idx INTEGER NOT NULL,
      text TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS progress (
      book_id TEXT PRIMARY KEY REFERENCES books(id) ON DELETE CASCADE,
      sentence_id TEXT NOT NULL REFERENCES sentences(id),
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_chapters_book_id ON chapters(book_id);
    CREATE INDEX IF NOT EXISTS idx_sentences_chapter_id ON sentences(chapter_id);
    CREATE INDEX IF NOT EXISTS idx_progress_book_id ON progress(book_id);
  `);

  return db;
}

export function getDb(): Database.Database {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}
