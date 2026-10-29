import { describe, expect, it, jest } from '@jest/globals';
import { Environment } from 'nunjucks';
import { DEFAULT_SETTINGS } from 'src/constants';
import { LOCAL_END, LOCAL_START, preserveLocalSection } from 'services/local-section';
import { renderSyncLog, resolveSyncLogPath } from 'services/sync-log';
import { createSyncReport, summarizeSyncReport } from 'services/sync-report';
import { Controller } from 'services/controller';
import type ReadwiseMirror from 'main';
import type { PluginContext } from 'types/plugin-context';

jest.mock('obsidian', () => ({ normalizePath: (path: string) => path }));
jest.mock('utils/file-utils', () => ({ getTrackingUrl: jest.fn(), isFileInFolder: jest.fn(), normalizeFilename: jest.fn() }));

describe('Phase 2 output controls', () => {
  it('preserves only the marked local section across regenerated content', () => {
    const first = preserveLocalSection(null, 'Generated A', true);
    const edited = first.replace(`${LOCAL_START}\n${LOCAL_END}`, `${LOCAL_START}\nMy notes\n${LOCAL_END}`);
    const next = preserveLocalSection(edited, 'Generated B', true);
    expect(next).toContain('Generated B');
    expect(next).toContain('My notes');
    expect(next).not.toContain('Generated A');
    expect(preserveLocalSection(edited, 'Generated B', false)).toBe('Generated B');
  });

  it('refuses to overwrite a note with broken local-section markers', () => {
    expect(() => preserveLocalSection(`${LOCAL_START}\nUnclosed note`, 'Generated B', true)).toThrow('missing or duplicate');
    expect(() => preserveLocalSection(null, `Generated ${LOCAL_START}`, true)).toThrow('reserved');
  });

  it('formats a report and configurable sync log', () => {
    const report = createSyncReport([
      { action: 'created', path: 'Readwise Sync/Books/One.md' },
      { action: 'updated', path: 'Readwise Sync/Books/Two.md' },
    ]);
    const settings = { ...DEFAULT_SETTINGS, logFilePath: 'Logs/Readwise.md',
      logTitleTemplate: '# Sync {{ date }}', logBodyTemplate: '{{ summary }}\n{% for event in report.events %}{{ event.action }} {{ event.path }}\n{% endfor %}' };
    expect(resolveSyncLogPath(settings)).toBe('Logs/Readwise.md');
    expect(summarizeSyncReport(report)).toContain('1 created, 1 updated');
    expect(renderSyncLog(new Environment(), settings, report, [], '2026-10-29', '12:00')).toContain('created Readwise Sync/Books/One.md');
  });

  it('rejects log paths outside the vault', () => {
    expect(() => resolveSyncLogPath({ ...DEFAULT_SETTINGS, logFilePath: '../outside.md' })).toThrow('vault-relative');
    expect(() => resolveSyncLogPath({ ...DEFAULT_SETTINGS, logFilePath: '/absolute.md' })).toThrow('vault-relative');
  });

  it('leaves the checkpoint and files untouched when preview is cancelled', async () => {
    const ctx = {
      settings: { ...DEFAULT_SETTINGS, previewSync: true, lastUpdated: '2026-01-01T00:00:00.000Z' },
      syncLock: { isAcquired: () => false, acquire: async () => {}, release: () => {} },
      logger: { error: jest.fn(), debug: jest.fn() },
      notice: jest.fn(), setStatusBarText: jest.fn(), saveAndApplySettings: jest.fn(),
    } as unknown as PluginContext;
    const plugin = {
      confirmSyncPreview: jest.fn(async () => false),
      writeLibraryToMarkdown: jest.fn(),
    } as unknown as ReadwiseMirror;
    const controller = new Controller(plugin, ctx);
    (controller as unknown as { api: { downloadUpdates: () => Promise<unknown> } }).api = {
      downloadUpdates: async () => ({ books: {}, categories: new Set(), highlightCount: 0 }),
    };
    const validation = jest.spyOn(Controller, 'validateAPIInstance').mockResolvedValue(true);

    await controller.sync();

    expect(plugin.writeLibraryToMarkdown).not.toHaveBeenCalled();
    expect(ctx.settings.lastUpdated).toBe('2026-01-01T00:00:00.000Z');
    validation.mockRestore();
  });
});
