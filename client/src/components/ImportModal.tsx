import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import type { TtsVoice, TtsVoiceMap } from '@tts-reader/shared';
import { getTtsVoices } from '../services/api.js';
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
