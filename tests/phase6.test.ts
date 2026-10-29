import { describe, expect, it, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { requestUrl, TFile } from 'obsidian';
import { Environment } from 'nunjucks';
import { parse, stringify } from 'yaml';
import { DEFAULT_SETTINGS } from 'src/constants';
import { BOOK_START, bookIdKey, renderBookSection, upsertBookSection } from 'services/book-notes';
import { inBookNoteFolder, parseBookRoutes } from 'services/book-routes';
import { diffLines } from 'services/line-diff';
import { syncReaderDocuments } from 'services/reader-sync';
import type { ReadwiseEnvironment } from 'services/readwise-environment';
import { filterHighlights } from 'services/template-rendering';
import { sendEditedNotes } from 'services/writeback';
import { mergeEditableNotes, readEditableNotes } from 'services/writeback-sections';
import type { Export, Highlight } from 'types/library';
import type { PluginContext } from 'types/plugin-context';
import { isTrackedReadwiseNote } from 'utils/tracking-utils';

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
  TFile: class {},
  normalizePath: (path: string) => path,
  getFrontMatterInfo: () => ({ contentStart: 0 }),
  parseYaml: (text: string) => parse(text),
  stringifyYaml: (value: unknown) => stringify(value),
}));
jest.mock('utils/file-utils', () => ({ normalizeFilename: (title: string) => title }));
const api = requestUrl as jest.MockedFunction<typeof requestUrl>;
const env = () => new Environment(undefined, { autoescape: false }) as ReadwiseEnvironment;

function highlight(id: number, tags: string[] = [], note = ''): Highlight {
  return {
    id, text: `Highlight ${id}`, note, is_deleted: false, location: id, location_type: 'location', highlighted_at: '',
    created_at: '', updated_at: '', url: null, readwise_url: `https://readwise.io/open/${id}`, color: '', book_id: 7,
    tags: tags.map((name, index) => ({ id: index, name })), is_favorite: false, is_discard: false,
  };
}

describe('Book note options', () => {
  it('parses routes with several categories and rejects unsafe folders', () => {
    expect(parseBookRoutes('books, podcasts: Inventory/Books\n# comment\narticles: Inventory/Articles')).toEqual([
      { categories: ['books', 'podcasts'], folder: 'Inventory/Books' },
      { categories: ['articles'], folder: 'Inventory/Articles' },
    ]);
    expect(() => parseBookRoutes('books: ../outside')).toThrow('Invalid book note route');
    expect(() => parseBookRoutes('Inventory/Books')).toThrow('Invalid book note route');
  });

  it('reads a book ID from a number, a numeric string, or a book review URL', () => {
    expect(bookIdKey(42829839)).toBe('42829839');
    expect(bookIdKey('42829839')).toBe('42829839');
    expect(bookIdKey('https://readwise.io/bookreview/42829839')).toBe('42829839');
    expect(bookIdKey('01JPZHDQCFBBJ2XT4GSK2FABKT')).toBeNull();
  });

  it('places a new section at the end, at the top below properties, or below a chosen heading', () => {
    const note = '---\nid: 1\n---\n\n> [!invisible]+\n> - Why?\n\n## Highlights\n\nOld text\n\n## Review\nMine\n';
    expect(upsertBookSection(note, 'S', 'append')).toMatch(/Mine\n\n<!-- readwise-sync:book:start -->\nS\n<!-- readwise-sync:book:end -->\n$/);
    expect(upsertBookSection(note, 'S', 'prepend')).toMatch(/^---\nid: 1\n---\n\n<!-- readwise-sync:book:start -->\nS\n<!-- readwise-sync:book:end -->\n\n> \[!invisible\]\+/);
    expect(upsertBookSection(note, 'S', 'heading', '## Highlights'))
      .toContain('## Highlights\n\n<!-- readwise-sync:book:start -->\nS\n<!-- readwise-sync:book:end -->\n\nOld text\n\n## Review');
    expect(upsertBookSection('Body\n', 'S', 'heading', '## Readwise')).toBe(`Body\n\n## Readwise\n\n${BOOK_START}\nS\n<!-- readwise-sync:book:end -->\n`);
  });

  it('embeds the block ID used by the highlight template', () => {
    const book = { user_book_id: 7, title: 'B', author: 'A', category: 'books', highlights: [highlight(5)], book_tags: [],
      document_note: '', readwise_url: 'https://readwise.io/bookreview/7' } as unknown as Export;
    const settings = { ...DEFAULT_SETTINGS, bookNoteBlockId: 'rw{{ id }}H', bookNoteSectionTemplate: '{% for h in highlights %}{{ h.display }}{% endfor %}' };
    const output = renderBookSection(env(), settings, book, 'Books/B.md', '', { mirror: () => '= B', atom: () => null });
    expect(output).toBe('![[= B#^rw5H]]');
  });

  it('never treats a note in a book note folder as a tracked Readwise note', () => {
    const settings = { ...DEFAULT_SETTINGS, bookNotesEnabled: true, bookNoteRoutes: 'books: Inventory/Books', trackingProperty: 'readwiseID' };
    const app = { metadataCache: { getFileCache: () => ({ frontmatter: { readwiseID: 'https://readwise.io/bookreview/7' } }) } };
    const inside = Object.assign(new TFile(), { path: 'Inventory/Books/B.md' });
    const outside = Object.assign(new TFile(), { path: 'Inventory/Readwise/Books/B.md' });
    expect(inBookNoteFolder(inside.path, settings)).toBe(true);
    expect(isTrackedReadwiseNote(inside, app as never, settings)).toBe(false);
    expect(isTrackedReadwiseNote(outside, app as never, settings)).toBe(true);
  });
});

