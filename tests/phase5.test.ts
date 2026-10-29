import { describe, expect, it, jest } from '@jest/globals';
import { requestUrl, TFile } from 'obsidian';
import { DEFAULT_SETTINGS } from 'src/constants';
import { rebaseEditedNotes, sendEditedNotes } from 'services/writeback';
import { mergeEditableNotes, readEditableNotes } from 'services/writeback-sections';
import type { PluginContext } from 'types/plugin-context';

jest.mock('obsidian', () => ({ requestUrl: jest.fn(), TFile: class {} }));
const api = requestUrl as jest.MockedFunction<typeof requestUrl>;

function context(contents: string, readerId?: string) {
  const file = Object.assign(new TFile(), { path: 'Readwise Sync/note.md' });
  let text = contents;
  const ctx = {
    settings: { ...DEFAULT_SETTINGS, apiToken: 'token', writebackReaderNotes: true, writebackHighlightNotes: true },
    app: {
      vault: {
        cachedRead: async () => text,
        process: async (_file: TFile, change: (value: string) => string) => { text = change(text); },
      },
      metadataCache: { getFileCache: () => ({ frontmatter: readerId ? { reader_id: readerId } : {} }) },
    },
  } as unknown as PluginContext;
  return { ctx, file, current: () => text };
}

describe('Phase 5 explicit note write-back', () => {
  it('preserves a local edit during regeneration and sends a Reader document note after remote comparison', async () => {
    api.mockReset();
    const first = mergeEditableNotes(null, '# Article', [{ target: 'reader', text: 'Remote original' }]);
    const edited = first.replace('Remote original\n<!-- readwise-sync:note:reader:end', 'Local revision\n<!-- readwise-sync:note:reader:end');
    const regenerated = mergeEditableNotes(edited, '# Updated article', [{ target: 'reader', text: 'Remote original' }]);
    expect(readEditableNotes(regenerated)[0].text).toBe('Local revision');
    const { ctx, file, current } = context(regenerated, 'reader123');
    api
      .mockResolvedValueOnce({ status: 200, json: { results: [{ id: 'reader123', notes: 'Remote original' }] } } as never)
      .mockResolvedValueOnce({ status: 200, json: { id: 'reader123' } } as never);
    expect(await sendEditedNotes(ctx, file, async () => true)).toBe(1);
    expect(api.mock.calls[1][0]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ notes: 'Local revision' }) });
    expect(readEditableNotes(current())[0].baseline).toBe('Local revision');
  });

  it('blocks a remote conflict before sending any highlight note', async () => {
    api.mockReset();
    const first = mergeEditableNotes(null, '# Book', [{ target: 'highlight-12', text: 'Original' }]);
    const edited = first.replace('Original\n<!-- readwise-sync:note:highlight-12:end', 'Local edit\n<!-- readwise-sync:note:highlight-12:end');
    const { ctx, file } = context(edited);
    api.mockResolvedValueOnce({ status: 200, json: { id: 12, note: 'Remote edit' } } as never);
    await expect(sendEditedNotes(ctx, file, async () => true)).rejects.toThrow('changed in Readwise');
    expect(api).toHaveBeenCalledTimes(1);
  });

  it('rebases a conflict without sending and retains the local edit', async () => {
    api.mockReset();
    const first = mergeEditableNotes(null, '# Book', [{ target: 'highlight-12', text: 'Original' }]);
    const edited = first.replace('Original\n<!-- readwise-sync:note:highlight-12:end', 'Local edit\n<!-- readwise-sync:note:highlight-12:end');
    const { ctx, file, current } = context(edited);
    api.mockResolvedValueOnce({ status: 200, json: { id: 12, note: 'Remote edit' } } as never);
    expect(await rebaseEditedNotes(ctx, file, async () => true)).toBe(1);
    expect(api).toHaveBeenCalledTimes(1);
    expect(readEditableNotes(current())[0]).toMatchObject({ baseline: 'Remote edit', text: 'Local edit' });
  });

  it('sends an edited Readwise highlight note only after confirmation', async () => {
    api.mockReset();
    const first = mergeEditableNotes(null, '# Book', [{ target: 'highlight-12', text: 'Original' }]);
    const edited = first.replace('Original\n<!-- readwise-sync:note:highlight-12:end', 'Local edit\n<!-- readwise-sync:note:highlight-12:end');
    const { ctx, file, current } = context(edited);
    api.mockResolvedValueOnce({ status: 200, json: { id: 12, note: 'Original' } } as never);
    expect(await sendEditedNotes(ctx, file, async () => false)).toBe(0);
    expect(api).toHaveBeenCalledTimes(1);

    api
      .mockResolvedValueOnce({ status: 200, json: { id: 12, note: 'Original' } } as never)
      .mockResolvedValueOnce({ status: 200, json: { id: 12, note: 'Local edit' } } as never);
    expect(await sendEditedNotes(ctx, file, async () => true)).toBe(1);
    expect(api.mock.calls[2][0]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ note: 'Local edit' }) });
    expect(readEditableNotes(current())[0].baseline).toBe('Local edit');
  });

  it('does not discard unsent edits when write-back sections are disabled', () => {
    const first = mergeEditableNotes(null, '# Book', [{ target: 'highlight-12', text: 'Original' }]);
    const edited = first.replace('Original\n<!-- readwise-sync:note:highlight-12:end', 'Local edit\n<!-- readwise-sync:note:highlight-12:end');
    expect(() => mergeEditableNotes(edited, '# Updated book', [])).toThrow('Unsent note edits');
  });
});
