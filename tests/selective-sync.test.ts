import { describe, expect, it } from '@jest/globals';
import { activeIgnore, ignoredDocument, selectLibrary } from 'services/selective-sync';
import type { Export, Library } from 'types/library';

function book(id: number): Export {
  return {
    user_book_id: id, is_deleted: false, title: `Book ${id}`, author: 'Author', readable_title: `Book ${id}`,
    source: 'reader', cover_image_url: '', unique_url: '', book_tags: [], category: id === 1 ? 'books' : 'articles',
    document_note: '', summary: '', readwise_url: '', source_url: '', asin: null, highlights: [],
  };
}

describe('selective sync', () => {
  it('keeps an until-changed ignore only while the full document is unchanged', () => {
    const original = book(1);
    const ignored = ignoredDocument(original, 'untilChanged');
    expect(activeIgnore(original, ignored)).toBe(true);
    expect(activeIgnore({ ...original, document_note: 'New note' }, ignored)).toBe(false);
    expect(activeIgnore({ ...original, highlights: [{ id: 5, tags: [{ id: 1, name: 'review' }] }] as Export['highlights'] }, ignored)).toBe(false);
    expect(activeIgnore({ ...original, document_note: 'New note' }, { ...ignored, mode: 'always' })).toBe(true);
  });

  it('passes only selected documents and their categories to the writer', () => {
    const library: Library = { books: { 1: book(1), 2: book(2) }, categories: new Set(['books', 'articles']), highlightCount: 0 };
    const selected = selectLibrary(library, new Set([2]));
    expect(Object.keys(selected.books)).toEqual(['2']);
    expect([...selected.categories]).toEqual(['articles']);
    expect(Object.keys(library.books)).toEqual(['1', '2']);
  });
});
