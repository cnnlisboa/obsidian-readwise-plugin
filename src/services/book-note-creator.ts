import { type App, normalizePath, TFile } from 'obsidian';
import type { PluginContext } from 'types/plugin-context';
import type { BooksBook } from './books-model';

const BOOK_SEARCH_ID = 'obsidian-book-search-plugin-fork';

interface BookSearchPlugin {
  settings: { folder?: string; fileNameFormat?: string };
  searchBookMetadata(query?: string): Promise<Record<string, unknown>>;
  getRenderedContents(book: Record<string, unknown>): Promise<string>;
}

interface PluginRegistry {
  plugins?: { plugins?: Record<string, unknown> };
}

function plugin<T>(app: App, id: string): T | undefined {
  return (app as unknown as PluginRegistry).plugins?.plugins?.[id] as T | undefined;
}

export function bookSearchAvailable(app: App): boolean {
  return !!plugin<BookSearchPlugin>(app, BOOK_SEARCH_ID);
}

function fill(template: string, values: Record<string, unknown>): string {
  return template.replace(/{{\s*([\w.]+)\s*}}/g, (_, key: string) => {
    const value = values[key];
    return typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  });
}

function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim() || 'Untitled book';
}

async function runTemplater(app: App, file: TFile): Promise<void> {
  const templater = plugin<{ settings?: Record<string, unknown>; templater?: { overwrite_file_commands(f: TFile): Promise<void> } }>(
    app, 'templater-obsidian');
  if (templater?.templater && !templater.settings?.trigger_on_file_creation) {
    await templater.templater.overwrite_file_commands(file);
  }
}

async function ensureFolder(app: App, folder: string): Promise<void> {
  if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
}

async function stampAndOpen(ctx: PluginContext, file: TFile, book: BooksBook): Promise<void> {
  const names = ctx.settings.booksPropertyNames;
  await ctx.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
    front[names.id] = book.id;
    if (book.product?.isbn && !front[names.isbn]) front[names.isbn] = book.product.isbn;
  });
  await ctx.app.workspace.getLeaf().openFile(file);
}

/**
 * Creates a book note for a Readwise Books entry. With the Book Search fork
 * installed, its search opens pre-filled (ISBN or title + author) so you pick
 * the match and it writes the note with your template and cover. Otherwise,
 * or if `fallback` is set, the fallback template is filled from Readwise.
 * Returns the note, or null if cancelled.
 */
export async function createBookNote(ctx: PluginContext, book: BooksBook, fallback = false): Promise<TFile | null> {
  const { app, settings } = ctx;
  const search = plugin<BookSearchPlugin>(app, BOOK_SEARCH_ID);
  if (search && !fallback) {
    const query = settings.booksSuggestQuery === 'isbn' && book.product?.isbn
      ? book.product.isbn
      : `${book.title ?? ''} ${book.author ?? ''}`.trim();
    let found: Record<string, unknown>;
    try {
      found = await search.searchBookMetadata(query);
    } catch {
      return null; // search closed without a choice
    }
    const contents = await search.getRenderedContents(found);
    const folder = normalizePath(search.settings.folder || settings.booksNoteFolder);
    const name = safeFileName(fill(search.settings.fileNameFormat || '{{title}}', found));
    const path = normalizePath(`${folder}/${name}.md`);
    await ensureFolder(app, folder);
    const existing = app.vault.getAbstractFileByPath(path);
    const file = existing instanceof TFile ? existing : await app.vault.create(path, contents);
    if (!(existing instanceof TFile)) await runTemplater(app, file);
    await stampAndOpen(ctx, file, book);
    return file;
  }

  // Fallback: the note template, filled from Readwise Books.
  const templateFile = app.vault.getAbstractFileByPath(normalizePath(settings.booksFallbackTemplate));
  const template = templateFile instanceof TFile ? await app.vault.read(templateFile) : '---\n---\n';
  const title = book.product?.title ?? book.title ?? '';
  const author = book.product?.author ?? book.author ?? '';
  const values: Record<string, unknown> = {
    title,
    author,
    totalPage: book.product?.page_count ?? '',
    publishDate: book.product?.publishing_date ?? '',
    description: (book.product?.summary ?? '').replace(/\n+/g, ' ').replace(/"/g, "'"),
    isbn13: book.product?.isbn ?? '',
    isbn10: '',
    coverUrl: '',
    localCoverImage: '',
    categories: '',
  };
  const folder = normalizePath(settings.booksNoteFolder);
  await ensureFolder(app, folder);
  const name = safeFileName(`${title}${author ? ` (${author})` : ''}`);
  const path = normalizePath(`${folder}/${name}.md`);
  const existing = app.vault.getAbstractFileByPath(path);
  const file = existing instanceof TFile ? existing : await app.vault.create(path, fill(template, values));
  if (!(existing instanceof TFile)) await runTemplater(app, file);
  await stampAndOpen(ctx, file, book);
  return file;
}
