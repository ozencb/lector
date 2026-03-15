import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { PlayIcon, StopIcon } from '@radix-ui/react-icons';
import type { TtsVoice, TtsVoiceMap } from '@tts-reader/shared';
import { getTtsDemoUrl, getTtsVoices } from '../services/api.js';
import styles from './ImportModal.module.scss';

interface ImportModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (voice: string, language: string) => void;
}

function readSetting(key: string, fallback: string): string {
  return localStorage.getItem(key) ?? fallback;
}

export default function ImportModal({ open, onOpenChange, onConfirm }: ImportModalProps) {
  const [voiceMap, setVoiceMap] = useState<TtsVoiceMap | null>(null);
  const [language, setLanguage] = useState(() => readSetting('tts-default-language', 'American English'));
  const [voice, setVoice] = useState(() => readSetting('tts-default-voice', ''));
  const [demoPlaying, setDemoPlaying] = useState(false);
  const audioRef = useRef<HTMLAudioElement | null>(null);

  const playDemo = useCallback((voiceId: string) => {
    if (!audioRef.current) audioRef.current = new Audio();
    const audio = audioRef.current;
    audio.pause();
    if (demoPlaying) {
      setDemoPlaying(false);
      return;
    }
    audio.src = getTtsDemoUrl(voiceId);
    audio.onended = () => setDemoPlaying(false);
    audio.onerror = () => setDemoPlaying(false);
    audio.play().then(() => setDemoPlaying(true)).catch(() => setDemoPlaying(false));
  }, [demoPlaying]);

  useEffect(() => {
    return () => { audioRef.current?.pause(); };
  }, []);

  useEffect(() => {
    if (!open || voiceMap) return;
    getTtsVoices().then(setVoiceMap).catch(() => {});
  }, [open, voiceMap]);

  const languages = voiceMap ? Object.keys(voiceMap) : [];
  const voices: TtsVoice[] = voiceMap && language ? (voiceMap[language] ?? []) : [];

  const handleLanguageChange = (lang: string) => {
    setLanguage(lang);
    setVoice('');
  };

  const handleConfirm = () => {
    const selectedVoice = voice || (voices.length > 0 ? voices[0].id : '');
    const languageCode = selectedVoice ? selectedVoice[0] : '';
    onConfirm(selectedVoice, languageCode);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content}>
          <Dialog.Title className={styles.title}>Import Book</Dialog.Title>

          <div className={styles.field}>
            <label>Language</label>
            <select
              className={styles.select}
              value={language}
              onChange={(e) => handleLanguageChange(e.target.value)}
            >
              {languages.map((lang) => (
                <option key={lang} value={lang}>{lang}</option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label>Voice</label>
            <div className={styles.voiceControl}>
              <select
                className={styles.select}
                value={voice}
                onChange={(e) => setVoice(e.target.value)}
              >
                <option value="">First available</option>
                {voices.map((v) => (
                  <option key={v.id} value={v.id}>{v.name}</option>
                ))}
              </select>
              <button
                className={styles.demoButton}
                onClick={() => playDemo(voice || (voices[0]?.id ?? ''))}
                disabled={voices.length === 0}
                aria-label="Preview voice"
              >
                {demoPlaying ? <StopIcon /> : <PlayIcon />}
              </button>
            </div>
          </div>

          <div className={styles.actions}>
            <button className={styles.cancelButton} onClick={() => onOpenChange(false)}>
              Cancel
            </button>
            <button className={styles.importButton} onClick={handleConfirm}>
              Import
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
