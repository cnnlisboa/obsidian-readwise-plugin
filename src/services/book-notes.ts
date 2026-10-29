import { normalizePath, type TFile } from 'obsidian';
import type { Environment } from 'nunjucks';
import type { Export, Highlight, Library } from 'types/library';
import type { PluginContext } from 'types/plugin-context';
import type { PluginSettings } from 'types/settings';
import { normalizeFilename } from 'utils/file-utils';
import type { SyncEvent } from './sync-report';
import { filterHighlights } from './template-rendering';
import { editableBlock, previousEditableNotes, type NoteTarget } from './writeback-sections';

export const BOOK_START = '<!-- readwise-sync:book:start -->';
export const BOOK_END = '<!-- readwise-sync:book:end -->';

/** Resolves vault files the book section links to; null when that file does not exist. */
export interface BookLinkResolver {
  mirror(book: Export): TFile | null;
  atom(highlight: Highlight): TFile | null;
  linktext(file: TFile, sourcePath: string): string;
}

export function bookNoteFolder(settings: PluginSettings): string {
  const folder = settings.bookNotesFolder.trim();
  if (!folder || folder.startsWith('/') || folder.split('/').includes('..')) {
    throw new Error('Book notes folder must be a vault-relative folder.');
  }
  return normalizePath(folder);
}

