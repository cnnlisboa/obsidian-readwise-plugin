export type SyncAction = 'created' | 'updated' | 'marked duplicate' | 'trashed duplicate' | 'failed';

export interface SyncEvent {
  action: SyncAction;
  path: string;
  detail?: string;
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
    failed: 0,
  };
  for (const event of events) counts[event.action]++;
  return { events: [...events], counts };
}

export function summarizeSyncReport(report: SyncReport): string {
  const { counts } = report;
  return `${counts.created} created, ${counts.updated} updated, ${counts['marked duplicate']} marked, ${counts['trashed duplicate']} trashed`;
}
