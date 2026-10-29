export type SyncAction = 'created' | 'updated' | 'marked duplicate' | 'trashed duplicate' | 'untagged' | 'skipped' | 'failed';

export interface SyncEvent {
  action: SyncAction;
  path: string;
  detail?: string;
  bookId?: number; // Readwise book behind the event, used to retry failures
}

export interface SyncReport {
  events: SyncEvent[];
  counts: Record<SyncAction, number>;
}

export function createSyncReport(events: SyncEvent[]): SyncReport {
  const counts: SyncReport['counts'] = {
    created: 0,
    updated: 0,
    'marked duplicate': 0,
    'trashed duplicate': 0,
    untagged: 0,
    skipped: 0,
    failed: 0,
  };
  for (const event of events) counts[event.action]++;
  return { events: [...events], counts };
}

export function summarizeSyncReport(report: SyncReport): string {
  const { counts } = report;
  return `${counts.created} created, ${counts.updated} updated, ${counts['marked duplicate']} marked, ${counts['trashed duplicate']} trashed${counts.untagged ? `, ${counts.untagged} untagged` : ''}${counts.skipped ? `, ${counts.skipped} skipped` : ''}`;
}
