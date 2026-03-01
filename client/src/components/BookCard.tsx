import { useState } from 'react';
import * as ContextMenu from '@radix-ui/react-context-menu';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { Book } from '@tts-reader/shared';
import { useNavigate } from 'react-router-dom';
import styles from './BookCard.module.scss';

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
}

export default function BookCard({ book, onDelete }: BookCardProps) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const progress = book.progress ?? 0;
  const pct = Math.round(progress * 100);

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
    </>
  );
}
