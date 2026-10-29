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
import { createSyncReport, type SyncReport } from 'services/sync-report';
import { renderSyncLog, resolveSyncLogPath } from 'services/sync-log';
import { filterHighlights, renderMarkdownTemplate } from 'services/template-rendering';
import spacetime from 'spacetime';
import { AUTHOR_SEPARATORS, DEFAULT_SETTINGS } from 'src/constants';
import type { BaseFile, ReadwiseDocument } from 'types/document';
import type { Export, Library } from 'types/library';
import type { PluginContext } from 'types/plugin-context';
import type { PluginSettings } from 'types/settings';
import Notify from 'ui/notify';
import { ConfirmDialog } from 'ui/dialog';
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
        await this.lock.acquire('readwise-obsidian:loaded');
        const statusBarItem = this.addStatusBarItem();
        this._notify = new Notify(statusBarItem);
        await this.initializeUI();
      })();
    });
  }

  public onunload(): void {
    this.logger.debug('Readwise Obsidian unloaded.');
    this.lock.release('readwise-obsidian:loaded');
    super.onunload();
  }

  private async initializeUI() {
    try {
      await this.loadAndApplySettings();
      this.addSettingTab(new ReadwiseMirrorSettingTab(this, this.ctx, this.env));
      this.logger.debug('Readwise Obsidian loaded.');

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

      // Update status bar every second if synced
      this.registerInterval(
        window.setInterval(() => {
          if (/Synced/.test(this.notify.getStatusBarText())) {
            this.notify.setStatusBarText(`Readwise: Synced ${humanReadableFormat(this.settings.lastUpdated)}`);
          }
        }, 1000)
      );
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
    Object.assign(this.settings, DEFAULT_SETTINGS, loaded ?? {});

    if (this.lock.isAcquired('readwise-obsidian:loaded')) {
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
      await Controller.initialize(this, this.ctx);
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

  public async writeLogToMarkdown(library: Library, report: SyncReport = createSyncReport([])) {
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
    const logString = renderSyncLog(this.env, this.settings, report, items, now.format('iso-short'), now.time());

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
    this.deduplicatingVaultWriter.buildTrackedFileIndex();
    const actions: string[] = [];
    for (const book of Object.values(library.books)) {
      const basename = this.getFileNameFromDoc(book);
      const target = normalizePath(`${this.deduplicatingVaultWriter.getCategoryPath(book.category)}/${basename}.md`);
      const existing = await this.deduplicatingVaultWriter.findExistingByHighlightsUrl({ readwise_url: book.readwise_url });
      if (existing.length > 0) {
        actions.push(`Update ${existing[0].path}`);
        if (this.settings.enableFileNameUpdates && existing[0].path !== target) actions.push(`Rename ${existing[0].path} toward ${target}`);
        for (const duplicate of existing.slice(1)) actions.push(`${this.settings.deleteDuplicates ? 'Trash' : 'Mark'} duplicate ${duplicate.path}`);
      } else {
        actions.push(`${this.app.vault.getFileByPath(target) ? 'Update or create collision for' : 'Create'} ${target}`);
      }
    }
    const prompt = createFragment((fragment) => {
      fragment.createEl('p', { text: `${actions.length} planned document actions. Review before writing to the vault.` });
      if (this.settings.atomicHighlights) fragment.createEl('p', { text: 'Atomic highlight files may also be created or updated.' });
      if (this.settings.logFile) fragment.createEl('p', { text: `A sync entry will be appended to ${resolveSyncLogPath(this.settings)}.` });
      const list = fragment.createEl('ul');
      for (const action of actions.slice(0, 60)) list.createEl('li', { text: action });
      if (actions.length > 60) fragment.createEl('p', { text: `${actions.length - 60} more actions are not shown.` });
    });
    return new Promise((resolve) => new ConfirmDialog(this.app, 'Preview Readwise sync', prompt, resolve).open());
  }

  // Write a library of Readwise books to markdown files
  public async writeLibraryToMarkdown(library: Library): Promise<SyncReport> {
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
      return createSyncReport([]);
    }

    // Process all files in batch
    try {
      this.logger.time('process');
      const report = await this.deduplicatingVaultWriter.process(readwiseFiles);
      this.logger.timeEnd('process');
      return report;
    } catch (err) {
      this.logger.error('Failed to process files batch', err);
      const failed = this.deduplicatingVaultWriter.getLastSyncReport().events.find((event) => event.action === 'failed');
      this.notify.notice(`Readwise: Sync write failed${failed ? ` at ${failed.path}` : ''}.`);
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
  private async processReadwiseLibrary(library: Library): Promise<BaseFile[]> {
    const readwiseFiles: BaseFile[] = [];
    this.deduplicatingVaultWriter.buildTrackedFileIndex();

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

          if (this.settings.enableFileNameUpdates) {
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
