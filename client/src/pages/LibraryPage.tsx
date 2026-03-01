import { useCallback, useEffect, useRef, useState } from 'react';
import { PlusIcon } from '@radix-ui/react-icons';
import type { Book } from '@tts-reader/shared';
import { deleteBook, listBooks, uploadBook } from '../services/api.js';
import BookCard from '../components/BookCard.js';
import ThemeToggle from '../components/ThemeToggle.js';
import styles from './LibraryPage.module.scss';

export default function LibraryPage() {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const fetchBooks = useCallback(() => {
    listBooks()
      .then(setBooks)
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, []);

  const handleDelete = async (id: string) => {
    try {
      await deleteBook(id);
      setBooks((prev) => prev.filter((b) => b.id !== id));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Delete failed');
    }
  };

  useEffect(() => {
    fetchBooks();
  }, [fetchBooks]);

  const handleUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Reset input so same file can be re-selected
    e.target.value = '';

    setUploading(true);
    setError(null);
    try {
      await uploadBook(file);
      fetchBooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Library</h1>
        <ThemeToggle />
        <input
          ref={fileInputRef}
          type="file"
          accept=".epub"
          onChange={handleUpload}
          hidden
        />
        <button
          className={styles.addButton}
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
        >
          {uploading ? (
            <span className={styles.spinner} />
          ) : (
            <PlusIcon width={18} height={18} />
          )}
          {uploading ? 'Uploading…' : 'Add'}
        </button>
      </div>

      {loading && <div className={styles.loading}>Loading…</div>}

      {error && <div className={styles.error}>{error}</div>}

      {!loading && !error && books.length === 0 && (
        <div className={styles.empty}>
          No books yet. Upload an epub to get started.
        </div>
      )}

      {!loading && !error && books.length > 0 && (
        <div className={styles.grid}>
          {books.map((book) => (
            <BookCard key={book.id} book={book} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}
