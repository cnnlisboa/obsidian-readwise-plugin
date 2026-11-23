import { describe, expect, it } from '@jest/globals';
import {
  type BooksBook,
  matchNotes,
  migrateConsumed,
  parseRating,
  planNoteSync,
  readNote,
  snapRating,
  titleKeys,
} from 'services/books-model';
import { BooksApi } from 'services/books-api';
import { DEFAULT_SETTINGS } from 'src/constants';

const names = DEFAULT_SETTINGS.booksPropertyNames;
const statusMap = DEFAULT_SETTINGS.booksStatusMap;
const options = { names, statusMap, finishedStatus: 'Done', formats: true };

function book(overrides: Partial<BooksBook> = {}): BooksBook {
  return {
    id: 7, title: 'Book', author: 'Author', status: 'currently_reading', creation_origin: 'uploaded_ebook',
    started_reading_at: null, finished_reading_at: null, rating: null, manual_total_pages: null, product: null,
    ...overrides,
  };
}

const note = (fm: Record<string, unknown>) => readNote(fm, names, statusMap);

describe('Readwise Books: reading note values', () => {
  it('reads ratings as numbers, stars, or leaves odd values alone', () => {
    expect(parseRating(4)).toBe(4);
    expect(parseRating('4.5')).toBe(4.5);
    expect(parseRating('⭐⭐⭐⭐')).toBe(4);
    expect(parseRating('⭐️⭐️⭐️')).toBe(3);
    expect(parseRating('⭐⭐⭐½')).toBe(3.5);
    expect(parseRating('+ ⭐️')).toBeNull();
    expect(parseRating(7)).toBe(7);
    expect(snapRating(7)).toBe(5);
    expect(snapRating(4.1)).toBe(4);
  });

  it('reads list-shaped status and dates', () => {
    const values = note({ status: ['Done'], finished: ['2025-02-11'], format: ['Digital'] });
    expect(values.status).toBe('Done');
    expect(values.finished).toBe('2025-02-11');
    expect(values.formats).toEqual(['Digital']);
  });
});

describe('Readwise Books: planning a note sync', () => {
  it('first sync: fills empty properties, stamps the id, adds Digital', () => {
    const plan = planNoteSync(note({ status: 'Active' }), book({
      started_reading_at: '2026-11-20T15:00:00Z', rating: 4.25, product: { isbn: '978', page_count: 300 },
    }), {}, options);
    expect(plan.frontmatter[names.id]).toBe(7);
    expect(plan.frontmatter[names.isbn]).toBe('978');
    expect(plan.frontmatter.rating).toBe(4.25);
    expect(plan.frontmatter.pages).toBe(300);
    expect(plan.frontmatter.start).toMatch(/^2026-11-2\d$/);
    expect(plan.frontmatter.format).toEqual(['Digital']);
    expect(plan.frontmatter.status).toBeUndefined();
    expect(plan.patch).toBeNull();
  });

  it('first sync: a note further along moves Readwise forward, never back', () => {
    expect(planNoteSync(note({ status: 'Done' }), book(), {}, options).patch?.status).toBe('finished');
    expect(planNoteSync(note({ status: 'Backlog' }), book(), {}, options).patch).toBeNull();
  });

  it('a status you change is pushed', () => {
    const previous = { noteStatus: 'Active', remoteStatus: 'currently_reading' };
    const plan = planNoteSync(note({ status: 'Stopped' }), book(), previous, options);
    expect(plan.patch?.status).toBe('did_not_finish');
  });

  it('finishing in Readwise writes Done once, and only once', () => {
    const previous = { noteStatus: 'Active', remoteStatus: 'currently_reading' };
    const finished = book({ status: 'finished', finished_reading_at: '2026-11-22T20:00:00Z' });
    const plan = planNoteSync(note({ status: 'Active' }), finished, previous, options);
    expect(plan.frontmatter.status).toBe('Done');
    expect(plan.frontmatter.finished).toMatch(/^2026-11-2\d$/);
    // You set it back to Active afterwards: sync leaves it.
    const again = planNoteSync(note({ status: 'Active' }), finished, plan.state, options);
    expect(again.frontmatter.status).toBeUndefined();
  });

  it('never writes Active or other statuses', () => {
    const previous = { noteStatus: 'Backlog', remoteStatus: 'want_to_read' };
    const plan = planNoteSync(note({ status: 'Backlog' }), book(), previous, options);
    expect(plan.frontmatter.status).toBeUndefined();
    expect(plan.patch).toBeNull();
  });

  it('unmapped statuses (Seed, Review) are left alone', () => {
    const previous = { noteStatus: 'Active', remoteStatus: 'currently_reading' };
    expect(planNoteSync(note({ status: 'Seed' }), book(), previous, options).patch).toBeNull();
  });

  it('your rating wins and 6 or 7 is sent as 5 but kept in the note', () => {
    const previous = { noteRating: 4, noteStatus: 'Active', remoteStatus: 'currently_reading' };
    const plan = planNoteSync(note({ status: 'Active', rating: 7 }), book({ rating: 4 }), previous, options);
    expect(plan.patch?.rating).toBe(5);
    expect(plan.frontmatter.rating).toBeUndefined();
    const later = planNoteSync(note({ status: 'Active', rating: 7 }), book({ rating: 5 }), plan.state, options);
    expect(later.frontmatter.rating).toBeUndefined();
    expect(later.patch).toBeNull();
  });

  it('dates are kept once set; your edits are pushed', () => {
    const previous = { noteStart: '2026-01-01', noteStatus: 'Active', remoteStatus: 'currently_reading' };
    const plan = planNoteSync(note({ status: 'Active', start: '2026-01-05' }),
      book({ started_reading_at: '2026-01-01T12:00:00Z' }), previous, options);
    expect(plan.patch?.started_reading_at).toBeDefined();
    const unchanged = planNoteSync(note({ status: 'Active', start: '2026-01-01' }),
      book({ started_reading_at: '2026-03-01T12:00:00Z' }), previous, options);
    expect(unchanged.frontmatter.start).toBeUndefined();
    expect(unchanged.patch).toBeNull();
  });

  it('pages are yours and go to manual_total_pages', () => {
    const plan = planNoteSync(note({ status: 'Active', pages: 412 }), book({ product: { page_count: 300 } }),
      { noteStatus: 'Active', remoteStatus: 'currently_reading' }, options);
    expect(plan.patch?.manual_total_pages).toBe(412);
    expect(plan.frontmatter.pages).toBeUndefined();
  });
});

