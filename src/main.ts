// Plugin classes
import { Lock } from 'async-await-mutex-lock';
import { type App, type CachedMetadata, normalizePath, Plugin, type PluginManifest, TFile } from 'obsidian';
import { Atomizer } from 'services/atomizer';
import { CommandManager } from 'services/command-manager';
import { Controller } from 'services/controller';
import { DeduplicatingVaultWriter } from 'services/deduplicating-vault-writer';
import { Frontmatter } from 'services/frontmatter';
import { FrontmatterManager } from 'services/frontmatter-manager';
import Logger from 'services/logger';
import { buildReadwiseDocument } from 'services/readwise-document-mapper';
import { ReadwiseEnvironment, ReadwiseLoader } from 'services/readwise-environment';
import { BookNoteIndex, planBookNotes, syncBookNotes, type BookLinkResolver } from 'services/book-notes';
import { diffLines } from 'services/line-diff';
import { createSyncReport, type SyncEvent, type SyncReport } from 'services/sync-report';
import { activeIgnore, selectLibrary } from 'services/selective-sync';
import { renderSyncLog, resolveSyncLogPath } from 'services/sync-log';
import { syncReaderDocuments } from 'services/reader-sync';
import { mergeEditableNotes } from 'services/writeback-sections';
import { filesWithEditedNotes, rebaseEditedNotes, sendEditedNotes } from 'services/writeback';
import { filterHighlights, renderMarkdownTemplate } from 'services/template-rendering';
import spacetime from 'spacetime';
import { AUTHOR_SEPARATORS, DEFAULT_SETTINGS } from 'src/constants';
import type { BaseFile, ReadwiseDocument } from 'types/document';
import type { Export, Library } from 'types/library';
import type { PluginContext } from 'types/plugin-context';
import type { PluginSettings } from 'types/settings';
import Notify from 'ui/notify';
import { ConfirmDialog } from 'ui/dialog';
import { BooksApi } from 'services/books-api';
import { addNotesToBooks, findSuggestions, syncReadwiseBookNotes } from 'services/book-note-sync';
import { createBookNote } from 'services/book-note-creator';
import type { BooksBook } from 'services/books-model';
import { authorFromSource, identityFromFilename, migrateConsumed, readList, readNote } from 'services/books-model';
import { BookSuggestionsModal } from 'ui/book-suggestions-modal';
import { HighlightRulesEngine, type RulesReport } from 'services/highlight-rules';
import { matchNotes } from 'services/books-model';
import { Notice } from 'obsidian';
import { SelectiveSyncModal } from 'ui/selective-sync-modal';
import ReadwiseMirrorSettingTab from 'ui/settings-tab';
import { normalizeFilename } from 'utils/file-utils';
import { humanReadableFormat } from 'utils/format-utils';
import { createdDate, updatedDate } from 'utils/highlight-date-utils';

export default class ReadwiseMirror extends Plugin {
  private _notify?: Notify;
  private _frontmatterManager?: FrontmatterManager;
  private _deduplicatingVaultWriter?: DeduplicatingVaultWriter;
  private settings: PluginSettings = { ...DEFAULT_SETTINGS };
  private loader: ReadwiseLoader;
  private env: ReadwiseEnvironment;
  private logger: Logger;
  private lock: Lock<string>;
  private syncTimer?: number;

  constructor(app: App, manifest: PluginManifest) {
    super(app, manifest);

    // Set new custom Environment using our custom loader
    this.loader = new ReadwiseLoader();
    this.env = new ReadwiseEnvironment(this.loader, { autoescape: false });
    this.logger = new Logger(false);
    this.lock = new Lock<string>();
  }

  private get notify(): Notify {
    if (!this._notify) {
      throw new Error('ReadwiseMirror is not initialized yet: notify is unavailable.');
    }

    return this._notify;
  }

  private get frontmatterManager(): FrontmatterManager {
    if (!this._frontmatterManager) {
      throw new Error('ReadwiseMirror is not initialized yet: frontmatterManager is unavailable.');
    }

    return this._frontmatterManager;
  }

  private get deduplicatingVaultWriter(): DeduplicatingVaultWriter {
    if (!this._deduplicatingVaultWriter) {
      throw new Error('ReadwiseMirror is not initialized yet: deduplicatingVaultWriter is unavailable.');
    }

    return this._deduplicatingVaultWriter;
  }

  private get ctx(): PluginContext {
    // Create plugin context for dependency injection
    const ctx: PluginContext = {
      settings: this.settings,
      app: this.app,
      logger: this.logger,
      syncLock: this.lock,
      statusBarItem: this.notify.statusBarItem,
      // exposed methods
      notice: (message: string, duration?: number) => this.notify.notice(message, duration),
      setStatusBarText: (message: string) => this.notify.setStatusBarText(message),
      saveAndApplySettings: () => this.saveAndApplySettings(),
    };
    return ctx;
  }

  public async onload() {
    // Move UI setup to onLayoutReady
    this.app.workspace.onLayoutReady(() => {
      void (async () => {
        await this.lock.acquire('readwise-sync:loaded');
        const statusBarItem = this.addStatusBarItem();
        this._notify = new Notify(statusBarItem);
        await this.initializeUI();
      })();
    });
  }

  public onunload(): void {
    if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
    this.logger.debug('Readwise Sync unloaded.');
    this.lock.release('readwise-sync:loaded');
    super.onunload();
  }