describe('Highlight tag filter', () => {
  const highlights = [highlight(1, ['Favorite']), highlight(2, ['skip']), highlight(3)];
  it('includes or excludes by tag, ignoring case', () => {
    const base = { ...DEFAULT_SETTINGS, highlightFilterTags: 'favorite, SKIP' };
    expect(filterHighlights(highlights, { ...base, highlightTagFilter: 'include' }).map((item) => item.id)).toEqual([1, 2]);
    expect(filterHighlights(highlights, { ...base, highlightTagFilter: 'exclude' }).map((item) => item.id)).toEqual([3]);
    expect(filterHighlights(highlights, { ...base, highlightTagFilter: 'off' })).toHaveLength(3);
  });
});

describe('Preview diff', () => {
  it('shows changed lines with context and elides distant unchanged lines', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i'].join('\n');
    expect(diffLines(before, after, 1)).toBe(['  a', '- b', '+ B', '  c', '…', '  h', '+ i'].join('\n'));
    expect(diffLines('same', 'same')).toBe('');
  });
});

describe('Send all edited notes', () => {
  function vaultWith(contents: Record<string, string>) {
    const files = Object.fromEntries(Object.keys(contents).map((path) => [path, Object.assign(new TFile(), { path })]));
    const ctx = {
      settings: { ...DEFAULT_SETTINGS, apiToken: 'token', writebackHighlightNotes: true },
      app: {
        vault: {
          getMarkdownFiles: () => Object.values(files),
          cachedRead: async (file: TFile) => contents[file.path],
          process: async (file: TFile, change: (text: string) => string) => { contents[file.path] = change(contents[file.path]); },
        },
        metadataCache: { getFileCache: () => ({ frontmatter: {} }) },
      },
    } as unknown as PluginContext;
    return { ctx, files: Object.values(files), contents };
  }
  const edited = (text: string) => mergeEditableNotes(null, '# Note', [{ target: 'highlight-9', text: 'Original' }])
    .replace('Original\n<!-- readwise-sync:note:highlight-9:end', `${text}\n<!-- readwise-sync:note:highlight-9:end`);

  it('sends one PATCH for the same edit in the book note and the Readwise note, and marks both sent', async () => {
    api.mockReset();
    const { ctx, files, contents } = vaultWith({ 'Books/B.md': edited('New'), 'Readwise/B.md': edited('New'), 'Other.md': 'plain' });
    api.mockResolvedValueOnce({ status: 200, json: { id: 9, note: 'Original' } } as never)
      .mockResolvedValueOnce({ status: 200, json: { id: 9 } } as never);
    expect(await sendEditedNotes(ctx, files, async () => true)).toBe(1);
    expect(api).toHaveBeenCalledTimes(2);
    for (const path of ['Books/B.md', 'Readwise/B.md']) expect(readEditableNotes(contents[path])[0].baseline).toBe('New');
  });

  it('refuses different edits of the same comment before contacting Readwise', async () => {
    api.mockReset();
    const { ctx, files } = vaultWith({ 'Books/B.md': edited('One'), 'Readwise/B.md': edited('Two') });
    await expect(sendEditedNotes(ctx, files, async () => true)).rejects.toThrow('edited differently');
    expect(api).not.toHaveBeenCalled();
  });
});

