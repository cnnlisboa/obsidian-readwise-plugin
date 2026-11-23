import { describe, expect, it } from '@jest/globals';
import {
  CHAPTER_END,
  CHAPTER_START,
  dueForDeletion,
  insertChapterNotes,
  noteWithoutTokens,
  type ProcessedRecord,
  triggeredKinds,
} from 'services/highlight-rules';
import { chapterNoteText, headingLevel } from 'services/template-rendering';

const tag = (name: string) => ({ id: 1, name });

describe('Highlight rules: triggers', () => {
  it('finds kinds from real tags and from note tokens', () => {
    expect(triggeredKinds({ tags: [tag('reference/book')], note: '' }, 'reference/')).toEqual(['book']);
    expect(triggeredKinds({ tags: [], note: 'read later #reference/book' }, 'reference/')).toEqual(['book']);
    expect(triggeredKinds({ tags: [], note: '.reference/person' }, 'reference/')).toEqual(['person']);
    expect(triggeredKinds({ tags: [tag('Reference/Research')], note: '' }, 'reference/')).toEqual(['research']);
    expect(triggeredKinds({ tags: [tag('reference')], note: 'no tokens' }, 'reference/')).toEqual([]);
  });

  it('strips trigger tokens from the note', () => {
    expect(noteWithoutTokens('Elogio da loucura #reference/book', 'reference/')).toBe('Elogio da loucura');
  });

  it('deletes only after the grace period', () => {
    const record = { state: 'marked', markedAt: '2026-11-20T00:00:00Z' } as ProcessedRecord;
    expect(dueForDeletion(record, 3, Date.parse('2026-11-22T00:00:00Z'))).toBe(false);
    expect(dueForDeletion(record, 3, Date.parse('2026-11-23T00:00:01Z'))).toBe(true);
    expect(dueForDeletion({ ...record, state: 'written' }, 0)).toBe(false);
  });
});

describe('Chapter notes', () => {
  it('reads heading levels from tags or the note', () => {
    expect(headingLevel({ tags: [tag('h2')], note: '' })).toBe(2);
    expect(headingLevel({ tags: [], note: '.h1\nthought' })).toBe(1);
    expect(headingLevel({ tags: [tag('favorite')], note: 'plain' })).toBe(0);
    expect(chapterNoteText('.h2\nMy thought about this chapter')).toBe('My thought about this chapter');
    expect(chapterNoteText('.h2')).toBe('');
  });

  it('creates the section and keeps reading order without touching your text', () => {
    const known = new Map<number, number>();
    let note = '# Book\n\nMy own notes.';
    note = insertChapterNotes(note, [{ id: 2, title: 'Two', level: 2, text: 'second', location: 20 }], known);
    expect(note).toContain('## Chapter notes');
    expect(note).toContain(CHAPTER_START);
    note = note.replace('second ^rwcn2', 'second, edited by me ^rwcn2');
    note = insertChapterNotes(note, [
      { id: 1, title: 'One', level: 2, text: 'first', location: 10 },
      { id: 3, title: 'Three', level: 2, text: 'third', location: 30 },
    ], known);
    const section = note.slice(note.indexOf(CHAPTER_START), note.indexOf(CHAPTER_END));
    expect(section.indexOf('### One')).toBeLessThan(section.indexOf('### Two'));
    expect(section.indexOf('### Two')).toBeLessThan(section.indexOf('### Three'));
    expect(section).toContain('second, edited by me ^rwcn2');
    expect(note.startsWith('# Book\n\nMy own notes.')).toBe(true);
    // Idempotent
    expect(insertChapterNotes(note, [{ id: 3, title: 'Three', level: 2, text: 'third', location: 30 }], known)).toBe(note);
  });
});
