/**
 * Pure decisions for syncing personal book notes with Readwise Books
 * (PLAN-readwise-books.md 2.3, decided 2026-11-23):
 *
 * - Obsidian is the source of truth. A value you change in a book note is
 *   pushed to Readwise Books.
 * - Readwise only fills empty properties in a note, with one exception: when a
 *   book becomes finished, the note's status is set to the "finished" status
 *   (Done) once. Sync never writes Active or any other status.
 * - Start and finish dates, rating and pages are written once, never changed.
 */

export type Shelf = 'want_to_read' | 'currently_reading' | 'finished' | 'did_not_finish';

export const SHELVES: Shelf[] = ['want_to_read', 'currently_reading', 'finished', 'did_not_finish'];

const SHELF_RANK: Record<string, number> = {
  unsorted: 0, want_to_read: 1, currently_reading: 2, did_not_finish: 3, finished: 4,
};

export interface BooksProduct {
  id?: string;
  title?: string | null;
  author?: string | null;
  isbn?: string | null;
  page_count?: number | null;
  publishing_date?: string | null;
  summary?: string | null;
}

export interface BooksBook {
  id: number;
  title: string | null;
  author: string | null;
  status: string;
  creation_origin?: string | null;
  progress?: number | null;
  started_reading_at: string | null;
  finished_reading_at: string | null;
  status_changed_at?: string | null;
  rating: number | null;
  manual_total_pages?: number | null;
  product?: BooksProduct | null;
  created?: string;
  updated?: string;
}

export interface BooksPropertyNames {
  status: string;
  rating: string;
  start: string;
  finished: string;
  format: string;
  pages: string;
  id: string;
  isbn: string;
}

/** What sync last wrote or saw, per Books id. */
export interface BookSyncState {
  noteStatus?: string | null;
  noteRating?: number | null;
  noteStart?: string | null;
  noteFinished?: string | null;
  notePages?: number | null;
  remoteStatus?: string | null;
  doneWritten?: boolean;
}

export interface NoteValues {
  status: string | null;
  rating: number | null;
  ratingRaw: unknown;
  start: string | null;
  finished: string | null;
  pages: number | null;
  formats: string[];
  id: number | null;
  isbn: string | null;
}

export interface BookPatch {
  id: number;
  status?: Shelf;
  rating?: number;
  started_reading_at?: string;
  finished_reading_at?: string;
  manual_total_pages?: number;
}

export interface NotePlan {
  /** Frontmatter properties to set (name -> value). */
  frontmatter: Record<string, unknown>;
  patch: BookPatch | null;
  state: BookSyncState;
  log: string[];
}

function first(value: unknown): unknown {
  return Array.isArray(value) ? value[0] : value;
}

function asText(value: unknown): string | null {
  const v = first(value);
  if (v instanceof Date) return v.toISOString();
  if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') return null;
  const text = String(v).trim();
  return text === '' ? null : text;
}

/** Status as plain text; a list's first value that the map knows wins. */
export function readStatus(value: unknown, map: Record<string, string>): string | null {
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = asText(item);
      if (text && text in map) return text;
    }
    return asText(value);
  }
  return asText(value);
}

/**
 * A rating number from a note: a number, a numeric string, or stars
 * (⭐ / ⭐️, counting ½). Values above 5 are kept as they are (sent as 5).
 */
export function parseRating(value: unknown): number | null {
  const v = first(value);
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v !== 'string') return null;
  const text = v.trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const n = Number(text);
    return n > 0 ? n : null;
  }
  const stars = (text.match(/⭐/gu) ?? []).length;
  const half = text.includes('½') ? 0.5 : 0;
  if (stars === 0 && half === 0) return null;
  if (text.replace(/⭐|\uFE0F|½|\s/gu, '') !== '') return null; // "+ ⭐️" and the like: leave alone
  return stars + half;
}

/** 0.25-5 in quarter steps; above 5 becomes 5. */
export function snapRating(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value <= 0) return null;
  const capped = Math.min(value, 5);
  return Math.max(0.25, Math.round(capped * 4) / 4);
}

