import { type App, TFile, normalizePath } from 'obsidian';
import type { PluginContext } from 'types/plugin-context';
import { BooksApi, isRetryable } from './books-api';
import {
  authorFromSource,
  type BookPatch,
  type BooksBook,
  identityFromFilename,
  matchNotes,
  type NoteIdentity,
  planNoteSync,
  readNote,
  readNumber,
} from './books-model';

export interface BooksSyncReport {
  notesUpdated: number;
  sent: number;
  queued: number;
  created: number;
  suggestions: BooksBook[];
  log: string[];
}

function filesUnder(app: App, folder: string): TFile[] {
  const prefix = normalizePath(folder).replace(/\/$/, '') + '/';
  return app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(prefix));
}

function frontmatterOf(app: App, file: TFile): Record<string, unknown> {
  const fm: Record<string, unknown> | undefined = app.metadataCache.getFileCache(file)?.frontmatter;
  return fm ?? {};
}

function noteIdentity(app: App, file: TFile, idProperty: string, isbnProperty: string): NoteIdentity {
  const fm = frontmatterOf(app, file);
  const fromName = identityFromFilename(file.basename.replace(/^=\s*/, ''));
  const aliases = Array.isArray(fm.aliases) ? fm.aliases : fm.aliases ? [fm.aliases] : [];
  const titles = [fromName.title, ...aliases.filter((a): a is string => typeof a === 'string')];
  if (typeof fm.title === 'string') titles.push(fm.title);
  return {
    path: file.path,
    titles,
    author: authorFromSource(fm.source) ?? fromName.author,
    id: readNumber(fm[idProperty]),
    isbn: typeof fm[isbnProperty] === 'string' ? fm[isbnProperty] : null,
  };
}

function wikilink(file: TFile): string {
  return `[[${file.basename}]]`;
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '' || (Array.isArray(value) && value.length === 0);
}

/**
 * One Readwise Books sync for personal book notes. Never touches a note's
 * body: only frontmatter, through processFrontMatter (so property history
 * plugins see the change like any other edit).
 */
export async function syncReadwiseBookNotes(ctx: PluginContext, api: BooksApi): Promise<BooksSyncReport> {
  const { app, settings } = ctx;
  const names = settings.booksPropertyNames;
  const report: BooksSyncReport = { notesUpdated: 0, sent: 0, queued: 0, created: 0, suggestions: [], log: [] };

  // Waiting patches first, so a newer edit below is sent after them.
  if (settings.booksPendingPatches.length > 0) {
    const pending = settings.booksPendingPatches;
    settings.booksPendingPatches = [];
    const results = await api.update(pending);
    results.forEach((result, i) => {
      if (result.ok) report.sent++;
      else if (isRetryable(result)) settings.booksPendingPatches.push(pending[i]);
    });
  }

  const books = await api.listAll();
  const byId = new Map(books.map((b) => [b.id, b]));
  const noteFiles = filesUnder(app, settings.booksNoteFolder);
  const identities = noteFiles.map((f) => noteIdentity(app, f, names.id, names.isbn));
  const matches = matchNotes(books, identities);

  // Highlights notes (books only), to link the two kinds of note.
  const highlightFiles = filesUnder(app, settings.baseFolderName)
    .filter((f) => {
      const category = frontmatterOf(app, f).category;
      return typeof category === 'string' && category.toLowerCase() === 'books';
    });
  const highlightMatches = matchNotes(books, highlightFiles.map((f) => noteIdentity(app, f, '__none__', '__none__')));

  const patches: BookPatch[] = [];
  const patchStates = new Map<number, import('./books-model').BookSyncState>();
  for (const [bookId, path] of matches) {
    const book = byId.get(bookId);
    const file = app.vault.getAbstractFileByPath(path);
    if (!book || !(file instanceof TFile)) continue;
    const fm = frontmatterOf(app, file);
    const previous = settings.booksState[String(bookId)] ?? {};
    const plan = planNoteSync(readNote(fm, names, settings.booksStatusMap), book, previous, {
      names,
      statusMap: settings.booksStatusMap,
      finishedStatus: settings.booksFinishedStatus,
      formats: settings.booksFormats,
    });

    const highlightsPath = highlightMatches.get(bookId);
    const highlightsFile = highlightsPath ? app.vault.getAbstractFileByPath(highlightsPath) : null;
    if (highlightsFile instanceof TFile && settings.booksHighlightsProperty
      && isEmpty(fm[settings.booksHighlightsProperty])) {
      plan.frontmatter[settings.booksHighlightsProperty] = wikilink(highlightsFile);
    }

    if (Object.keys(plan.frontmatter).length > 0) {
      await app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
        Object.assign(front, plan.frontmatter);
      });
      report.notesUpdated++;
    }
    if (highlightsFile instanceof TFile && settings.booksBookProperty
      && isEmpty(frontmatterOf(app, highlightsFile)[settings.booksBookProperty])) {
      await app.fileManager.processFrontMatter(highlightsFile, (front: Record<string, unknown>) => {
        if (isEmpty(front[settings.booksBookProperty])) front[settings.booksBookProperty] = wikilink(file);
      });
    }
    for (const line of plan.log) report.log.push(`${file.basename}: ${line}`);
    if (plan.patch) {
      patches.push(plan.patch);
      patchStates.set(bookId, plan.state);
      // Saved only once the patch lands, so a failed push is retried.
      settings.booksState[String(bookId)] = {
        ...previous, doneWritten: plan.state.doneWritten, remoteStatus: book.status,
      };
    } else {
      settings.booksState[String(bookId)] = plan.state;
    }
  }

  if (patches.length > 0) {
    const results = await api.update(patches);
    results.forEach((result, i) => {
      const patch = patches[i];
      if (result.ok) {
        report.sent++;
        const state = patchStates.get(patch.id);
        if (state) settings.booksState[String(patch.id)] = state;
      } else if (isRetryable(result)) {
        settings.booksPendingPatches.push(patch);
        const state = patchStates.get(patch.id);
        if (state) settings.booksState[String(patch.id)] = state;
        report.queued++;
      } else {
        // Recorded anyway so a refused change isn't retried forever.
        const state = patchStates.get(patch.id);
        if (state) settings.booksState[String(patch.id)] = state;
        report.log.push(`Readwise Books refused an update for book ${patch.id}: ${result.code} ${result.message ?? ''}`);
      }
    });
  }

  // Notes with a synced status but no Readwise Books entry.
  if (settings.booksAutoPushNew) {
    report.created += await pushNewNotes(ctx, api, noteFiles, new Set(matches.values()));
  }

  if (settings.booksSuggest) report.suggestions = suggestionsFrom(ctx, books, matches);

  settings.booksLastSync = new Date().toISOString();
  await ctx.saveAndApplySettings();
  return report;
}

