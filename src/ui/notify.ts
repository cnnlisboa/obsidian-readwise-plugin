import { Notice } from 'obsidian';
import type { PluginSettings } from 'types/settings';

export default class Notify {
  private statusBarMode: PluginSettings['statusBarMode'] = 'full';
  private statusBarText = '';

  constructor(private _statusBarItem: HTMLElement) {}

  get statusBarItem(): HTMLElement {
    return this._statusBarItem;
  }

  notice(message: string, duration = 5000) {
    new Notice(message, duration);
  }

  setStatusBarText(message: string) {
    // Ensure the message is a string
    this.statusBarText = typeof message === 'string' ? message : '';
    this.renderStatusBar();
  }

  setStatusBarMode(mode: PluginSettings['statusBarMode']) {
    this.statusBarMode = mode;
    this.renderStatusBar();
  }

  private renderStatusBar() {
    this._statusBarItem.style.display = this.statusBarMode === 'hidden' ? 'none' : '';
    const progress = this.statusBarText.match(/Processing - (\d+)%/);
    const compactText = progress ? `RW ${progress[1]}%`
      : /error|failed/i.test(this.statusBarText) ? 'RW: Error'
      : /Token Required/i.test(this.statusBarText) ? 'RW: Token'
      : /Synced|Updated/i.test(this.statusBarText) ? 'RW: Synced'
      : 'RW: Sync';
    this._statusBarItem.setText(this.statusBarMode === 'compact' && this.statusBarText ? compactText : this.statusBarText);
    this._statusBarItem.title = this.statusBarText;
    this._statusBarItem.setAttribute('aria-label', this.statusBarText);
  }

  getStatusBarText(): string {
    return this.statusBarText;
  }
}
