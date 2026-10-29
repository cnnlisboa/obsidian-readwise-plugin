import { requestUrl } from 'obsidian';

const LIST_URL = 'https://readwise.io/api/v3/list/';

export interface ReaderDocument {
  id: string;
  url: string;
  source_url?: string | null;
  title: string;
  author?: string | null;
  category: string;
  tags?: Record<string, { name?: string }>;
  notes?: string | null;
  summary?: string | null;
  updated_at: string;
  parent_id?: string | null;
  html_content?: string | null;
  raw_source_url?: string | null;
}

interface ReaderPage {
  results: ReaderDocument[];
  nextPageCursor: string | null;
}

export interface ReaderListOptions {
  /** Include html_content and raw_source_url. Without them a page is much smaller. */
  content?: boolean;
  updatedAfter?: string;
  id?: string;
}

export async function listTaggedReaderDocuments(token: string, tag: string, options: ReaderListOptions = { content: true }): Promise<ReaderDocument[]> {
  const results: ReaderDocument[] = [];
  let cursor: string | null = null;
  const seenCursors = new Set<string>();

  do {
    const query = new URLSearchParams({ limit: '100' });
    if (tag) query.set('tag', tag);
    if (options.content) {
      query.set('withHtmlContent', 'true');
      query.set('withRawSourceUrl', 'true');
    }
    if (options.updatedAfter) query.set('updatedAfter', options.updatedAfter);
    if (options.id) query.set('id', options.id);
    if (cursor) query.set('pageCursor', cursor);
    let retries = 0;
    while (true) {
      const response = await requestUrl({
        url: `${LIST_URL}?${query.toString()}`,
        headers: { Authorization: `Token ${token}` },
        throw: false,
      });
      if (response.status === 429) {
        if (++retries > 5) throw new Error('Reader API rate limit persisted after five retries.');
        const seconds = Number(response.headers['retry-after'] ?? response.headers['Retry-After']);
        await new Promise((resolve) => window.setTimeout(resolve, (Number.isFinite(seconds) ? Math.max(1, seconds) : 60) * 1000));
        continue;
      }
      if (response.status !== 200) throw new Error(`Reader API list failed with HTTP ${response.status}.`);
      const page = response.json as ReaderPage;
      if (!Array.isArray(page.results) || (page.nextPageCursor !== null && typeof page.nextPageCursor !== 'string')) {
        throw new Error('Reader API returned an invalid document page.');
      }
      results.push(...page.results.filter((document) => document && typeof document.id === 'string' && !document.parent_id));
      cursor = page.nextPageCursor;
      if (cursor) {
        if (seenCursors.has(cursor)) throw new Error('Reader API repeated a page cursor.');
        seenCursors.add(cursor);
      }
      break;
    }
  } while (cursor);

  return results;
}
