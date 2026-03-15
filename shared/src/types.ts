export interface Book {
  id: string;
  title: string;
  author: string;
  coverPath: string | null;
  createdAt: number;
  totalChapters: number;
  totalSentences: number;
  progress: number | null;
  ttsStatus: 'pending' | 'generating' | 'completed' | 'failed';
}

export interface Chapter {
  id: string;
  bookId: string;
  idx: number;
  title: string;
  sentenceCount: number;
}

export interface Sentence {
  id: string;
  idx: number;
  text: string;
}

export interface Progress {
  bookId: string;
  sentenceId: string;
  chapterId: string;
  chapterIdx: number;
  sentenceIdx: number;
  updatedAt: number;
}

export interface BookDetail {
  id: string;
  title: string;
  author: string;
  coverPath: string | null;
  chapters: Chapter[];
}

export interface ChapterDetail {
  id: string;
  bookId: string;
  idx: number;
  title: string;
  sentences: Sentence[];
}

export interface BookUploadResponse {
  id: string;
  title: string;
  author: string;
  coverPath: string | null;
  totalChapters: number;
  totalSentences: number;
  ttsStatus: 'pending' | 'generating' | 'completed' | 'failed';
}

export interface TtsStatus {
  status: 'pending' | 'generating' | 'completed' | 'failed';
  total: number;
  completed: number;
  failed: number;
}

export interface TtsVoice {
  id: string;
  name: string;
}

export interface TtsVoiceMap {
  [language: string]: TtsVoice[];
}
