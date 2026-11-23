import { Setting } from 'obsidian';
import type { PluginContext } from 'types/plugin-context';
import type { BooksPropertyNamesSetting } from 'types/settings';

const SHELF_OPTIONS: Record<string, string> = {
  '': 'Not synced',
  want_to_read: 'Want to read',
  currently_reading: 'Currently reading',
  finished: 'Finished',
  did_not_finish: 'Did not finish',
};

const PROPERTY_LABELS: [keyof BooksPropertyNamesSetting, string][] = [
  ['status', 'Status'],
  ['rating', 'Rating'],
  ['start', 'Start date'],
  ['finished', 'Finish date'],
  ['format', 'Format'],
  ['pages', 'Pages'],
  ['id', 'Readwise Books id'],
  ['isbn', 'ISBN'],
];

export function renderBooksSettings(containerEl: HTMLElement, ctx: PluginContext, refresh: () => void): void {
  const settings = ctx.settings;
  const save = async () => ctx.saveAndApplySettings();

  new Setting(containerEl).setName('Readwise Books').setHeading();
  new Setting(containerEl)
    .setName('Sync book notes with Readwise Books')
    .setDesc('After each sync, your book notes and Readwise Books are compared. Obsidian is the source of truth: '
      + 'status, rating, dates and pages you change in a note are sent to Readwise Books. Readwise only fills '
      + 'empty properties, and sets the status to the finished status once when you finish a book. The note body '
      + 'is never touched.')
    .addToggle((t) => t.setValue(settings.booksEnabled).onChange(async (v) => {
      settings.booksEnabled = v;
      await save();
    }));
  new Setting(containerEl)
    .setName('Book notes folder')
    .setDesc('Book notes are looked for here, subfolders included.')
    .addText((t) => t.setValue(settings.booksNoteFolder).onChange(async (v) => {
      settings.booksNoteFolder = v.trim();
      await save();
    }));

  new Setting(containerEl).setName('Status mapping').setHeading()
    .setDesc('Each note status and the Readwise Books shelf it means. "Not synced" statuses are left alone.');
  for (const status of Object.keys(settings.booksStatusMap)) {
    new Setting(containerEl)
      .setName(status)
      .addDropdown((d) => d.addOptions(SHELF_OPTIONS).setValue(settings.booksStatusMap[status] ?? '')
        .onChange(async (v) => {
          settings.booksStatusMap[status] = v;
          await save();
        }))
      .addExtraButton((b) => b.setIcon('trash').setTooltip('Remove').onClick(async () => {
        delete settings.booksStatusMap[status];
        await save();
        refresh();
      }));
  }
  let newStatus = '';
  new Setting(containerEl)
    .setName('Add a status')
    .addText((t) => t.setPlaceholder('Status value').onChange((v) => { newStatus = v.trim(); }))
    .addButton((b) => b.setButtonText('Add').onClick(async () => {
      if (!newStatus || newStatus in settings.booksStatusMap) return;
      settings.booksStatusMap[newStatus] = '';
      await save();
      refresh();
    }));
  new Setting(containerEl)
    .setName('Status for finished books')
    .setDesc('Written once, when a book becomes Finished in Readwise Books (from KOReader or elsewhere).')
    .addText((t) => t.setValue(settings.booksFinishedStatus).onChange(async (v) => {
      settings.booksFinishedStatus = v.trim() || 'Done';
      await save();
    }));

  new Setting(containerEl).setName('Properties').setHeading();
  for (const [key, label] of PROPERTY_LABELS) {
    new Setting(containerEl).setName(label).addText((t) => t.setValue(settings.booksPropertyNames[key])
      .onChange(async (v) => {
        settings.booksPropertyNames[key] = v.trim() || settings.booksPropertyNames[key];
        await save();
      }));
  }
  new Setting(containerEl)
    .setName('Add formats from Readwise')
    .setDesc('Adds Digital, Audio or Physical to the format list when Readwise knows how you read the book. Never removes one.')
    .addToggle((t) => t.setValue(settings.booksFormats).onChange(async (v) => {
      settings.booksFormats = v;
      await save();
    }));
  new Setting(containerEl)
    .setName('Link to highlights note')
    .setDesc('Property on the book note that links to its Readwise highlights note. Empty to turn off.')
    .addText((t) => t.setValue(settings.booksHighlightsProperty).onChange(async (v) => {
      settings.booksHighlightsProperty = v.trim();
      await save();
    }));
  new Setting(containerEl)
    .setName('Link back to book note')
    .setDesc('Property on the highlights note that links to the book note. Empty to turn off.')
    .addText((t) => t.setValue(settings.booksBookProperty).onChange(async (v) => {
      settings.booksBookProperty = v.trim();
      await save();
    }));
  new Setting(containerEl)
    .setName('Add new book notes to Readwise Books')
    .setDesc('At sync, a book note with a synced status but no Readwise Books id is added to Readwise Books '
      + '(by ISBN, or title and author). Off: use the command "Add this book to Readwise Books".')
    .addToggle((t) => t.setValue(settings.booksAutoPushNew).onChange(async (v) => {
      settings.booksAutoPushNew = v;
      await save();
    }));

  new Setting(containerEl).setName('Book note suggestions').setHeading();
  new Setting(containerEl)
    .setName('Suggest notes for books without one')
    .setDesc('After a sync, books on the shelves below with no book note are offered for a new note.')
    .addToggle((t) => t.setValue(settings.booksSuggest).onChange(async (v) => {
      settings.booksSuggest = v;
      await save();
    }));
  for (const shelf of ['want_to_read', 'currently_reading', 'finished', 'did_not_finish']) {
    new Setting(containerEl)
      .setName(`Suggest for ${SHELF_OPTIONS[shelf]}`)
      .addToggle((t) => t.setValue(settings.booksSuggestShelves.includes(shelf)).onChange(async (v) => {
        settings.booksSuggestShelves = v
          ? [...new Set([...settings.booksSuggestShelves, shelf])]
          : settings.booksSuggestShelves.filter((s) => s !== shelf);
        await save();
      }));
  }
  new Setting(containerEl)
    .setName('Book Search query')
    .setDesc('What the Book Search modal is pre-filled with.')
    .addDropdown((d) => d.addOptions({ isbn: 'ISBN (title and author if none)', title: 'Title and author' })
      .setValue(settings.booksSuggestQuery).onChange(async (v) => {
        settings.booksSuggestQuery = v as 'isbn' | 'title';
        await save();
      }));
  new Setting(containerEl)
    .setName('Fallback template')
    .setDesc('Used when the Book Search plugin is not available. Notes go to the book notes folder.')
    .addText((t) => t.setValue(settings.booksFallbackTemplate).onChange(async (v) => {
      settings.booksFallbackTemplate = v.trim();
      await save();
    }));
  new Setting(containerEl)
    .setName(`Books never suggested (${settings.booksSuggestExcluded.length})`)
    .setDesc('Books you chose "Don\'t suggest again" for, or that existed when suggestions started.')
    .addButton((b) => b.setButtonText('Clear list').onClick(async () => {
      settings.booksSuggestExcluded = [];
      await save();
      refresh();
    }));
}

