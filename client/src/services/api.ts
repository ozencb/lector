import type {
  Book,
  BookDetail,
  BookUploadResponse,
  ChapterDetail,
  Progress,
  TtsStatus,
  TtsVoiceMap,
} from "@tts-reader/shared";

const BASE_URL = import.meta.env.DEV ? "http://localhost:3000" : "";

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, init);
  } catch {
    throw new Error("Network error — check your connection and try again.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(text || `Request failed (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json() as Promise<T>;
}

export function listBooks(): Promise<Book[]> {
  return request<Book[]>("/api/books");
}

export function getBook(id: string): Promise<BookDetail> {
  return request<BookDetail>(`/api/books/${id}`);
}

export function deleteBook(id: string): Promise<void> {
  return request<void>(`/api/books/${id}`, { method: "DELETE" });
}

export function uploadBook(file: File, voice?: string, language?: string, errorBehavior?: string): Promise<BookUploadResponse> {
  const form = new FormData();
  form.append("file", file);
  if (voice) form.append("voice", voice);
  if (language) form.append("language", language);
  if (errorBehavior) form.append("errorBehavior", errorBehavior);
  return request<BookUploadResponse>("/api/books", {
    method: "POST",
    body: form,
  });
}

export function getChapter(id: string): Promise<ChapterDetail> {
  return request<ChapterDetail>(`/api/chapters/${id}`);
}

export function getProgress(bookId: string): Promise<Progress> {
  return request<Progress>(`/api/books/${bookId}/progress`);
}

export function updateProgress(
  bookId: string,
  sentenceId: string,
): Promise<Progress> {
  return request<Progress>(`/api/books/${bookId}/progress`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ sentenceId }),
  });
}

export function getTtsStatus(bookId: string): Promise<TtsStatus> {
  return request<TtsStatus>(`/api/books/${bookId}/tts-status`);
}

export function getTtsVoices(): Promise<TtsVoiceMap> {
  return request<TtsVoiceMap>("/api/tts/voices");
}

export function getTtsAudioUrl(sentenceId: string): string {
  return `${BASE_URL}/api/tts/${sentenceId}`;
}

export function regenerateBookAudio(bookId: string): Promise<{ status: string }> {
  return request<{ status: string }>(`/api/books/${bookId}/regenerate`, {
    method: "POST",
  });
}

/** Fire-and-forget progress save for beforeunload (sendBeacon). */
export function updateProgressBeacon(bookId: string, sentenceId: string): void {
  const url = `${BASE_URL}/api/books/${bookId}/progress`;
  const body = JSON.stringify({ sentenceId });
  navigator.sendBeacon(url, new Blob([body], { type: "application/json" }));
}
