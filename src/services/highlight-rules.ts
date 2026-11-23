import { type App, normalizePath, requestUrl, TFile } from 'obsidian';
import type { Export, Highlight } from 'types/library';
import type { PluginContext } from 'types/plugin-context';
import { chapterNoteText, headingLevel } from './template-rendering';
import type { HighlightRule } from './highlight-rules-defaults';

export type { HighlightRule } from './highlight-rules-defaults';
export { DEFAULT_RULES, DEFAULT_RULE_TEMPLATE } from './highlight-rules-defaults';

/**
 * Tag-triggered rules (PLAN F) and chapter notes (PLAN H).
 *
 * A highlight tagged `reference/<kind>` (a real tag, or `#reference/<kind>` /
 * `.reference/<kind>` typed in its note) becomes a note in the vault. Each
 * highlight is processed once and recorded with everything needed to find
 * it again (text, book, location), so nothing depends on it surviving.
 * After the note is written and read back, the highlight gets the processed
 * tag in Readwise; after the grace period it is deleted, unless dry run is on.
 *
 * Chapter notes: a heading highlight (h1/h2/h3) whose note has your own text
 * after the ".h2" is copied into the book note's managed section. The
 * heading highlight itself stays in Readwise.
 */

export interface ProcessedRecord {
  state: 'written' | 'marked' | 'deleted' | 'failed';
  rule: string;
  kind?: string;
  path?: string;
  text: string;
  note: string;
  tags: string[];
  bookTitle: string;
  author: string;
  v2BookId: number;
  readerHighlightId?: string | null;
  location: number;
  locationType: string;
  createdAt: string;
  markedAt?: string;
  deletedAt?: string;
}

/** Kinds this highlight triggers for a rule (from tags and note tokens). */
export function triggeredKinds(highlight: Pick<Highlight, 'tags' | 'note'>, prefix: string): string[] {
  const kinds = new Set<string>();
  const lowerPrefix = prefix.toLowerCase();
  for (const tag of highlight.tags ?? []) {
    const name = tag.name.trim().toLowerCase();
    if (name.startsWith(lowerPrefix) && name.length > lowerPrefix.length) kinds.add(name.slice(lowerPrefix.length));
  }
  const escaped = lowerPrefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const pattern = new RegExp(`(?:^|\\s)[#.]${escaped}([\\w-]+)`, 'gi');
  for (const match of (highlight.note ?? '').matchAll(pattern)) kinds.add(match[1].toLowerCase());
  return [...kinds];
}

/** The note without trigger tokens, for the created note. */
export function noteWithoutTokens(note: string, prefix: string): string {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  return (note ?? '').replace(new RegExp(`(^|\\s)[#.]${escaped}[\\w-]+`, 'gi'), '$1').trim();
}

/** Grace period passed? */
export function dueForDeletion(record: ProcessedRecord, graceDays: number, now = Date.now()): boolean {
  if (record.state !== 'marked' || !record.markedAt) return false;
  return now - new Date(record.markedAt).getTime() >= graceDays * 86400000;
}

/** Text between the chapter-notes markers, with one entry per highlight. */
export const CHAPTER_START = '<!-- chapter-notes:start -->';
export const CHAPTER_END = '<!-- chapter-notes:end -->';

export interface ChapterEntry {
  id: number;
  title: string;
  level: number;
  text: string;
  location: number;
}

/**
 * Adds chapter entries to a book note's managed section, in reading order.
 * Existing text inside the markers is never changed: a new entry goes after
 * the last entry with an earlier location (found by its block id), or at
 * the end. The section is created at the end of the note if missing.
 */
export function insertChapterNotes(content: string, entries: ChapterEntry[], known: Map<number, number>): string {
  let text = content;
  if (!text.includes(CHAPTER_START) || !text.includes(CHAPTER_END)) {
    text = `${text.replace(/\s*$/, '')}\n\n## Chapter notes\n\n${CHAPTER_START}\n${CHAPTER_END}\n`;
  }
  const sorted = [...entries].sort((a, b) => a.location - b.location);
  for (const entry of sorted) {
    if (text.includes(`^rwcn${entry.id}`)) continue;
    const block = `\n### ${entry.title}\n\n${entry.text} ^rwcn${entry.id}\n`;
    const start = text.indexOf(CHAPTER_START) + CHAPTER_START.length;
    const end = text.indexOf(CHAPTER_END);
    const section = text.slice(start, end);
    // Last known entry before this one in reading order.
    let insertAt = section.length;
    let bestLocation = -Infinity;
    let firstAfter: number | null = null;
    for (const [id, location] of known) {
      const marker = `^rwcn${id}`;
      const at = section.indexOf(marker);
      if (at < 0) continue;
      if (location <= entry.location && location > bestLocation) {
        bestLocation = location;
        insertAt = section.indexOf('\n', at) + 1 || section.length;
      } else if (location > entry.location && (firstAfter === null || at < firstAfter)) {
        firstAfter = section.lastIndexOf('\n###', at);
      }
    }
    if (bestLocation === -Infinity && firstAfter !== null && firstAfter >= 0) insertAt = firstAfter;
    const updated = section.slice(0, insertAt).replace(/\n*$/, '\n') + block + section.slice(insertAt);
    text = text.slice(0, start) + updated.replace(/\n*$/, '\n') + text.slice(end);
    known.set(entry.id, entry.location);
  }
  return text;
}

