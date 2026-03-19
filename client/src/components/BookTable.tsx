import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Book } from '@tts-reader/shared';
import { getTtsStatus, regenerateBookAudio, prioritizeBookAudio } from '../services/api.js';
import styles from './BookTable.module.scss';

interface BookTableProps {
  books: Book[];
  onDelete?: (id: string) => void;
  onRetry?: (id: string) => void;
  onPrioritize?: (id: string) => void;
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function TtsCell({ book, onRetry }: { book: Book; onRetry?: (id: string) => void }) {
  const [completed, setCompleted] = useState(0);
  const [total, setTotal] = useState(0);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (book.ttsStatus === 'generating') {
      const poll = () => {
        getTtsStatus(book.id).then((s) => {
          setCompleted(s.completed);
          setTotal(s.total);
        }).catch(() => {});
      };
      poll();
      intervalRef.current = setInterval(poll, 5000);
      return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
    }
    return () => { if (intervalRef.current) clearInterval(intervalRef.current); };
  }, [book.ttsStatus, book.id]);

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await regenerateBookAudio(book.id);
    onRetry?.(book.id);
  };

  switch (book.ttsStatus) {
    case 'completed':
      return <span className={styles.statusDone}>Done</span>;
    case 'generating':
      return (
        <span className={styles.statusGenerating}>
          {completed}/{total}
        </span>
      );
    case 'failed':
      return (
        <span className={styles.statusFailed}>
          Failed <button className={styles.retryBtn} onClick={handleRetry}>Retry</button>
        </span>
      );
    case 'pending':
      return (
        <span className={styles.statusPending}>
          Pending
        </span>
      );
  }
}

export default function BookTable({ books, onDelete, onRetry, onPrioritize }: BookTableProps) {
  const navigate = useNavigate();

  return (
    <div className={styles.tableWrap}>
      <table className={styles.table}>
        <thead>
          <tr>
            <th>Title</th>
            <th>Author</th>
            <th>Book Size</th>
            <th>Audio Size</th>
            <th>Audio</th>
            <th>Progress</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {books.map((book) => {
            const pct = book.progress !== null ? Math.round(book.progress * 100) : 0;
            return (
              <tr key={book.id} onClick={() => navigate(`/read/${book.id}`)} className={styles.row}>
                <td className={styles.titleCell}>{book.title}</td>
                <td className={styles.authorCell}>{book.author}</td>
                <td className={styles.sizeCell}>{formatSize(book.fileSize)}</td>
                <td className={styles.sizeCell}>{formatSize(book.audioSize)}</td>
                <td className={styles.audioCell}>
                  <TtsCell book={book} onRetry={onRetry} />
                </td>
                <td className={styles.progressCell}>
                  {pct > 0 ? `${pct}%` : '—'}
                </td>
                <td className={styles.actionsCell}>
                  {(book.ttsStatus === 'pending' || book.ttsStatus === 'generating') && (
                    <button
                      className={styles.prioritizeBtn}
                      onClick={async (e) => { e.stopPropagation(); await prioritizeBookAudio(book.id); onPrioritize?.(book.id); }}
                    >
                      Prioritize
                    </button>
                  )}
                  <button
                    className={styles.deleteBtn}
                    onClick={(e) => { e.stopPropagation(); onDelete?.(book.id); }}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
