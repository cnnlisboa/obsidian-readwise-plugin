import { type App, Modal, Setting } from 'obsidian';
import type { BooksBook } from 'services/books-model';

const SHELF_LABEL: Record<string, string> = {
  want_to_read: 'Want to read',
  currently_reading: 'Currently reading',
  finished: 'Finished',
  did_not_finish: 'Did not finish',
};

export interface SuggestionActions {
  create(book: BooksBook): Promise<boolean>;
  dismiss(book: BooksBook): Promise<void>;
  excludeAll(books: BooksBook[]): Promise<void>;
}

/**
 * Readwise Books entries without a book note. Each row: Create note (opens
 * Book Search), Not now, Don't suggest again.
 */
export class BookSuggestionsModal extends Modal {
  constructor(app: App, private books: BooksBook[], private actions: SuggestionActions) {
    super(app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl } = this;
    contentEl.empty();
    this.titleEl.setText('Book notes to create');
    if (this.books.length === 0) {
      contentEl.createEl('p', { text: 'No suggestions. Every book on the chosen shelves has a note.' });
      return;
    }
    contentEl.createEl('p', {
      text: 'These Readwise Books entries have no book note yet. "Don\'t suggest again" hides a book for good '
        + '(you can undo it in settings).',
    });
    new Setting(contentEl).addButton((btn) => btn
      .setButtonText(`Don't suggest any of these (${this.books.length})`)
      .onClick(async () => {
        await this.actions.excludeAll(this.books);
        this.books = [];
        this.close();
      }));
    for (const book of [...this.books]) {
      new Setting(contentEl)
        .setName(book.title ?? 'Untitled')
        .setDesc(`${book.author ?? ''}${book.author ? ' · ' : ''}${SHELF_LABEL[book.status] ?? book.status}`)
        .addButton((btn) => btn.setButtonText('Create note').setCta().onClick(async () => {
          this.close();
          const created = await this.actions.create(book);
          if (created) this.books = this.books.filter((b) => b.id !== book.id);
        }))
        .addButton((btn) => btn.setButtonText('Not now').onClick(() => {
          this.books = this.books.filter((b) => b.id !== book.id);
          this.render();
        }))
        .addExtraButton((btn) => btn.setIcon('eye-off').setTooltip("Don't suggest again").onClick(async () => {
          await this.actions.dismiss(book);
          this.books = this.books.filter((b) => b.id !== book.id);
          this.render();
        }));
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
