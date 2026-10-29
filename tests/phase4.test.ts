import { describe, expect, it, jest } from '@jest/globals';
import { TFile } from 'obsidian';
import { Environment } from 'nunjucks';
import { parse, stringify } from 'yaml';
import { DEFAULT_SETTINGS } from 'src/constants';
import { BOOK_END, BOOK_START, BookNoteIndex, bookTitleKeys, syncBookNotes, upsertBookSection, type BookLinkResolver } from 'services/book-notes';
import { syncReaderDocuments } from 'services/reader-sync';
import type { ReadwiseEnvironment } from 'services/readwise-environment';
import { readEditableNotes } from 'services/writeback-sections';
import type { Export, Highlight, Library } from 'types/library';
import type { PluginContext } from 'types/plugin-context';
import type { PluginSettings } from 'types/settings';

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(async () => ({ status: 200, json: { results: [], nextPageCursor: null } })),
  TFile: class {},
  normalizePath: (path: string) => path,
  getFrontMatterInfo: () => ({ contentStart: 0 }),
  parseYaml: (text: string) => parse(text),
  stringifyYaml: (value: unknown) => stringify(value),
}));
jest.mock('utils/file-utils', () => ({ normalizeFilename: (title: string) => title }));

// Matches the plugin's ReadwiseEnvironment, which renders Markdown without HTML escaping.
const env = () => new Environment(undefined, { autoescape: false }) as ReadwiseEnvironment;

function highlight(id: number, text: string, note = ''): Highlight {
  return {
    id, text, note, is_deleted: false, location: id, location_type: 'location', highlighted_at: '2026-10-01T00:00:00Z',
    created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-01T00:00:00Z', url: null,
    readwise_url: `https://readwise.io/open/${id}`, color: '', book_id: 7, tags: [], is_favorite: false, is_discard: false,
  };
}

function book(overrides: Partial<Export> = {}): Export {
  return {
    user_book_id: 7, is_deleted: false, title: '$100M Offers- How to Make Offers So Good', author: 'Alex Hormozi',
    readable_title: '$100M Offers', source: 'kindle', cover_image_url: '', unique_url: '', book_tags: [], category: 'books',
    document_note: 'Why I read it', summary: '', readwise_url: 'https://readwise.io/bookreview/7', source_url: '', asin: null,
    highlights: [highlight(11, 'Make the offer better.', 'Remote comment'), highlight(12, 'Second idea.')],
    ...overrides,
  };
}

function vault(initial: Record<string, { text: string; frontmatter?: Record<string, unknown> }>) {
  const files = new Map<string, string>();
  const meta = new Map<string, Record<string, unknown>>();
  const objects = new Map<string, TFile>();
  const add = (path: string, text: string, frontmatter: Record<string, unknown> = {}) => {
    const basename = path.split('/').pop()?.replace(/\.md$/, '') ?? path;
    objects.set(path, Object.assign(new TFile(), { path, basename }));
    files.set(path, text);
    meta.set(path, frontmatter);
  };
  for (const [path, value] of Object.entries(initial)) add(path, value.text, value.frontmatter);
  const app = {
    vault: {
      getMarkdownFiles: () => [...objects.values()],
      getAbstractFileByPath: (path: string) => objects.get(path) ?? null,
      getFileByPath: (path: string) => objects.get(path) ?? null,
      createFolder: async (): Promise<void> => undefined,
      create: async (path: string, text: string) => { add(path, text); return objects.get(path); },
      read: async (file: TFile) => files.get(file.path) ?? '',
      cachedRead: async (file: TFile) => files.get(file.path) ?? '',
      process: async (file: TFile, change: (text: string) => string) => { files.set(file.path, change(files.get(file.path) ?? '')); },
    },
    metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: meta.get(file.path) }) },
    fileManager: {
      processFrontMatter: async (file: TFile, change: (frontmatter: Record<string, unknown>) => void) => {
        const frontmatter = { ...meta.get(file.path) };
        change(frontmatter);
        meta.set(file.path, frontmatter);
      },
      trashFile: async (file: TFile) => { objects.delete(file.path); files.delete(file.path); },
    },
  };
  return { app, files, meta, objects };
}