/** YYYY-MM-DD from a note date (string, Date, list), or null. */
export function readDate(value: unknown): string | null {
  const v = first(value);
  if (v instanceof Date && !Number.isNaN(v.getTime())) return v.toISOString().slice(0, 10);
  const text = asText(v);
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : null;
}

/** Local calendar date of an ISO timestamp. */
export function localDate(iso: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** A note date as an ISO timestamp at local noon (so it stays that day in any zone). */
export function dateToIso(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0).toISOString();
}

export function readNumber(value: unknown): number | null {
  const v = first(value);
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v.trim()) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

export function readList(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => asText(v)).filter((v): v is string => !!v);
  const text = asText(value);
  return text ? [text] : [];
}

export function readNote(frontmatter: Record<string, unknown>, names: BooksPropertyNames,
  statusMap: Record<string, string>): NoteValues {
  return {
    status: readStatus(frontmatter[names.status], statusMap),
    rating: parseRating(frontmatter[names.rating]),
    ratingRaw: frontmatter[names.rating],
    start: readDate(frontmatter[names.start]),
    finished: readDate(frontmatter[names.finished]),
    pages: readNumber(frontmatter[names.pages]),
    formats: readList(frontmatter[names.format]),
    id: readNumber(frontmatter[names.id]),
    isbn: asText(frontmatter[names.isbn]),
  };
}

/** Formats implied by how the book got into Readwise. */
export function formatsFromOrigin(origin: string | null | undefined): string[] {
  if (!origin) return [];
  if (['uploaded_ebook', 'bookstore_ebook', 'kindle', 'reader'].includes(origin)) return ['Digital'];
  if (origin === 'audible') return ['Audio'];
  if (origin === 'physical') return ['Physical'];
  return [];
}

export interface PlanOptions {
  names: BooksPropertyNames;
  /** Obsidian status -> shelf ('' = not synced). */
  statusMap: Record<string, string>;
  /** Status written when a book is finished. */
  finishedStatus: string;
  /** Add formats from Readwise (add-only). */
  formats: boolean;
}

/**
 * One book note against its Readwise Books entry. `previous` is the state
 * saved after the last sync (empty the first time).
 */
