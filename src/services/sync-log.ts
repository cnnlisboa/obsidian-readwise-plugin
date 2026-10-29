import { normalizePath } from 'obsidian';
import type { Environment } from 'nunjucks';
import type { PluginSettings } from 'types/settings';
import { summarizeSyncReport, type SyncReport } from './sync-report';

export interface SyncLogItem {
  id: number;
  title: string;
  highlights: number;
  category: string;
}

export function resolveSyncLogPath(settings: PluginSettings): string {
  const configured = settings.logFilePath.trim() || `${settings.baseFolderName}/${settings.logFileName}`;
  if (configured.startsWith('/') || configured.split('/').includes('..') || !configured.endsWith('.md')) {
    throw new Error('Sync log path must be a vault-relative Markdown path without parent traversal.');
  }
  return normalizePath(configured);
}

export function renderSyncLog(
  env: Environment,
  settings: PluginSettings,
  report: SyncReport,
  items: SyncLogItem[],
  date: string,
  time: string
): string {
  const context = { date, time, items, report, summary: summarizeSyncReport(report) };
  return [
    env.renderString(settings.logTitleTemplate, context),
    env.renderString(settings.logBodyTemplate, context),
  ].filter(Boolean).join('\n\n').trim();
}
