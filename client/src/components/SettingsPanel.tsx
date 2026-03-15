import { useCallback, useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import * as Switch from '@radix-ui/react-switch';
import { PlayIcon, StopIcon } from '@radix-ui/react-icons';
import type { TtsVoice, TtsVoiceMap } from '@tts-reader/shared';
import { getTtsDemoUrl, getTtsVoices } from '../services/api.js';
import styles from './SettingsPanel.module.scss';

interface SettingsPanelProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

function readSetting(key: string, fallback: string): string {
  return localStorage.getItem(key) ?? fallback;
}

export default function SettingsPanel({ open, onOpenChange }: SettingsPanelProps) {
  const [voiceMap, setVoiceMap] = useState<TtsVoiceMap | null>(null);

  const [language, setLanguage] = useState(() => readSetting('tts-default-language', 'American English'));
  const [voice, setVoice] = useState(() => readSetting('tts-default-voice', ''));
  const [skipImport, setSkipImport] = useState(() => readSetting('tts-skip-import-dialog', 'false') === 'true');
  const [errorBehavior, setErrorBehavior] = useState(() => readSetting('tts-error-behavior', 'skip'));
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
    localStorage.setItem('tts-default-language', lang);
    // Reset voice when language changes
    setVoice('');
    localStorage.setItem('tts-default-voice', '');
  };

  const handleVoiceChange = (v: string) => {
    setVoice(v);
    localStorage.setItem('tts-default-voice', v);
  };

  const handleSkipImportChange = (checked: boolean) => {
    setSkipImport(checked);
    localStorage.setItem('tts-skip-import-dialog', String(checked));
  };

  const handleErrorBehaviorChange = (val: string) => {
    setErrorBehavior(val);
    localStorage.setItem('tts-error-behavior', val);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className={styles.overlay} />
        <Dialog.Content className={styles.content}>
          <Dialog.Title className={styles.title}>Settings</Dialog.Title>

          <div className={styles.row}>
            <label className={styles.label}>Default language</label>
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

          <div className={styles.row}>
            <label className={styles.label}>Default voice</label>
            <div className={styles.voiceControl}>
              <select
                className={styles.select}
                value={voice}
                onChange={(e) => handleVoiceChange(e.target.value)}
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

          <div className={styles.row}>
            <label className={styles.label}>Skip import dialog</label>
            <Switch.Root
              className={styles.switchRoot}
              checked={skipImport}
              onCheckedChange={handleSkipImportChange}
            >
              <Switch.Thumb className={styles.switchThumb} />
            </Switch.Root>
          </div>

          <div className={styles.row}>
            <label className={styles.label}>On generation failure</label>
            <select
              className={styles.select}
              value={errorBehavior}
              onChange={(e) => handleErrorBehaviorChange(e.target.value)}
            >
              <option value="skip">Skip failed sentences</option>
              <option value="stop">Stop generation</option>
            </select>
          </div>

          <button className={styles.done} onClick={() => onOpenChange(false)}>
            Done
          </button>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