  private async initializeUI() {
    try {
      await this.loadAndApplySettings();
      this.addSettingTab(new ReadwiseMirrorSettingTab(this, this.ctx, this.env));
      this.logger.debug('Readwise Sync loaded.');

      // Instantiate controller and attach to context
      this._frontmatterManager = new FrontmatterManager(this.ctx, this.env, this.app.fileManager);
      this._deduplicatingVaultWriter = new DeduplicatingVaultWriter(this.ctx, this.frontmatterManager);

      if (!this.settings.apiToken) {
        this.notify.notice('Readwise: API Token not detected\nPlease enter in configuration page');
        this.notify.setStatusBarText('Readwise: API Token Required');
      } else {
        //Update status bar with last sync time
        if (this.settings.lastUpdated)
          this.notify.setStatusBarText(`Readwise: Updated ${humanReadableFormat(this.settings.lastUpdated)}`);
        else this.notify.setStatusBarText('Readwise: Click to Sync');
      }

      // Register all commands and run startup commands
      let controllerInstance: Controller;
      try {
        controllerInstance = await Controller.initialize(this, this.ctx);
        new CommandManager(this, this.ctx, controllerInstance).initialize();
      } catch (error) {
        this.logger.error('Error initializing Readwise controller:', error);
        // Show concise user-facing notice but do not rethrow — allow plugin to continue
        this.notify.notice('Readwise: Controller initialization failed. Check console for details.');
      }

    } catch (error) {
      this.logger.error('Error during plugin initialization:', error);
    }
  }

  // Reload settings after external change (e.g. after sync)
  async onExternalSettingsChange() {
    this.logger.debug('External settings change detected, reloading settings...');
    await this.loadAndApplySettings();
  }

  /**
   * Loads settings from disk and applies them to the plugin instance.
   * In particular, this updates the header and highlight templates.
   */
  async loadAndApplySettings() {
    const loaded = (await this.loadData()) as Partial<PluginSettings> | null;

    // Mutate the existing object instead of creating a new reference
    // Order matters: defaults first, then loaded values override them
    // Deep copies of the defaults, so editing nested settings (rules, status
    // map, property names) never changes the shared default objects.
    Object.assign(this.settings, structuredClone(DEFAULT_SETTINGS), loaded ?? {});
    this.settings.booksPropertyNames = { ...DEFAULT_SETTINGS.booksPropertyNames, ...(loaded?.booksPropertyNames ?? {}) };

    if (this.lock.isAcquired('readwise-sync:loaded')) {
      await this.applySettings();
    }
  }

  /**
   * Saves the current settings to disk and applies them to the plugin instance.
   * In particular, this updates the header and highlight templates.
   */
  private async saveAndApplySettings() {
    await this.saveData(this.settings);
    await this.applySettings();
  }

  /**
   * Applies the logger mode, and header and highlight templates from the current settings to the plugin instance.
   */
  private async applySettings() {
    this.notify.setStatusBarMode(this.settings.statusBarMode);
    // Set logger debug mode
    this.logger.setDebugMode(this.settings.debugMode);
    try {
      // Update and try to compile
      this.loader.setSource('header', this.settings.headerTemplate);
      this.env.getTemplate('header', true);
    } catch (error) {
      this.logger.error('Error setting header template:', error);
      this.notify.notice('Readwise: Error setting header template. Check console for details.');
    }
    try {
      // Update and try to compile
      this.loader.setSource('highlight', this.settings.highlightTemplate);
      this.env.getTemplate('highlight', true);
    } catch (error) {
      this.logger.error('Error setting highlight template:', error);
      this.notify.notice('Readwise: Error setting highlight template. Check console for details.');
    }

    // Re-initialize the ReadwiseController instance
    try {
      const controller = await Controller.initialize(this, this.ctx);
      if (this.syncTimer !== undefined) window.clearInterval(this.syncTimer);
      this.syncTimer = undefined;
      const minutes = Number(this.settings.syncIntervalMinutes);
      if (Number.isFinite(minutes) && minutes >= 1 && minutes <= 1440) {
        this.syncTimer = window.setInterval(() => { void controller.sync(); }, minutes * 60_000);
      }
    } catch (error) {
      this.logger.error('Error initializing Readwise controller during settings apply:', error);
      this.notify.notice('Readwise: Controller initialization failed. Check console for details.');
    }
  }

  /**
   * Checks whether a specific file should be atomized,
   * based on the various settings that govern this step
   *
   * @param contents
   * @returns boolean
   */
  private shouldAtomize(frontmatter: Frontmatter): boolean {
    // Early return if atomic highlights or tracking is disabled
    if (!this.settings.atomicHighlights || !this.settings.trackFiles) {
      return false;
    }

    // If conditional atomization is disabled, always atomize
    if (!this.settings.atomicConditionalAtomize) {
      return true;
    }

    try {
      return Boolean(frontmatter?.get('rw-atomize'));
    } catch (error) {
      this.logger.warn('Error parsing frontmatter for atomization check:', error);
      return false;
    }
  }

  /**
   * Parses a string of authors into an array of individual authors
   * @param authorString The input string containing one or more authors
   * @returns Array of individual author names
   */
  private parseAuthor(authorString?: string): string[] {
    if (!authorString?.trim()) {
      return [];
    }

    return authorString
      .split(AUTHOR_SEPARATORS)
      .map((author) => author.trim())
      .filter((author) => {
        if (!author) {
          return false;
        }
        return true;
      });
  }

