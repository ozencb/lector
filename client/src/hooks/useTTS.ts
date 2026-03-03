import { useCallback, useEffect, useRef, useState } from 'react';

interface UseTTSOptions {
  text: string | undefined;
  /** Called when utterance ends. Return false to stop auto-play (e.g., at end of book). */
  onEnd: () => boolean | void;
}

const VOICE_STORAGE_KEY = 'tts-voice';
const SPEED_STORAGE_KEY = 'tts-speed';

function getStoredVoiceKey(): string | null {
  return localStorage.getItem(VOICE_STORAGE_KEY);
}

function storeVoiceKey(voice: SpeechSynthesisVoice): void {
  localStorage.setItem(VOICE_STORAGE_KEY, `${voice.name}::${voice.lang}`);
}

function findVoiceByKey(voices: SpeechSynthesisVoice[], key: string): SpeechSynthesisVoice | null {
  return voices.find(v => `${v.name}::${v.lang}` === key) ?? null;
}

/**
 * The Web Speech API rate property scales non-linearly — small increases
 * produce disproportionately large perceived speed changes. This dampens
 * the deviation from 1.0 so user-facing labels feel accurate.
 */
function adjustRate(rate: number): number {
  return 1 + (rate - 1) * 0.35;
}

export function useTTS({ text, onEnd }: UseTTSOptions) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeedState] = useState(() => {
    const stored = localStorage.getItem(SPEED_STORAGE_KEY);
    return stored ? parseFloat(stored) : 1.0;
  });
  const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]);
  const [selectedVoice, setSelectedVoice] = useState<SpeechSynthesisVoice | null>(null);
  const onEndRef = useRef(onEnd);
  const isPlayingRef = useRef(false);
  const speedRef = useRef(speed);
  const selectedVoiceRef = useRef(selectedVoice);
  const speakGenRef = useRef(0);

  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { speedRef.current = speed; }, [speed]);
  useEffect(() => { selectedVoiceRef.current = selectedVoice; }, [selectedVoice]);

  // Load voices (async in some browsers)
  useEffect(() => {
    const loadVoices = () => {
      const available = speechSynthesis.getVoices();
      if (available.length === 0) return;
      setVoices(available);

      // Restore saved voice or fall back to default
      const storedKey = getStoredVoiceKey();
      if (storedKey) {
        const found = findVoiceByKey(available, storedKey);
        setSelectedVoice(found); // null if not found = browser default
      }
    };

    loadVoices();
    speechSynthesis.addEventListener('voiceschanged', loadVoices);
    return () => { speechSynthesis.removeEventListener('voiceschanged', loadVoices); };
  }, []);

  useEffect(() => {
    return () => { speechSynthesis.cancel(); };
  }, []);

  const speak = useCallback((sentence: string, rate: number) => {
    const gen = ++speakGenRef.current;
    speechSynthesis.cancel();
    const utterance = new SpeechSynthesisUtterance(sentence);
    utterance.rate = adjustRate(rate);
    if (selectedVoiceRef.current) {
      utterance.voice = selectedVoiceRef.current;
    }
    utterance.onend = () => {
      if (!isPlayingRef.current || gen !== speakGenRef.current) return;
      const result = onEndRef.current();
      if (result === false) {
        setIsPlaying(false);
      }
    };
    // Chrome bug: calling speak() immediately after cancel() can corrupt the
    // SpeechSynthesis service. A short delay lets it settle.
    setTimeout(() => {
      if (gen === speakGenRef.current) {
        speechSynthesis.speak(utterance);
      }
    }, 50);
  }, []);

  const play = useCallback(() => {
    if (!text) return;
    setIsPlaying(true);
    speak(text, speed);
  }, [text, speed, speak]);

  const pause = useCallback(() => {
    setIsPlaying(false);
    speechSynthesis.cancel();
  }, []);

  const setVoice = useCallback((voice: SpeechSynthesisVoice | null) => {
    setSelectedVoice(voice);
    if (voice) {
      storeVoiceKey(voice);
    } else {
      localStorage.removeItem(VOICE_STORAGE_KEY);
    }
  }, []);

  // Re-speak when text changes while playing
  const prevTextRef = useRef(text);
  useEffect(() => {
    if (text && text !== prevTextRef.current && isPlayingRef.current) {
      speak(text, speedRef.current);
    }
    prevTextRef.current = text;
  }, [text, speak]);

  // Restart with new rate when speed changes while playing
  useEffect(() => {
    speedRef.current = speed;
    if (isPlayingRef.current && text) {
      speak(text, speed);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [speed]);

  // Restart with new voice when voice changes while playing
  useEffect(() => {
    selectedVoiceRef.current = selectedVoice;
    if (isPlayingRef.current && text) {
      speak(text, speedRef.current);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedVoice]);

  const setSpeed = useCallback((s: number) => {
    setSpeedState(s);
    localStorage.setItem(SPEED_STORAGE_KEY, String(s));
  }, []);

  return { isPlaying, play, pause, speed, setSpeed, voices, selectedVoice, setVoice };
}
