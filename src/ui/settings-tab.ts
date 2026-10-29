import type ReadwiseMirror from 'main';
import {
  type ButtonComponent,
  Modal,
  PluginSettingTab,
  type RequestUrlResponse,
  requestUrl,
  Setting,
  type TextComponent,
} from 'obsidian';
import { Controller } from 'services/controller';
import { Atomizer } from 'services/atomizer';
import ReadwiseApi, { TokenValidationError } from 'services/readwise-api';
import { ReadwiseEnvironment, ReadwiseLoader } from 'services/readwise-environment';
import { renderReaderFrontmatter } from 'services/reader-frontmatter';
import { buildReadwiseDocument } from 'services/readwise-document-mapper';
import { renderMarkdownTemplate } from 'services/template-rendering';
import { DEFAULT_SETTINGS } from 'src/constants';
import type { PluginContext } from 'types/plugin-context';
import type { Export } from 'types/library';
import type { TemplateValidationResult } from 'types/utilities';
import { WarningDialog } from 'ui/dialog';
import { sanitizeFrontmatterTemplate, validateFrontmatterTemplate } from 'utils/frontmatter-utils';
import { hasAtomizeBlocks } from 'utils/template-utils';

interface SettingsTab {
  id: string;
  name: string;
  icon?: string; // Optional icon for visual distinction
  render: (containerEl: HTMLElement) => void;
}

class TabView {
  private static lastActiveTab: string;
  private activeTab: string;
  private tabContent?: HTMLElement;

  constructor(
    private containerEl: HTMLElement,
    private tabs: SettingsTab[]
  ) {
    // Use the last active tab if it exists and is valid, otherwise use first tab
    this.activeTab =
      TabView.lastActiveTab && tabs.some((t) => t.id === TabView.lastActiveTab) ? TabView.lastActiveTab : tabs[0].id;
  }

  render() {
    // Create tab container
    const tabContainer = this.containerEl.createDiv({
      cls: 'settings-tab-container',
    });

    // Create tab buttons
    const tabButtons = tabContainer.createDiv({
      cls: 'settings-tab-buttons',
    });

    for (const tab of this.tabs) {
      const btn = tabButtons.createEl('button', {
        cls: ['settings-tab-button', this.activeTab === tab.id ? 'active' : ''],
        text: tab.name,
      });
      btn.addEventListener('click', () => this.switchTab(tab.id));
    }

    // Create tab content area
    this.tabContent = tabContainer.createDiv({
      cls: 'settings-tab-content',
    });

    this.renderActiveTab();
  }

  private renderActiveTab() {
    // Render active tab
    const activeTab = this.tabs.find((t) => t.id === this.activeTab);
    if (activeTab && this.tabContent) {
      // Clear existing content
      this.tabContent.empty();
      activeTab.render(this.tabContent);
    }
  }

  private switchTab(tabId: string) {
    this.activeTab = tabId;
    TabView.lastActiveTab = tabId; // Store the last active tab

    // Update button states
    const buttons = this.containerEl.querySelectorAll('.settings-tab-button');
    for (const btn of Array.from(buttons)) {
      btn.classList.toggle('active', btn.textContent === this.tabs.find((t) => t.id === tabId)?.name);
    }

    this.renderActiveTab();
  }
}

export default class ReadwiseMirrorSettingTab extends PluginSettingTab {
  private tokenValidationMessage?: HTMLElement;
  private retrievalButton?: ButtonComponent;
  private tokenValue?: TextComponent;
  private validationButton?: ButtonComponent;