  public async writeLogToMarkdown(library: Library, report: SyncReport = createSyncReport([]), source = 'Readwise') {
    const vault = this.app.vault;
    const path = resolveSyncLogPath(this.settings);
    const abstractFile = vault.getAbstractFileByPath(path);

    const now = spacetime.now();
    const items = Object.values(library.books).map((book) => ({
      id: book.user_book_id,
      title: this.getFileNameFromDoc(book),
      highlights: book.highlights.length,
      category: book.category,
    }));
    const logString = renderSyncLog(this.env, this.settings, report, items, now.format('iso-short'), now.time(), source);

    try {
      const parentPath = path.slice(0, path.lastIndexOf('/'));
      if (parentPath) await this.deduplicatingVaultWriter.ensureFolder(parentPath);
      if (abstractFile) {
        // If log file already exists, append to the content instead of overwriting
        const logFile = vault.getFileByPath(path);
        if (!logFile) throw new Error(`Sync log is not a file: ${path}`);
        this.logger.debug('logFile:', logFile);

        await vault.process(logFile, (content) => `${content}\n\n${logString}`);
      } else {
        await vault.create(path, logString);
      }
    } catch (err) {
      this.logger.error('Error writing to sync log file', err);
      throw err;
    }
  }

  public async confirmSyncPreview(library: Library): Promise<boolean> {
    if (!this.settings.previewSync || Object.keys(library.books).length === 0) return true;
    // A dry run renders every note without renaming or writing, so the preview can show real text changes.
    const files = await this.processReadwiseLibrary(library, true);
    const changes: { title: string; diff: string }[] = [];
    const actions: string[] = [];
    const planned = new Map<number, string>();
    for (const file of files) {
      const target = normalizePath(`${this.deduplicatingVaultWriter.getCategoryPath(file.doc.category)}/${file.basename}.md`);
      if (file.primary instanceof TFile) {
        planned.set(file.doc.id, file.primary.path);
        const { before, after, properties } = await this.deduplicatingVaultWriter.previewUpdate(file);
        const diff = diffLines(before, after);
        if (!diff && !properties.length) continue;
        actions.push(`Update ${file.primary.path}`);
        changes.push({ title: file.primary.path, diff: `${properties.length ? `Properties: ${properties.join(', ')}\n` : ''}${diff}` });
        if (this.settings.enableFileNameUpdates && file.primary.path !== target) actions.push(`Rename ${file.primary.path} toward ${target}`);
      } else {
        planned.set(file.doc.id, file.primary);
        actions.push(`${this.app.vault.getFileByPath(file.primary) ? 'Update or create collision for' : 'Create'} ${file.primary}`);
      }
      for (const duplicate of file.duplicates) actions.push(`${this.settings.deleteDuplicates ? 'Trash' : 'Mark'} duplicate ${duplicate.path}`);
    }
    if (this.settings.bookNotesEnabled) {
      for (const plan of await planBookNotes(this.ctx, this.env, library, this.bookLinks(planned))) {
        if (plan.skipped) {
          actions.push(`Skip "${plan.book.title}": ${plan.skipped}`);
          continue;
        }
        const diff = diffLines(plan.before, plan.after);
        if (!diff && !plan.stampId) continue;
        actions.push(`${plan.create ? 'Create' : 'Update'} book note ${plan.path}`);
        changes.push({ title: `Book note: ${plan.path}`,
          diff: `${plan.stampId ? `Properties: ${this.settings.bookNoteIdProperty}\n` : ''}${diff}` });
      }
    }
    if (!actions.length) return true;
    const prompt = createFragment((fragment) => {
      fragment.createEl('p', { text: `${actions.length} planned actions. Review before writing to the vault.` });
      if (this.settings.atomicHighlights) fragment.createEl('p', { text: 'Atomic highlight files may also be created or updated.' });
      if (this.settings.logFile) fragment.createEl('p', { text: `A sync entry will be appended to ${resolveSyncLogPath(this.settings)}.` });
      const list = fragment.createEl('ul');
      for (const action of actions.slice(0, 60)) list.createEl('li', { text: action });
      if (actions.length > 60) fragment.createEl('p', { text: `${actions.length - 60} more actions are not shown.` });
      if (changes.length) fragment.createEl('h4', { text: 'Text changes' });
      const diffs = fragment.createDiv({ cls: 'readwise-writeback-preview' });
      for (const change of changes.slice(0, 40)) {
        const details = diffs.createEl('details');
        details.createEl('summary', { text: change.title });
        details.createEl('pre', { text: change.diff || '(no body change)' });
      }
      if (changes.length > 40) fragment.createEl('p', { text: `${changes.length - 40} more changed notes are not shown.` });
    });
    return new Promise((resolve) => new ConfirmDialog(this.app, 'Preview Readwise sync', prompt, resolve).open());
  }

  /** Applies saved exclusions, or lets the user choose the documents in this batch. */
  public async chooseSyncDocuments(library: Library, showModal: boolean): Promise<Library | null> {
    const ignored = this.settings.ignoredDocuments ?? {};
    if (showModal) {
      const result = await new Promise<import('ui/selective-sync-modal').SelectiveSyncResult | null>((resolve) =>
        new SelectiveSyncModal(this.app, library, ignored, this.settings.selectiveSyncInitiallyChecked, resolve).open());
      if (!result) return null;
      this.settings.ignoredDocuments = result.ignoredDocuments;
      await this.saveData(this.settings);
      return selectLibrary(library, result.selectedIds);
    }
    const selected = new Set<number>();
    for (const book of Object.values(library.books)) {
      const key = String(book.user_book_id);
      if (ignored[key]?.mode === 'untilChanged' && !activeIgnore(book, ignored[key])) delete ignored[key];
      if (!activeIgnore(book, ignored[key])) selected.add(book.user_book_id);
    }
    return selectLibrary(library, selected);
  }