function suggestionsFrom(ctx: PluginContext, books: BooksBook[], matches: Map<number, string>): BooksBook[] {
  const excluded = new Set(ctx.settings.booksSuggestExcluded);
  return books.filter((b) => b.status !== 'deleted' && !matches.has(b.id)
    && ctx.settings.booksSuggestShelves.includes(b.status) && !excluded.has(b.id));
}

/** Books on the suggestion shelves with no book note, without syncing anything. */
export function findSuggestions(ctx: PluginContext, books: BooksBook[]): BooksBook[] {
  const names = ctx.settings.booksPropertyNames;
  const identities = filesUnder(ctx.app, ctx.settings.booksNoteFolder)
    .map((f) => noteIdentity(ctx.app, f, names.id, names.isbn));
  return suggestionsFrom(ctx, books, matchNotes(books, identities));
}

/** POST /books for book notes whose status maps to a shelf but have no id. */
export async function pushNewNotes(ctx: PluginContext, api: BooksApi, files: TFile[],
  matchedPaths: Set<string>): Promise<number> {
  const { app, settings } = ctx;
  const names = settings.booksPropertyNames;
  const candidates: { file: TFile; item: { product: Record<string, string>; status?: string } }[] = [];
  for (const file of files) {
    if (matchedPaths.has(file.path)) continue;
    const fm = frontmatterOf(app, file);
    const values = readNote(fm, names, settings.booksStatusMap);
    const shelf = values.status ? settings.booksStatusMap[values.status] : '';
    if (!shelf || values.id) continue;
    const identity = identityFromFilename(file.basename);
    const author = authorFromSource(fm.source) ?? identity.author;
    const product: Record<string, string> = values.isbn ? { isbn: values.isbn }
      : author ? { title: identity.title, author } : {};
    if (Object.keys(product).length === 0) continue;
    candidates.push({ file, item: { product, status: shelf } });
  }
  return addNotesToBooks(ctx, api, candidates);
}

export async function addNotesToBooks(ctx: PluginContext, api: BooksApi,
  candidates: { file: TFile; item: { product: Record<string, string>; status?: string } }[]): Promise<number> {
  if (candidates.length === 0) return 0;
  const results = await api.create(candidates.map((c) => c.item));
  let created = 0;
  for (let i = 0; i < candidates.length; i++) {
    const result = results[i];
    const bookId = result?.raw?.book_id as number | undefined;
    if (result?.ok && typeof bookId === 'number') {
      await ctx.app.fileManager.processFrontMatter(candidates[i].file, (front: Record<string, unknown>) => {
        front[ctx.settings.booksPropertyNames.id] = bookId;
      });
      created++;
    } else {
      ctx.logger.warn(`Readwise Books: could not add ${candidates[i].file.basename}`, result);
    }
  }
  return created;
}