describe('Readwise Books: matching notes', () => {
  it('matches by id, then ISBN, then unique title + compatible author', () => {
    const books = [
      book({ id: 1, title: 'Scientific Advertising', author: 'Claude C. Hopkins' }),
      book({ id: 2, title: 'Príncipe', author: 'Niccolo Machiavelli', product: { isbn: '111' } }),
      book({ id: 3, title: 'Linked', author: 'X' }),
      book({ id: 4, title: 'Twin', author: 'A' }),
    ];
    const matches = matchNotes(books, [
      { path: 'a.md', titles: ['Scientific Advertising'], author: 'Claude Hopkins', id: null, isbn: null },
      { path: 'b.md', titles: ['O Príncipe'], author: 'Maquiavel', id: null, isbn: '111' },
      { path: 'c.md', titles: ['Something else'], author: null, id: 3, isbn: null },
      { path: 'd.md', titles: ['Twin'], author: 'A', id: null, isbn: null },
      { path: 'e.md', titles: ['Twin'], author: 'A', id: null, isbn: null },
    ]);
    expect(matches.get(1)).toBe('a.md');
    expect(matches.get(2)).toBe('b.md');
    expect(matches.get(3)).toBe('c.md');
    expect(matches.has(4)).toBe(false);
  });

  it('title keys drop subtitles, articles and accents', () => {
    expect(titleKeys('The Great Mental Models: General Thinking')).toContain('greatmentalmodels');
    expect(titleKeys('Ética')).toContain('etica');
  });
});

describe('Readwise Books: client validation', () => {
  it('drops unsendable patches and snaps ratings', () => {
    expect(BooksApi.clean({ id: 1 })).toBeNull();
    expect(BooksApi.clean({ id: 1, status: 'unsorted' as never })).toBeNull();
    expect(BooksApi.clean({ id: 1, rating: 6 })).toEqual({ id: 1, rating: 5 });
  });
});

describe('Readwise Books: consumed -> format', () => {
  it('adds Audio for audio values, nothing for Book, keeps unknown values', () => {
    expect(migrateConsumed(['Audio 🎧'], ['Digital'])).toEqual({ formats: ['Digital', 'Audio'], removeConsumed: true });
    expect(migrateConsumed(['Book 📚'], [])).toEqual({ formats: [], removeConsumed: true });
    expect(migrateConsumed(null, ['Physical'])).toEqual({ formats: ['Physical'], removeConsumed: true });
    expect(migrateConsumed(['71bWq691-2L.jpg]]"'], []).removeConsumed).toBe(false);
  });
});