  public async syncReaderDocuments(full = false): Promise<SyncReport> {
    if (this.lock.isAcquired('reader-sync')) throw new Error('Reader sync is already running.');
    await this.lock.acquire('reader-sync');
    try {
      const report = await syncReaderDocuments(this.ctx, this.env, full, async (actions) => {
        const prompt = createFragment((fragment) => {
          fragment.createEl('p', { text: `${actions.length} tagged Reader documents will be checked. Content and assets may be downloaded.` });
          const list = fragment.createEl('ul');
          for (const action of actions.slice(0, 60)) list.createEl('li', { text: action });
          if (actions.length > 60) fragment.createEl('p', { text: `${actions.length - 60} more documents are not shown.` });
        });
        return new Promise((resolve) => new ConfirmDialog(this.app, 'Preview Reader sync', prompt, resolve).open());
      });
      if (this.settings.logFile && report.events.length > 0) {
        await this.writeLogToMarkdown({ books: {}, categories: new Set(), highlightCount: 0 }, report, 'Reader');
      }
      return report;
    } finally {
      this.lock.release('reader-sync');
    }
  }

  /** Sends unsent note edits from the given files, or from the whole vault when files is omitted. */
  public async sendEditedNotes(files?: TFile[]): Promise<number> {
    if (this.lock.isAcquired('writeback')) throw new Error('A note send is already running.');
    await this.lock.acquire('writeback');
    try {
      const targets = files ?? await filesWithEditedNotes(this.ctx);
      return await sendEditedNotes(this.ctx, targets, async (items) => {
        const prompt = createFragment((fragment) => {
          fragment.createEl('p', { text: `${items.length} edited notes will be sent to Readwise. Review each change.` });
          const list = fragment.createEl('div', { cls: 'readwise-writeback-preview' });
          for (const item of items) list.createEl('pre', { text: item });
        });
        return new Promise((resolve) => new ConfirmDialog(this.app, 'Send edited notes', prompt, resolve).open());
      });
    } finally {
      this.lock.release('writeback');
    }
  }

  public async rebaseEditedNotes(file: TFile): Promise<number> {
    if (this.lock.isAcquired('writeback')) throw new Error('A note send is already running.');
    await this.lock.acquire('writeback');
    try {
      return await rebaseEditedNotes(this.ctx, file, async (items) => {
        const prompt = createFragment((fragment) => {
          fragment.createEl('p', { text: 'Use the current remote notes as baselines while keeping your local edits? This does not send any notes.' });
          const list = fragment.createEl('div', { cls: 'readwise-writeback-preview' });
          for (const item of items) list.createEl('pre', { text: item });
        });
        return new Promise((resolve) => new ConfirmDialog(this.app, 'Review note conflicts', prompt, resolve).open());
      });
    } finally {
      this.lock.release('writeback');
    }
  }

  /** Writes the managed Readwise section into personal book notes. Run after the Readwise notes exist. */
  /** Link text for book sections. planned maps book IDs to Readwise note paths that do not exist yet (previews). */
  private bookLinks(planned = new Map<number, string>()): BookLinkResolver {
    const writer = this.deduplicatingVaultWriter;
    writer.buildTrackedFileIndex();
    const linktext = (file: TFile, sourcePath: string) => this.app.metadataCache.fileToLinktext(file, sourcePath, true);
    return {
      mirror: (book, sourcePath) => {
        const file = writer.getTrackedFiles(book.readwise_url)[0]
          ?? this.app.vault.getFileByPath(normalizePath(`${writer.getCategoryPath(book.category)}/${this.getFileNameFromDoc(book)}.md`));
        if (file) return linktext(file, sourcePath);
        return planned.get(book.user_book_id)?.replace(/\.md$/, '') ?? null;
      },
      atom: (highlight, sourcePath) => {
        const file = this.settings.atomicHighlights ? writer.getTrackedFiles(highlight.readwise_url)[0] : undefined;
        return file ? linktext(file, sourcePath) : null;
      },
    };
  }

  /** Writes the managed Readwise section into personal book notes. Run after the Readwise notes exist. */
  public async writeBookNotes(library: Library): Promise<SyncEvent[]> {
    if (!this.settings.bookNotesEnabled) return [];
    return syncBookNotes(this.ctx, this.env, library, new BookNoteIndex(this.ctx), this.bookLinks());
  }

  // Write a library of Readwise books to markdown files
  /** Refuses to sync while the original Readwise Mirror plugin is enabled and writes to the same folder. */
  private async assertNoMirrorConflict(): Promise<void> {
    const plugins = (this.app as unknown as { plugins?: { enabledPlugins?: Set<string> } }).plugins;
    if (!plugins?.enabledPlugins?.has('readwise-mirror')) return;
    const path = normalizePath(`${this.app.vault.configDir}/plugins/readwise-mirror/data.json`);
    if (!(await this.app.vault.adapter.exists(path))) return;
    const data = JSON.parse(await this.app.vault.adapter.read(path)) as { baseFolderName?: unknown };
    if (typeof data.baseFolderName === 'string' && normalizePath(data.baseFolderName) === normalizePath(this.settings.baseFolderName)) {
      throw new Error('Readwise Mirror is enabled and writes to the same library folder. Disable it before syncing.');
    }
  }

