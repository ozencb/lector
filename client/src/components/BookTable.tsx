import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { Book } from '@tts-reader/shared';
import { getTtsStatus, regenerateBookAudio, prioritizeBookAudio, getDownloadAudioUrl } from '../services/api.js';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
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

const SPEED_OPTIONS = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

function DownloadCell({ book }: { book: Book }) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [downloadText, setDownloadText] = useState('Downloading…');

  useEffect(() => {
    if (!downloading) return;
    setDownloadText('Downloading…');
    const id = setInterval(() => {
      setDownloadText((t) => t === 'Downloading…' ? 'Processing Audio…' : 'Downloading…');
    }, 3000);
    return () => clearInterval(id);
  }, [downloading]);

  if (book.ttsStatus === 'pending') return null;

  const handleDownload = async () => {
    setDownloading(true);
    try {
      const res = await fetch(getDownloadAudioUrl(book.id, speed));
      if (!res.ok) throw new Error();
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="([^"]+)"/);
      a.download = match?.[1] || '';
      a.click();
      URL.revokeObjectURL(url);
      setDialogOpen(false);
    } catch {
      // download failed silently
    } finally {
      setDownloading(false);
    }
  };

  return (
    <>
      <button
        className={styles.downloadBtn}
        disabled={downloading}
        onClick={(e) => {
          e.stopPropagation();
          if (!downloading) setDialogOpen(true);
        }}
      >
        {downloading && <span className={styles.spinner} />}
        {downloading ? downloadText : 'Download'}
      </button>
      <Dialog.Root open={dialogOpen} onOpenChange={(open) => { if (!downloading) setDialogOpen(open); }}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.dialogOverlay} />
          <Dialog.Content className={styles.dialogContent} onClick={(e) => e.stopPropagation()} onInteractOutside={(e) => { if (downloading) e.preventDefault(); }}>
            <Dialog.Title className={styles.dialogTitle}>
              Download Audio
            </Dialog.Title>
            {book.ttsStatus !== 'completed' && (
              <p className={styles.dialogWarning}>
                Audio generation is still in progress. Only what's been generated so far will be included.
              </p>
            )}
            <div className={styles.speedLabel}>Speed</div>
            <div className={styles.speedGrid}>
              {SPEED_OPTIONS.map((s) => (
                <button
                  key={s}
                  className={`${styles.speedBtn} ${s === speed ? styles.speedBtnActive : ''}`}
                  onClick={() => setSpeed(s)}
                >
                  {s}x
                </button>
              ))}
            </div>
            <p className={styles.dialogInfo}>
              This may take a moment — all audio files are merged into one.
            </p>
            <div className={styles.dialogActions}>
              <Dialog.Close asChild>
                <button className={styles.dialogCancel} disabled={downloading}>Cancel</button>
              </Dialog.Close>
              <button
                className={styles.dialogConfirm}
                disabled={downloading}
                onClick={handleDownload}
              >
                {downloading && <span className={styles.spinner} />}
                {downloading ? downloadText : 'Download'}
              </button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
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
                <td className={styles.downloadCell}>
                  <DownloadCell book={book} />
                </td>
                <td className={styles.actionsCell}>
                  {book.ttsStatus === 'pending' && (
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