export function renderRulesSettings(containerEl: HTMLElement, ctx: PluginContext, refresh: () => void): void {
  const settings = ctx.settings;
  const save = async () => ctx.saveAndApplySettings();

  new Setting(containerEl).setName('Highlight rules').setHeading();
  new Setting(containerEl)
    .setName('Run highlight rules at sync')
    .setDesc('A highlight with a rule tag (for example reference/book) becomes a note. The tag can be a real '
      + 'Readwise tag, or typed in the highlight note as #reference/book or .reference/book. Each highlight is '
      + 'processed once.')
    .addToggle((t) => t.setValue(settings.rulesEnabled).onChange(async (v) => {
      settings.rulesEnabled = v;
      await save();
    }));
  new Setting(containerEl)
    .setName('Dry run (never delete)')
    .setDesc('While on, processed highlights are tagged but never deleted from Readwise. Use "Review highlights '
      + 'waiting to be deleted" to see what would go.')
    .addToggle((t) => t.setValue(settings.rulesDryRun).onChange(async (v) => {
      settings.rulesDryRun = v;
      await save();
    }));
  new Setting(containerEl)
    .setName('Days before deleting')
    .addText((t) => t.setValue(String(settings.rulesGraceDays)).onChange(async (v) => {
      const n = Number(v);
      if (Number.isFinite(n) && n >= 0) {
        settings.rulesGraceDays = n;
        await save();
      }
    }));
  new Setting(containerEl)
    .setName('Processed tag')
    .setDesc('Added in Readwise to a highlight once its note exists.')
    .addText((t) => t.setValue(settings.rulesProcessedTag).onChange(async (v) => {
      settings.rulesProcessedTag = v.trim();
      await save();
    }));

  settings.highlightRules.forEach((rule, index) => {
    new Setting(containerEl).setName(`Rule: ${rule.name}`).setHeading()
      .addToggle((t) => t.setValue(rule.enabled).onChange(async (v) => {
        rule.enabled = v;
        await save();
      }))
      .addExtraButton((b) => b.setIcon('trash').setTooltip('Remove rule').onClick(async () => {
        settings.highlightRules.splice(index, 1);
        await save();
        refresh();
      }));
    new Setting(containerEl).setName('Name').addText((t) => t.setValue(rule.name).onChange(async (v) => {
      rule.name = v.trim() || rule.name;
      await save();
    }));
    new Setting(containerEl)
      .setName('Tag prefix')
      .setDesc('The part after it is the kind: reference/book has the kind "book".')
      .addText((t) => t.setValue(rule.tagPrefix).onChange(async (v) => {
        rule.tagPrefix = v.trim();
        await save();
      }));
    new Setting(containerEl)
      .setName('Folder')
      .setDesc('For kinds without their own folder. Empty: vault root.')
      .addText((t) => t.setValue(rule.folder).onChange(async (v) => {
        rule.folder = v.trim();
        await save();
      }));
    new Setting(containerEl)
      .setName('Folders per kind')
      .setDesc('One per line: kind: folder. Example: book: Inbox/Books')
      .addTextArea((t) => {
        t.setValue(Object.entries(rule.kindFolders).map(([k, f]) => `${k}: ${f}`).join('\n')).onChange(async (v) => {
          const folders: Record<string, string> = {};
          for (const line of v.split('\n')) {
            const match = /^\s*([^:]+?)\s*:\s*(.*?)\s*$/.exec(line);
            if (match && match[1]) folders[match[1].toLowerCase()] = match[2];
          }
          rule.kindFolders = folders;
          await save();
        });
        t.inputEl.rows = 3;
      });
    new Setting(containerEl)
      .setName('File name')
      .setDesc('Variables: kind, text, title, author, date.')
      .addText((t) => t.setValue(rule.filenameTemplate).onChange(async (v) => {
        rule.filenameTemplate = v;
        await save();
      }));
    new Setting(containerEl)
      .setName('Note template')
      .setDesc('Variables: tag, kind, text, note, book_title, title, author, book_link, highlights_link, location, readwise_url, url, date.')
      .addTextArea((t) => {
        t.setValue(rule.noteTemplate).onChange(async (v) => {
          rule.noteTemplate = v;
          await save();
        });
        t.inputEl.rows = 8;
      });
    new Setting(containerEl)
      .setName('Delete the highlight after the grace period')
      .addToggle((t) => t.setValue(rule.deleteAfterGrace).onChange(async (v) => {
        rule.deleteAfterGrace = v;
        await save();
      }));
  });
  new Setting(containerEl).addButton((b) => b.setButtonText('Add rule').onClick(async () => {
    settings.highlightRules.push({
      ...settings.highlightRules[0] ?? {},
      name: `Rule ${settings.highlightRules.length + 1}`,
      tagPrefix: 'new/',
      enabled: false,
      folder: '',
      kindFolders: {},
      filenameTemplate: '{{ kind }} - {{ text | truncate(60, true, "") }}',
      noteTemplate: settings.highlightRules[0]?.noteTemplate ?? '> {{ text }}\n',
      deleteAfterGrace: false,
    });
    await save();
    refresh();
  }));

  new Setting(containerEl).setName('Chapters').setHeading();
  new Setting(containerEl)
    .setName('Copy chapter notes into book notes')
    .setDesc('A chapter heading highlight (.h1/.h2/.h3) with your own text after it is copied to the book note, '
      + 'between <!-- chapter-notes:start --> and <!-- chapter-notes:end -->. Runs with the rules.')
    .addToggle((t) => t.setValue(settings.chapterNotesEnabled).onChange(async (v) => {
      settings.chapterNotesEnabled = v;
      await save();
    }));
  new Setting(containerEl)
    .setName('Group highlights by chapter')
    .setDesc('Heading highlights (tagged h1, h2, h3) become headings in the highlights note instead of quotes. '
      + 'Notes are rewritten at their next sync.')
    .addToggle((t) => t.setValue(settings.groupByChapters).onChange(async (v) => {
      settings.groupByChapters = v;
      await save();
    }));
  new Setting(containerEl)
    .setName('Heading level of an h1 chapter')
    .setDesc('1 makes h1 chapters "#", h2 "##". Your highlight template uses "## rw<id>" per highlight, so 1 is '
      + 'the only level above it.')
    .addDropdown((d) => d.addOptions({ 1: '#', 2: '##', 3: '###' }).setValue(String(settings.chapterHeadingBase))
      .onChange(async (v) => {
        settings.chapterHeadingBase = Number(v);
        await save();
      }));
  new Setting(containerEl)
    .setName('Edit button next to highlights')
    .setDesc('Shows ✏️ after each Readwise link in reading view. The command "Edit Readwise highlight under cursor" works in editing view.')
    .addToggle((t) => t.setValue(settings.showEditButton).onChange(async (v) => {
      settings.showEditButton = v;
      await save();
    }));
}
