import { useCallback, useEffect, useRef, useState } from 'react';
import { getTtsAudioUrl } from '../services/api.js';

interface UseTTSOptions {
  sentenceId: string | undefined;
  prefetchIds?: string[];
  onEnd: () => boolean | void;
}

const SPEED_STORAGE_KEY = 'tts-speed';

export function useTTS({ sentenceId, prefetchIds, onEnd }: UseTTSOptions) {
  const [isPlaying, setIsPlaying] = useState(false);
  const [speed, setSpeedState] = useState(() => {
    const stored = localStorage.getItem(SPEED_STORAGE_KEY);
    return stored ? parseFloat(stored) : 1.0;
  });

  const audioRef = useRef<HTMLAudioElement | null>(null);
  const onEndRef = useRef(onEnd);
  const isPlayingRef = useRef(false);
  const speedRef = useRef(speed);
  const genRef = useRef(0);

  useEffect(() => { onEndRef.current = onEnd; }, [onEnd]);
  useEffect(() => { isPlayingRef.current = isPlaying; }, [isPlaying]);
  useEffect(() => { speedRef.current = speed; }, [speed]);

  // Create audio element once
  useEffect(() => {
    const audio = new Audio();
    audioRef.current = audio;

    audio.addEventListener('ended', () => {
      const currentGen = genRef.current;
      const result = onEndRef.current();
      if (result === false) {
        // Only update if generation hasn't changed (no new sentence triggered)
        if (genRef.current === currentGen) {
          setIsPlaying(false);
        }
      }
    });

    return () => {
      audio.pause();
      audio.removeAttribute('src');
      audioRef.current = null;
    };
  }, []);

  const play = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !sentenceId) return;
    const gen = ++genRef.current;
    audio.src = getTtsAudioUrl(sentenceId);
    audio.playbackRate = speedRef.current;
    audio.play().catch(() => {
      if (gen === genRef.current) setIsPlaying(false);
    });
    setIsPlaying(true);
  }, [sentenceId]);

  const pause = useCallback(() => {
    audioRef.current?.pause();
    setIsPlaying(false);
  }, []);

  // Sentence change while playing
  const prevSentenceIdRef = useRef(sentenceId);
  useEffect(() => {
    if (sentenceId && sentenceId !== prevSentenceIdRef.current && isPlayingRef.current) {
      const audio = audioRef.current;
      if (!audio) return;
      const gen = ++genRef.current;
      audio.src = getTtsAudioUrl(sentenceId);
      audio.playbackRate = speedRef.current;
      audio.play().catch(() => {
        if (gen === genRef.current) setIsPlaying(false);
      });
    }
    prevSentenceIdRef.current = sentenceId;
  }, [sentenceId]);

  // Speed change while playing
  useEffect(() => {
    speedRef.current = speed;
    const audio = audioRef.current;
    if (audio) {
      audio.playbackRate = speed;
    }
  }, [speed]);

  // Prefetch
  useEffect(() => {
    if (!prefetchIds || prefetchIds.length === 0) return;
    const controller = new AbortController();

    for (const id of prefetchIds) {
      const url = getTtsAudioUrl(id);
      const doFetch = () => {
        fetch(url, { signal: controller.signal }).then(res => {
          if (res.status === 404 && !controller.signal.aborted) {
            setTimeout(() => {
              if (!controller.signal.aborted) doFetch();
            }, 3000);
          }
        }).catch(() => {});
      };
      doFetch();
    }

    return () => { controller.abort(); };
  }, [prefetchIds]);

  const setSpeed = useCallback((s: number) => {
    setSpeedState(s);
    localStorage.setItem(SPEED_STORAGE_KEY, String(s));
  }, []);

  return { isPlaying, play, pause, speed, setSpeed };
}