export function planNoteSync(note: NoteValues, book: BooksBook, previous: BookSyncState,
  options: PlanOptions): NotePlan {
  const { names } = options;
  const fm: Record<string, unknown> = {};
  const patch: BookPatch = { id: book.id };
  const log: string[] = [];
  const state: BookSyncState = { ...previous };
  const firstSight = previous.remoteStatus === undefined && previous.noteStatus === undefined;

  // ---- id / isbn (once)
  if (note.id !== book.id) fm[names.id] = book.id;
  if (!note.isbn && book.product?.isbn) fm[names.isbn] = book.product.isbn;

  // ---- status
  const mappedShelf = note.status ? options.statusMap[note.status] : undefined;
  const noteStatusChanged = !firstSight && note.status !== (previous.noteStatus ?? null);
  const remoteFinishedNow = book.status === 'finished' && previous.remoteStatus !== 'finished';
  let noteStatus = note.status;
  if (noteStatusChanged && mappedShelf && mappedShelf !== book.status) {
    patch.status = mappedShelf as Shelf;
    log.push(`status ${note.status} → ${mappedShelf}`);
  } else if (book.status === 'finished' && !previous.doneWritten
    && (remoteFinishedNow || firstSight) && note.status !== options.finishedStatus
    && !(noteStatusChanged && mappedShelf)) {
    // The one status sync writes. On first sight only if the note has none
    // yet; an existing status there is yours.
    if (!firstSight || !note.status) {
      fm[names.status] = options.finishedStatus;
      noteStatus = options.finishedStatus;
      state.doneWritten = true;
      log.push(`note status → ${options.finishedStatus}`);
    }
  } else if (firstSight && mappedShelf && mappedShelf !== book.status && book.status !== 'finished'
    && (SHELF_RANK[mappedShelf] ?? 0) > (SHELF_RANK[book.status] ?? 0)) {
    // First sight: a note further along than Readwise moves it forward. A
    // note behind Readwise (Backlog while the device says reading) waits
    // for you to change it.
    patch.status = mappedShelf as Shelf;
    log.push(`status ${note.status} → ${mappedShelf} (first sync)`);
  }
  if (note.status === options.finishedStatus) state.doneWritten = true;
  state.noteStatus = noteStatus;
  state.remoteStatus = patch.status ?? book.status;

  // ---- rating
  const noteRatingChanged = note.rating !== null && note.rating !== (previous.noteRating ?? null);
  if (noteRatingChanged) {
    const sent = snapRating(note.rating);
    if (sent !== null && sent !== book.rating) {
      patch.rating = sent;
      log.push(`rating ${note.rating} → ${sent}`);
    }
  } else if (note.rating === null && note.ratingRaw == null && book.rating !== null) {
    fm[names.rating] = book.rating;
    state.noteRating = book.rating;
    log.push(`note rating ← ${book.rating}`);
  }
  if (note.rating !== null) state.noteRating = note.rating;

  // ---- dates
  const remoteStart = localDate(book.started_reading_at);
  if (note.start) {
    if (note.start !== (previous.noteStart ?? null) && note.start !== remoteStart) {
      patch.started_reading_at = dateToIso(note.start);
      log.push(`start → ${note.start}`);
    }
    state.noteStart = note.start;
  } else if (remoteStart) {
    fm[names.start] = remoteStart;
    state.noteStart = remoteStart;
  }
  const remoteFinished = localDate(book.finished_reading_at);
  if (note.finished) {
    if (note.finished !== (previous.noteFinished ?? null) && note.finished !== remoteFinished) {
      patch.finished_reading_at = dateToIso(note.finished);
      log.push(`finished → ${note.finished}`);
    }
    state.noteFinished = note.finished;
  } else if (remoteFinished) {
    fm[names.finished] = remoteFinished;
    state.noteFinished = remoteFinished;
  }

  // ---- pages
  if (note.pages) {
    if (note.pages !== book.manual_total_pages && note.pages <= 5000
      && (note.pages !== (previous.notePages ?? null) || book.manual_total_pages == null)) {
      patch.manual_total_pages = note.pages;
    }
    state.notePages = note.pages;
  } else if (book.product?.page_count) {
    fm[names.pages] = book.product.page_count;
    state.notePages = book.product.page_count;
  }

  // ---- formats (add-only)
  if (options.formats) {
    const have = new Set(note.formats.map((f) => f.toLowerCase()));
    const add = formatsFromOrigin(book.creation_origin).filter((f) => !have.has(f.toLowerCase()));
    if (add.length > 0) fm[names.format] = [...note.formats, ...add];
  }

  const hasPatch = Object.keys(patch).length > 1;
  return { frontmatter: fm, patch: hasPatch ? patch : null, state, log };
}

// ---------------------------------------------------------------- matching

const ACCENTS: Record<string, string> = { à: 'a', á: 'a', â: 'a', ã: 'a', ä: 'a', ç: 'c', è: 'e', é: 'e', ê: 'e',
  ë: 'e', ì: 'i', í: 'i', î: 'i', ï: 'i', ñ: 'n', ò: 'o', ó: 'o', ô: 'o', õ: 'o', ö: 'o', ù: 'u', ú: 'u', û: 'u', ü: 'u' };
const ARTICLES = ['the', 'an', 'a', 'o', 'os', 'as', 'um', 'uma', 'el', 'la', 'los', 'las', 'le', 'les', 'il', 'lo'];

function fold(text: string): string {
  return text.toLowerCase().replace(/[àáâãäçèéêëìíîïñòóôõöùúûü]/g, (ch) => ACCENTS[ch] ?? ch);
}
function squash(text: string): string {
  return text.replace(/[^a-z0-9]/g, '');
}
function stripArticle(text: string): string {
  for (const article of ARTICLES) {
    const match = new RegExp(`^\\s*${article}\\s+(.+)$`).exec(text);
    if (match) return match[1];
  }
  return text;
}

export function titleKeys(title: string | null | undefined): string[] {
  const folded = fold(title ?? '');
  const main = /^(.*?)\s*:/.exec(folded)?.[1] ?? /^(.*?)\s+-\s+/.exec(folded)?.[1] ?? folded;
  const keys: string[] = [];
  for (const variant of [folded, main, stripArticle(folded), stripArticle(main)]) {
    const key = squash(variant);
    if (key && !keys.includes(key)) keys.push(key);
  }
  return keys;
}