  /** Remembers which books failed, so "Retry failed Readwise items" can fetch just those. */
  private async recordFailures(library: Library, events: SyncEvent[]): Promise<void> {
    const attempted = new Set(Object.values(library.books).map((book) => book.user_book_id));
    const failed = events.filter((event) => event.action === 'failed' && event.bookId !== undefined).map((event) => event.bookId);
    const next = [...new Set([...this.settings.failedBookIds.filter((id) => !attempted.has(id)), ...failed])];
    if (next.join() === this.settings.failedBookIds.join()) return;
    this.settings.failedBookIds = next;
    await this.saveData(this.settings);
  }

  // Write a library of Readwise books to markdown files
  public async writeLibraryToMarkdown(library: Library): Promise<SyncReport> {
    await this.assertNoMirrorConflict();
    this.logger.group('Write Library to Markdown');
    try {
      await this.deduplicatingVaultWriter.createCategoryFolders(library.categories);
    } catch (err) {
      this.logger.error('Failed to create category folders', err);
      this.notify.notice('Readwise: Failed to create category folders. Sync aborted.');
      this.logger.groupEnd();
      throw err;
    }

    // Prepare all files first
    const readwiseFiles: BaseFile[] = await this.processReadwiseLibrary(library);

    if (readwiseFiles.length === 0) {
      this.logger.debug('No eligible Readwise files to process (all highlights filtered out). Skipping write.');
      this.logger.groupEnd();
      await this.recordFailures(library, []);
      return createSyncReport([]);
    }

    // Process all files in batch
    let bookEvents: SyncEvent[] = [];
    try {
      this.logger.time('process');
      const report = await this.deduplicatingVaultWriter.process(readwiseFiles);
      this.logger.timeEnd('process');
      bookEvents = await this.writeBookNotes(library);
      const failed = bookEvents.find((event) => event.action === 'failed');
      // A failed book note must keep the checkpoint where it is, so the book is fetched again next sync.
      if (failed) throw new Error(`Book note failed at ${failed.path}: ${failed.detail ?? 'unknown error'}`);
      await this.recordFailures(library, []);
      return createSyncReport([...report.events, ...bookEvents]);
    } catch (err) {
      this.logger.error('Failed to process files batch', err);
      const events = [...this.deduplicatingVaultWriter.getLastSyncReport().events, ...bookEvents];
      await this.recordFailures(library, events);
      const failed = events.find((event) => event.action === 'failed');
      this.notify.notice(`Readwise: Sync write failed${failed ? ` at ${failed.path}` : ''}. Run "Retry failed Readwise items" to try again.`);
      throw err;
    } finally {
      this.logger.groupEnd();
    }
  }

  public async processFrontmatterUpdatesInLibrary(library: Library): Promise<void> {
    const readwiseFiles: BaseFile[] = await this.processReadwiseLibrary(library);
    await this.deduplicatingVaultWriter.processFrontmatter(readwiseFiles);
  }