function context(app: unknown, settings: Partial<PluginSettings> = {}): PluginContext {
  return {
    settings: { ...DEFAULT_SETTINGS, bookNotesEnabled: true, bookNoteRoutes: 'books: Inventory/Books', ...settings },
    app, logger: { debug: jest.fn(), error: jest.fn(), warn: jest.fn() }, saveAndApplySettings: jest.fn(async () => undefined),
  } as unknown as PluginContext;
}

const library = (...books: Export[]): Library => ({
  books: Object.fromEntries(books.map((item) => [item.user_book_id, item])), categories: new Set(['books']), highlightCount: 0,
});

function links(app: ReturnType<typeof vault>['app']): BookLinkResolver {
  return {
    mirror: () => (app.vault.getFileByPath('Readwise Sync/Books/100M Offers.md') ? 'Readwise Sync/Books/100M Offers' : null),
    atom: () => null,
  };
}

describe('Phase 4 book notes', () => {
  it('derives title keys with and without the subtitle', () => {
    expect(bookTitleKeys(book())).toEqual(expect.arrayContaining(['100m offers how to make offers so good', '100m offers']));
  });

  it('matches by ID first and by filename without the author, never claiming a note bound to another book', () => {
    const { app } = vault({
      'Inventory/Books/100M Offers (Alex Hormozi).md': { text: '' },
      'Inventory/Books/Other.md': { text: '', frontmatter: { readwiseID: 99, aliases: ['$100M Offers'] } },
      'Inventory/Books/Bound.md': { text: '', frontmatter: { readwiseID: 7 } },
    });
    const index = new BookNoteIndex(context(app));
    expect(index.find(book()).file?.path).toBe('Inventory/Books/Bound.md');
    expect(index.find(book({ user_book_id: 8 })).file?.path).toBe('Inventory/Books/100M Offers (Alex Hormozi).md');
  });

  it('reports several title matches as skipped instead of guessing', async () => {
    const { app } = vault({
      'Inventory/Books/100M Offers (Alex Hormozi).md': { text: '' },
      'Inventory/Books/Offers.md': { text: '', frontmatter: { aliases: '$100M Offers' } },
    });
    const ctx = context(app);
    const events = await syncBookNotes(ctx, env(), library(book()), new BookNoteIndex(ctx), links(app));
    expect(events).toEqual([expect.objectContaining({ action: 'skipped', path: book().title })]);
  });

  it('writes only the managed section, stamps the ID, and embeds highlights with comments below', async () => {
    const path = 'Inventory/Books/100M Offers (Alex Hormozi).md';
    const { app, files, meta } = vault({
      [path]: { text: '---\ntags: book\n---\n\nMy own review.\n' },
      'Readwise Sync/Books/100M Offers.md': { text: '' },
    });
    const ctx = context(app);
    const events = await syncBookNotes(ctx, env(), library(book()), new BookNoteIndex(ctx), links(app));
    expect(events).toEqual([{ action: 'updated', path, bookId: 7 }]);
    expect(meta.get(path)).toMatchObject({ readwiseID: 7 });
    const text = files.get(path) ?? '';
    expect(text.startsWith('---\ntags: book\n---\n\nMy own review.\n\n<!-- readwise-sync:book:start -->')).toBe(true);
    expect(text).toContain('Why I read it');
    expect(text).toContain('![[Readwise Sync/Books/100M Offers#^11]]\n\nRemote comment');
    expect(text).toContain('![[Readwise Sync/Books/100M Offers#^12]]');

    // The user moved the section above their review; a later sync keeps it there.
    const moved = `${text.slice(text.indexOf(BOOK_START), text.indexOf(BOOK_END) + BOOK_END.length)}\n\nMy own review.\n`;
    files.set(path, moved);
    const updated = book({ document_note: 'Changed note' });
    await syncBookNotes(ctx, env(), library(updated), new BookNoteIndex(ctx), links(app));
    expect(files.get(path)).toMatch(/^<!-- readwise-sync:book:start -->[\s\S]*Changed note[\s\S]*<!-- readwise-sync:book:end -->\n\nMy own review.\n$/);
  });

  it('keeps a comment edited in the book note as a writable section until it is sent', async () => {
    const path = 'Inventory/Books/Bound.md';
    const { app, files } = vault({ [path]: { text: 'Mine', frontmatter: { readwiseID: 7 } } });
    const ctx = context(app, { writebackHighlightNotes: true, bookNoteHighlightStyle: 'quote' });
    await syncBookNotes(ctx, env(), library(book()), new BookNoteIndex(ctx), links(app));
    expect(files.get(path)).toContain('> Make the offer better.');
    files.set(path, (files.get(path) ?? '').replace('Remote comment\n<!-- readwise-sync:note:highlight-11:end', 'Local comment\n<!-- readwise-sync:note:highlight-11:end'));
    await syncBookNotes(ctx, env(), library(book()), new BookNoteIndex(ctx), links(app));
    const note = readEditableNotes(files.get(path) ?? '').find((item) => item.target === 'highlight-11');
    expect(note).toMatchObject({ text: 'Local comment', baseline: 'Remote comment' });
    // Turning write-back off must not discard the unsent edit.
    ctx.settings.writebackHighlightNotes = false;
    const events = await syncBookNotes(ctx, env(), library(book()), new BookNoteIndex(ctx), links(app));
    expect(events[0]).toMatchObject({ action: 'failed' });
  });

  it('creates a missing book note only when enabled, and ignores other categories', async () => {
    const { app, files, meta } = vault({});
    const ctx = context(app, { bookNoteCreateMissing: true });
    const events = await syncBookNotes(ctx, env(), library(book({ title: 'Deep Work' }), book({ user_book_id: 9, category: 'articles' })),
      new BookNoteIndex(ctx), links(app));
    const path = 'Inventory/Books/Deep Work (Alex Hormozi).md';
    expect(events).toEqual([{ action: 'created', path, bookId: 7 }]);
    expect(files.get(path)).toContain('aliases:\n  - "Deep Work"');
    expect(files.get(path)).toContain(BOOK_START);
    expect(meta.get(path)).toMatchObject({ readwiseID: 7 });
  });

  it('rejects a broken section rather than duplicating it', () => {
    expect(() => upsertBookSection(`${BOOK_START}\nold`, 'new')).toThrow('missing or duplicate');
  });
});

