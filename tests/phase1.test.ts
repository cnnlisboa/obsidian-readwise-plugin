import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { requestUrl, TFile } from 'obsidian';
import type ReadwiseMirror from 'main';
import { DEFAULT_SETTINGS } from 'src/constants';
import { Controller } from 'services/controller';
import { DeduplicatingVaultWriter } from 'services/deduplicating-vault-writer';
import ReadwiseApi from 'services/readwise-api';
import { filterHighlights } from 'services/template-rendering';
import { sampleMetadata } from './sample-data';
import type { ReadwiseDocument } from 'types/document';
import type { Export, Library } from 'types/library';
import type { PluginContext } from 'types/plugin-context';
import { normalizeFilename } from 'utils/file-utils';

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
  TFile: class {},
  TFolder: class {},
  normalizePath: (path: string) => path,
  getFrontMatterInfo: jest.fn(),
}));
jest.mock('utils/file-utils', () => ({
  getTrackingUrl: jest.fn(),
  isFileInFolder: jest.fn(),
  normalizeFilename: jest.fn(),
}));

function book(id: number, tags: string[] = []): Export {
  return {
    user_book_id: id,
    is_deleted: false,
    title: `Book ${id}`,
    author: '',
    readable_title: `Book ${id}`,
    source: 'reader',
    cover_image_url: '',
    unique_url: '',
    book_tags: tags.map((name, index) => ({ id: index, name })),
    category: 'books',
    document_note: '',
    summary: '',
    readwise_url: `https://readwise.io/bookreview/${id}`,
    source_url: '',
    asin: null,
    highlights: [],
  };
}

function context(): PluginContext {
  return {
    settings: { ...DEFAULT_SETTINGS },
    app: {} as PluginContext['app'],
    logger: {
      group: jest.fn(), groupEnd: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn(),
    } as unknown as PluginContext['logger'],
    syncLock: { isAcquired: () => false, acquire: async () => {}, release: () => {} },
    statusBarItem: {} as HTMLElement,
    notice: jest.fn(),
    setStatusBarText: jest.fn(),
    saveAndApplySettings: jest.fn(async () => {}),
  };
}