  /**
   * Processes a given Readwise library object and generates an array of `ReadwiseFile` objects,
   * each representing a book with its associated highlights and metadata.
   *
   * @param library - The Readwise library object containing books and their highlights.
   * @returns An array of `ReadwiseFile` objects, each containing the filename, document metadata, and file contents.
   */
  private async processReadwiseLibrary(library: Library, dryRun = false): Promise<BaseFile[]> {
    if (this.settings.writebackHighlightNotes && !this.settings.trackFiles) {
      throw new Error('Highlight note write-back requires file tracking.');
    }
    const readwiseFiles: BaseFile[] = [];
    this.deduplicatingVaultWriter.buildTrackedFileIndex();
    const bookNotes = this.settings.bookNotesEnabled && this.settings.bookNoteDocumentNoteOnly ? new BookNoteIndex(this.ctx) : null;

    // Get total number of records
    const booksTotal = Object.keys(library.books).length;
    let bookCurrent = 1;

    for (const bookId in library.books) {
      this.notify.setStatusBarText(
        `Readwise: Processing - ${Math.floor((bookCurrent / booksTotal) * 100)}% finished (${bookCurrent}/${booksTotal})`
      );
      bookCurrent += 1;
      const book: Export = library.books[bookId];

      const { title, category, highlights, source_url, unique_url } = book;

      // Sanitize title, replace colon with substitute from settings
      const basename = this.getFileNameFromDoc(book);

      // Filter highlights
      const filteredHighlights = filterHighlights(highlights, this.settings);

      if (filteredHighlights.length === 0) {
        this.logger.debug(`No highlights found for '${title}' (${source_url})`);
      }

      const doc: ReadwiseDocument = buildReadwiseDocument(book, {
        basename,
        settings: this.settings,
      });
      // The book note shows this document note instead
      if (bookNotes?.receives(book)) doc.document_note = '';

      // Get the primary path for new file before checking for duplicates
      const readwisePrimary = normalizePath(
        `${this.deduplicatingVaultWriter.getCategoryPath(category)}/${basename}.md`
      );

      // Prepare the readwise file object
      const readwiseFile: BaseFile = {
        type: 'base',
        primary: readwisePrimary,
        basename,
        doc,
        contents: '', // Always overwritten in the atomize branches below before being pushed
        duplicates: [], // Populated if existing files are found
        atoms: [], // Populated only when atomizing
      };
      // note_link is just the basename in this case
      doc.linktext = basename;

      // Early deduplication check to find primary and duplicate files
      if (this.settings.trackFiles && this.settings.trackingProperty) {
        const existingFiles = await this.deduplicatingVaultWriter.findExistingByHighlightsUrl(doc);
        if (existingFiles.length > 0) {
          const [primary, ...duplicates] = existingFiles;
          this.logger.debug(
            `Found ${existingFiles.length} existing file(s) for '${title}' (${source_url}), using primary: ${primary.path}`
          );

          if (this.settings.enableFileNameUpdates && !dryRun) {
            const hash = this.deduplicatingVaultWriter.generateShortHash(book.user_book_id);

            try {
              for (let i = 0; i < duplicates.length; i++) {
                const duplicate = duplicates[i];
                const duplicateParent = duplicate.parent;
                if (!duplicateParent) {
                  throw new Error(`Cannot rename duplicate file ${duplicate.path}: parent folder is null.`);
                }
                const duplicateParentPath = duplicateParent.path;
                let newPath = normalizePath(`${duplicateParentPath}/${basename} ${i + 1}.md`);
                // Avoid overwriting existing files
                let suffix = i + 1;
                while ((await this.app.vault.adapter.exists(newPath, false)) && newPath !== duplicate.path) {
                  suffix++;
                  newPath = normalizePath(`${duplicateParentPath}/${basename} ${suffix}.md`);
                }
                if (newPath !== duplicate.path) {
                  await this.app.fileManager.renameFile(duplicate, newPath);
                }
              }

              const newFileExists = await this.app.vault.adapter.exists(readwisePrimary, false);
              const primaryParent = primary.parent;
              if (!primaryParent) {
                throw new Error(`Cannot rename primary file ${primary.path}: parent folder is null.`);
              }
              const primaryParentPath = primaryParent.path;
              // Add hash to filename if there's a collision (and the primary is not in the duplicates)
              const newPath =
                newFileExists && readwisePrimary !== primary.path
                  ? normalizePath(`${primaryParentPath}/${basename} ${hash}.md`)
                  : normalizePath(`${primaryParentPath}/${basename}.md`);
              this.logger.debug(`Rename file from ${primary.path} to ${newPath}`);
              await this.app.fileManager.renameFile(primary, newPath);
            } catch (error) {
              this.logger.error(`Error renaming file ${primary.path}`, error);
              throw error;
            }
          }

          readwiseFile.primary = primary;
          readwiseFile.duplicates = duplicates;
          doc.linktext = this.app.metadataCache.fileToLinktext(readwiseFile.primary, readwiseFile.primary.path, true);
        }
      }
      // Assign frontmatter

      const hasExistingFrontmatter = readwiseFile.primary instanceof TFile;
      let frontmatter = this.frontmatterManager.getFrontmatter(readwiseFile, hasExistingFrontmatter);
      if (hasExistingFrontmatter) {
        const primaryFile = readwiseFile.primary;
        if (primaryFile instanceof TFile) {
          const fileMetadata: CachedMetadata | null = this.app.metadataCache.getFileCache(primaryFile);
          if (fileMetadata?.frontmatter) {
            const existingFrontmatter = new Frontmatter(fileMetadata.frontmatter);
            frontmatter = existingFrontmatter.merge(frontmatter);
          }
        }
      }

      // Determine if we should atomize this file
      const shouldAtomize = this.shouldAtomize(frontmatter);
      // Render header, and highlights by rendering the core template
      const _contents = renderMarkdownTemplate(this.env, this.loader, {
        doc,
        book,
        highlights: filteredHighlights,
        headerTemplate: 'header',
        highlightTemplate: 'highlight',
        settings: this.settings,
      });

      // Assign frontmatter to readwiseFile
      readwiseFile.frontmatter = frontmatter?.toString();

      // Atomize only when enabled and when trackFiles is enabled as well
      const atomizer = new Atomizer();
      if (shouldAtomize) {
        try {
          const { contents, atoms } = atomizer.atomize(_contents, { basename, doc, book });
          this.logger.debug(`Atomized ${atoms?.length} highlights for '${title}' (${source_url})`);
          readwiseFile.contents = contents;
          readwiseFile.atoms = atoms;
        } catch (err) {
          this.logger.error(`Failed to atomize '${title}' (${unique_url}): `, err);
          readwiseFile.contents = _contents; // fall back to raw contents
        }
      } else {
        try {
          atomizer.setCompositeEnvironment();
          const { contents } = atomizer.atomize(_contents, { basename, doc, book });
          readwiseFile.contents = contents;
        } catch (err) {
          this.logger.error(`Failed to process composite '${title}' (${unique_url}): `, err);
          readwiseFile.contents = _contents; // fall back to raw contents
        }
      }
      const oldContents = readwiseFile.primary instanceof TFile ? await this.app.vault.cachedRead(readwiseFile.primary) : null;
      readwiseFile.contents = mergeEditableNotes(oldContents, readwiseFile.contents,
        this.settings.writebackHighlightNotes
          ? filteredHighlights.filter((highlight) => !highlight.is_deleted).map((highlight) => ({
            target: `highlight-${highlight.id}` as const, text: highlight.note ?? '',
          }))
          : []);
      readwiseFiles.push(readwiseFile);
    }
    return readwiseFiles;
  }

  /**
   * Get the filename from the Readwise document
   * @param book
   * @returns filename
   */
  private getFileNameFromDoc(book: Export) {
    let filename: string;
    if (this.settings.useCustomFilename) {
      const template = this.settings.filenameTemplate;
      const context = {
        title: book.title,
        author: this.parseAuthor(book.author).join(', '),
        category: book.category,
        source: book.source_url,
        book_id: book.user_book_id,
        created: createdDate(book.highlights),
        updated: updatedDate(book.highlights),
      };
      this.loader.setSource('filename', template);
      filename = this.env.render('filename', context);
    } else {
      filename = book.title;
    }

    return normalizeFilename(filename, this.settings);
  }