  private isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null;
  }

  constructor(
    plugin: ReadwiseMirror,
    private ctx: PluginContext,
    private readonly env: ReadwiseEnvironment
  ) {
    super(ctx.app, plugin);
  }

  /**
   * Adjusts the number of rows in a textarea based on content and wrapping
   *
   * @param textEl - The textarea element to adjust
   * @param minRows - Minimum number of rows to show (default: 3)
   *
   * Behavior:
   * - Calculates total lines needed based on content
   * - Accounts for line wrapping based on textarea width
   * - Maintains minimum row count
   * - Adds one extra row for editing
   *
   * Example:
   * For a textarea with cols=50:
   * - "Short line" -> 1 line
   * - "Very long line..." (>50 chars) -> 2 lines
   * - "Line 1\nLine 2" -> 2 lines
   * - "" (empty) -> minRows
   */
  private adjustTextareaRows = (textEl: HTMLTextAreaElement, minRows = 3) => {
    const content = textEl.value;
    const width = textEl.cols;

    // Calculate wrapped lines
    let totalLines = 0;
    for (const line of content.split('\n')) {
      // Calculate how many times the line wraps
      const wrappedLines = Math.ceil(line.length / width);
      totalLines += Math.max(1, wrappedLines);
    }

    // Add 1 to account for the last line and set minimum
    textEl.rows = Math.max(minRows, totalLines + 1);
  };

  // Button-based authentication inspired by the official Readwise plugin
  private async getUserAuthToken(attempt = 0): Promise<boolean> {
    const MAX_ATTEMPTS = 20;
    const BASE_TIMEOUT = 1000;
    const MAX_TIMEOUT = 10000;

    const baseURL = 'https://readwise.io';
    const uuid = this.getReadwiseMirrorClientId();

    if (attempt === 0) {
      window.open(`${baseURL}/api_auth?token=${uuid}&service=readwise-mirror`);
    }

    let response: RequestUrlResponse;
    try {
      response = await requestUrl({ url: `${baseURL}/api/auth?token=${uuid}` });
      if (response.status === 200) {
        const data: unknown = response.json;
        if (this.isRecord(data) && typeof data.userAccessToken === 'string' && data.userAccessToken.length > 0) {
          this.ctx.logger.debug('Token successfully retrieved');
          this.ctx.settings.apiToken = data.userAccessToken;
          await this.ctx.saveAndApplySettings();
          this.display(); // Refresh the settings page
          return true;
        }
      }
    } catch (e) {
      this.ctx.logger.error('Failed to authenticate with Readwise:', e);
    }

    if (attempt >= MAX_ATTEMPTS) {
      this.ctx.notice('Authentication timeout. Please try again.');
      return false;
    }

    const timeout = Math.min(BASE_TIMEOUT * 2 ** attempt, MAX_TIMEOUT);
    await new Promise((resolve) => window.setTimeout(resolve, timeout));
    return this.getUserAuthToken(attempt + 1);
  }

  // Button-based authentication inspired by the official Readwise plugin
  private getReadwiseMirrorClientId() {
    let readwiseMirrorClientId = window.localStorage.getItem('readwise-sync-client-id') ?? window.localStorage.getItem('readwise-obsidian-client-id');
    if (readwiseMirrorClientId) {
      return readwiseMirrorClientId;
    }

    readwiseMirrorClientId = Math.random().toString(36).substring(2, 15);
    window.localStorage.setItem('readwise-sync-client-id', readwiseMirrorClientId);
    return readwiseMirrorClientId;
  }

  private createTemplateDocumentation(variables: [string, string][], title?: string) {
    return createFragment((fragment) => {
      const documentationContainer = fragment.createDiv({
        cls: 'setting-documentation-container',
      });

      if (title) {
        documentationContainer.createDiv({
          text: title,
          cls: 'setting-item-description',
        });
      }

      const container = documentationContainer.createDiv({
        cls: 'setting-item-description',
        attr: { style: 'margin-top: 10px' },
      });

      container.createSpan({ text: 'Available variables:' });
      container.createEl('br');

      const list = container.createEl('ul', { cls: 'template-vars-list' });

      for (const [key, desc] of variables) {
        const item = list.createEl('li');
        item.createEl('code', { text: `{{ ${key} }}` });
        item.appendText(`: ${desc}`);
      }

      const syntaxNote = container.createDiv({ cls: 'template-syntax-note' });
      syntaxNote.appendText('Supports Nunjucks templating syntax. See ');
      const link = syntaxNote.createEl('a', {
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        text: 'built-in filters documentation',
        href: 'https://mozilla.github.io/nunjucks/templating.html#builtin-filters',
      });
      link.setAttr('target', '_blank');
      syntaxNote.appendText(' and the ');
      syntaxNote.createEl('a', {
        // eslint-disable-next-line obsidianmd/ui/sentence-case
        text: 'documentation in the Wiki',
        href: 'https://github.com/jsonMartin/readwise-mirror/wiki/Guide:-Templating',
      });
      syntaxNote.append(' for more details.');
    });
  }

  display(): void {
    void this.displayAsync();
  }

  private async displayAsync(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    const tabs: SettingsTab[] = [
      {
        id: 'general',
        name: 'General',
        render: (container) => {
          this.renderDebugMode(container);
          this.renderAuthentication(container);
          this.renderLibrarySettings(container);
          this.renderSyncSettings(container);
          this.renderSyncLogging(container);
        },
      },
      {
        id: 'files',
        name: 'File tracking and naming',
        render: (container) => {
          this.renderFileTracking(container);
          this.renderFilenameSettings(container);
        },
      },
      {
        id: 'reader',
        name: 'Reader',
        render: (container) => this.renderReaderSettings(container),
      },
      {
        id: 'frontmatter-template',
        name: 'Frontmatter',
        render: (container) => {
          this.renderFrontmatterTemplateSettings(container);
        },
      },
      {
        id: 'header-template',
        name: 'Header',
        render: (container) => {
          this.renderHeaderTemplateSettings(container);
        },
      },
      {
        id: 'highlight-template',
        name: 'Highlights',
        render: (container) => {
          this.renderAtomicHighlightsSettings(container);
          this.renderHighlightTemplateSettings(container);
          this.renderHighlightSettings(container);
        },
      },
    ];

    new TabView(containerEl, tabs).render();
  }

  /**
   * Updates the authentication buttons based on the current state.
   * @param state The current authentication state
   */
  private updateAuthButtons(state: 'empty' | 'valid' | 'invalid' | 'verifying'): void {
    switch (state) {
      case 'valid':
        this.validationButton?.setDisabled(true).removeCta().setButtonText('Verified');
        this.retrievalButton?.setDisabled(true).setButtonText('Re-authenticate with Readwise');
        if (this.tokenValue !== undefined) {
          this.tokenValue.inputEl.type = 'password';
        }
        break;
      case 'invalid':
        this.validationButton?.setDisabled(false).setCta().setButtonText('Apply');
        this.retrievalButton?.setDisabled(false).setButtonText('Authenticate with Readwise');
        if (this.tokenValue !== undefined) this.tokenValue.inputEl.type = 'text';
        break;
      case 'verifying':
        this.validationButton?.setDisabled(true).setCta();
        this.retrievalButton?.setDisabled(true);
        break;
      default:
        this.validationButton?.setDisabled(false).setCta().setButtonText('Apply');
        this.retrievalButton?.setDisabled(false).setButtonText('Authenticate with Readwise');
        break;
    }
  }

  private requireTokenValidationMessage(): HTMLElement {
    if (!this.tokenValidationMessage) {
      throw new Error('Token validation message element is not initialized. Call renderAuthentication() first.');
    }

    return this.tokenValidationMessage;
  }

  private getErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    if (typeof error === 'string') {
      return error;
    }
    if (typeof error === 'number' || typeof error === 'boolean' || typeof error === 'bigint') {
      return String(error);
    }
    try {
      return JSON.stringify(error);
    } catch {
      return 'Unknown error';
    }
  }

  /**
   * Updates the validation message div based on status.
   * @param status 'invalid' | 'success' | 'running' | 'error'
   * @param errorMsg Optional error message for 'error' status
   */
  private setTokenValidationStatus(status: 'invalid' | 'success' | 'running' | 'error' | 'empty', errorMsg?: string) {
    const el = this.requireTokenValidationMessage();
    el.show();
    switch (status) {
      case 'invalid':
        el.setText('Invalid token');
        el.setAttr('style', 'color: var(--text-error); margin-top: 0.5em;');
        break;
      case 'success':
        el.setText('Token validated successfully');
        el.setAttr('style', 'color: var(--text-success); margin-top: 0.5em;');
        break;
      case 'running':
        el.setText('Validating token...');
        el.setAttr('style', 'color: var(--text-accent); margin-top: 0.5em;');
        break;
      case 'error':
        el.setText(errorMsg || 'Token validation error');
        el.setAttr('style', 'color: var(--text-error); margin-top: 0.5em;');
        break;
      default:
        el.setText('');
        el.hide();
    }
  }

  private renderDebugMode(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Debug mode')
      .setDesc('Enable debug logging')
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.debugMode).onChange(async (value) => {
          this.ctx.settings.debugMode = value;
          this.ctx.logger.setDebugMode(value);
          this.ctx.logger.warn('Debug mode:', value ? 'enabled' : 'disabled');
          await this.ctx.saveAndApplySettings();
        })
      );
  }

  private renderAuthentication(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Authentication').setHeading();

    let hasValidToken: boolean | null = null;

    // Create a single validation message div and a function to update its status
    this.tokenValidationMessage = containerEl.createDiv({
      cls: 'setting-item-description validation-message',
      attr: {
        style: 'margin-top: 0.5em; display: none;',
      },
    });

    new Setting(containerEl)
      .setName('Readwise authentication')
      .setDesc(
        createFragment((fragment) => {
          fragment.createEl('strong', { text: 'How to authenticate: ' });
          fragment.appendText('Paste your API key from ');
          // eslint-disable-next-line obsidianmd/ui/sentence-case
          fragment.createEl('a', { text: 'readwise.io/access_token', href: 'https://readwise.io/access_token' });
          fragment.appendText(', or use the "Authenticate with Readwise" button for automatic retrieval of the token.');
          fragment.createEl('br');
          fragment.append(this.requireTokenValidationMessage());
          this.updateAuthButtons('verifying');
          this.setTokenValidationStatus('running');

          void (async () => {
            try {
              hasValidToken = await Controller.validateAPIInstance();
              if (hasValidToken) this.ctx.setStatusBarText('Readwise: Click to Sync');
              this.updateAuthButtons(hasValidToken ? 'valid' : 'invalid');
              this.setTokenValidationStatus(hasValidToken ? 'success' : 'invalid');
            } catch (error) {
              this.updateAuthButtons('invalid');
              if (error instanceof TokenValidationError) {
                this.setTokenValidationStatus('error', error.message);
              } else {
                this.setTokenValidationStatus('error', 'Token validation error');
              }
            }
          })();
        })
      )
      .addButton((button) => {
        this.retrievalButton = button;
        this.retrievalButton
          .setButtonText(!hasValidToken === false ? 'Re-authenticate with Readwise' : 'Authenticate with Readwise')
          .onClick(async () => {
            const authModal = new Modal(this.app);
            authModal.titleEl.setText('Authenticate with Readwise');
            authModal.contentEl.createEl('p', {
              text: 'A new window will open for Readwise authentication. After logging in, an error page may appear—this is normal and can be closed.',
            });
            authModal.contentEl.createEl('p', {
              text: 'Check your authentication status here in Obsidian settings after completing the process.',
            });
            authModal.contentEl.createEl('br');
            const buttonContainer = authModal.contentEl.createDiv();
            buttonContainer.addClass('readwise-modal-actions');

            const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
            const continueButton = buttonContainer.createEl('button', { text: 'Understood' });
            continueButton.addClass('mod-cta');

            cancelButton.onclick = () => authModal.close();
            continueButton.onclick = () => {
              authModal.close();
              void (async () => {
                const isAuthenticated = await this.getUserAuthToken();
                this.updateAuthButtons(isAuthenticated ? 'valid' : 'invalid');
                this.setTokenValidationStatus(isAuthenticated ? 'success' : 'invalid');
              })();
            };
            authModal.open();
          })
          .setDisabled(Boolean(hasValidToken));
        return this.retrievalButton;
      })
      .addText((text) => {
        this.tokenValue = text;
        const token = this.ctx.settings.apiToken ?? '';
        const tokenInputEl = text.inputEl;

        tokenInputEl.type = 'password';

        this.tokenValue.setPlaceholder('API token').setValue(token);
        this.tokenValue.onChange(() => {
          const value = tokenInputEl.value;
          if (value !== this.ctx.settings.apiToken) {
            this.setTokenValidationStatus('empty');
            this.updateAuthButtons('invalid');
          }
        });
        tokenInputEl.onfocus = () => {
          tokenInputEl.type = 'text';
        };
        tokenInputEl.onblur = () => {
          if (hasValidToken) {
            tokenInputEl.type = 'password';
          }
        };
      })
      .addButton((button) => {
        this.validationButton = button;
        this.validationButton
          .setDisabled(Boolean(hasValidToken))
          .setCta()
          .setIcon('check')
          .setButtonText(hasValidToken ? 'Verified' : 'Apply')
          .onClick(async () => {
            const value = this.tokenValue?.inputEl?.value ?? '';
            if (value === '') {
              this.ctx.settings.apiToken = value;
              this.updateAuthButtons('empty');
              this.setTokenValidationStatus('empty');
              await this.ctx.saveAndApplySettings();
              this.ctx.notice('Cleared token. Add or retrieve token to sync.');
            } else if (value !== this.ctx.settings.apiToken) {
              this.updateAuthButtons('verifying');
              this.setTokenValidationStatus('running');

              try {
                const isValidToken = await ReadwiseApi.validateTokenValue(value);

                if (isValidToken) {
                  this.ctx.settings.apiToken = value;
                  await this.ctx.saveAndApplySettings();
                  this.setTokenValidationStatus('success');
                  this.updateAuthButtons('valid');
                  this.ctx.notice('New token set.');
                } else {
                  this.setTokenValidationStatus('invalid');
                  this.updateAuthButtons('invalid');
                  this.ctx.notice('Failed to verify token: Invalid API token.');
                }
              } catch (error) {
                this.ctx.notice(`Failed to verify token: ${this.getErrorMessage(error)}`);
                this.setTokenValidationStatus('invalid');
                this.updateAuthButtons('invalid');
              }
            }
          });
        // Add fixed width class
        this.validationButton.buttonEl.addClass('readwise-auth-validate-btn');
        return this.validationButton;
      });
  }

  private renderLibrarySettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Library').setHeading();

    new Setting(containerEl)
      .setName('Library folder name')
      .setDesc('Default: Readwise')
      .addText((text) =>
        text
          .setPlaceholder('Readwise')
          .setValue(this.ctx.settings.baseFolderName)
          .onChange(async (value) => {
            const normalized = value.trim();
            this.ctx.settings.baseFolderName = normalized || DEFAULT_SETTINGS.baseFolderName;
            await this.ctx.saveAndApplySettings();
          })
      );

    // Add new Filter by tag setting
    new Setting(containerEl)
      .setName('Filter by tag')
      .setDesc('Only sync Readwise items with specific document tags')
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.filterNotesByTag).onChange(async (value) => {
          this.ctx.settings.filterNotesByTag = value;
          // Trigger a refresh of the settings display to show/hide the tags input
          await this.ctx.saveAndApplySettings();
          this.display();
        })
      );

    // Add tags input field (only visible when filterByTag is enabled)
    if (this.ctx.settings.filterNotesByTag) {
      new Setting(containerEl)
        .setName('Tags to include')
        .setDesc(
          'Enter tags separated by commas (e.g., important, todo, review). Only Readwise items matching any of these tags (document level) will be synced.'
        )
        .addTextArea((text) => {
          text
            .setPlaceholder('Tag1, tag2, tag3')
            .setValue(this.ctx.settings.filteredTags.join(', '))
            .onChange(async (value) => {
              this.ctx.settings.filteredTags = value
                .split(/[,;\n]/) // We are bit more generous with separation characters
                .map((tag) => tag.trim())
                .filter((tag) => tag !== '');
              await this.ctx.saveAndApplySettings();
            });

          // Adjust the height of the text area
          text.inputEl.rows = 2;

          return text;
        });
    }
  }

  private renderSyncSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Sync').setHeading();

    new Setting(containerEl)
      .setName('Auto sync when starting')
      .setDesc('Automatically syncs new highlights after opening Obsidian')
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.autoSync).onChange(async (value) => {
          this.ctx.settings.autoSync = value;
          await this.ctx.saveAndApplySettings();
        })
      );

    new Setting(containerEl)
      .setName('Preview sync changes')
      .setDesc('Show planned document actions and ask before each library sync.')
      .addToggle((toggle) => toggle.setValue(this.ctx.settings.previewSync).onChange(async (value) => {
        this.ctx.settings.previewSync = value;
        await this.ctx.saveAndApplySettings();
      }));

    new Setting(containerEl)
      .setName('Preserve local writing')
      .setDesc('Keep one local section when synced notes are regenerated.')
      .addToggle((toggle) => toggle.setValue(this.ctx.settings.preserveLocalSection).onChange(async (value) => {
        this.ctx.settings.preserveLocalSection = value;
        await this.ctx.saveAndApplySettings();
      }));
    new Setting(containerEl)
      .setName('Local writing boundary')
      .setDesc('Choose comment markers or a Markdown heading for the section that survives sync.')
      .addDropdown((dropdown) => dropdown
        .addOption('markers', 'Comment markers')
        .addOption('heading', 'Markdown heading')
        .setValue(this.ctx.settings.localSectionMode)
        .onChange(async (value) => {
          this.ctx.settings.localSectionMode = value as 'markers' | 'heading';
          await this.ctx.saveAndApplySettings();
          this.display();
        }));
    if (this.ctx.settings.localSectionMode === 'heading') {
      new Setting(containerEl)
        .setName('Local writing heading')
        .setDesc('Use a unique Markdown heading, such as ## my notes. Text below it survives until the next heading at the same or higher level.')
        .addText((text) => text.setValue(this.ctx.settings.localSectionHeading).onChange(async (value) => {
          this.ctx.settings.localSectionHeading = value;
          await this.ctx.saveAndApplySettings();
        }));
    }
  }

  private renderReaderSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Reader documents').setHeading();
    new Setting(containerEl)
      .setName('Sync tagged reader documents')
      .setDesc('Fetch full content for documents with the chosen reader tag after each Readwise highlights sync. A separate command can run this alone.')
      .addToggle((toggle) => toggle.setValue(this.ctx.settings.readerEnabled).onChange(async (value) => {
        this.ctx.settings.readerEnabled = value;
        await this.ctx.saveAndApplySettings();
      }));
    new Setting(containerEl)
      .setName('Reader tag')
      .setDesc('Exact reader tag key to select documents. Leave blank to prevent reader sync.')
      .addText((text) => text.setValue(this.ctx.settings.readerTag).onChange(async (value) => {
        this.ctx.settings.readerTag = value.trim();
        await this.ctx.saveAndApplySettings();
      }));
    new Setting(containerEl)
      .setName('Document folder')
      .setDesc('Vault-relative folder for full reader documents and downloaded assets.')
      .addText((text) => text.setValue(this.ctx.settings.readerFolder).onChange(async (value) => {
        this.ctx.settings.readerFolder = value.trim();
        await this.ctx.saveAndApplySettings();
      }));
    new Setting(containerEl)
      .setName('Link matching highlight notes')
      .setDesc('Match by exact source URL. Adds a link in each direction when one unambiguous Readwise note is found.')
      .addToggle((toggle) => toggle.setValue(this.ctx.settings.readerLinkHighlights).onChange(async (value) => {
        this.ctx.settings.readerLinkHighlights = value;
        await this.ctx.saveAndApplySettings();
      }));
    new Setting(containerEl)
      .setName('Download inline images')
      .setDesc('Save available images beside the full document for offline use.')
      .addToggle((toggle) => toggle.setValue(this.ctx.settings.readerDownloadImages).onChange(async (value) => {
        this.ctx.settings.readerDownloadImages = value;
        await this.ctx.saveAndApplySettings();
      }));
    new Setting(containerEl)
      .setName('Download PDF and e-book files')
      .setDesc('Save available original PDF and e-book source files in the assets folder.')
      .addToggle((toggle) => toggle.setValue(this.ctx.settings.readerDownloadSourceFiles).onChange(async (value) => {
        this.ctx.settings.readerDownloadSourceFiles = value;
        await this.ctx.saveAndApplySettings();
      }));
    new Setting(containerEl)
      .setName('Document and highlights layout')
      .setDesc('Linked keeps a link to the Readwise highlights note. Combined copies its current body below the full content.')
      .addDropdown((dropdown) => dropdown
        .addOption('separate', 'Linked notes')
        .addOption('combined', 'Combined document')
        .setValue(this.ctx.settings.readerOutputMode)
        .onChange(async (value) => {
          this.ctx.settings.readerOutputMode = value as 'separate' | 'combined';
          await this.ctx.saveAndApplySettings();
        }));
    let previewEl: HTMLElement;
    const updateReaderPreview = (template: string) => {
      if (!previewEl) return;
      try {
        previewEl.setText(this.env.renderString(template, {
          title: 'Sample article', author: 'Sample author', notes: 'A document note',
          content: '## Full content\n\nA sample paragraph.', source_file: '',
          highlight_link: '[[Sample highlights]]', highlights: 'Highlights: [[Sample highlights]]',
        }));
      } catch (error) {
        previewEl.setText(`Template error: ${this.getErrorMessage(error)}`);
      }
    };
    new Setting(containerEl)
      .setName('Document template')
      .setDesc('Nunjucks variables include title, author, notes, content, source_file, highlight_link, and highlights.')
      .addTextArea((text) => {
        text.setValue(this.ctx.settings.readerDocumentTemplate).onChange(async (value) => {
          this.ctx.settings.readerDocumentTemplate = value;
          await this.ctx.saveAndApplySettings();
          updateReaderPreview(value);
        });
        text.inputEl.rows = 12;
      });
    previewEl = containerEl.createEl('pre', { cls: 'readwise-template-preview' });
    updateReaderPreview(this.ctx.settings.readerDocumentTemplate);

    const sampleReader = {
      id: 'sample-reader-id', url: 'https://read.readwise.io/new/read/sample-reader-id',
      source_url: 'https://example.com/article', title: 'Sample article', author: 'Sample author',
      category: 'article', updated_at: '2026-10-29T00:00:00Z', tags: { sample: { name: 'Sample' } },
      notes: 'A document note',
    };
    let yamlPreview: HTMLElement;
    const updateYamlPreview = (template: string) => {
      if (!yamlPreview) return;
      try {
        yamlPreview.setText(renderReaderFrontmatter(this.env, template, sampleReader, this.ctx.settings.readerTag || 'sample-tag').trim());
      } catch (error) {
        yamlPreview.setText(`Template error: ${this.getErrorMessage(error)}`);
      }
    };
    new Setting(containerEl)
      .setName('Document YAML template')
      .setDesc('Set tags and other properties for imported reader notes. Tracking fields are added automatically. Available: reader_tag, tag_names, document, and reader document fields.')
      .addTextArea((text) => {
        text.setValue(this.ctx.settings.readerYamlTemplate).onChange(async (value) => {
          this.ctx.settings.readerYamlTemplate = value;
          await this.ctx.saveAndApplySettings();
          updateYamlPreview(value);
        });
        text.inputEl.rows = 8;
      });
    yamlPreview = containerEl.createEl('pre', { cls: 'readwise-template-preview' });
    updateYamlPreview(this.ctx.settings.readerYamlTemplate);
  }

  private renderAtomicHighlightsSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Atomic highlights').setHeading();

    // Add atomic highlights setting with tracking dependency
    new Setting(containerEl)
      .setName('Enable atomic highlights')
      .setDesc(
        createFragment((fragment) => {
          fragment.appendText('Allows creation of atomic highlights & notes. Please check the documentation on the ');
          fragment
            .createEl('a', {
              text: 'Wiki',
              href: 'https://github.com/jsonMartin/readwise-mirror/wiki/Guide:-Atomic-highlights',
            })
            .setAttr('target', '_blank');
          fragment.appendText(' for details.');

          if (!this.ctx.settings.trackFiles) {
            fragment.createEl('br');
            fragment.createEl('br');
            fragment.createSpan({
              text: 'Requires file tracking to be enabled.',
              attr: { style: 'color: var(--text-error);' },
            });
          }

          if (this.ctx.settings.atomicHighlights && !hasAtomizeBlocks(this.ctx.settings.highlightTemplate)) {
            fragment.createEl('br');
            fragment.createEl('br');
            const warningSpan = fragment.createSpan({
              attr: { style: 'color: var(--text-warning);' },
            });
            warningSpan.appendText(
              'Your highlight template does not contain atomize blocks. Atomic highlights will not be created until you add '
            );
            warningSpan.createEl('code', { text: '{% atomize %}...{% endatomize %}' });
            warningSpan.appendText(' blocks. See the ');
            warningSpan
              .createEl('a', {
                text: 'Wiki',
                href: 'https://github.com/jsonMartin/readwise-mirror/wiki/Guide:-Atomic-highlights',
              })
              .setAttr('target', '_blank');
            warningSpan.appendText(' for details.');
          }
        })
      )
      .addToggle((toggle) => {
        // Disable and turn off if tracking is disabled
        if (!this.ctx.settings.trackFiles) {
          toggle.setValue(false);
          toggle.setDisabled(true);
          if (this.ctx.settings.atomicHighlights) {
            this.ctx.settings.atomicHighlights = false;
            void this.ctx.saveAndApplySettings(); // Fire and forget is acceptable here
          }
        } else {
          toggle.setValue(this.ctx.settings.atomicHighlights).onChange(async (value) => {
            if (value) {
              new WarningDialog(
                this.app,
                'Enable atomic highlights',
                createFragment((fragment) => {
                  fragment.createDiv({
                    text: 'Enabling atomic highlights will create individual note files for each highlight in your vault.',
                  });
                  fragment.createEl('br');
                  fragment.createDiv({
                    text: 'This can lead to the creation of many new files. Please make sure you understand how atomic highlights work before continuing.',
                  });
                  fragment.createEl('br');
                  fragment.createDiv({
                    text: 'Would you like to proceed?',
                  });
                }),
                (confirmed: boolean) => {
                  if (confirmed) {
                    void (async () => {
                      this.ctx.settings.atomicHighlights = true;
                      await this.ctx.saveAndApplySettings();
                      this.display();
                    })();
                  } else {
                    toggle.setValue(false);
                  }
                }
              ).open();
            } else {
              this.ctx.settings.atomicHighlights = false;
              await this.ctx.saveAndApplySettings();
              this.display();
            }
          });
        }
        return toggle;
      });

    // Add atomic highlights parent property setting

    new Setting(containerEl)
      .setClass('indent')
      .setName('Conditional atomization (rw-atomize)')
      .setDesc(
        createFragment((fragment) => {
          fragment.appendText('Only create atomic notes for Readwise notes where ');
          fragment.createEl('code', { text: 'Rw-atomize: true' });
          fragment.appendText(" is set in the highlight's frontmatter. ");
        })
      )
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.atomicConditionalAtomize).onChange(async (value) => {
          this.ctx.settings.atomicConditionalAtomize = value;
          await this.ctx.saveAndApplySettings();
        })
      );

    new Setting(containerEl)
      .setClass('indent')
      .setName('Atomic parent property')
      .setDesc('Frontmatter property used to link atomic notes back to their parent document (default: Rw-parent).')
      .addText((text) =>
        text
          .setPlaceholder('Rw-parent')
          .setValue(this.ctx.settings.atomicParentProperty || 'rw-parent')
          .onChange(async (value) => {
            this.ctx.settings.atomicParentProperty = value || 'rw-parent';
            await this.ctx.saveAndApplySettings();
          })
      );

    // Add atomic highlights frontmatter setting
    new Setting(containerEl)
      .setClass('indent')
      .setName('Inherit parent note frontmatter')
      .setDesc(
        "Inherit the frontmatter from the parent note in atomic highlights. Frontmatter properties defined in atomize blocks will overwrite the parent note's frontmatter."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.atomicInheritParentFrontmatter).onChange(async (value) => {
          this.ctx.settings.atomicInheritParentFrontmatter = value;
          await this.ctx.saveAndApplySettings();
        })
      );
  }

  private renderHighlightSettings(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Highlight organization').setHeading();

    new Setting(containerEl)
      .setName('Sort highlights by location')
      .setDesc(
        'If checked, highlights will be listed in order of location. Combine with above sort highlights from oldest to newest option to reverse order.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.highlightSortByLocation).onChange(async (value) => {
          this.ctx.settings.highlightSortByLocation = value;
          await this.ctx.saveAndApplySettings();
        })
      );

    new Setting(containerEl)
      .setName('Sort highlights from oldest to newest')
      .setDesc(
        'If checked, highlights will be listed from oldest to newest. Unchecked, newest highlights will appear first.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.highlightSortOldestToNewest).onChange(async (value) => {
          this.ctx.settings.highlightSortOldestToNewest = value;
          await this.ctx.saveAndApplySettings();
        })
      );

    new Setting(containerEl)
      .setName('Filter discarded highlights')
      .setDesc(
        'If enabled, do not display discarded highlights in the Readwise library. (Deleted highlights will still be removed on sync)'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.highlightDiscard).onChange(async (value) => {
          this.ctx.settings.highlightDiscard = value;
          await this.ctx.saveAndApplySettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync highlights with notes only')
      .setDesc(
        'If checked, highlights will only be synced if they have a note. This makes it easier to use these notes for zettelkasten.'
      )
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.syncNotesOnly).onChange(async (value) => {
          this.ctx.settings.syncNotesOnly = value;
          await this.ctx.saveAndApplySettings();
        })
      );
  }

  private renderFileTracking(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('File tracking').setHeading();

    new Setting(containerEl)
      .setName('Enable file tracking')
      .setDesc(
        createFragment((fragment) => {
          fragment.appendText(
            'Track your Readwise notes using their unique Readwise URL to enable reliable updates and deduplication. See the Wiki: '
          );
          fragment
            .createEl('a', {
              text: 'File tracking and naming',
              href: 'https://github.com/jsonMartin/readwise-mirror/wiki/Guide:-File-tracking-and-naming',
            })
            .setAttr('target', '_blank');
        })
      )
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.trackFiles).onChange(async (value) => {
          if (!value) {
            new WarningDialog(
              this.app,
              'Risk of inconsistency',
              createFragment((fragment) => {
                fragment.createDiv({
                  text: 'Disabling file tracking may lead to loss of consistency in your Obsidian vault if you sync Readwise notes without tracking properties and then re-enable file tracking again.',
                });
                fragment.createEl('br');
                fragment.createDiv({ text: 'Are you sure you want to continue?' });
              }),

              (confirmed: boolean) => {
                if (confirmed) {
                  void (async () => {
                    this.ctx.settings.trackFiles = false;
                    await this.ctx.saveAndApplySettings();
                    this.display();
                  })();
                } else {
                  toggle.setValue(true);
                }
              }
            ).open();
          } else {
            this.ctx.settings.trackFiles = value;
            await this.ctx.saveAndApplySettings();
            this.display();
          }
        })
      );

    if (this.ctx.settings.trackFiles) {
      new Setting(containerEl)
        .setClass('indent')
        .setName('Tracking property')
        .setDesc('Protected frontmatter property used to track the unique Readwise URL across syncs (default: uri).')
        .addText((text) =>
          text.setValue(this.ctx.settings.trackingProperty).onChange(async (value) => {
            this.ctx.settings.trackingProperty = value || 'uri';
            await this.ctx.saveAndApplySettings();
          })
        );

      new Setting(containerEl)
        .setClass('indent')
        .setName('Track across vault')
        .setDesc('Track, and update files across your entire vault, and not just inside the Readwise library folder.')
        .addToggle((toggle) =>
          toggle.setValue(this.ctx.settings.trackAcrossVault).onChange(async (value) => {
            if (!value) {
              new WarningDialog(
                this.app,
                'Risk of inconsistency',
                createFragment((fragment) => {
                  fragment.createDiv({
                    text: 'Once enabled, disabling file tracking across the vault may lead to loss of consistency in your Obsidian vault and duplicate notes. Tracked Readwise notes that you previously moved outside the Readwise library folder might be re-created inside the Readwise library. ',
                  });
                  fragment.createEl('br');
                  fragment.createDiv({ text: 'Are you sure you want to continue?' });
                }),
                (confirmed: boolean) => {
                  if (confirmed) {
                    void (async () => {
                      this.ctx.settings.trackAcrossVault = false;
                      await this.ctx.saveAndApplySettings();
                      this.display();
                    })();
                  } else {
                    toggle.setValue(true);
                  }
                }
              ).open();
            } else {
              this.ctx.settings.trackAcrossVault = value;
              await this.ctx.saveAndApplySettings();
              this.display();
            }
          })
        );

      new Setting(containerEl)
        .setClass('indent')
        .setName('Remove duplicate files')
        .setDesc(
          createFragment((fragment) => {
            fragment.appendText(
              'Duplicate notes with the same Readwise URL will be removed when enabled. Otherwise, they will be marked with duplicate: true in frontmatter.'
            );
          })
        )
        .addToggle((toggle) =>
          toggle.setValue(this.ctx.settings.deleteDuplicates).onChange(async (value) => {
            if (value) {
              const modal = new Modal(this.app);
              modal.titleEl.setText('Warning');
              modal.contentEl.createEl('p', {
                text: 'This will permanently delete duplicate files instead of marking them. If enabled, files in your vault will be deleted when duplicates are found. Are you sure you want to continue?',
              });

              const buttonContainer = modal.contentEl.createDiv();
              buttonContainer.addClass('readwise-modal-actions');
              buttonContainer.addClass('readwise-modal-actions-spaced');

              const cancelButton = buttonContainer.createEl('button', {
                text: 'Cancel',
              });
              const confirmButton = buttonContainer.createEl('button', {
                text: 'Confirm',
              });
              confirmButton.addClass('readwise-modal-danger-btn');

              cancelButton.onclick = () => {
                toggle.setValue(false);
                modal.close();
              };

              confirmButton.onclick = () => {
                void (async () => {
                  this.ctx.settings.deleteDuplicates = true;
                  await this.ctx.saveAndApplySettings();
                  modal.close();
                })();
              };

              modal.open();
            } else {
              this.ctx.settings.deleteDuplicates = false;
              await this.ctx.saveAndApplySettings();
            }
          })
        );
    }
  }

  private renderFilenameSettings(containerEl: HTMLElement): void {
    if (this.ctx.settings.trackFiles) {
      new Setting(containerEl).setName('Filename updates and filename templates').setHeading();

      new Setting(containerEl)
        .setName('File name updates')
        .setDesc(
          createFragment((fragment) => {
            fragment.appendText('Enable file name updates on sync and customize how filenames are generated.');
            fragment.createEl('br');
            fragment.appendText('See the ');
            fragment
              .createEl('a', {
                text: 'File tracking and naming',
                href: 'https://github.com/jsonMartin/readwise-mirror/wiki/Guide:-File-tracking-and-naming',
              })
              .setAttr('target', '_blank');
            fragment.appendText(' wiki for details.');
          })
        )
        .addToggle((toggle) =>
          toggle.setValue(this.ctx.settings.enableFileNameUpdates).onChange(async (value) => {
            this.ctx.settings.enableFileNameUpdates = value;
            await this.ctx.saveAndApplySettings();
            this.display();
          })
        );
    }

    if (this.ctx.settings.trackFiles && this.ctx.settings.enableFileNameUpdates) {
      new Setting(containerEl)
        .setName('Use custom filename template')
        .setDesc('Enable custom filename templates using nunjucks variables.')
        .addToggle((toggle) =>
          toggle.setValue(this.ctx.settings.useCustomFilename).onChange(async (value) => {
            this.ctx.settings.useCustomFilename = value;
            await this.ctx.saveAndApplySettings();
            this.display();
          })
        );

      if (this.ctx.settings.useCustomFilename) {
        new Setting(containerEl)
          .setClass('indent')
          .setName('Filename template')
          .setDesc('Nunjucks template used to generate filenames.')
          .addText((text) =>
            text
              .setPlaceholder('{{title}}')
              .setValue(this.ctx.settings.filenameTemplate)
              .onChange(async (value) => {
                this.ctx.settings.filenameTemplate = value || '{{title}}';
                await this.ctx.saveAndApplySettings();
              })
          );
      }

      new Setting(containerEl)
        .setName('Colon replacement in filenames')
        .setDesc('String used to replace colons (:) in filenames.')
        .addText((text) =>
          text
            .setPlaceholder('Colon replacement in title')
            .setValue(this.ctx.settings.colonSubstitute)
            .onChange(async (value) => {
              if (!value || /[:<>"/\\|?*]/.test(value)) {
                this.ctx.logger.warn(`Colon replacement: empty or invalid value: ${value}`);
                this.ctx.settings.colonSubstitute = DEFAULT_SETTINGS.colonSubstitute;
              } else {
                this.ctx.logger.debug(`Colon replacement: setting value: ${value}`);
                this.ctx.settings.colonSubstitute = value;
              }
              await this.ctx.saveAndApplySettings();
            })
        );

      new Setting(containerEl)
        .setName('Use slugify for filenames')
        .setDesc('Enable slugification to create clean filenames.')
        .addToggle((toggle) =>
          toggle.setValue(this.ctx.settings.useSlugify).onChange(async (value) => {
            this.ctx.settings.useSlugify = value;
            await this.ctx.saveAndApplySettings();
            // Trigger re-render to show/hide property selector
            this.display();
          })
        );

      if (this.ctx.settings.useSlugify) {
        new Setting(containerEl)
          .setClass('indent')
          .setName('Slugify separator')
          .setDesc('Character used as separator in slugified filenames.')
          .addText((text) =>
            text
              .setPlaceholder('-')
              .setValue(this.ctx.settings.slugifySeparator)
              .onChange(async (value) => {
                this.ctx.settings.slugifySeparator = value || '-';
                await this.ctx.saveAndApplySettings();
              })
          );

        new Setting(containerEl)
          .setClass('indent')
          .setName('Slugify lowercase')
          .setDesc('Convert slugified filenames to lowercase.')
          .addToggle((toggle) =>
            toggle.setValue(this.ctx.settings.slugifyLowercase).onChange(async (value) => {
              this.ctx.settings.slugifyLowercase = value;
              await this.ctx.saveAndApplySettings();
            })
          );
      }
    }
  }

  private renderSyncLogging(containerEl: HTMLElement): void {
    new Setting(containerEl).setName('Sync notifications and logging').setHeading();

    new Setting(containerEl)
      .setName('Display sync notifications')
      .setDesc('Display Obsidian notifications during sync operations')
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.syncNotifications).onChange(async (value) => {
          this.ctx.settings.syncNotifications = value;
          await this.ctx.saveAndApplySettings();
        })
      );

    new Setting(containerEl)
      .setName('Sync log')
      .setDesc('Save sync log to file in library')
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.logFile).onChange(async (value) => {
          this.ctx.settings.logFile = value;
          await this.ctx.saveAndApplySettings();
          // Trigger re-render to show/hide log filename setting
          this.display();
        })
      );

    if (this.ctx.settings.logFile) {
      new Setting(containerEl)
        .setClass('indent')
        .setName('Log filename')
        .setDesc('Default: Sync.md')
        .addText((text) =>
          text
            .setPlaceholder('Sync.md')
            .setValue(this.ctx.settings.logFileName)
            .onChange(async (value) => {
              if (!value) return;
              this.ctx.settings.logFileName = value;
              await this.ctx.saveAndApplySettings();
            })
        );
      new Setting(containerEl)
        .setClass('indent')
        .setName('Log path override')
        .setDesc('Vault-relative Markdown path. Leave blank to use the library folder and log filename.')
        .addText((text) => text.setPlaceholder('Logs/Readwise Sync.md').setValue(this.ctx.settings.logFilePath).onChange(async (value) => {
          this.ctx.settings.logFilePath = value.trim();
          await this.ctx.saveAndApplySettings();
        }));
      new Setting(containerEl)
        .setClass('indent')
        .setName('Log title template')
        .setDesc('Nunjucks variables: date, time, summary, report, items.')
        .addTextArea((text) => text.setValue(this.ctx.settings.logTitleTemplate).onChange(async (value) => {
          this.ctx.settings.logTitleTemplate = value;
          await this.ctx.saveAndApplySettings();
        }));
      new Setting(containerEl)
        .setClass('indent')
        .setName('Log body template')
        .setDesc('Nunjucks variables: date, time, summary, report.counts, report.events, items.')
        .addTextArea((text) => text.setValue(this.ctx.settings.logBodyTemplate).onChange(async (value) => {
          this.ctx.settings.logBodyTemplate = value;
          await this.ctx.saveAndApplySettings();
        }));
    }
  }

  private appendMarkdownTemplatePreview(containerEl: HTMLElement, input: HTMLTextAreaElement, kind: 'header' | 'highlight'): void {
    const box = containerEl.createDiv({ cls: 'template-preview' });
    box.createEl('strong', { text: 'Sample rendered note' });
    const result = box.createEl('pre', { cls: 'template-preview-content' });
    const update = () => {
      try {
        const book: Export = {
          user_book_id: 123, is_deleted: false, title: 'Example Book', author: 'Example Author', readable_title: 'Example Book',
          source: 'manual', cover_image_url: 'https://example.com/cover.jpg', unique_url: '', book_tags: [], category: 'books',
          document_note: 'An example document note.', summary: 'Example summary.', readwise_url: 'https://readwise.io/bookreview/123',
          source_url: '', asin: null,
          highlights: [{ id: 456, is_deleted: false, text: 'An example highlight.', note: 'An example comment.', location: 1,
            location_type: 'page', highlighted_at: '2026-01-01', created_at: '2026-01-01', updated_at: '2026-01-01', url: null,
            readwise_url: 'https://readwise.io/open/456', color: 'yellow', book_id: 123, tags: [], is_favorite: false, is_discard: false }],
        };
        const loader = new ReadwiseLoader();
        const env = new ReadwiseEnvironment(loader);
        loader.setSource('header', kind === 'header' ? input.value : this.ctx.settings.headerTemplate);
        loader.setSource('highlight', kind === 'highlight' ? input.value : this.ctx.settings.highlightTemplate);
        const doc = buildReadwiseDocument(book, { basename: 'Example Book', settings: this.ctx.settings });
        const raw = renderMarkdownTemplate(env, loader, { doc, book, highlights: book.highlights,
          headerTemplate: 'header', highlightTemplate: 'highlight', settings: this.ctx.settings });
        const atomizer = new Atomizer();
        atomizer.setCompositeEnvironment();
        result.setText(atomizer.atomize(raw, { basename: doc.sanitized_title, doc, book }).contents);
        input.removeClass('invalid-template');
      } catch (error) {
        result.setText(`Preview error: ${this.getErrorMessage(error)}`);
        input.addClass('invalid-template');
      }
    };
    input.addEventListener('input', update);
    update();
  }

  private renderFrontmatterTemplateSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Templates')
      .setHeading()
      .setDesc(
        createFragment((fragment) => {
          fragment.createEl('p', {
            text: 'The plugin uses three templates to control how your Readwise content is formatted:',
          });

          fragment.createEl('p', {
            text: '1. Frontmatter template: Controls the YAML metadata at the top of each note',
          });
          fragment.createEl('p', {
            text: '2. Header template: Controls the main document structure and metadata below the frontmatter',
          });
          fragment.createEl('p', {
            text: '3. Highlight template: Controls how individual highlights are formatted within the note',
          });

          fragment.createEl('p', {
            text: 'Each template supports nunjucks templating syntax and provides access to specific variables relevant to that section.',
          });
        })
      );

    // Documentation block for templates

    new Setting(containerEl)
      .setName('Frontmatter')
      .setDesc(
        createFragment((fragment) => {
          fragment.appendText('Controls the YAML metadata at the top of each note');
        })
      )
      .setHeading();

    new Setting(containerEl)
      .setName('Add frontmatter')
      .setDesc('Add frontmatter (defined with the frontmatter template below)')
      .addToggle((toggle) =>
        toggle.setValue(this.ctx.settings.frontMatter).onChange(async (value) => {
          // Test template with sample data
          try {
            const { isValidYaml, error } = validateFrontmatterTemplate(this.env, this.ctx.settings.frontMatterTemplate);
            if ((value && isValidYaml) || !value) {
              // Save settings and update the template
              this.ctx.settings.frontMatter = value;
              await this.ctx.saveAndApplySettings();
              // Trigger re-render to show/hide frontmatter settings
              this.display();
            } else if (value && !isValidYaml) {
              this.ctx.notice(`Invalid frontmatter template: ${this.getErrorMessage(error)}`);
              toggle.setValue(false);
              // Trigger re-render to show/hide property selector
              this.display();
            }
          } catch (error) {
            this.ctx.logger.error('Error validating frontmatter template:', error);
            return;
          }
        })
      );

    if (this.ctx.settings.frontMatter) {
      new Setting(containerEl)
        .setClass('indent')
        .setName('Update frontmatter')
        .setDesc(
          createFragment((fragment) => {
            fragment.appendText('Update frontmatter when syncing existing files');
            fragment.createEl('br');
            fragment.createEl('br');
            fragment.appendText(
              'When enabled, frontmatter of existing files will be updated, keeping additional fields that are not present in the template. Works best with file tracking enabled.'
            );
          })
        )
        .addToggle((toggle) =>
          toggle.setValue(this.ctx.settings.updateFrontmatter).onChange(async (value) => {
            this.ctx.settings.updateFrontmatter = value;
            await this.ctx.saveAndApplySettings();
            // Trigger re-render to show/hide protection settings
            this.display();
          })
        );

      if (this.ctx.settings.updateFrontmatter) {
        new Setting(containerEl)
          .setClass('indent')
          .setName('Protect frontmatter fields')
          .setDesc(
            createFragment((fragment) => {
              fragment.appendText('Prevent existing frontmatter fields from being overwritten during sync');
              fragment.createEl('br');
              fragment.createEl('br');
              fragment.appendText(
                'Note: Only fields that already exist in the file will be protected. A field marked for protection which is not present yet in the original field will be written normally at the first write/update, and will be protected henceforth.'
              );
              fragment.createEl('br');
              if (this.ctx.settings.trackFiles) {
                fragment.appendText('The tracking field ');
                fragment.createEl('strong', {
                  text: this.ctx.settings.trackingProperty,
                });
                fragment.appendText(' cannot be protected.');
              }
            })
          )
          .addToggle((toggle) =>
            toggle.setValue(this.ctx.settings.protectFrontmatter).onChange(async (value) => {
              this.ctx.settings.protectFrontmatter = value;
              await this.ctx.saveAndApplySettings();
              this.display();
            })
          );

        if (this.ctx.settings.protectFrontmatter) {
          const validateProtectedFields = (value: string): { isValid: boolean; error?: string } => {
            const fields = value
              .split('\n')
              .map((f) => f.trim())
              .filter((f) => f.length > 0);
            const dedupField = this.ctx.settings.trackingProperty;

            if (this.ctx.settings.trackFiles && fields.includes(dedupField)) {
              return {
                isValid: false,
                error: `Cannot protect tracking field '${dedupField}'`,
              };
            }
            return { isValid: true };
          };

          const container = containerEl.createDiv();
          new Setting(container)
            .setClass('indent')
            .setName('Protected fields')
            .setDesc('Enter one field name per line')
            .addTextArea((text) => {
              const errorDiv = container.createDiv({
                cls: 'validation-error',
                attr: { style: 'color: var(--text-error); margin-top: 0.5em;' },
              });

              const initialRows = 3;
              text.inputEl.addClass('settings-template-input');
              text.inputEl.rows = initialRows;
              text.inputEl.cols = 25;

              text
                .setValue(this.ctx.settings.protectedFields)
                .setPlaceholder('Status\ntags')
                .onChange(async (value) => {
                  const validation = validateProtectedFields(value);
                  errorDiv.setText(validation.error || '');

                  if (validation.isValid) {
                    this.ctx.settings.protectedFields = value;
                    await this.ctx.saveAndApplySettings();
                  }
                });

              const validation = validateProtectedFields(this.ctx.settings.protectedFields);
              errorDiv.setText(validation.error || '');

              // Initial row adjustment
              this.adjustTextareaRows(text.inputEl, initialRows);

              // Adjust on content change
              text.inputEl.addEventListener('input', () => {
                this.adjustTextareaRows(text.inputEl, initialRows);
              });

              return text;
            });
        }
      }
    }

    new Setting(containerEl)
      .setName('Frontmatter template')
      .setDesc(
        createFragment((fragment) => {
          fragment.appendText(
            'Controls YAML frontmatter metadata. The same variables are available as for the Header template, with specific versions optimised for YAML (tags), and escaped values for YAML compatibility.'
          );
        })
      )
      .setHeading();

    new Setting(containerEl)
      .setDesc(
        createFragment((fragment) => {
          fragment.append(
            this.createTemplateDocumentation([
              ['id', 'Document ID'],
              ['linktext', 'Obsidian note linktext for the document (without Wikilink syntax)'],
              ['created', 'Creation timestamp'],
              ['updated', 'Last update timestamp'],
              ['last_highlight_at', 'Last highlight timestamp'],
              ['title', 'Document title (escaped for YAML)'],
              ['sanitized_title', 'Title safe for file system (escaped for YAML)'],
              ['author', 'Author name(s) (escaped for YAML)'],
              ['authorStr', 'Author names with wiki links (escaped for YAML)'],
              ['category', 'Content type'],
              ['num_highlights', 'Number of highlights'],
              ['source_url', 'Original content URL'],
              ['unique_url', 'Unique identifier URL'],
              ['tags', 'Tags with # prefix'],
              ['tags_nohash', 'Tags without # prefix (compatible with frontmatter)'],
              ['highlight_tags', 'Tags from highlights with # prefix'],
              ['hl_tags_nohash', 'Tags from highlights without # prefix (compatible with frontmatter)'],
              ['highlights_url, readwise_url', 'Readwise URL (auto-injected if file tracking enabled)'],
              [
                'Note:',
                'If file tracking is enabled, the specified tracking property will be automatically added or updated in the frontmatter template, independent of the frontmatter settings.',
              ],
            ])
          );
        })
      )
      .addTextArea((text) => {
        const initialRows = 12;
        text.inputEl.addClass('settings-template-input');
        text.inputEl.id = 'frontmatter-template';
        text.inputEl.rows = initialRows;
        text.inputEl.cols = 50;

        const container = containerEl.createDiv();

        // Create preview elements below textarea
        const previewContainer = container.createDiv('template-preview');
        previewContainer.createDiv({
          text: 'Template Preview (Error):',
          cls: ['template-preview-title', 'template-preview-title-error'],
        });

        const errorNotice = previewContainer.createDiv({
          cls: 'validation-notice',
        });
        errorNotice.id = 'validation-notice';

        const previewContent = previewContainer.createEl('pre', {
          cls: ['template-preview-content', 'settings-template-input'],
        });
        previewContent.id = 'template-preview-content';

        const errorDetails = previewContainer.createEl('pre', {
          cls: ['error-details'],
          attr: {
            style:
              'color: var(--text-error); background-color: var(--background-primary-alt); padding: 0.5em; border-radius: 4px; margin-top: 0.5em; font-family: monospace; white-space: pre-wrap;',
          },
        });
        errorDetails.id = 'error-details';

        errorDetails.hide();

        // Update preview on template changes
        const updatePreview = (result: TemplateValidationResult) => {
          const isInvalidTemplate = result.isValidTemplate === false;
          const isInvalidYaml = result.isValidYaml === false;
          const hasError = isInvalidTemplate || isInvalidYaml;

          if (isInvalidTemplate) {
            errorNotice.setText('Your frontmatter template contains invalid nunjucks syntax.');
            errorDetails.setText(result.error ?? '');
          } else if (isInvalidYaml) {
            errorNotice.setText('Your frontmatter template creates invalid YAML.');
            errorDetails.setText(result.error ?? '');
          } else {
            errorNotice.setText('');
            errorDetails.setText('');
          }

          if (result.preview) {
            previewContent.setText(result.preview);
          }

          text.inputEl.toggleClass('invalid-template', hasError);
          errorDetails.toggle(hasError);
          previewContainer.toggle(hasError && result.preview !== '');
        };

        // Display rendered template on load
        try {
          const validationResult: TemplateValidationResult = validateFrontmatterTemplate(
            this.env,
            this.ctx.settings.frontMatterTemplate
          );
          updatePreview(validationResult);
        } catch (error) {
          // Catch Nunjucks template errors
          this.ctx.logger.error('Error validating frontmatter template:', error);
          const errorMessage = this.getErrorMessage(error);
          updatePreview({
            isValidYaml: false,
            isValidTemplate: false,
            error: errorMessage,
            preview: this.ctx.settings.frontMatterTemplate,
          });
        }
        text.setValue(sanitizeFrontmatterTemplate(this.ctx.settings.frontMatterTemplate)).onChange(async (value) => {
          const noticeEl = containerEl.querySelector('#validation-notice');
          try {
            const validationResult: TemplateValidationResult = validateFrontmatterTemplate(this.env, value);

            // Update validation notice
            if (noticeEl) {
              noticeEl.setText(validationResult.isValidYaml ? '' : (validationResult.error ?? ''));
            }

            // Set the frontmatter in settings, but only if enabled
            if (!value && this.ctx.settings.frontMatter) {
              this.ctx.settings.frontMatterTemplate = DEFAULT_SETTINGS.frontMatterTemplate;
            } else {
              this.ctx.settings.frontMatterTemplate = sanitizeFrontmatterTemplate(value);
            }

            updatePreview(validationResult);
            await this.ctx.saveAndApplySettings();
          } catch (error) {
            // Catch Nunjucks template errors
            this.ctx.logger.error('Error validating frontmatter template:', error);
            const errorMessage = this.getErrorMessage(error);

            if (noticeEl) {
              noticeEl.setText(`Error validating frontmatter template: ${errorMessage}`);
              updatePreview({
                isValidYaml: false,
                isValidTemplate: false,
                error: errorMessage,
                preview: value,
              });
            }
          }
        });

        // Initial row adjustment
        this.adjustTextareaRows(text.inputEl, initialRows);

        // Adjust on content change
        text.inputEl.addEventListener('input', () => {
          this.adjustTextareaRows(text.inputEl, initialRows);
        });

        return text;
      });
  }

  private renderHeaderTemplateSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Header template')
      .setDesc(
        createFragment((fragment) => {
          fragment.appendText('Controls document metadata and structure.');
        })
      )
      .setHeading();

    new Setting(containerEl)
      .setDesc(
        this.createTemplateDocumentation([
          ['id', 'Document ID'],
          ['title', 'Document title'],
          ['sanitized_title', 'Title safe for file system'],
          ['author/authorStr', 'Author name(s), authorStr includes wiki links'],
          ['category', 'Content type (books, articles, etc)'],
          ['cover_image_url', 'Book/article cover'],
          ['summary', 'Document summary'],
          ['document_note', 'Additional notes'],
          ['num_highlights', 'Number of highlights'],
          ['highlights_url, readwise_url', 'Readwise URL'],
          ['source_url', 'Original content URL'],
          ['unique_url', 'Unique identifier URL'],
          ['created/updated/last_highlight_at', 'Timestamps'],
          ['tags/tags_nohash', 'Tags (with/without # prefix)'],
          ['highlight_tags/hl_tags_nohash', 'Tags from highlights (with/without # prefix)'],
        ])
      )
      .addTextArea((text) => {
        const initialRows = 15;
        text.inputEl.addClass('settings-template-input');
        text.inputEl.rows = initialRows;
        text.inputEl.cols = 50;
        text.setValue(this.ctx.settings.headerTemplate).onChange(async (value) => {
          if (!value) {
            this.ctx.settings.headerTemplate = DEFAULT_SETTINGS.headerTemplate;
          } else {
            this.ctx.settings.headerTemplate = value;
          }
          await this.ctx.saveAndApplySettings();
        });

        // Initial row adjustment
        this.adjustTextareaRows(text.inputEl, initialRows);

        // Adjust on content change
        text.inputEl.addEventListener('input', () => {
          this.adjustTextareaRows(text.inputEl, initialRows);
        });

        this.appendMarkdownTemplatePreview(containerEl, text.inputEl, 'header');

        return text;
      });
  }

  private renderHighlightTemplateSettings(containerEl: HTMLElement): void {
    new Setting(containerEl)
      .setName('Highlight template')
      .setDesc(
        createFragment((fragment) => {
          fragment.appendText('Controls individual highlight formatting.');
        })
      )
      .setHeading();

    new Setting(containerEl)
      .setDesc(
        this.createTemplateDocumentation([
          [
            'doc',
            'Parent document (Check-out Header template for details). Individual fields can be accessed as doc.<field>: doc.id would return the id of the parent document, doc.linktext the parent document link (without Wikilink syntax).)',
          ],
          ['text', 'Highlight content (supports bq filter for blockquotes)'],
          ['note', 'Associated notes (supports qa filter for Q&A format)'],
          ['color', 'Highlight color'],
          ['location', 'Book location'],
          ['location_url', 'Direct link to highlight location'],
          ['locationUrl', 'Direct link to highlight location (legacy variable)'],
          ['url', 'Source URL'],
          ['id', 'Highlight ID'],
          ['category', 'Content type (e.g., books)'],
          ['tags', 'Tags with # prefix'],
          ['created_at', 'Creation timestamp'],
          ['updated_at', 'Last update timestamp'],
          ['highlighted_at', 'Highlight timestamp'],
        ])
      )
      .addTextArea((text) => {
        const initialRows = 12;
        text.inputEl.addClass('settings-template-input');
        text.inputEl.rows = initialRows;
        text.inputEl.cols = 50;
        text.setValue(this.ctx.settings.highlightTemplate).onChange(async (value) => {
          if (!value) {
            this.ctx.settings.highlightTemplate = DEFAULT_SETTINGS.highlightTemplate;
          } else {
            this.ctx.settings.highlightTemplate = value;
          }
          await this.ctx.saveAndApplySettings();
        });

        // Initial row adjustment
        this.adjustTextareaRows(text.inputEl, initialRows);

        // Adjust on content change
        text.inputEl.addEventListener('input', () => {
          this.adjustTextareaRows(text.inputEl, initialRows);
        });

        this.appendMarkdownTemplatePreview(containerEl, text.inputEl, 'highlight');

        return text;
      });
  }
}
