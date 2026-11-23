import { Modal, Setting } from 'obsidian';
import type { ProcessedRecord } from 'services/highlight-rules';
import type { PluginContext } from 'types/plugin-context';

/** Highlights a rule processed and that wait for the grace period to end. */
export class PendingDeletionsModal extends Modal {
  constructor(private ctx: PluginContext, private pending: [string, ProcessedRecord][],
    private keep: (id: string) => Promise<void>) {
    super(ctx.app);
  }

  onOpen(): void {
    this.render();
  }

  private render(): void {
    const { contentEl, ctx } = this;
    contentEl.empty();
    this.titleEl.setText('Highlights waiting to be deleted');
    const mode = ctx.settings.rulesDryRun
      ? 'Dry run is on: nothing is deleted. Turn it off in settings when you trust the rules.'
      : `Deleted from Readwise ${ctx.settings.rulesGraceDays} day(s) after their note was written.`;
    contentEl.createEl('p', { text: mode });
    if (this.pending.length === 0) {
      contentEl.createEl('p', { text: 'Nothing is waiting.' });
      return;
    }
    for (const [id, record] of this.pending) {
      const marked = record.markedAt ? record.markedAt.slice(0, 10) : '';
      new Setting(contentEl)
        .setName(record.text.length > 80 ? `${record.text.slice(0, 80)}…` : record.text)
        .setDesc(`${record.bookTitle} · ${record.rule}${record.kind ? `/${record.kind}` : ''} · marked ${marked} · ${record.path ?? ''}`)
        .addButton((b) => b.setButtonText('Keep in Readwise').onClick(async () => {
          await this.keep(id);
          this.pending = this.pending.filter(([other]) => other !== id);
          this.render();
        }));
    }
  }
}
