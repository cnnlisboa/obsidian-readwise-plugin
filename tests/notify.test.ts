import { describe, expect, it } from '@jest/globals';
import Notify from 'ui/notify';

describe('status bar display', () => {
  it('switches between full, compact, and hidden while retaining the latest status', () => {
    const attributes = new Map<string, string>();
    const item = {
      style: { display: '' },
      textContent: '',
      title: '',
      setText(text: string) { this.textContent = text; },
      setAttribute(name: string, value: string) { attributes.set(name, value); },
    } as unknown as HTMLElement;
    const notify = new Notify(item);

    notify.setStatusBarText('Readwise: Processing - 42% finished (2/5)');
    expect(item.textContent).toBe('Readwise: Processing - 42% finished (2/5)');

    notify.setStatusBarMode('compact');
    expect(item.textContent).toBe('RW 42%');
    expect(item.title).toBe('Readwise: Processing - 42% finished (2/5)');
    expect(attributes.get('aria-label')).toBe(item.title);

    notify.setStatusBarMode('hidden');
    notify.setStatusBarText('Readwise: Sync error network unavailable');
    expect(item.style.display).toBe('none');

    notify.setStatusBarMode('compact');
    expect(item.style.display).toBe('');
    expect(item.textContent).toBe('RW: Error');
    notify.setStatusBarMode('full');
    expect(item.textContent).toBe('Readwise: Sync error network unavailable');
  });
});
