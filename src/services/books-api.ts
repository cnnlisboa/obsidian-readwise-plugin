import { requestUrl } from 'obsidian';
import type { BookPatch, BooksBook } from './books-model';
import { snapRating } from './books-model';

const BASE = 'https://readwise.io/books/api/v1';
const WRITABLE = new Set(['want_to_read', 'currently_reading', 'finished', 'did_not_finish', 'deleted']);

export interface ItemResult {
  ok: boolean;
  id?: number | null;
  code?: string;
  message?: string;
  raw?: Record<string, unknown>;
}

/**
 * Readwise Books API (experimental). Batches answer 200 even when items fail,
 * so every item's result is read; unknown fields are silently ignored, so
 * items are validated before sending.
 */
export class BooksApi {
  constructor(private token: () => string | null) {}

  private async call(method: string, path: string, body?: unknown): Promise<unknown> {
    const token = this.token();
    if (!token) throw new Error('Readwise token missing');
    const response = await requestUrl({
      url: `${BASE}${path}`,
      method,
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    if (response.status === 429) {
      const wait = Number(response.headers?.['retry-after'] ?? 30);
      await new Promise((resolve) => window.setTimeout(resolve, Math.min(wait, 120) * 1000));
      return this.call(method, path, body);
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Readwise Books ${method} ${path.split('?')[0]}: HTTP ${response.status}`);
    }
    return response.json as unknown;
  }

  /** Every book on every shelf (deleted included). */
  async listAll(): Promise<BooksBook[]> {
    const books: BooksBook[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 50; page++) {
      const query: string = `?limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const data = await this.call('GET', `/books${query}`) as { results?: unknown; next?: string | null };
      if (!Array.isArray(data?.results)) throw new Error('Readwise Books: unexpected response');
      for (const book of data.results as BooksBook[]) {
        if (book && typeof book.id === 'number') books.push(book);
      }
      const next = data.next ? new URL(data.next).searchParams.get('cursor') : null;
      if (!next) break;
      cursor = next;
    }
    return books;
  }

  static clean(patch: BookPatch): BookPatch | null {
    const out: BookPatch = { id: patch.id };
    if (patch.status !== undefined) {
      if (!WRITABLE.has(patch.status)) return null;
      out.status = patch.status;
    }
    if (patch.rating !== undefined) {
      const rating = snapRating(patch.rating);
      if (rating === null) return null;
      out.rating = rating;
    }
    if (patch.started_reading_at) out.started_reading_at = patch.started_reading_at;
    if (patch.finished_reading_at) out.finished_reading_at = patch.finished_reading_at;
    if (patch.manual_total_pages !== undefined) {
      const pages = Math.floor(patch.manual_total_pages);
      if (pages >= 1 && pages <= 5000) out.manual_total_pages = pages;
    }
    return Object.keys(out).length > 1 ? out : null;
  }

  private async batch(method: string, path: string, items: unknown[], size: number,
    okStatuses: string[]): Promise<ItemResult[]> {
    const results: ItemResult[] = [];
    for (let i = 0; i < items.length; i += size) {
      const chunk = items.slice(i, i + size);
      try {
        const data = await this.call(method, path, { items: chunk }) as { results?: Record<string, unknown>[] };
        chunk.forEach((_, j) => {
          const entry = data?.results?.[j];
          const error = entry?.error as { code?: string; message?: string } | null | undefined;
          results.push(entry ? {
            ok: typeof entry.status === 'string' && okStatuses.includes(entry.status),
            id: (entry.id ?? entry.book_id) as number | null,
            code: error?.code,
            message: error?.message,
            raw: entry,
          } : { ok: false, code: 'missing_result' });
        });
      } catch (error) {
        chunk.forEach(() => results.push({ ok: false, code: 'request_failed', message: String(error) }));
      }
    }
    return results;
  }

  /** PATCH /books; results align with `patches` (unsendable ones fail locally). */
  async update(patches: BookPatch[]): Promise<ItemResult[]> {
    const cleaned = patches.map((p) => BooksApi.clean(p));
    const sendable = cleaned.filter((p): p is BookPatch => p !== null);
    const sent = await this.batch('PATCH', '/books', sendable, 100, ['updated']);
    let k = 0;
    return cleaned.map((p) => (p ? sent[k++] : { ok: false, code: 'invalid_value', message: 'not sendable' }));
  }

  /** POST /books: { product: {isbn} | {title, author}, status }. */
  async create(items: { product: Record<string, string>; status?: string }[]): Promise<ItemResult[]> {
    return this.batch('POST', '/books', items, 10, ['created', 'existing']);
  }
}

export function isRetryable(result: ItemResult | undefined): boolean {
  return !result || ['rate_limited', 'server_error', 'request_failed', 'missing_result'].includes(result.code ?? '');
}