describe('Incremental Reader sync', () => {
  it('fetches content only for changed or new documents', async () => {
    api.mockReset();
    (globalThis as { DOMParser?: typeof DOMParser }).DOMParser = new JSDOM('').window.DOMParser;
    const doc = (id: string, updated: string) => ({ id, url: `https://read.readwise.io/read/${id}`, title: id, category: 'article',
      updated_at: updated, parent_id: null as string | null, html_content: '<p>Text</p>' });
    const notes = new Map<string, { path: string; frontmatter: Record<string, unknown> }>([
      ['same', { path: 'Reader/same same.md', frontmatter: { reader_id: 'same', reader_updated_at: '2026-10-01', reader_sync_tag: 'vault' } }],
      ['stale', { path: 'Reader/stale stale.md', frontmatter: { reader_id: 'stale', reader_updated_at: '2026-09-01', reader_sync_tag: 'vault' } }],
    ]);
    const tfiles = [...notes.values()].map((note) => Object.assign(new TFile(), { path: note.path }));
    const written = new Map<string, string>();
    api
      .mockResolvedValueOnce({ status: 200, json: { results: [doc('same', '2026-10-01'), doc('stale', '2026-10-20'), doc('new', '2026-10-02')], nextPageCursor: null } } as never)
      .mockResolvedValueOnce({ status: 200, json: { results: [doc('stale', '2026-10-20')], nextPageCursor: null } } as never)
      .mockResolvedValueOnce({ status: 200, json: { results: [doc('new', '2026-10-02')], nextPageCursor: null } } as never);
    const ctx = {
      settings: { ...DEFAULT_SETTINGS, apiToken: 'token', readerEnabled: true, readerTag: 'vault', readerFolder: 'Reader',
        readerLastSync: '2026-10-10T00:00:00Z', readerLinkHighlights: false, preserveLocalSection: false },
      app: {
        vault: {
          getMarkdownFiles: () => tfiles,
          adapter: { exists: async () => true },
          cachedRead: async () => '',
          getFileByPath: (): TFile | null => null,
          getAbstractFileByPath: (): TFile | null => null,
          create: async (path: string, text: string) => { written.set(path, text); },
          modify: async (file: TFile, text: string) => { written.set(file.path, text); },
        },
        metadataCache: { getFileCache: (file: TFile) => ({ frontmatter: [...notes.values()].find((note) => note.path === file.path)?.frontmatter }) },
        fileManager: { renameFile: async (): Promise<void> => undefined },
      },
      logger: { error: jest.fn(), warn: jest.fn() },
      saveAndApplySettings: jest.fn(async () => undefined),
    } as unknown as PluginContext;
    const report = await syncReaderDocuments(ctx, env(), false, async () => true);
    expect(report.counts).toMatchObject({ created: 1, updated: 1 });
    expect([...written.keys()].sort()).toEqual(['Reader/new new.md', 'Reader/stale stale.md']);
    const urls = api.mock.calls.map((call) => (call[0] as { url: string }).url);
    expect(urls[0]).not.toContain('withHtmlContent');
    expect(urls[1]).toContain('updatedAfter=2026-10-10');
    expect(urls[2]).toContain('id=new');
    expect(ctx.settings.readerLastSync).not.toBe('2026-10-10T00:00:00Z');
  });
});
