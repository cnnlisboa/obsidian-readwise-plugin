import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import { JSDOM } from 'jsdom';
import { requestUrl, TFile } from 'obsidian';
import { Environment } from 'nunjucks';
import { DEFAULT_SETTINGS } from 'src/constants';
import { listTaggedReaderDocuments } from 'services/reader-api';
import type { ReaderDocument } from 'services/reader-api';
import { syncReaderDocuments } from 'services/reader-sync';
import type { PluginContext } from 'types/plugin-context';
import type { ReadwiseEnvironment } from 'services/readwise-environment';

jest.mock('obsidian', () => ({
  requestUrl: jest.fn(),
  TFile: class {},
  normalizePath: (path: string) => path,
  getFrontMatterInfo: () => ({ contentStart: 0 }),
}));
jest.mock('utils/file-utils', () => ({ normalizeFilename: (title: string) => title }));

const api = requestUrl as jest.MockedFunction<typeof requestUrl>;
const document: ReaderDocument = {
  id: 'doc123', url: 'https://read.readwise.io/new/read/doc123', source_url: 'https://example.com/a',
  title: 'Article', author: 'Someone', category: 'article', updated_at: '2026-10-29T00:00:00Z',
  notes: 'A document note', html_content: '<article><h2>Body</h2><p>Full text.</p></article>', parent_id: null,
};

beforeEach(() => {
  api.mockReset();
  (globalThis as { DOMParser?: typeof DOMParser }).DOMParser = new JSDOM('').window.DOMParser;
});

describe('Phase 3 Reader ingestion', () => {
  it('uses the exact tag and follows Reader page cursors while excluding child highlights', async () => {
    api
      .mockResolvedValueOnce({ status: 200, json: { results: [document, { ...document, id: 'child', parent_id: 'doc123' }], nextPageCursor: 'next-1' } } as never)
      .mockResolvedValueOnce({ status: 200, json: { results: [{ ...document, id: 'doc456' }], nextPageCursor: null } } as never);
    const docs = await listTaggedReaderDocuments('token', 'vault-copy');
    expect(docs.map((item) => item.id)).toEqual(['doc123', 'doc456']);
    expect(api.mock.calls[0][0]).toMatchObject({
      url: expect.stringContaining('tag=vault-copy'), headers: { Authorization: 'Token token' }, throw: false,
    });
    expect((api.mock.calls[1][0] as { url: string }).url).toContain('pageCursor=next-1');
  });

  it('writes full content and reciprocal links for a matching highlight note', async () => {
    const illustrated = { ...document, html_content: `${document.html_content}<img src="https://example.com/image.png" alt="Example">` };
    api
      .mockResolvedValueOnce({ status: 200, json: { results: [illustrated], nextPageCursor: null } } as never)
      .mockResolvedValueOnce({ status: 200, arrayBuffer: new ArrayBuffer(2) } as never)
      .mockResolvedValueOnce({ status: 200, json: { results: [illustrated], nextPageCursor: null } } as never);
    const highlight = Object.assign(new TFile(), { path: 'Readwise Sync/Articles/Article.md' });
    const files = new Map<string, string>([[highlight.path, 'Source URL: https://example.com/a\n\nA highlight']]);
    const fileObjects = new Map<string, TFile>([[highlight.path, highlight]]);
    const folders = new Set<string>();
    const vault = {
      adapter: { exists: async (path: string) => folders.has(path) || files.has(path) },
      createFolder: async (path: string) => { folders.add(path); },
      getMarkdownFiles: () => [...fileObjects.values()],
      cachedRead: async (file: TFile) => files.get(file.path) ?? '',
      getFileByPath: (path: string) => fileObjects.get(path) ?? null,
      create: async (path: string, content: string) => { files.set(path, content); fileObjects.set(path, Object.assign(new TFile(), { path })); },
      createBinary: async (path: string) => { files.set(path, 'binary asset'); },
      modify: async (file: TFile, content: string) => { files.set(file.path, content); },
      process: async (file: TFile, change: (text: string) => string) => { files.set(file.path, change(files.get(file.path) ?? '')); },
    };
    const ctx = {
      settings: { ...DEFAULT_SETTINGS, apiToken: 'token', readerEnabled: true, readerTag: 'vault-copy' },
      app: { vault, metadataCache: { getFileCache: (file: TFile): { frontmatter: { reader_id: string } } | null =>
        file.path.includes('doc123') ? { frontmatter: { reader_id: 'doc123' } } : null }, fileManager: {} },
      logger: { error: jest.fn(), warn: jest.fn() },
    } as unknown as PluginContext;
    const report = await syncReaderDocuments(ctx, new Environment() as ReadwiseEnvironment, async () => true);
    const readerPath = 'Readwise Sync/Reader/Article doc123.md';
    expect(report.counts.created).toBe(1);
    expect(files.get(readerPath)).toContain('Full text.');
    expect(files.get(readerPath)).toContain('A document note');
    expect(files.get(readerPath)).toContain('[[Readwise Sync/Articles/Article]]');
    expect(files.get(highlight.path)).toContain('[[Readwise Sync/Reader/Article doc123]]');
    expect([...files.keys()]).toContainEqual(expect.stringMatching(/_assets\/doc123-[a-f0-9]+\.png$/));
    expect(files.get(readerPath)).toContain('](./_assets/');

    files.set(highlight.path, `${files.get(highlight.path)}\n<!-- readwise-obsidian:local:start -->\nMy note\n<!-- readwise-obsidian:local:end -->`);
    ctx.settings.readerOutputMode = 'combined';
    const combined = await syncReaderDocuments(ctx, new Environment() as ReadwiseEnvironment, async () => true);
    expect(combined.counts.updated).toBe(1);
    expect(files.get(readerPath)).toContain('A highlight');
    expect(files.get(readerPath)).toContain('My note');
  });
});
