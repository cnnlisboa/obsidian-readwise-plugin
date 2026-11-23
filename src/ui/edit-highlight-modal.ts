import { Modal, Notice, requestUrl, Setting } from 'obsidian';
import type { PluginContext } from 'types/plugin-context';

interface RemoteHighlight {
  id: number;
  text: string;
  note: string;
  url: string | null;
  external_id?: string | null;
  tags: { id: number; name: string }[];
}

async function call(ctx: PluginContext, method: string, url: string, body?: unknown) {
  return requestUrl({
    url,
    method,
    headers: { Authorization: `Token ${ctx.settings.apiToken}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    throw: false,
  });
}

/** Highlights made in Reader can only change their note and tags (Reader API). */
export function isReaderHighlight(h: Pick<RemoteHighlight, 'url' | 'external_id'>): boolean {
  return !!h.external_id && !h.external_id.startsWith('epub-toc') && (h.url ?? '').startsWith('https://read.readwise.io');
}

export function parseTagList(text: string): string[] {
  return [...new Set(text.split(',').map((t) => t.trim()).filter(Boolean))];
}

/**
 * Edit a Readwise highlight's text, note and tags from Obsidian. Saving
 * writes to Readwise, then `afterSave` re-syncs so the note shows the change.
 */
export class EditHighlightModal extends Modal {
  private highlight?: RemoteHighlight;

  constructor(private ctx: PluginContext, private id: number, private afterSave: () => Promise<void>) {
    super(ctx.app);
  }

  async onOpen(): Promise<void> {
    this.titleEl.setText('Edit Readwise highlight');
    this.contentEl.createEl('p', { text: 'Loading…' });
    const response = await call(this.ctx, 'GET', `https://readwise.io/api/v2/highlights/${this.id}/`);
    if (response.status !== 200) {
      this.contentEl.empty();
      this.contentEl.createEl('p', { text: `Couldn't load highlight ${this.id} (HTTP ${response.status}).` });
      return;
    }
    this.highlight = response.json as RemoteHighlight;
    this.render();
  }

  private render(): void {
    const h = this.highlight;
    if (!h) return;
    const { contentEl } = this;
    contentEl.empty();
    const reader = isReaderHighlight(h);
    let text = h.text;
    let note = h.note ?? '';
    let tags = (h.tags ?? []).map((t) => t.name).join(', ');

    new Setting(contentEl)
      .setName('Text')
      .setDesc(reader ? 'Made in Reader: the passage can only be changed by highlighting it again in Reader.' : '')
      .addTextArea((t) => {
        t.setValue(text).onChange((v) => { text = v; });
        t.inputEl.rows = 5;
        t.inputEl.addClass('readwise-edit-highlight-text');
        t.setDisabled(reader);
      });
    new Setting(contentEl).setName('Note').addTextArea((t) => {
      t.setValue(note).onChange((v) => { note = v; });
      t.inputEl.rows = 4;
    });
    new Setting(contentEl)
      .setName('Tags')
      .setDesc('Comma-separated. A rule tag (like reference/book) runs its rule at the next sync.')
      .addText((t) => t.setValue(tags).onChange((v) => { tags = v; }));
    new Setting(contentEl)
      .addButton((b) => b.setButtonText('Save').setCta().onClick(async () => {
        b.setDisabled(true);
        try {
          await this.save(text, note, parseTagList(tags));
          this.close();
          new Notice('Readwise: highlight saved. Updating the note…');
          await this.afterSave();
        } catch (error) {
          new Notice(`Readwise: could not save the highlight. ${String(error)}`);
          b.setDisabled(false);
        }
      }))
      .addButton((b) => b.setButtonText('Cancel').onClick(() => this.close()));
  }

  private async save(text: string, note: string, tags: string[]): Promise<void> {
    const h = this.highlight;
    if (!h) return;
    const ctx = this.ctx;
    if (isReaderHighlight(h)) {
      const response = await call(ctx, 'PATCH', `https://readwise.io/api/v3/update/${h.external_id}/`, { notes: note, tags });
      if (response.status < 200 || response.status >= 300) throw new Error(`Reader HTTP ${response.status}`);
      return;
    }
    if (text !== h.text || note !== (h.note ?? '')) {
      const response = await call(ctx, 'PATCH', `https://readwise.io/api/v2/highlights/${h.id}/`, { text, note });
      if (response.status < 200 || response.status >= 300) throw new Error(`HTTP ${response.status}`);
    }
    const have = new Map((h.tags ?? []).map((t) => [t.name.toLowerCase(), t]));
    const want = new Set(tags.map((t) => t.toLowerCase()));
    for (const name of tags) {
      if (!have.has(name.toLowerCase())) {
        const response = await call(ctx, 'POST', `https://readwise.io/api/v2/highlights/${h.id}/tags/`, { name });
        if (response.status < 200 || response.status >= 300) throw new Error(`tag "${name}": HTTP ${response.status}`);
      }
    }
    for (const [key, tag] of have) {
      if (!want.has(key)) {
        await call(ctx, 'DELETE', `https://readwise.io/api/v2/highlights/${h.id}/tags/${tag.id}/`);
      }
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Highlight id on or just above the cursor line: a readwise.io/open link or ^rw<id>H. */
export function highlightIdNear(lines: string[], line: number): number | null {
  for (let i = line; i >= Math.max(0, line - 12); i--) {
    const match = /readwise\.io\/open\/(\d+)/.exec(lines[i] ?? '') ?? /\^rw(\d+)[HN]\b/.exec(lines[i] ?? '')
      ?? /^#+\s+rw(\d+)\s*$/.exec(lines[i] ?? '');
    if (match) return Number(match[1]);
  }
  return null;
}