// ------------------------------------------------------------------ engine

function render(template: string, values: Record<string, unknown>, env: { renderString(t: string, c: object): string }): string {
  return env.renderString(template, values);
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 120) || 'Highlight';
}

async function uniquePath(app: App, folder: string, base: string): Promise<string> {
  let path = normalizePath(folder ? `${folder}/${base}.md` : `${base}.md`);
  for (let i = 2; await app.vault.adapter.exists(path); i++) {
    path = normalizePath(folder ? `${folder}/${base} ${i}.md` : `${base} ${i}.md`);
  }
  return path;
}

export interface RulesReport {
  written: number;
  marked: number;
  deleted: number;
  chapterNotes: number;
  failures: string[];
}

export class HighlightRulesEngine {
  constructor(
    private ctx: PluginContext,
    private env: { renderString(t: string, c: object): string },
    private links: { bookNote(book: Export): TFile | null; highlightsNote(book: Export): string | null }
  ) {}

  private get settings() {
    return this.ctx.settings;
  }

  private async v2(method: string, path: string, body?: unknown): Promise<boolean> {
    const response = await requestUrl({
      url: `https://readwise.io/api/v2${path}`,
      method,
      headers: { Authorization: `Token ${this.settings.apiToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    return response.status >= 200 && response.status < 300 || response.status === 404 && method === 'DELETE';
  }

  private async reader(method: string, path: string, body?: unknown): Promise<boolean> {
    const response = await requestUrl({
      url: `https://readwise.io/api/v3${path}`,
      method,
      headers: { Authorization: `Token ${this.settings.apiToken}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      throw: false,
    });
    return response.status >= 200 && response.status < 300 || response.status === 404 && method === 'DELETE';
  }

  /** Runs every rule over the given books, then the deletion pass. */
  async run(books: Export[]): Promise<RulesReport> {
    const report: RulesReport = { written: 0, marked: 0, deleted: 0, chapterNotes: 0, failures: [] };
    if (!this.settings.rulesEnabled) return report;
    const processed = this.settings.processedHighlights;

    for (const book of books) {
      const chapterEntries: ChapterEntry[] = [];
      for (const highlight of book.highlights ?? []) {
        if (highlight.is_deleted) continue;
        const key = String(highlight.id);

        // Chapter notes (books only, into the book note).
        if (this.settings.chapterNotesEnabled && book.category === 'books' && !processed[`cn${key}`]) {
          const level = headingLevel(highlight);
          const text = level ? chapterNoteText(highlight.note) : '';
          if (level && text) {
            chapterEntries.push({ id: highlight.id, title: highlight.text.trim(), level, text, location: highlight.location });
          }
        }

        if (processed[key]) continue;
        for (const rule of this.settings.highlightRules) {
          if (!rule.enabled || !rule.tagPrefix) continue;
          const kinds = triggeredKinds(highlight, rule.tagPrefix);
          if (kinds.length === 0) continue;
          try {
            await this.writeRuleNote(rule, kinds[0], book, highlight);
            report.written++;
          } catch (error) {
            report.failures.push(`${book.title}: ${String(error)}`);
          }
          break;
        }
      }
      if (chapterEntries.length > 0) {
        try {
          report.chapterNotes += await this.writeChapterNotes(book, chapterEntries);
        } catch (error) {
          report.failures.push(`${book.title} chapter notes: ${String(error)}`);
        }
      }
    }

    await this.markAndDelete(report);
    await this.ctx.saveAndApplySettings();
    return report;
  }

  private async writeRuleNote(rule: HighlightRule, kind: string, book: Export, highlight: Highlight): Promise<void> {
    const { app } = this.ctx;
    const bookNote = this.links.bookNote(book);
    const highlightsNote = this.links.highlightsNote(book);
    const values = {
      tag: `${rule.tagPrefix}${kind}`,
      kind,
      text: highlight.text,
      note: noteWithoutTokens(highlight.note, rule.tagPrefix),
      book_title: bookNote?.basename ?? book.title,
      title: book.title,
      author: book.author,
      book_link: bookNote ? `[[${bookNote.basename}]]` : highlightsNote ? `[[${highlightsNote}]]` : book.title,
      highlights_link: highlightsNote ? `[[${highlightsNote}#^rw${highlight.id}H]]` : '',
      location: highlight.location,
      readwise_url: highlight.readwise_url,
      url: highlight.url ?? book.unique_url ?? '',
      date: new Date().toISOString().slice(0, 10),
    };
    const folder = normalizePath(rule.kindFolders[kind] ?? rule.folder ?? '').replace(/^\/$/, '');
    if (folder && !(await app.vault.adapter.exists(folder))) await app.vault.createFolder(folder);
    const path = await uniquePath(app, folder === '.' ? '' : folder, safeName(render(rule.filenameTemplate, values, this.env)));
    const content = render(rule.noteTemplate, values, this.env);
    const file = await app.vault.create(path, content);
    // Verify before anything is allowed to delete the highlight.
    const readBack = await app.vault.read(file);
    const verified = readBack.includes(highlight.text.slice(0, 40));
    this.settings.processedHighlights[String(highlight.id)] = {
      state: verified ? 'written' : 'failed',
      rule: rule.name,
      kind,
      path,
      text: highlight.text,
      note: highlight.note,
      tags: (highlight.tags ?? []).map((t) => t.name),
      bookTitle: book.title,
      author: book.author,
      v2BookId: book.user_book_id,
      readerHighlightId: (highlight as Highlight & { external_id?: string | null }).external_id ?? null,
      location: highlight.location,
      locationType: highlight.location_type,
      createdAt: new Date().toISOString(),
    };
    if (!verified) throw new Error(`note ${path} did not contain the highlight after writing`);
  }

  private async writeChapterNotes(book: Export, entries: ChapterEntry[]): Promise<number> {
    const file = this.links.bookNote(book);
    if (!file) return 0;
    const known = new Map<number, number>();
    for (const [key, record] of Object.entries(this.settings.processedHighlights)) {
      if (key.startsWith('cn') && record.v2BookId === book.user_book_id) known.set(Number(key.slice(2)), record.location);
    }
    let added = 0;
    await this.ctx.app.vault.process(file, (content) => {
      const updated = insertChapterNotes(content, entries, known);
      added = entries.filter((e) => !content.includes(`^rwcn${e.id}`) && updated.includes(`^rwcn${e.id}`)).length;
      return updated;
    });
    for (const entry of entries) {
      this.settings.processedHighlights[`cn${entry.id}`] = {
        state: 'written', rule: 'chapter-note', path: file.path, text: entry.title, note: entry.text, tags: [],
        bookTitle: book.title, author: book.author, v2BookId: book.user_book_id, location: entry.location,
        locationType: 'location', createdAt: new Date().toISOString(),
      };
    }
    return added;
  }

  /** Processed tag on written highlights; deletion after the grace period. */
  async markAndDelete(report: RulesReport): Promise<void> {
    const processed = this.settings.processedHighlights;
    for (const [key, record] of Object.entries(processed)) {
      if (key.startsWith('cn')) continue;
      const rule = this.settings.highlightRules.find((r) => r.name === record.rule);
      if (record.state === 'written' && this.settings.rulesProcessedTag) {
        if (await this.v2('POST', `/highlights/${key}/tags/`, { name: this.settings.rulesProcessedTag })) {
          record.state = 'marked';
          record.markedAt = new Date().toISOString();
          report.marked++;
        }
      }
      if (!rule?.deleteAfterGrace || this.settings.rulesDryRun) continue;
      if (!dueForDeletion(record, this.settings.rulesGraceDays)) continue;
      // A highlight made in Reader is deleted in Reader: a v2 delete doesn't
      // reach Reader and comes back (tested 2026-11-23).
      const ok = record.readerHighlightId && !record.readerHighlightId.startsWith('epub-toc')
        ? await this.reader('DELETE', `/delete/${record.readerHighlightId}/`)
        : await this.v2('DELETE', `/highlights/${key}/`);
      if (ok) {
        record.state = 'deleted';
        record.deletedAt = new Date().toISOString();
        report.deleted++;
      }
    }
  }

  /** Records waiting for deletion, for the review command. */
  pending(): [string, ProcessedRecord][] {
    return Object.entries(this.settings.processedHighlights)
      .filter(([key, r]) => !key.startsWith('cn') && r.state === 'marked');
  }
}
