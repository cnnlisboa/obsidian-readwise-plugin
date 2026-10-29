import { requestUrl, type TFile } from 'obsidian';
import type { PluginContext } from 'types/plugin-context';
import { markSent, readEditableNotes, type EditableNote } from './writeback-sections';

interface PendingNote { note: EditableNote; remote: string; url: string; body: Record<string, string> }

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

async function readRemote(ctx: PluginContext, note: EditableNote, readerId: string | undefined): Promise<PendingNote> {
  const token = ctx.settings.apiToken;
  if (!token) throw new Error('An API token is required for write-back.');
  const headers = { Authorization: `Token ${token}` };
  if (note.target === 'reader') {
    if (!readerId || !/^[a-z0-9_-]+$/i.test(readerId)) throw new Error('This note has no valid Reader document ID.');
    const response = await requestUrl({ url: `https://readwise.io/api/v3/list/?id=${encodeURIComponent(readerId)}`, headers, throw: false });
    const data: unknown = response.json;
    const results = record(data) ? data.results : undefined;
    if (response.status !== 200 || !Array.isArray(results) || results.length !== 1 || !record(results[0]) || typeof results[0].notes !== 'string') {
      throw new Error(`Could not read the current Reader document note (HTTP ${response.status}).`);
    }
    return { note, remote: results[0].notes,
      url: `https://readwise.io/api/v3/update/${readerId}/`, body: { notes: note.text } };
  }
  const id = Number(note.target.slice('highlight-'.length));
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid Readwise highlight ID.');
  const url = `https://readwise.io/api/v2/highlights/${id}/`;
  const response = await requestUrl({ url, headers, throw: false });
  const data: unknown = response.json;
  if (response.status !== 200 || !record(data) || data.id !== id || typeof data.note !== 'string') {
    throw new Error(`Could not read Readwise highlight ${id} (HTTP ${response.status}).`);
  }
  return { note, remote: data.note, url, body: { note: note.text } };
}

export async function sendEditedNotes(ctx: PluginContext, file: TFile, confirm: (items: string[]) => Promise<boolean>): Promise<number> {
  const token = ctx.settings.apiToken;
  if (!token) throw new Error('An API token is required for write-back.');
  const content = await ctx.app.vault.cachedRead(file);
  const changed = readEditableNotes(content).filter((note) => note.text.trim() !== note.baseline.trim());
  if (!changed.length) return 0;
  const readerId: unknown = ctx.app.metadataCache.getFileCache(file)?.frontmatter?.reader_id;
  const pending: PendingNote[] = [];
  for (const note of changed) {
    if (note.target === 'reader' && !ctx.settings.writebackReaderNotes) throw new Error('Reader note write-back is disabled.');
    if (note.target !== 'reader' && !ctx.settings.writebackHighlightNotes) throw new Error('Highlight note write-back is disabled.');
    const item = await readRemote(ctx, note, typeof readerId === 'string' ? readerId : undefined);
    if (item.remote.trim() !== note.baseline.trim()) {
      throw new Error(`${note.target} changed in Readwise since it was imported. Review the remote note before sending.`);
    }
    pending.push(item);
  }
  if (!(await confirm(pending.map(({ note, remote }) => `${note.target}\nFrom:\n${remote || '(empty)'}\n\nTo:\n${note.text || '(empty)'}`)))) return 0;

  let sent = 0;
  for (const item of pending) {
    const response = await requestUrl({ url: item.url, method: 'PATCH',
      headers: { Authorization: `Token ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(item.body), throw: false });
    if (response.status !== 200) throw new Error(`Write-back failed for ${item.note.target} (HTTP ${response.status}). ${sent} notes were sent before this failure.`);
    await ctx.app.vault.process(file, (current) => markSent(current, item.note.target, item.note.text));
    sent++;
  }
  return sent;
}

export async function rebaseEditedNotes(ctx: PluginContext, file: TFile, confirm: (items: string[]) => Promise<boolean>): Promise<number> {
  const content = await ctx.app.vault.cachedRead(file);
  const changed = readEditableNotes(content).filter((note) => note.text.trim() !== note.baseline.trim());
  const readerId: unknown = ctx.app.metadataCache.getFileCache(file)?.frontmatter?.reader_id;
  const conflicts: PendingNote[] = [];
  for (const note of changed) {
    const item = await readRemote(ctx, note, typeof readerId === 'string' ? readerId : undefined);
    if (item.remote.trim() !== note.baseline.trim()) conflicts.push(item);
  }
  if (!conflicts.length) return 0;
  if (!(await confirm(conflicts.map(({ note, remote }) =>
    `${note.target}\nPrevious remote:\n${note.baseline || '(empty)'}\n\nCurrent remote:\n${remote || '(empty)'}\n\nYour local edit:\n${note.text || '(empty)'}`)))) return 0;
  for (const item of conflicts) {
    await ctx.app.vault.process(file, (current) => markSent(current, item.note.target, item.remote));
  }
  return conflicts.length;
}