export function authorTokens(author: string | null | undefined): Set<string> {
  return new Set((fold(author ?? '').match(/[a-z0-9]+/g) ?? []).filter((w) => w.length >= 3));
}

export function authorsCompatible(a: string | null | undefined, b: string | null | undefined): boolean {
  const ta = authorTokens(a);
  const tb = authorTokens(b);
  if (ta.size === 0 || tb.size === 0) return true;
  for (const word of ta) if (tb.has(word)) return true;
  return false;
}

export interface NoteIdentity {
  path: string;
  titles: string[];
  author: string | null;
  id: number | null;
  isbn: string | null;
}

/**
 * Books id -> note path. By id property first, then ISBN, then a unique
 * title (or alias) with a compatible author. Ties are never guessed.
 */
export function matchNotes(books: BooksBook[], notes: NoteIdentity[]): Map<number, string> {
  const result = new Map<number, string>();
  const used = new Set<string>();
  const byId = new Map<number, NoteIdentity>();
  const byIsbn = new Map<string, NoteIdentity>();
  const byKey = new Map<string, NoteIdentity[]>();
  for (const note of notes) {
    if (note.id) byId.set(note.id, note);
    if (note.isbn) byIsbn.set(note.isbn.replace(/-/g, ''), note);
    for (const title of note.titles) {
      for (const key of titleKeys(title)) {
        const list = byKey.get(key) ?? [];
        if (!list.includes(note)) list.push(note);
        byKey.set(key, list);
      }
    }
  }
  const live = books.filter((b) => b.status !== 'deleted');
  for (const book of live) {
    const note = byId.get(book.id);
    if (note) { result.set(book.id, note.path); used.add(note.path); }
  }
  for (const book of live) {
    if (result.has(book.id)) continue;
    const isbn = book.product?.isbn?.replace(/-/g, '');
    const note = isbn ? byIsbn.get(isbn) : undefined;
    if (note && !used.has(note.path) && !note.id) { result.set(book.id, note.path); used.add(note.path); }
  }
  for (const book of live) {
    if (result.has(book.id)) continue;
    for (const key of titleKeys(book.title)) {
      const candidates = (byKey.get(key) ?? []).filter((n) => !used.has(n.path) && !n.id
        && authorsCompatible(n.author, book.author));
      if (candidates.length === 1) {
        result.set(book.id, candidates[0].path);
        used.add(candidates[0].path);
        break;
      }
      if (candidates.length > 1) break;
    }
  }
  return result;
}

/** Title and author from a "Title (Author)" file name. */
export function identityFromFilename(basename: string): { title: string; author: string | null } {
  const match = /^(.*)\s+\(([^()]+)\)\s*$/.exec(basename);
  return match ? { title: match[1], author: match[2] } : { title: basename, author: null };
}

/** "[[Author]]" or a list of them -> "Author, Author". */
export function authorFromSource(value: unknown): string | null {
  const list = Array.isArray(value) ? value : value == null ? [] : [value];
  const names = list.map((v) => String(v).replace(/^\[\[|\]\]$/g, '').split('|')[0].trim()).filter(Boolean);
  return names.length ? names.join(', ') : null;
}

/**
 * `consumed` -> `format` (decided 2026-11-23): Audio values add "Audio";
 * Book values add nothing. `consumed` is removed only when every value in it
 * was understood, so anything unexpected stays for you to look at.
 */
export function migrateConsumed(consumed: unknown, formats: string[]): { formats: string[]; removeConsumed: boolean } {
  const values = readList(consumed);
  const result = [...formats];
  let understood = true;
  for (const value of values) {
    const word = value.replace(/[^\p{L}]/gu, '').toLowerCase();
    if (word === 'audio' || word === 'audiobook') {
      if (!result.some((f) => f.toLowerCase() === 'audio')) result.push('Audio');
    } else if (word !== 'book') {
      understood = false;
    }
  }
  return { formats: result, removeConsumed: understood };
}