describe('Phase 1 sync foundations', () => {
  beforeEach(() => jest.clearAllMocks());

  it('fetches every page using the string cursor returned by Readwise', async () => {
    const ctx = context();
    const mockedRequest = jest.mocked(requestUrl);
    mockedRequest
      .mockResolvedValueOnce({ status: 204 } as Awaited<ReturnType<typeof requestUrl>>)
      .mockResolvedValueOnce({ status: 200, json: { results: [book(1)], nextPageCursor: 'page-two' } } as Awaited<ReturnType<typeof requestUrl>>)
      .mockResolvedValueOnce({ status: 200, json: { results: [book(2)], nextPageCursor: null } } as Awaited<ReturnType<typeof requestUrl>>);
    ctx.settings.apiToken = 'test-token';

    const api = await ReadwiseApi.create(ctx);
    const results = await api.fetchData();

    expect(results.map((item) => item.user_book_id)).toEqual([1, 2]);
    const secondPageRequest = mockedRequest.mock.calls[2][0];
    expect(typeof secondPageRequest === 'string' ? secondPageRequest : secondPageRequest.url).toContain('pageCursor=page-two');
  });

  it('filters by document tags without matching highlight tags or case', async () => {
    const ctx = context();
    ctx.settings.filterNotesByTag = true;
    ctx.settings.filteredTags = ['Keep'];
    ctx.settings.apiToken = 'test-token';
    jest.mocked(requestUrl).mockResolvedValue({ status: 204 } as Awaited<ReturnType<typeof requestUrl>>);
    const api = await ReadwiseApi.create(ctx);

    const library = await api.buildLibrary([book(1, ['keep']), book(2, ['other']), book(3, ['KEEP'])]);
    expect(Object.keys(library.books)).toEqual(['1', '3']);
    expect([...library.categories]).toEqual(['books']);
  });

  it('excludes deleted highlights from rendered notes', () => {
    const visible = filterHighlights(sampleMetadata.highlights, DEFAULT_SETTINGS);
    expect(visible.some((highlight) => highlight.is_deleted)).toBe(false);
    expect(visible.length).toBeLessThan(sampleMetadata.highlights.length);
  });

  it('does not advance the checkpoint when writing fails', async () => {
    const ctx = context();
    ctx.settings.lastUpdated = '2026-01-01T00:00:00.000Z';
    ctx.settings.logFile = false;
    const plugin = {
      chooseSyncDocuments: jest.fn(async (library: Library) => library),
      writeLibraryToMarkdown: jest.fn<() => Promise<void>>().mockRejectedValue(new Error('disk full')),
    } as unknown as ReadwiseMirror;
    const controller = new Controller(plugin, ctx);
    (controller as unknown as { api: { downloadUpdates: () => Promise<unknown> } }).api = {
      downloadUpdates: async () => ({ books: {}, categories: new Set(), highlightCount: 0 }),
    };
    const validation = jest.spyOn(Controller, 'validateAPIInstance').mockResolvedValue(true);

    await controller.sync();

    expect(ctx.settings.lastUpdated).toBe('2026-01-01T00:00:00.000Z');
    expect(ctx.saveAndApplySettings).not.toHaveBeenCalled();
    expect(ctx.notice).toHaveBeenCalledWith(expect.stringContaining('Sync failed'));
    validation.mockRestore();
  });

  it('restores the in-memory checkpoint if saving settings fails', async () => {
    const ctx = context();
    ctx.settings.lastUpdated = '2026-01-01T00:00:00.000Z';
    ctx.settings.logFile = false;
    ctx.saveAndApplySettings = jest.fn<() => Promise<void>>().mockRejectedValue(new Error('settings unavailable'));
    const plugin = {
      chooseSyncDocuments: jest.fn(async (library: Library) => library),
      writeLibraryToMarkdown: jest.fn(async () => {}),
    } as unknown as ReadwiseMirror;
    const controller = new Controller(plugin, ctx);
    (controller as unknown as { api: { downloadUpdates: () => Promise<unknown> } }).api = {
      downloadUpdates: async () => ({ books: {}, categories: new Set(), highlightCount: 0 }),
    };
    const validation = jest.spyOn(Controller, 'validateAPIInstance').mockResolvedValue(true);

    await controller.sync();

    expect(ctx.settings.lastUpdated).toBe('2026-01-01T00:00:00.000Z');
    validation.mockRestore();
  });

  it('indexes tracked files once and gives an unmarked primary first', async () => {
    const ctx = context();
    const root: { path: string; parent: null } = { path: ctx.settings.baseFolderName, parent: null };
    const first = { path: `${root.path}/Books/one.md`, parent: { path: `${root.path}/Books`, parent: root } } as TFile;
    const duplicate = { path: `${root.path}/Books/two.md`, parent: first.parent } as TFile;
    const other = { path: `${root.path}/Books/other.md`, parent: first.parent } as TFile;
    const cache = new Map<TFile, { frontmatter: Record<string, unknown> }>([
      [first, { frontmatter: { uri: 'https://readwise.io/bookreview/1' } }],
      [duplicate, { frontmatter: { uri: 'https://readwise.io/bookreview/1', duplicate: true } }],
      [other, { frontmatter: { uri: 'https://readwise.io/bookreview/2' } }],
    ]);
    const getMarkdownFiles = jest.fn(() => [duplicate, other, first]);
    ctx.app = {
      vault: { getMarkdownFiles },
      metadataCache: { getFileCache: (file: TFile) => cache.get(file) },
    } as unknown as PluginContext['app'];
    const writer = new DeduplicatingVaultWriter(ctx, {} as ConstructorParameters<typeof DeduplicatingVaultWriter>[1]);
    writer.buildTrackedFileIndex();
    const matches = await writer.findExistingByHighlightsUrl({ readwise_url: 'https://readwise.io/bookreview/1' } as ReadwiseDocument);

    expect(matches).toEqual([first, duplicate]);
    expect(getMarkdownFiles).toHaveBeenCalledTimes(1);
    expect(writer.generateShortHash(1)).toBe(writer.generateShortHash(1));
    expect(writer.generateShortHash(1)).not.toBe(writer.generateShortHash(2));
  });

  it('updates the tracked primary and trashes only its duplicate when configured', async () => {
    const ctx = context();
    ctx.settings.deleteDuplicates = true;
    const primary = Object.assign(new TFile(), { path: 'Readwise Sync/Books/one.md' });
    const duplicate = Object.assign(new TFile(), { path: 'Readwise Sync/Books/one-copy.md' });
    const trashFile = jest.fn(async () => {});
    ctx.app = {
      vault: { process: jest.fn(async () => {}), cachedRead: jest.fn(async () => 'old content') },
      fileManager: { processFrontMatter: jest.fn(async () => {}), trashFile },
    } as unknown as PluginContext['app'];
    const frontmatterManager = {
      getFrontmatter: () => ({ entries: (): [string, unknown][] => [] }),
    } as unknown as ConstructorParameters<typeof DeduplicatingVaultWriter>[1];
    const writer = new DeduplicatingVaultWriter(ctx, frontmatterManager);

    await writer.process([{
      type: 'base', primary, duplicates: [duplicate], basename: 'one',
      doc: { id: 1 } as ReadwiseDocument, contents: 'new content', atoms: [],
    }]);

    expect(ctx.app.fileManager.processFrontMatter).toHaveBeenCalledWith(primary, expect.any(Function));
    expect(trashFile).toHaveBeenCalledWith(duplicate);
    expect(trashFile).not.toHaveBeenCalledWith(primary);
  });

  it('rejects broken local markers before changing frontmatter', async () => {
    const ctx = context();
    const primary = Object.assign(new TFile(), { path: 'Readwise Sync/Books/one.md' });
    const processFrontMatter = jest.fn(async () => {});
    ctx.app = {
      vault: { cachedRead: jest.fn(async () => '<!-- readwise-obsidian:local:start -->\nUnclosed') },
      fileManager: { processFrontMatter },
    } as unknown as PluginContext['app'];
    const frontmatterManager = {
      getFrontmatter: () => ({ entries: (): [string, unknown][] => [] }),
    } as unknown as ConstructorParameters<typeof DeduplicatingVaultWriter>[1];
    const writer = new DeduplicatingVaultWriter(ctx, frontmatterManager);

    await expect(writer.process([{
      type: 'base', primary, duplicates: [], basename: 'one',
      doc: { id: 1 } as ReadwiseDocument, contents: 'new content', atoms: [],
    }])).rejects.toThrow('missing or duplicate');
    expect(processFrontMatter).not.toHaveBeenCalled();
  });

  it('renames a note through Obsidian so its links can be updated', async () => {
    const ctx = context();
    const renameFile = jest.fn(async () => {});
    ctx.app = { fileManager: { renameFile } } as unknown as PluginContext['app'];
    jest.mocked(normalizeFilename).mockReturnValue('Clean');
    const file = { basename: 'Unclean', name: 'Unclean.md', parent: { path: 'Readwise Sync/Books' } } as TFile;

    expect(await new Controller({} as ReadwiseMirror, ctx).renameReadwiseNote(file)).toBe(true);
    expect(renameFile).toHaveBeenCalledWith(file, 'Readwise Sync/Books/Clean.md');
  });

  it('creates the new mirror folder before its category folders', async () => {
    const ctx = context();
    const created = new Set<string>();
    const createFolder = jest.fn(async (path: string) => { created.add(path); });
    ctx.app = {
      vault: {
        getAbstractFileByPath: (path: string) => created.has(path) ? { path } : null,
        createFolder,
      },
    } as unknown as PluginContext['app'];
    const writer = new DeduplicatingVaultWriter(ctx, {} as ConstructorParameters<typeof DeduplicatingVaultWriter>[1]);

    await writer.createCategoryFolders(new Set(['books']));

    expect(createFolder.mock.calls.map(([path]) => path)).toEqual(['Readwise Sync', 'Readwise Sync/Books']);
  });
});
