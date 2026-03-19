import { useEffect, useRef, useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import * as Dialog from '@radix-ui/react-dialog';
import type { Book } from '@tts-reader/shared';
import { useNavigate } from 'react-router-dom';
import { getTtsStatus, regenerateBookAudio, prioritizeBookAudio } from '../services/api.js';
import styles from './BookCard.module.scss';

function formatSize(bytes: number): string {
  if (bytes === 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function hashColor(str: string): string {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 40%, 30%)`;
}

interface BookCardProps {
  book: Book;
  onDelete?: (id: string) => void;
  onRetry?: (id: string) => void;
  onPrioritize?: (id: string) => void;
}

export default function BookCard({ book, onDelete, onRetry, onPrioritize }: BookCardProps) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [infoOpen, setInfoOpen] = useState(false);
  const [ttsCompleted, setTtsCompleted] = useState(0);
  const [ttsTotal, setTtsTotal] = useState(0);
  const ttsStatus = book.ttsStatus;
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const progress = book.progress ?? 0;
  const pct = Math.round(progress * 100);

  useEffect(() => {
    if (ttsStatus === 'generating') {
      const poll = () => {
        getTtsStatus(book.id).then((s) => {
          setTtsCompleted(s.completed);
          setTtsTotal(s.total);
        }).catch(() => {});
      };
      poll();
      intervalRef.current = setInterval(poll, 5000);
      return () => {
        if (intervalRef.current) clearInterval(intervalRef.current);
      };
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [ttsStatus, book.id]);

  const handleRetry = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await regenerateBookAudio(book.id);
    onRetry?.(book.id);
  };

  const cardContent = (
    <>
      {book.coverPath ? (
        <img className={styles.cover} src={book.coverPath} alt={book.title} />
      ) : (
        <div
          className={styles.placeholder}
          style={{ background: hashColor(book.title) }}
        >
          {book.title.charAt(0).toUpperCase()}
        </div>
      )}
      <div className={styles.info}>
        <div className={styles.title}>{book.title}</div>
        <div className={styles.author}>{book.author}</div>
        <div className={styles.progressBar}>
          <div className={styles.progressTrack}>
            <div
              className={styles.progressFill}
              style={{ width: `${pct}%` }}
            />
          </div>
          {progress > 0 && (
            <div className={styles.progressLabel}>{pct}%</div>
          )}
        </div>
        {ttsStatus === 'generating' && (
          <div className={styles.ttsStatus}>
            Generating audio… <span className={styles.ttsProgress}>{ttsCompleted}/{ttsTotal}</span>
          </div>
        )}
        {ttsStatus === 'pending' && (
          <div className={styles.ttsStatus}>Audio pending…</div>
        )}
        {ttsStatus === 'failed' && (
          <div className={styles.ttsStatus}>
            Audio failed <button className={styles.ttsRetry} onClick={handleRetry}>Retry</button>
          </div>
        )}
      </div>
    </>
  );

  return (
    <>
      <ContextMenu.Root>
        <ContextMenu.Trigger asChild>
          <div className={styles.card} onClick={() => navigate(`/read/${book.id}`)}>
            {cardContent}
          </div>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Content className={styles.contextMenu}>
            <ContextMenu.Item
              className={styles.contextMenuItemDefault}
              onSelect={() => setInfoOpen(true)}
            >
              Info
            </ContextMenu.Item>
            {(ttsStatus === 'pending' || ttsStatus === 'generating') && (
              <>
                <ContextMenu.Separator className={styles.contextMenuSeparator} />
                <ContextMenu.Item
                  className={styles.contextMenuItemDefault}
                  onSelect={() => {
                    prioritizeBookAudio(book.id).then(() => onPrioritize?.(book.id)).catch(() => {});
                  }}
                >
                  Prioritize Audio
                </ContextMenu.Item>
              </>
            )}
            <ContextMenu.Separator className={styles.contextMenuSeparator} />
            <ContextMenu.Item
              className={styles.contextMenuItem}
              onSelect={() => setConfirmOpen(true)}
            >
              Delete
            </ContextMenu.Item>
          </ContextMenu.Content>
        </ContextMenu.Portal>
      </ContextMenu.Root>

      <AlertDialog.Root open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialog.Portal>
          <AlertDialog.Overlay className={styles.dialogOverlay} />
          <AlertDialog.Content className={styles.dialogContent}>
            <AlertDialog.Title className={styles.dialogTitle}>
              Delete {book.title}?
            </AlertDialog.Title>
            <AlertDialog.Description className={styles.dialogDescription}>
              This cannot be undone.
            </AlertDialog.Description>
            <div className={styles.dialogActions}>
              <AlertDialog.Cancel asChild>
                <button className={styles.dialogCancel}>Cancel</button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  className={styles.dialogDelete}
                  onClick={() => onDelete?.(book.id)}
                >
                  Delete
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <Dialog.Root open={infoOpen} onOpenChange={setInfoOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.dialogOverlay} />
          <Dialog.Content className={styles.dialogContent}>
            <Dialog.Title className={styles.dialogTitle}>
              {book.title}
            </Dialog.Title>
            <dl className={styles.infoList}>
              <div className={styles.infoRow}>
                <dt>Author</dt>
                <dd>{book.author}</dd>
              </div>
              <div className={styles.infoRow}>
                <dt>Chapters</dt>
                <dd>{book.totalChapters}</dd>
              </div>
              <div className={styles.infoRow}>
                <dt>Sentences</dt>
                <dd>{book.totalSentences}</dd>
              </div>
              <div className={styles.infoRow}>
                <dt>Book Size</dt>
                <dd>{formatSize(book.fileSize)}</dd>
              </div>
              <div className={styles.infoRow}>
                <dt>Audio Size</dt>
                <dd>{formatSize(book.audioSize)}</dd>
              </div>
              <div className={styles.infoRow}>
                <dt>Audio Status</dt>
                <dd>{book.ttsStatus === 'completed' ? 'Done' : book.ttsStatus === 'generating' ? `Generating (${ttsCompleted}/${ttsTotal})` : book.ttsStatus === 'failed' ? 'Failed' : 'Pending'}</dd>
              </div>
              <div className={styles.infoRow}>
                <dt>Progress</dt>
                <dd>{pct > 0 ? `${pct}%` : '—'}</dd>
              </div>
            </dl>
            <div className={styles.dialogActions}>
              <Dialog.Close asChild>
                <button className={styles.dialogCancel}>Close</button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </>
  );
}
