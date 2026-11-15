import type { Export, Library } from 'types/library';
import type { IgnoredDocument } from 'types/settings';

/** A compact signature of the full API record, including notes and highlight tags. */
export function documentSignature(book: Export): string {
  const json = JSON.stringify(book);
  let hash = 2166136261;
  for (let i = 0; i < json.length; i++) {
    hash ^= json.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `${json.length}:${(hash >>> 0).toString(16)}`;
}

export function ignoredDocument(book: Export, mode: IgnoredDocument['mode']): IgnoredDocument {
  return {
    mode,
    signature: documentSignature(book),
    title: book.title,
    author: book.author,
    category: book.category,
    cover: book.cover_image_url,
    highlightCount: book.highlights.length,
  };
}

export function activeIgnore(book: Export, ignored: IgnoredDocument | undefined): boolean {
  return Boolean(ignored && (ignored.mode === 'always' || ignored.signature === documentSignature(book)));
}

export function selectLibrary(library: Library, selectedIds: ReadonlySet<number>): Library {
  const books = Object.fromEntries(Object.values(library.books)
    .filter((book) => selectedIds.has(book.user_book_id))
    .map((book) => [book.user_book_id, book]));
  const selected = Object.values(books);
  return {
    books,
    categories: new Set(selected.map((book) => book.category)),
    highlightCount: selected.reduce((count, book) => count + book.highlights.length, 0),
  };
}