  private async deleteLibraryFolder() {
    const vault = this.app.vault;
    const path = `${this.settings.baseFolderName}`;

    const abstractFile = vault.getAbstractFileByPath(path);

    // Delete old instance of file
    if (abstractFile) {
      try {
        this.logger.debug('Attempting to delete entire library at:', abstractFile);
        await this.app.fileManager.trashFile(abstractFile);
        return true;
      } catch (err) {
        this.logger.error(`Attempted to delete file ${path} but no file was found`, err);
        return false;
      }
    }
  }

  // ---------------------------------------------------------- Highlight rules

  private rulesEngine(): HighlightRulesEngine {
    return new HighlightRulesEngine(this.ctx, this.env, {
      highlightsNote: (book) => this.findHighlightsNote(book)?.basename ?? null,
      bookNote: (book) => this.findBookNote(book),
    });
  }

  /** The Readwise highlights note of a book, by its tracking property. */
  private findHighlightsNote(book: Export): TFile | null {
    const tracking = this.settings.trackingProperty;
    const review = `https://readwise.io/bookreview/${book.user_book_id}`;
    const prefix = normalizePath(this.settings.baseFolderName) + '/';
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(prefix)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (fm && (fm[tracking] === review || String(fm[tracking]) === String(book.user_book_id))) return file;
    }
    return null;
  }

  /** The personal book note: via the highlights note's link, else by title. */
  private findBookNote(book: Export): TFile | null {
    const highlights = this.findHighlightsNote(book);
    const link = highlights && this.settings.booksBookProperty
      ? this.app.metadataCache.getFileCache(highlights)?.frontmatter?.[this.settings.booksBookProperty]
      : null;
    if (typeof link === 'string') {
      const target = this.app.metadataCache.getFirstLinkpathDest(link.replace(/^\[\[|\]\]$/g, '').split('|')[0], '');
      if (target) return target;
    }
    if (book.category !== 'books') return null;
    const folder = normalizePath(this.settings.booksNoteFolder) + '/';
    const files = this.app.vault.getMarkdownFiles().filter((f) => f.path.startsWith(folder));
    const match = matchNotes(
      [{ id: book.user_book_id, title: book.title, author: book.author, status: 'x', started_reading_at: null,
        finished_reading_at: null, rating: null }],
      files.map((f) => {
        const name = /^(.*)\s+\(([^()]+)\)\s*$/.exec(f.basename);
        return { path: f.path, titles: [name ? name[1] : f.basename], author: name ? name[2] : null, id: null as number | null, isbn: null as string | null };
      })
    );
    const path = match.get(book.user_book_id);
    const file = path ? this.app.vault.getAbstractFileByPath(path) : null;
    return file instanceof TFile ? file : null;
  }

  /** After a library sync: rules over the books that changed. */
  public async runHighlightRules(library: Library, announce = false): Promise<RulesReport | null> {
    if (!this.settings.rulesEnabled) {
      if (announce) this.notify.notice('Readwise: turn on highlight rules in settings first.');
      return null;
    }
    const report = await this.rulesEngine().run(Object.values(library.books));
    for (const failure of report.failures) this.logger.warn(`Highlight rules: ${failure}`);
    if (announce || report.written || report.chapterNotes || report.deleted) {
      const parts = [`${report.written} note(s) created`, `${report.chapterNotes} chapter note(s)`];
      if (report.deleted) parts.push(`${report.deleted} highlight(s) deleted`);
      if (report.failures.length) parts.push(`${report.failures.length} failed (see console)`);
      this.notify.notice(`Readwise rules: ${parts.join(', ')}.`);
    }
    return report;
  }

  public pendingRuleDeletions() {
    return this.rulesEngine().pending();
  }

  /** Puts a processed highlight back to "never delete". */
  public async keepProcessedHighlight(id: string): Promise<void> {
    const record = this.settings.processedHighlights[id];
    if (record) {
      record.state = 'deleted';
      record.deletedAt = 'kept';
      await this.saveAndApplySettings();
    }
  }

  // ---------------------------------------------------------- Readwise Books

  private booksApi(): BooksApi {
    return new BooksApi(() => this.settings.apiToken);
  }

  private lastBookSuggestions: BooksBook[] = [];

  /** Book notes <-> Readwise Books. Runs after each library sync when enabled. */
  public async syncReadwiseBooks(manual = false): Promise<void> {
    if (!this.settings.booksEnabled) {
      if (manual) this.notify.notice('Readwise Books: turn on "Sync book notes with Readwise Books" in settings first.');
      return;
    }
    const report = await syncReadwiseBookNotes(this.ctx, this.booksApi());
    for (const line of report.log) this.logger.debug(`Readwise Books: ${line}`);
    if (manual || report.notesUpdated || report.sent || report.created) {
      const parts = [`${report.notesUpdated} note(s) updated`, `${report.sent} change(s) sent`];
      if (report.created) parts.push(`${report.created} added to Readwise Books`);
      if (report.queued) parts.push(`${report.queued} waiting`);
      this.notify.notice(`Readwise Books: ${parts.join(', ')}.`);
    }
    this.lastBookSuggestions = report.suggestions;
    if (report.suggestions.length === 0) return;

    if (!this.settings.booksSuggestBaselineDone) {
      // First run: don't flood. Offer to set aside everything that exists now.
      new ConfirmDialog(this.app, 'Book note suggestions',
        `${report.suggestions.length} book(s) in Readwise Books have no book note. Stop suggesting these and only `
        + 'suggest books added or moved from now on? (Cancel to review them now.)',
        (confirm) => {
          void (async () => {
            this.settings.booksSuggestBaselineDone = true;
            if (confirm) {
              this.excludeFromSuggestions(report.suggestions);
              this.lastBookSuggestions = [];
            }
            await this.saveAndApplySettings();
            if (!confirm) this.showBookSuggestions();
          })();
        }).open();
      return;
    }
    const fragment = createFragment((f) => {
      f.appendText(`Readwise Books: ${report.suggestions.length} book(s) could use a book note. `);
      const link = f.createEl('a', { text: 'Review' });
      link.addEventListener('click', () => this.showBookSuggestions());
    });
    new Notice(fragment, 15000);
  }

  private excludeFromSuggestions(books: BooksBook[]): void {
    this.settings.booksSuggestExcluded = [...new Set([...this.settings.booksSuggestExcluded, ...books.map((b) => b.id)])];
  }

  public showBookSuggestions(): void {
    new BookSuggestionsModal(this.app, this.lastBookSuggestions, {
      create: async (book) => {
        try {
          const file = await createBookNote(this.ctx, book);
          return file !== null;
        } catch (error) {
          this.logger.error('Readwise Books: note creation failed', error);
          this.notify.notice(`Readwise Books: could not create the note. ${error}`);
          return false;
        }
      },
      dismiss: async (book) => {
        this.excludeFromSuggestions([book]);
        await this.saveAndApplySettings();
      },
      excludeAll: async (books) => {
        this.excludeFromSuggestions(books);
        this.lastBookSuggestions = [];
        await this.saveAndApplySettings();
      },
    }).open();
  }

  /** Command: suggestions from Readwise without running a full sync first. */
  public async refreshAndShowBookSuggestions(): Promise<void> {
    if (!this.settings.booksEnabled) {
      this.notify.notice('Readwise Books: turn on "Sync book notes with Readwise Books" in settings first.');
      return;
    }
    const books = await this.booksApi().listAll();
    this.lastBookSuggestions = findSuggestions(this.ctx, books);
    this.showBookSuggestions();
  }

  public async excludeAllCurrentBooks(): Promise<void> {
    const books = await this.booksApi().listAll();
    this.excludeFromSuggestions(books.filter((b) => b.status !== 'deleted'));
    this.settings.booksSuggestBaselineDone = true;
    await this.saveAndApplySettings();
    this.notify.notice(`Readwise Books: ${books.length} current book(s) won't be suggested.`);
  }

  /** Command: move `consumed` into `format` across book notes. */
  public async migrateConsumedProperty(): Promise<void> {
    const folder = normalizePath(this.settings.booksNoteFolder) + '/';
    const formatName = this.settings.booksPropertyNames.format;
    let changed = 0;
    let kept = 0;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(folder)) continue;
      const fm = this.app.metadataCache.getFileCache(file)?.frontmatter;
      if (!fm || !('consumed' in fm)) continue;
      const plan = migrateConsumed(fm.consumed, readList(fm[formatName]));
      await this.app.fileManager.processFrontMatter(file, (front: Record<string, unknown>) => {
        if (plan.formats.length > readList(front[formatName]).length) front[formatName] = plan.formats;
        if (plan.removeConsumed) delete front.consumed;
      });
      if (plan.removeConsumed) changed++;
      else kept++;
    }
    this.notify.notice(`Readwise Books: moved "consumed" in ${changed} note(s)`
      + (kept ? `; ${kept} kept it because of a value I didn't recognise.` : '.'));
  }

  /** Command: add the open book note to Readwise Books. */
  public async addActiveNoteToBooks(file: TFile): Promise<void> {
    const fm = (this.app.metadataCache.getFileCache(file)?.frontmatter ?? {}) as Record<string, unknown>;
    const names = this.settings.booksPropertyNames;
    const values = readNote(fm, names, this.settings.booksStatusMap);
    if (values.id) {
      this.notify.notice('Readwise Books: this note already has a Readwise Books id.');
      return;
    }
    const identity = identityFromFilename(file.basename);
    const author = authorFromSource(fm.source) ?? identity.author;
    const product: Record<string, string> = values.isbn ? { isbn: values.isbn }
      : author ? { title: identity.title, author } : { title: identity.title, author: '' };
    if (!product.isbn && !product.author) {
      this.notify.notice('Readwise Books: add an author (source) or ISBN to the note first.');
      return;
    }
    const shelf = values.status ? this.settings.booksStatusMap[values.status] : '';
    const added = await addNotesToBooks(this.ctx, this.booksApi(),
      [{ file, item: { product, status: shelf || undefined } }]);
    this.notify.notice(added ? 'Readwise Books: added.' : 'Readwise Books: could not add this book (see console).');
  }

  async deleteLibrary() {
    this.settings.lastUpdated = null;
    await this.saveAndApplySettings();

    if (await this.deleteLibraryFolder()) {
      if (this.settings.syncNotifications) this.notify.notice('Readwise: library folder deleted');
    } else {
      if (this.settings.syncNotifications) this.notify.notice('Readwise: Error deleting library folder');
    }

    this.notify.setStatusBarText('Readwise: Click to Sync');
  }
}
