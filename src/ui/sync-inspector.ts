import { type App, Modal, type TFile } from 'obsidian';
import { bookIdKey } from 'services/book-notes';
import { inBookNoteFolder } from 'services/book-routes';
import { hasUnsentEdit, readEditableNotes } from 'services/writeback-sections';
import { READWISE_EXTERNAL_ID_FIELD, READWISE_REVIEW_URL_BASE } from 'src/constants';
import type { PluginContext } from 'types/plugin-context';
import { humanReadableFormat } from 'utils/format-utils';
import { isTrackedReadwiseNote } from 'utils/tracking-utils';

export interface InspectorSection {
  heading: string;
  rows: [label: string, value: string][];
  files?: TFile[];
}

type Frontmatter = Record<string, unknown>;

function frontmatterOf(ctx: PluginContext, file: TFile): Frontmatter {
  return (ctx.app.metadataCache.getFileCache(file)?.frontmatter ?? {});
}

function text(value: unknown): string {
  return typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean' ? String(value) : '';
}

/** Collects what the plugin knows about one note: its kind, IDs, related notes, and sync and write-back state. */
export function inspectNote(ctx: PluginContext, file: TFile, content: string): InspectorSection[] {
  const { settings } = ctx;
  const frontmatter = frontmatterOf(ctx, file);
  const sections: InspectorSection[] = [];
  const tracking = text(frontmatter[settings.trackingProperty]);
  const isReadwise = isTrackedReadwiseNote(file, ctx.app, settings);
  const isBookNote = inBookNoteFolder(file.path, settings);
  const readerId = text(frontmatter.reader_id);
  const bookId = isReadwise ? bookIdKey(tracking) : isBookNote ? bookIdKey(frontmatter[settings.bookNoteIdProperty]) : null;
  const externalId = text(frontmatter[READWISE_EXTERNAL_ID_FIELD]);

  const kind = [isReadwise && 'Readwise note', isBookNote && 'Book note', readerId && 'Reader document'].filter(Boolean).join(', ');
  const identity: InspectorSection['rows'] = [['Kind', kind || 'Not managed by Readwise Sync']];
  if (bookId) identity.push(['Readwise book ID', bookId], ['Readwise URL', `${READWISE_REVIEW_URL_BASE}${bookId}`]);
  if (externalId) identity.push(['Reader document ID (from Readwise)', externalId]);
  if (readerId) {
    identity.push(['Reader document ID', readerId], ['Reader URL', text(frontmatter.reader_url)],
      ['Imported with tag', text(frontmatter.reader_sync_tag) || '(unknown)'],
      ['Reader updated', text(frontmatter.reader_updated_at)]);
    if (frontmatter.reader_tag_removed === true) identity.push(['Tag', 'Removed in Reader; this note is no longer synced']);
  }
  if (isBookNote && !bookId) identity.push(['Matching', `No ${settings.bookNoteIdProperty} yet; matched by title at sync time`]);
  sections.push({ heading: 'Identity', rows: identity });

  const related: TFile[] = [];
  for (const other of ctx.app.vault.getMarkdownFiles()) {
    if (other.path === file.path) continue;
    const data = frontmatterOf(ctx, other);
    const otherIsReadwise = isTrackedReadwiseNote(other, ctx.app, settings);
    const sameBook = bookId && ((otherIsReadwise && bookIdKey(data[settings.trackingProperty]) === bookId) ||
      (inBookNoteFolder(other.path, settings) && bookIdKey(data[settings.bookNoteIdProperty]) === bookId));
    const sameReader = (externalId && data.reader_id === externalId) || (readerId && data[READWISE_EXTERNAL_ID_FIELD] === readerId);
    if (sameBook || sameReader) related.push(other);
  }
  sections.push({ heading: 'Related notes', rows: related.length ? [] : [['', 'None found']], files: related });

  const notes = (() => {
    try {
      return readEditableNotes(content);
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  })();
  const writeback: InspectorSection['rows'] = [];
  if (typeof notes === 'string') writeback.push(['Problem', notes]);
  else {
    const unsent = notes.filter(hasUnsentEdit);
    writeback.push(['Writable sections', String(notes.length)], ['Unsent edits', unsent.length ? unsent.map((note) => note.target).join(', ') : 'None']);
  }
  sections.push({ heading: 'Note write-back', rows: writeback });

  const sync: InspectorSection['rows'] = [['Last Readwise sync', settings.lastUpdated ? humanReadableFormat(settings.lastUpdated) : 'Never']];
  if (readerId) sync.push(['Last incremental Reader sync', settings.readerLastSync ? humanReadableFormat(settings.readerLastSync) : 'Never']);
  if (bookId && settings.failedBookIds.includes(Number(bookId))) sync.push(['Status', 'Last write failed; run "Retry failed Readwise items"']);
  sections.push({ heading: 'Sync', rows: sync });
  return sections;
}

export class SyncInspectorModal extends Modal {
  constructor(app: App, private file: TFile, private sections: InspectorSection[]) {
    super(app);
  }

  onOpen(): void {
    this.titleEl.setText(`Sync info: ${this.file.basename}`);
    for (const section of this.sections) {
      this.contentEl.createEl('h4', { text: section.heading });
      const list = this.contentEl.createEl('ul');
      for (const [label, value] of section.rows) list.createEl('li', { text: label ? `${label}: ${value}` : value });
      for (const related of section.files ?? []) {
        const link = list.createEl('li').createEl('a', { text: related.path, href: '#' });
        link.addEventListener('click', (event) => {
          event.preventDefault();
          void this.app.workspace.openLinkText(related.path, this.file.path);
          this.close();
        });
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
