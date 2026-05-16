import { useCallback, useEffect, useRef, useState } from 'react';
import { DashboardIcon, GearIcon, GitHubLogoIcon, ListBulletIcon, PlusIcon } from '@radix-ui/react-icons';
import type { Book } from '@tts-reader/shared';
import { deleteBook, listBooks, uploadBook } from '../services/api.js';
import BookCard from '../components/BookCard.js';
import BookTable from '../components/BookTable.js';
import ThemeToggle from '../components/ThemeToggle.js';
import ImportModal from '../components/ImportModal.js';
import SettingsPanel from '../components/SettingsPanel.js';
import styles from './LibraryPage.module.scss';

export default function LibraryPage() {
  const [books, setBooks] = useState<Book[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [importModalOpen, setImportModalOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'table'>(() =>
    (localStorage.getItem('library-view') as 'grid' | 'table') || 'grid'
  );
  const fileInputRef = useRef<HTMLInputElement>(null);

  const toggleView = () => {
    const next = viewMode === 'grid' ? 'table' : 'grid';
    setViewMode(next);
    localStorage.setItem('library-view', next);
  };

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

    const skipDialog = localStorage.getItem('tts-skip-import-dialog') === 'true';
    if (skipDialog) {
      const defaultVoice = localStorage.getItem('tts-default-voice') || undefined;
      const defaultLanguage = localStorage.getItem('tts-default-language') || undefined;
      const errorBehavior = localStorage.getItem('tts-error-behavior') || 'skip';
      setUploading(true);
      setError(null);
      try {
        await uploadBook(file, defaultVoice, defaultLanguage, errorBehavior);
        fetchBooks();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Upload failed');
      } finally {
        setUploading(false);
      }
    } else {
      setPendingFile(file);
      setImportModalOpen(true);
    }
  };

  const handleImportConfirm = async (voice: string, language: string) => {
    if (!pendingFile) return;
    setImportModalOpen(false);
    setUploading(true);
    setError(null);
    try {
      const errorBehavior = localStorage.getItem('tts-error-behavior') || 'skip';
      await uploadBook(pendingFile, voice, language, errorBehavior);
      fetchBooks();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Upload failed');
    } finally {
      setUploading(false);
      setPendingFile(null);
    }
  };

  return (
    <div className={styles.page}>
      <div className={styles.header}>
        <h1 className={styles.heading}>Library</h1>
        <button className={styles.viewToggle} onClick={toggleView} aria-label="Toggle view">
          {viewMode === 'grid' ? <ListBulletIcon width={18} height={18} /> : <DashboardIcon width={18} height={18} />}
        </button>
        <ThemeToggle />
        <button className={styles.settingsButton} onClick={() => setSettingsOpen(true)} aria-label="Settings">
          <GearIcon width={18} height={18} />
        </button>
        <a className={styles.githubLink} href="https://github.com/ozencb/lector" target="_blank" rel="noopener noreferrer" aria-label="GitHub">
          <GitHubLogoIcon width={18} height={18} />
        </a>
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

      {!loading && !error && books.length > 0 && viewMode === 'grid' && (
        <div className={styles.grid}>
          {books.map((book) => (
            <BookCard key={book.id} book={book} onDelete={handleDelete} onRetry={fetchBooks} onPrioritize={fetchBooks} />
          ))}
        </div>
      )}

      {!loading && !error && books.length > 0 && viewMode === 'table' && (
        <BookTable books={books} onDelete={handleDelete} onRetry={fetchBooks} onPrioritize={fetchBooks} />
      )}
      <ImportModal open={importModalOpen} onOpenChange={setImportModalOpen} onConfirm={handleImportConfirm} />
      <SettingsPanel open={settingsOpen} onOpenChange={setSettingsOpen} />
    </div>
  );
}
