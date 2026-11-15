import { type App, Modal } from 'obsidian';
import { activeIgnore, documentSignature, ignoredDocument } from 'services/selective-sync';
import type { Export, Library } from 'types/library';
import type { IgnoredDocument } from 'types/settings';

export interface SelectiveSyncResult {
  selectedIds: Set<number>;
  ignoredDocuments: Record<string, IgnoredDocument>;
}

export class SelectiveSyncModal extends Modal {
  private resolved = false;
  private expandedIgnored = false;
  private readonly selectedIds = new Set<number>();
  private readonly changedIds = new Set<number>();
  private readonly ignoredDocuments: Record<string, IgnoredDocument>;
  private readonly books: Export[];

  constructor(
    app: App,
    library: Library,
    ignored: Record<string, IgnoredDocument>,
    initiallyChecked: boolean,
    private readonly onSubmit: (result: SelectiveSyncResult | null) => void
  ) {
    super(app);
    this.books = Object.values(library.books).sort((a, b) => a.title.localeCompare(b.title));
    this.ignoredDocuments = { ...ignored };
    for (const book of this.books) {
      const saved = this.ignoredDocuments[String(book.user_book_id)];
      if (saved?.mode === 'untilChanged' && !activeIgnore(book, saved)) {
        this.changedIds.add(book.user_book_id);
        delete this.ignoredDocuments[String(book.user_book_id)];
      }
      if (initiallyChecked && !activeIgnore(book, this.ignoredDocuments[String(book.user_book_id)])) {
        this.selectedIds.add(book.user_book_id);
      }
    }
    this.titleEl.setText('Select Readwise documents');
    this.render();
  }

  private button(parent: HTMLElement, label: string, action: () => void, cta = false): HTMLButtonElement {
    const button = parent.createEl('button', { text: label, attr: { type: 'button' } });
    if (cta) button.addClass('mod-cta');
    button.addEventListener('click', action);
    return button;
  }

  private render() {
    const root = this.contentEl;
    root.empty();
    root.addClass('readwise-selective-sync');
    root.createEl('p', { text: `${this.books.length} documents in this sync batch. Select documents to sync now. Ignored documents remain available below.` });

    const toolbar = root.createDiv({ cls: 'readwise-selective-toolbar' });
    this.button(toolbar, 'Select all', () => {
      for (const book of this.books) if (!activeIgnore(book, this.ignoredDocuments[String(book.user_book_id)])) this.selectedIds.add(book.user_book_id);
      this.render();
    });
    this.button(toolbar, 'Select none', () => {
      this.selectedIds.clear();
      this.render();
    });

    const active = this.books.filter((book) => !activeIgnore(book, this.ignoredDocuments[String(book.user_book_id)]));
    const list = root.createDiv({ cls: 'readwise-selective-list' });
    for (const book of active) this.renderBook(list, book);
    if (!active.length) list.createEl('p', { text: 'No documents available to select.' });

    const ignoredEntries = Object.entries(this.ignoredDocuments);
    const ignoredSection = root.createEl('details', { cls: 'readwise-selective-ignored' });
    ignoredSection.open = this.expandedIgnored;
    ignoredSection.addEventListener('toggle', () => { this.expandedIgnored = ignoredSection.open; });
    ignoredSection.createEl('summary', { text: `Ignored (${ignoredEntries.length})` });
    const ignoredList = ignoredSection.createDiv({ cls: 'readwise-selective-list' });
    for (const [id, record] of ignoredEntries) {
      const book = this.books.find((candidate) => String(candidate.user_book_id) === id);
      const row = this.renderIdentity(ignoredList, record.title, record.author, record.category, record.cover, record.highlightCount);
      const status = book && documentSignature(book) !== record.signature ? 'Changed since ignored' : book ? 'Unchanged' : 'Not in this sync batch';
      row.createEl('span', { cls: 'readwise-selective-meta', text: `${record.mode === 'always' ? 'Always ignored' : 'Ignored until changed'} · ${status}` });
      this.button(row, 'Unignore', () => {
        delete this.ignoredDocuments[id];
        if (book) this.selectedIds.add(book.user_book_id);
        this.render();
      });
    }

    const actions = root.createDiv({ cls: 'readwise-selective-toolbar readwise-selective-actions' });
    this.button(actions, `Sync selected (${this.selectedIds.size})`, () => {
      this.resolved = true;
      this.close();
      this.onSubmit({ selectedIds: this.selectedIds, ignoredDocuments: this.ignoredDocuments });
    }, true);
    this.button(actions, 'Cancel', () => {
      this.resolved = true;
      this.close();
      this.onSubmit(null);
    });
  }

  private renderIdentity(parent: HTMLElement, title: string, author: string, category: string, cover: string, count: number): HTMLElement {
    const row = parent.createDiv({ cls: 'readwise-selective-document' });
    if (cover && /^https:\/\//i.test(cover)) row.createEl('img', { attr: { src: cover, alt: '' } });
    const info = row.createDiv({ cls: 'readwise-selective-info' });
    info.createEl('strong', { text: title || 'Untitled' });
    info.createEl('span', { cls: 'readwise-selective-meta', text: [author, category, `${count} highlights`].filter(Boolean).join(' · ') });
    return row;
  }

  private renderBook(parent: HTMLElement, book: Export) {
    const row = this.renderIdentity(parent, book.title, book.author, book.category, book.cover_image_url, book.highlights.length);
    if (this.changedIds.has(book.user_book_id)) row.createEl('span', { cls: 'readwise-selective-meta', text: 'Changed since ignored' });
    const controls = row.createDiv({ cls: 'readwise-selective-controls' });
    const checkbox = controls.createEl('input', { attr: { type: 'checkbox', 'aria-label': `Sync ${book.title}` } });
    checkbox.checked = this.selectedIds.has(book.user_book_id);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) this.selectedIds.add(book.user_book_id);
      else this.selectedIds.delete(book.user_book_id);
      this.render();
    });
    this.button(controls, 'Ignore until changed', () => this.ignore(book, 'untilChanged'));
    this.button(controls, 'Always ignore', () => this.ignore(book, 'always'));
  }

  private ignore(book: Export, mode: IgnoredDocument['mode']) {
    this.ignoredDocuments[String(book.user_book_id)] = ignoredDocument(book, mode);
    this.selectedIds.delete(book.user_book_id);
    this.expandedIgnored = true;
    this.render();
  }

  onClose() {
    if (!this.resolved) this.onSubmit(null);
  }
}
