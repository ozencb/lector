import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  ArrowLeftIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  PlayIcon,
  PauseIcon,
  TimerIcon,
} from '@radix-ui/react-icons';
import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import WheelPicker from '../components/WheelPicker.js';
import ThemeToggle from '../components/ThemeToggle.js';
import type { BookDetail, ChapterDetail } from '@tts-reader/shared';
import { getBook, getChapter, getProgress, updateProgress, updateProgressBeacon, prioritizeBookAudio } from '../services/api.js';
import { useTTS } from '../hooks/useTTS.js';
import { debounce } from '../utils/debounce.js';
import styles from './ReaderPage.module.scss';

const SPEED_OPTIONS = [
  { label: '0.50x', value: '0.50' },
  { label: '0.75x', value: '0.75' },
  { label: '1.00x', value: '1.00' },
  { label: '1.25x', value: '1.25' },
  { label: '1.50x', value: '1.50' },
  { label: '1.75x', value: '1.75' },
  { label: '2.00x', value: '2.00' },
  { label: '2.50x', value: '2.50' },
  { label: '3.00x', value: '3.00' },
];

export default function ReaderPage() {
  const { bookId } = useParams<{ bookId: string }>();
  const navigate = useNavigate();

  const [book, setBook] = useState<BookDetail | null>(null);
  const [chapter, setChapter] = useState<ChapterDetail | null>(null);
  const [chapterIdx, setChapterIdx] = useState(0);
  const [sentenceIdx, setSentenceIdx] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusMode, setFocusMode] = useState(() => localStorage.getItem('focusMode') === 'true');

  // Cache loaded chapters to avoid refetching
  const chapterCache = useRef<Map<string, ChapterDetail>>(new Map());

  const loadChapter = useCallback(async (chapterId: string): Promise<ChapterDetail> => {
    const cached = chapterCache.current.get(chapterId);
    if (cached) return cached;
    const data = await getChapter(chapterId);
    chapterCache.current.set(chapterId, data);
    return data;
  }, []);

  // Initial load: fetch book + progress, load correct chapter
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;

    (async () => {
      try {
        const bookData = await getBook(bookId);
        if (cancelled) return;
        setBook(bookData);

        // Auto-prioritize TTS generation for the book being read
        if (bookData.ttsStatus !== 'completed') {
          prioritizeBookAudio(bookId).catch(() => {});
        }

        let targetChapterIdx = 0;
        let targetSentenceIdx = 0;

        try {
          const progress = await getProgress(bookId);
          targetChapterIdx = progress.chapterIdx;
          targetSentenceIdx = progress.sentenceIdx;
        } catch {
          // No progress saved — start from beginning
        }

        if (cancelled) return;
        const ch = await loadChapter(bookData.chapters[targetChapterIdx].id);
        if (cancelled) return;

        setChapter(ch);
        setChapterIdx(targetChapterIdx);
        setSentenceIdx(targetSentenceIdx);
        setLoading(false);
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : 'Failed to load book');
          setLoading(false);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [bookId, loadChapter]);

  // Preload adjacent chapters
  useEffect(() => {
    if (!book) return;
    const prevIdx = chapterIdx - 1;
    const nextIdx = chapterIdx + 1;
    if (prevIdx >= 0) loadChapter(book.chapters[prevIdx].id).catch(() => {});
    if (nextIdx < book.chapters.length) loadChapter(book.chapters[nextIdx].id).catch(() => {});
  }, [book, chapterIdx, loadChapter]);

  // Update page title
  useEffect(() => {
    if (book) {
      document.title = `${book.title} — TTS Reader`;
    }
    return () => { document.title = 'TTS Reader'; };
  }, [book]);

  const goToSentence = useCallback(async (dir: 'next' | 'prev') => {
    if (!book || !chapter) return;

    if (dir === 'next') {
      if (sentenceIdx < chapter.sentences.length - 1) {
        setSentenceIdx(sentenceIdx + 1);
      } else {
        // Find next chapter with sentences (skip empty)
        let nextIdx = chapterIdx + 1;
        while (nextIdx < book.chapters.length) {
          try {
            const nextCh = await loadChapter(book.chapters[nextIdx].id);
            if (nextCh.sentences.length > 0) {
              setChapter(nextCh);
              setChapterIdx(nextIdx);
              setSentenceIdx(0);
              return;
            }
          } catch { /* skip */ }
          nextIdx++;
        }
      }
    } else {
      if (sentenceIdx > 0) {
        setSentenceIdx(sentenceIdx - 1);
      } else {
        // Find prev chapter with sentences (skip empty)
        let prevIdx = chapterIdx - 1;
        while (prevIdx >= 0) {
          try {
            const prevCh = await loadChapter(book.chapters[prevIdx].id);
            if (prevCh.sentences.length > 0) {
              setChapter(prevCh);
              setChapterIdx(prevIdx);
              setSentenceIdx(prevCh.sentences.length - 1);
              return;
            }
          } catch { /* skip */ }
          prevIdx--;
        }
      }
    }
  }, [book, chapter, chapterIdx, sentenceIdx, loadChapter]);

  const currentSentence = chapter?.sentences[sentenceIdx];

  const isAtEnd = book && chapter
    ? chapterIdx === book.chapters.length - 1 && sentenceIdx === chapter.sentences.length - 1
    : false;

  const isAtEndRef = useRef(false);
  isAtEndRef.current = isAtEnd;

  const tts = useTTS({
    sentenceId: currentSentence?.id,
    prefetchIds: chapter?.sentences
      .slice(sentenceIdx + 1, sentenceIdx + 6)
      .map(s => s.id),
    onEnd: () => {
      if (isAtEndRef.current) return false;
      goToSentence('next');
    },
  });
  // --- Progress saving ---
  const debouncedSave = useRef(
    debounce((bId: string, sId: string) => {
      updateProgress(bId, sId).catch(() => {});
    }, 5000)
  ).current;

  // Save progress on sentence change (debounced)
  useEffect(() => {
    if (!bookId || !currentSentence) return;
    debouncedSave(bookId, currentSentence.id);
  }, [bookId, currentSentence, debouncedSave]);

  // Save immediately on pause
  const origPause = tts.pause;
  const pauseWithSave = useCallback(() => {
    origPause();
    if (bookId && currentSentence) {
      debouncedSave.cancel();
      updateProgress(bookId, currentSentence.id).catch(() => {});
    }
  }, [origPause, bookId, currentSentence, debouncedSave]);

  // Save on page unload via sendBeacon
  const bookIdRef = useRef(bookId);
  const sentenceRef = useRef(currentSentence);
  bookIdRef.current = bookId;
  sentenceRef.current = currentSentence;

  useEffect(() => {
    const onUnload = () => {
      if (bookIdRef.current && sentenceRef.current) {
        debouncedSave.cancel();
        updateProgressBeacon(bookIdRef.current, sentenceRef.current.id);
      }
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      window.removeEventListener('beforeunload', onUnload);
      debouncedSave.flush();
    };
  }, [debouncedSave]);

  const prevSentence = chapter?.sentences[sentenceIdx - 1];
  const nextSentence = chapter?.sentences[sentenceIdx + 1];

  // Show prev chapter's last sentence if at start of current chapter
  const [prevChapterLastSentence, setPrevChapterLastSentence] = useState<string | null>(null);
  const [nextChapterFirstSentence, setNextChapterFirstSentence] = useState<string | null>(null);

  useEffect(() => {
    if (!book || !chapter) return;
    // If at first sentence, get prev chapter's last sentence for display
    if (sentenceIdx === 0 && chapterIdx > 0) {
      const prevId = book.chapters[chapterIdx - 1].id;
      loadChapter(prevId).then(ch => {
        setPrevChapterLastSentence(ch.sentences[ch.sentences.length - 1]?.text ?? null);
      }).catch(() => setPrevChapterLastSentence(null));
    } else {
      setPrevChapterLastSentence(null);
    }
    // If at last sentence, get next chapter's first sentence for display
    if (chapter && sentenceIdx === chapter.sentences.length - 1 && chapterIdx < (book?.chapters.length ?? 0) - 1) {
      const nextId = book.chapters[chapterIdx + 1].id;
      loadChapter(nextId).then(ch => {
        setNextChapterFirstSentence(ch.sentences[0]?.text ?? null);
      }).catch(() => setNextChapterFirstSentence(null));
    } else {
      setNextChapterFirstSentence(null);
    }
  }, [book, chapter, chapterIdx, sentenceIdx, loadChapter]);

  const toggleFocusMode = useCallback((checked: boolean) => {
    setFocusMode(checked);
    localStorage.setItem('focusMode', String(checked));
  }, []);

  const [chapterDialogOpen, setChapterDialogOpen] = useState(false);
  const [speedPickerOpen, setSpeedPickerOpen] = useState(false);

  const jumpToChapter = useCallback(async (idx: number) => {
    if (!book) return;
    tts.pause();
    try {
      const ch = await loadChapter(book.chapters[idx].id);
      setChapter(ch);
      setChapterIdx(idx);
      setSentenceIdx(0);
      setChapterDialogOpen(false);
    } catch {
      // Failed to load chapter
    }
  }, [book, loadChapter, tts]);

  const displayPrev = prevSentence?.text ?? prevChapterLastSentence;
  const displayNext = nextSentence?.text ?? nextChapterFirstSentence;

  // Speed feedback toast
  const [speedToast, setSpeedToast] = useState<string | null>(null);
  const speedToastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  const showSpeedToast = useCallback((newSpeed: number) => {
    setSpeedToast(`${newSpeed.toFixed(2)}x`);
    clearTimeout(speedToastTimer.current);
    speedToastTimer.current = setTimeout(() => setSpeedToast(null), 1000);
  }, []);

  // Keyboard shortcuts
  const goToSentenceRef = useRef(goToSentence);
  goToSentenceRef.current = goToSentence;
  const ttsRef = useRef(tts);
  ttsRef.current = tts;
  const pauseWithSaveRef = useRef(pauseWithSave);
  pauseWithSaveRef.current = pauseWithSave;

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      // Don't handle if focus is in an input/textarea
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

      switch (e.key) {
        case ' ':
          e.preventDefault();
          if (ttsRef.current.isPlaying) {
            pauseWithSaveRef.current();
          } else {
            ttsRef.current.play();
          }
          break;
        case 'ArrowLeft':
          e.preventDefault();
          goToSentenceRef.current('prev');
          break;
        case 'ArrowRight':
          e.preventDefault();
          goToSentenceRef.current('next');
          break;
        case '[': {
          const cur = ttsRef.current.speed;
          const next = Math.max(0.5, cur - 0.25);
          if (next !== cur) {
            ttsRef.current.setSpeed(next);
            showSpeedToast(next);
          }
          break;
        }
        case ']': {
          const cur = ttsRef.current.speed;
          const next = Math.min(3.0, cur + 0.25);
          if (next !== cur) {
            ttsRef.current.setSpeed(next);
            showSpeedToast(next);
          }
          break;
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      clearTimeout(speedToastTimer.current);
    };
  }, [showSpeedToast]);

  if (loading) {
    return <div className={styles.loadingState}>Loading…</div>;
  }

  if (error || !book || !chapter || !currentSentence) {
    return (
      <div className={styles.errorState}>
        <p>{error || 'Book not found'}</p>
        <button className={styles.backLink} onClick={() => navigate('/')}>Back to Library</button>
      </div>
    );
  }

  return (
    <div className={styles.page}>
      {/* Header */}
      <header className={styles.header}>
        <button className={styles.iconButton} onClick={() => navigate('/')} aria-label="Back to library">
          <ArrowLeftIcon width={20} height={20} />
        </button>
        <span className={styles.bookTitle}>{book.title}</span>
        <Dialog.Root open={chapterDialogOpen} onOpenChange={setChapterDialogOpen}>
          <Dialog.Trigger asChild>
            <button className={styles.chapterIndicator}>
              Ch {chapterIdx + 1}/{book.chapters.length}
            </button>
          </Dialog.Trigger>
          <Dialog.Portal>
            <Dialog.Overlay className={styles.dialogOverlay} />
            <Dialog.Content className={styles.dialogContent}>
              <Dialog.Title className={styles.dialogTitle}>Chapters</Dialog.Title>
              <div className={styles.chapterList}>
                {book.chapters.map((ch, idx) => (
                  <button
                    key={ch.id}
                    className={`${styles.chapterItem} ${idx === chapterIdx ? styles.chapterItemActive : ''}`}
                    onClick={() => jumpToChapter(idx)}
                  >
                    <span className={styles.chapterNum}>{idx + 1}</span>
                    <span className={styles.chapterTitle}>{ch.title || `Chapter ${idx + 1}`}</span>
                  </button>
                ))}
              </div>
            </Dialog.Content>
          </Dialog.Portal>
        </Dialog.Root>
        <ThemeToggle />
        <label className={styles.focusToggle}>
          <span className={styles.focusLabel}>Focus</span>
          <Switch.Root
            className={styles.switchRoot}
            checked={focusMode}
            onCheckedChange={toggleFocusMode}
          >
            <Switch.Thumb className={styles.switchThumb} />
          </Switch.Root>
        </label>
      </header>

      {/* Sentence display */}
      <div className={styles.sentenceArea}>
        <div className={`${styles.prevSentence} ${focusMode ? styles.hidden : ''}`} key={`prev-${chapterIdx}-${sentenceIdx}`}>
          {displayPrev ?? ''}
        </div>
        <div className={styles.currentSentence} key={`cur-${chapterIdx}-${sentenceIdx}`}>
          {currentSentence.text}
        </div>
        <div className={`${styles.nextSentence} ${focusMode ? styles.hidden : ''}`} key={`next-${chapterIdx}-${sentenceIdx}`}>
          {displayNext ?? ''}
        </div>
      </div>

      {/* Controls */}
      <div className={styles.controls}>
        <button className={styles.iconButton} onClick={() => setSpeedPickerOpen(true)} aria-label="Playback speed">
          <TimerIcon width={20} height={20} />
        </button>
        <button
          className={styles.iconButton}
          onClick={() => goToSentence('prev')}
          aria-label="Previous sentence"
        >
          <ChevronLeftIcon width={24} height={24} />
        </button>
        <button
          className={styles.playButton}
          onClick={() => tts.isPlaying ? pauseWithSave() : tts.play()}
          aria-label={tts.isPlaying ? 'Pause' : 'Play'}
        >
          {tts.isPlaying ? <PauseIcon width={24} height={24} /> : <PlayIcon width={24} height={24} />}
        </button>
        <button
          className={styles.iconButton}
          onClick={() => goToSentence('next')}
          aria-label="Next sentence"
        >
          <ChevronRightIcon width={24} height={24} />
        </button>
      </div>

      {/* Speed picker modal */}
      <Dialog.Root open={speedPickerOpen} onOpenChange={setSpeedPickerOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className={styles.pickerOverlay} />
          <Dialog.Content className={styles.pickerContent}>
            <Dialog.Title className={styles.pickerTitle}>Speed</Dialog.Title>
            <WheelPicker
              items={SPEED_OPTIONS}
              value={tts.speed.toFixed(2)}
              onChange={(val) => tts.setSpeed(parseFloat(val))}
            />
            <button className={styles.pickerDone} onClick={() => setSpeedPickerOpen(false)}>Done</button>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      {/* Speed change toast */}
      {speedToast && (
        <div className={styles.speedToast} key={speedToast + Date.now()}>
          {speedToast}
        </div>
      )}
    </div>
  );
}