describe('Phase 4 Reader tag removal', () => {
  it('trashes untagged imports from the current tag but keeps notes with local writing', async () => {
    const { app, objects, meta } = vault({
      'Readwise Sync/Reader/Plain a1.md': { text: 'body', frontmatter: { reader_id: 'a1', reader_sync_tag: 'vault' } },
      'Readwise Sync/Reader/Mine a2.md': { text: 'body\n<!-- readwise-obsidian:local:start -->\nkeep me\n<!-- readwise-obsidian:local:end -->',
        frontmatter: { reader_id: 'a2', reader_sync_tag: 'vault' } },
      'Readwise Sync/Reader/Older a3.md': { text: 'body', frontmatter: { reader_id: 'a3', reader_sync_tag: 'previous-tag' } },
    });
    const ctx = context(Object.assign(app, { vault: { ...app.vault, adapter: { exists: async () => true } } }),
      { apiToken: 'token', readerEnabled: true, readerTag: 'vault', readerTagRemoved: 'trash' });
    const report = await syncReaderDocuments(ctx, env(), false, async () => true);
    expect(report.counts.untagged).toBe(2);
    expect(objects.has('Readwise Sync/Reader/Plain a1.md')).toBe(false);
    expect(meta.get('Readwise Sync/Reader/Mine a2.md')).toMatchObject({ reader_tag_removed: true });
    expect(objects.has('Readwise Sync/Reader/Older a3.md')).toBe(true);
  });
});
