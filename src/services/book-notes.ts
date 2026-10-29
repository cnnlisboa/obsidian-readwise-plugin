import { normalizePath, type TFile } from 'obsidian';
import type { Environment } from 'nunjucks';
import { READWISE_REVIEW_URL_BASE } from 'src/constants';
import type { Export, Highlight, Library } from 'types/library';
import type { PluginContext } from 'types/plugin-context';
import type { PluginSettings } from 'types/settings';
import { normalizeFilename } from 'utils/file-utils';
import { bookRouteFolder, parseBookRoutes } from './book-routes';
import { findHeadingSection } from './local-section';
import type { SyncEvent } from './sync-report';
import { filterHighlights } from './template-rendering';
import { editableBlock, previousEditableNotes } from './writeback-sections';

export const BOOK_START = '<!-- readwise-sync:book:start -->';
export const BOOK_END = '<!-- readwise-sync:book:end -->';

/** Resolves link text, relative to the book note, for the files the section links to. */
export interface BookLinkResolver {
  mirror(book: Export, sourcePath: string): string | null;
  atom(highlight: Highlight, sourcePath: string): string | null;
}

export function normalizeTitle(value: string): string {
  return value.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

/** Full title plus the title before a subtitle separator, e.g. "Deep Work: Rules" → "Deep Work". */
export function bookTitleKeys(book: Pick<Export, 'title' | 'readable_title'>): string[] {
  const keys = new Set<string>();
  for (const title of [book.title, book.readable_title]) {
    if (!title) continue;
    keys.add(normalizeTitle(title));
    keys.add(normalizeTitle(title.split(/\s*(?::|–|—|-\s)\s*/)[0]));
  }
  keys.delete('');
  return [...keys];
}

/** Filename, filename without a trailing "(Author)", title property, and aliases. */
export function noteTitleKeys(basename: string, frontmatter: Record<string, unknown> | undefined): string[] {
  const values: unknown[] = [basename, basename.replace(/\s*\([^()]*\)\s*$/, '')];
  if (frontmatter) {
    const aliases: unknown = frontmatter.aliases;
    values.push(frontmatter.title, ...(Array.isArray(aliases) ? (aliases as unknown[]) : [aliases]));
  }
  const keys = new Set(values.filter((value): value is string => typeof value === 'string').map(normalizeTitle));
  keys.delete('');
  return [...keys];
}

/** Accepts a book ID as a number, a numeric string, or a Readwise book review URL. */
export function bookIdKey(value: unknown): string | null {
  if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  const id = trimmed.startsWith(READWISE_REVIEW_URL_BASE) ? trimmed.slice(READWISE_REVIEW_URL_BASE.length) : trimmed;
  return /^\d+$/.test(id) ? id : null;
}

export interface BookMatch {
  file?: TFile;
  ambiguous?: TFile[];
}

interface FolderIndex {
  byId: Map<string, TFile[]>;
  byTitle: Map<string, Set<TFile>>;
}

function routeFor(settings: PluginSettings, book: Export): string | null {
  return book.is_deleted ? null : bookRouteFolder(settings, book.category);
}

export function routedToBookNote(settings: PluginSettings, book: Export): boolean {
  return Boolean(routeFor(settings, book));
}

export class BookNoteIndex {
  private folders = new Map<string, FolderIndex>();

  constructor(private ctx: PluginContext) {
    const { settings } = ctx;
    const excluded = [settings.baseFolderName, settings.readerFolder].map((item) => `${normalizePath(item)}/`);
    const folders = [...new Set(parseBookRoutes(settings.bookNoteRoutes).map((route) => route.folder))];
    for (const folder of folders) this.folders.set(folder, { byId: new Map(), byTitle: new Map() });
    for (const file of ctx.app.vault.getMarkdownFiles()) {
      if (excluded.some((prefix) => file.path.startsWith(prefix))) continue;
      const folder = folders.find((item) => file.path.startsWith(`${item}/`));
      const index = folder ? this.folders.get(folder) : undefined;
      if (!index) continue;
      const frontmatter = ctx.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      const id = bookIdKey(frontmatter?.[settings.bookNoteIdProperty]);
      if (id) {
        // A note already bound to a book is never claimed by another book's title.
        index.byId.set(id, [...(index.byId.get(id) ?? []), file]);
        continue;
      }
      for (const key of noteTitleKeys(file.basename, frontmatter)) {
        if (!index.byTitle.has(key)) index.byTitle.set(key, new Set());
        index.byTitle.get(key)?.add(file);
      }
    }
  }

  private indexFor(book: Export): FolderIndex | undefined {
    const folder = routeFor(this.ctx.settings, book);
    return folder ? this.folders.get(folder) : undefined;
  }

  find(book: Export): BookMatch {
    const index = this.indexFor(book);
    if (!index) return {};
    const byId = index.byId.get(String(book.user_book_id)) ?? [];
    if (byId.length === 1) return { file: byId[0] };
    if (byId.length > 1) return { ambiguous: byId };
    if (!this.ctx.settings.bookNoteMatchByTitle) return {};
    const found = new Set<TFile>();
    for (const key of bookTitleKeys(book)) for (const file of index.byTitle.get(key) ?? []) found.add(file);
    if (found.size === 1) return { file: [...found][0] };
    return found.size > 1 ? { ambiguous: [...found] } : {};
  }

  /** Whether a sync would write this book's section somewhere. */
  receives(book: Export): boolean {
    return Boolean(this.indexFor(book)) && (Boolean(this.find(book).file) || this.ctx.settings.bookNoteCreateMissing);
  }

  bind(book: Export, file: TFile): void {
    const index = this.indexFor(book);
    if (!index) return;
    index.byId.set(String(book.user_book_id), [file]);
    for (const files of index.byTitle.values()) files.delete(file);
  }
}

function frontmatterEnd(contents: string): number {
  const match = /^---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/.exec(contents);
  return match ? match[0].length : 0;
}

export function upsertBookSection(
  contents: string,
  section: string,
  placement: PluginSettings['bookNotePlacement'] = 'append',
  heading = ''
): string {
  if (section.includes(BOOK_START) || section.includes(BOOK_END)) {
    throw new Error('The book section template contains reserved markers.');
  }
  const block = `${BOOK_START}\n${section.trim()}\n${BOOK_END}`;
  const start = contents.indexOf(BOOK_START);
  const end = contents.indexOf(BOOK_END);
  if (start >= 0 || end >= 0) {
    if (start < 0 || end < start || contents.indexOf(BOOK_START, start + 1) >= 0 || contents.indexOf(BOOK_END, end + 1) >= 0) {
      throw new Error('The Readwise section has missing or duplicate markers.');
    }
    // Once present, the section stays wherever it is, even if the user moved it.
    return `${contents.slice(0, start)}${block}${contents.slice(end + BOOK_END.length)}`;
  }
  if (placement === 'prepend') {
    const at = frontmatterEnd(contents);
    const rest = contents.slice(at).replace(/^\s+/, '');
    return `${contents.slice(0, at)}${at ? '\n' : ''}${block}\n${rest ? `\n${rest}` : ''}`;
  }
  if (placement === 'heading' && heading.trim()) {
    const found = findHeadingSection(contents, heading);
    if (!found) return `${contents.trimEnd()}\n\n${heading.trim()}\n\n${block}\n`;
    const lines = contents.split('\n');
    const after = lines.slice(found.start + 1);
    while (after.length && !after[0].trim()) after.shift();
    return [...lines.slice(0, found.start + 1), '', block, '', ...after].join('\n');
  }
  return `${contents.trimEnd()}\n\n${block}\n`;
}

function quote(text: string): string {
  return text.trim().split('\n').map((line) => `> ${line}`.trimEnd()).join('\n');
}

export function renderBookSection(
  env: Environment,
  settings: PluginSettings,
  book: Export,
  bookNotePath: string,
  existing: string,
  links: BookLinkResolver
): string {
  const highlights = filterHighlights(book.highlights, settings);
  const targets = highlights.map((highlight) => `highlight-${highlight.id}` as const);
  // Comments edited in the book note use the same markers as the Readwise note, so either location can send them.
  const previous = previousEditableNotes(existing, settings.writebackHighlightNotes ? targets : []);
  const mirrorLink = links.mirror(book, bookNotePath);
  const context = {
    book,
    title: book.title,
    author: book.author,
    category: book.category,
    document_note: book.document_note ?? '',
    summary: book.summary ?? '',
    cover_image_url: book.cover_image_url,
    readwise_url: book.readwise_url,
    source_url: book.source_url,
    tags: (book.book_tags ?? []).map((tag) => tag.name),
    readwise_link: mirrorLink ? `[[${mirrorLink}]]` : book.readwise_url,
    highlights: highlights.map((highlight) => {
      const atom = links.atom(highlight, bookNotePath);
      const blockId = env.renderString(settings.bookNoteBlockId, highlight).trim();
      const target = atom ?? (mirrorLink && blockId ? `${mirrorLink}#^${blockId}` : '');
      const embed = target ? `![[${target}]]` : '';
      const link = target ? `[[${target}]]` : '';
      const quoted = quote(highlight.text);
      const style = settings.bookNoteHighlightStyle;
      const display = !target || style === 'quote' ? quoted : style === 'link' ? `${quoted}\n${link}` : embed;
      const note = highlight.note ?? '';
      const comment = settings.writebackHighlightNotes
        ? editableBlock(previous.get(`highlight-${highlight.id}`), `highlight-${highlight.id}`, note)
        : note;
      return { ...highlight, note, tags: (highlight.tags ?? []).map((tag) => tag.name), embed, link, quote: quoted, display, comment };
    }),
  };
  return env.renderString(settings.bookNoteSectionTemplate, context);
}

export function bookNoteFileName(env: Environment, settings: PluginSettings, book: Export): string {
  const rendered = env.renderString(settings.bookNoteFilenameTemplate, {
    title: book.title, author: book.author, category: book.category, book_id: book.user_book_id,
  });
  const name = normalizeFilename(rendered, settings).slice(0, 200).trim();
  if (!name) throw new Error('The book note filename template rendered an empty name.');
  return name;
}

function newNoteContents(env: Environment, settings: PluginSettings, book: Export): string {
  return env.renderString(settings.bookNoteNewTemplate, {
    title: book.title, author: book.author, category: book.category, cover_image_url: book.cover_image_url,
    source_url: book.source_url, readwise_url: book.readwise_url, book_id: book.user_book_id, book,
    now: new Date().toISOString(),
  });
}

/** One book note's planned change, computed without writing. */
export interface BookNotePlan {
  book: Export;
  path: string;
  file?: TFile;
  create: boolean;
  stampId: boolean;
  skipped?: string;
  before: string;
  after: string;
}

export async function planBookNote(
  ctx: PluginContext,
  env: Environment,
  book: Export,
  index: BookNoteIndex,
  links: BookLinkResolver
): Promise<BookNotePlan | null> {
  const { settings } = ctx;
  const folder = routeFor(settings, book);
  if (!folder) return null;
  const match = index.find(book);
  if (match.ambiguous) {
    return { book, path: book.title, create: false, stampId: false, before: '', after: '',
      skipped: `Several book notes match: ${match.ambiguous.map((file) => file.path).join(', ')}. Set ${settings.bookNoteIdProperty}: ${book.user_book_id} on one.` };
  }
  if (!match.file && !settings.bookNoteCreateMissing) return null;
  const path = match.file?.path ?? normalizePath(`${folder}/${bookNoteFileName(env, settings, book)}.md`);
  if (!match.file && ctx.app.vault.getAbstractFileByPath(path)) throw new Error(`A different note already exists at ${path}.`);
  const before = match.file ? await ctx.app.vault.read(match.file) : newNoteContents(env, settings, book);
  const after = upsertBookSection(before, renderBookSection(env, settings, book, path, before, links),
    settings.bookNotePlacement, settings.bookNotePlacementHeading);
  const boundId = match.file ? bookIdKey(ctx.app.metadataCache.getFileCache(match.file)?.frontmatter?.[settings.bookNoteIdProperty]) : null;
  return { book, path, file: match.file, create: !match.file, before: match.file ? before : '', after,
    stampId: (!match.file || settings.bookNoteStampId) && boundId !== String(book.user_book_id) };
}

export async function planBookNotes(ctx: PluginContext, env: Environment, library: Library, links: BookLinkResolver): Promise<BookNotePlan[]> {
  const index = new BookNoteIndex(ctx);
  const plans: BookNotePlan[] = [];
  for (const book of Object.values(library.books)) {
    const plan = await planBookNote(ctx, env, book, index, links);
    if (plan) plans.push(plan);
  }
  return plans;
}

export async function syncBookNotes(
  ctx: PluginContext,
  env: Environment,
  library: Library,
  index: BookNoteIndex,
  links: BookLinkResolver
): Promise<SyncEvent[]> {
  const { settings } = ctx;
  const events: SyncEvent[] = [];
  for (const book of Object.values(library.books)) {
    let path = book.title;
    try {
      const plan = await planBookNote(ctx, env, book, index, links);
      if (!plan) {
        if (routedToBookNote(settings, book)) ctx.logger.debug(`No book note matches '${book.title}'`);
        continue;
      }
      if (plan.skipped) {
        events.push({ action: 'skipped', path: book.title, detail: plan.skipped, bookId: book.user_book_id });
        continue;
      }
      path = plan.path;
      let file = plan.file;
      if (!file) {
        const segments = path.split('/').slice(0, -1);
        for (let i = 1; i <= segments.length; i++) {
          const current = segments.slice(0, i).join('/');
          if (!ctx.app.vault.getAbstractFileByPath(current)) await ctx.app.vault.createFolder(current);
        }
        file = await ctx.app.vault.create(path, plan.after);
      }
      index.bind(book, file);
      if (plan.stampId) {
        await ctx.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          frontmatter[settings.bookNoteIdProperty] = book.user_book_id;
        });
      }
      let changed = false;
      if (plan.file) {
        const bookNote = plan.file;
        // Recompute inside process, so an edit made after planning is not overwritten.
        await ctx.app.vault.process(bookNote, (current) => {
          const next = upsertBookSection(current, renderBookSection(env, settings, book, bookNote.path, current, links),
            settings.bookNotePlacement, settings.bookNotePlacementHeading);
          changed = next !== current;
          return next;
        });
      }
      if (plan.create) events.push({ action: 'created', path, bookId: book.user_book_id });
      else if (changed || plan.stampId) events.push({ action: 'updated', path, bookId: book.user_book_id });
    } catch (error) {
      ctx.logger.error(`Book note sync failed for '${book.title}'`, error);
      events.push({ action: 'failed', path, detail: error instanceof Error ? error.message : String(error), bookId: book.user_book_id });
    }
  }
  return events;
}