export function routedToBookNote(settings: PluginSettings, book: Export): boolean {
  if (!settings.bookNotesEnabled || book.is_deleted) return false;
  const categories = settings.bookNotesCategories.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  return categories.includes(book.category.toLowerCase());
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

export interface BookMatch { file?: TFile; ambiguous?: TFile[] }

export class BookNoteIndex {
  private byId = new Map<string, TFile[]>();
  private byTitle = new Map<string, Set<TFile>>();

  constructor(private ctx: PluginContext) {
    const { settings } = ctx;
    const folder = bookNoteFolder(settings);
    const excluded = [settings.baseFolderName, settings.readerFolder].map((item) => `${normalizePath(item)}/`);
    for (const file of ctx.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${folder}/`) || excluded.some((prefix) => file.path.startsWith(prefix))) continue;
      const frontmatter = ctx.app.metadataCache.getFileCache(file)?.frontmatter as Record<string, unknown> | undefined;
      const id = frontmatter?.[settings.bookNoteIdProperty];
      if (typeof id === 'string' || typeof id === 'number') {
        // A note already bound to a book is never claimed by another book's title.
        this.byId.set(String(id), [...(this.byId.get(String(id)) ?? []), file]);
        continue;
      }
      for (const key of noteTitleKeys(file.basename, frontmatter)) {
        if (!this.byTitle.has(key)) this.byTitle.set(key, new Set());
        this.byTitle.get(key)?.add(file);
      }
    }
  }

  find(book: Export): BookMatch {
    const byId = this.byId.get(String(book.user_book_id)) ?? [];
    if (byId.length === 1) return { file: byId[0] };
    if (byId.length > 1) return { ambiguous: byId };
    if (!this.ctx.settings.bookNoteMatchByTitle) return {};
    const found = new Set<TFile>();
    for (const key of bookTitleKeys(book)) for (const file of this.byTitle.get(key) ?? []) found.add(file);
    if (found.size === 1) return { file: [...found][0] };
    return found.size > 1 ? { ambiguous: [...found] } : {};
  }

  /** Whether a sync would write this book's section somewhere. */
  receives(book: Export): boolean {
    return routedToBookNote(this.ctx.settings, book) && (Boolean(this.find(book).file) || this.ctx.settings.bookNoteCreateMissing);
  }

  bind(book: Export, file: TFile): void {
    this.byId.set(String(book.user_book_id), [file]);
    for (const files of this.byTitle.values()) files.delete(file);
  }
}

export function upsertBookSection(contents: string, section: string): string {
  if (section.includes(BOOK_START) || section.includes(BOOK_END)) {
    throw new Error('The book section template contains reserved markers.');
  }
  const block = `${BOOK_START}\n${section.trim()}\n${BOOK_END}`;
  const start = contents.indexOf(BOOK_START);
  const end = contents.indexOf(BOOK_END);
  if (start < 0 && end < 0) return `${contents.trimEnd()}\n\n${block}\n`;
  if (start < 0 || end < start || contents.indexOf(BOOK_START, start + 1) >= 0 || contents.indexOf(BOOK_END, end + 1) >= 0) {
    throw new Error('The Readwise section has missing or duplicate markers.');
  }
  return `${contents.slice(0, start)}${block}${contents.slice(end + BOOK_END.length)}`;
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
  const targets: NoteTarget[] = highlights.map((highlight) => `highlight-${highlight.id}` as const);
  // Comments edited in the book note use the same markers as the highlight note, so either location can send them.
  const previous = previousEditableNotes(existing, settings.writebackHighlightNotes ? targets : []);
  const mirror = links.mirror(book);
  const mirrorLink = mirror ? links.linktext(mirror, bookNotePath) : '';
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
      const atom = links.atom(highlight);
      const target = atom ? links.linktext(atom, bookNotePath) : mirrorLink ? `${mirrorLink}#^${highlight.id}` : '';
      const embed = target ? `![[${target}]]` : '';
      const link = target ? `[[${target}]]` : '';
      const quoted = quote(highlight.text);
      const style = settings.bookNoteHighlightStyle;
      const display = !target || style === 'quote' ? quoted : style === 'link' ? `${quoted}\n${link}` : embed;
      const note = highlight.note ?? '';
      const comment = settings.writebackHighlightNotes
        ? editableBlock(previous.get(`highlight-${highlight.id}`), `highlight-${highlight.id}`, note)
        : note;
      return {
        ...highlight,
        note,
        tags: (highlight.tags ?? []).map((tag) => tag.name),
        embed,
        link,
        quote: quoted,
        display,
        comment,
      };
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

export function planBookNotes(index: BookNoteIndex, env: Environment, settings: PluginSettings, library: Library): string[] {
  const actions: string[] = [];
  for (const book of Object.values(library.books)) {
    if (!routedToBookNote(settings, book)) continue;
    const match = index.find(book);
    if (match.file) actions.push(`Update Readwise section in book note ${match.file.path}`);
    else if (match.ambiguous) actions.push(`Skip "${book.title}": ${match.ambiguous.length} book notes match`);
    else if (settings.bookNoteCreateMissing) {
      actions.push(`Create book note ${normalizePath(`${bookNoteFolder(settings)}/${bookNoteFileName(env, settings, book)}.md`)}`);
    }
  }
  return actions;
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
    if (!routedToBookNote(settings, book)) continue;
    let path = book.title;
    try {
      const match = index.find(book);
      if (match.ambiguous) {
        events.push({ action: 'skipped', path: book.title,
          detail: `Several book notes match: ${match.ambiguous.map((file) => file.path).join(', ')}. Set ${settings.bookNoteIdProperty}: ${book.user_book_id} on one.` });
        continue;
      }
      let file = match.file;
      let created = false;
      if (!file) {
        if (!settings.bookNoteCreateMissing) {
          ctx.logger.debug(`No book note matches '${book.title}'`);
          continue;
        }
        const folder = bookNoteFolder(settings);
        path = normalizePath(`${folder}/${bookNoteFileName(env, settings, book)}.md`);
        if (ctx.app.vault.getAbstractFileByPath(path)) throw new Error(`A different note already exists at ${path}.`);
        const segments = folder.split('/');
        for (let i = 1; i <= segments.length; i++) {
          const current = segments.slice(0, i).join('/');
          if (!ctx.app.vault.getAbstractFileByPath(current)) await ctx.app.vault.createFolder(current);
        }
        file = await ctx.app.vault.create(path, env.renderString(settings.bookNoteNewTemplate, {
          title: book.title, author: book.author, category: book.category, cover_image_url: book.cover_image_url,
          source_url: book.source_url, readwise_url: book.readwise_url, book_id: book.user_book_id, book,
        }));
        created = true;
      }
      path = file.path;
      index.bind(book, file);
      const boundId: unknown = ctx.app.metadataCache.getFileCache(file)?.frontmatter?.[settings.bookNoteIdProperty];
      if ((created || settings.bookNoteStampId) && boundId !== book.user_book_id && boundId !== String(book.user_book_id)) {
        await ctx.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
          frontmatter[settings.bookNoteIdProperty] = book.user_book_id;
        });
      }
      const bookNote = file;
      let changed = false;
      await ctx.app.vault.process(bookNote, (current) => {
        const next = upsertBookSection(current, renderBookSection(env, settings, book, bookNote.path, current, links));
        changed = next !== current;
        return next;
      });
      if (created) events.push({ action: 'created', path });
      else if (changed) events.push({ action: 'updated', path });
    } catch (error) {
      ctx.logger.error(`Book note sync failed for '${book.title}'`, error);
      events.push({ action: 'failed', path, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return events;
}
