export type NoteTarget = 'reader' | `highlight-${number}`;

export interface EditableNote {
  target: NoteTarget;
  baseline: string;
  text: string;
  start: number;
  end: number;
}

function startMarker(target: NoteTarget, baseline: string): string {
  return `<!-- readwise-sync:note:${target}:start:${encodeURIComponent(baseline)} -->`;
}

function endMarker(target: NoteTarget): string {
  return `<!-- readwise-sync:note:${target}:end -->`;
}

export function readEditableNotes(contents: string): EditableNote[] {
  const matches = [...contents.matchAll(/<!-- readwise-sync:note:(reader|highlight-\d+):start:([^\n]*?) -->\n([\s\S]*?)\n<!-- readwise-sync:note:\1:end -->/g)];
  const markerCount = [...contents.matchAll(/<!-- readwise-sync:note:/g)].length;
  if (markerCount !== matches.length * 2) throw new Error('A writable note section has broken markers.');
  const targets = new Set<string>();
  return matches.map((match) => {
    const target = match[1] as NoteTarget;
    if (targets.has(target)) throw new Error(`Duplicate writable note section: ${target}`);
    targets.add(target);
    return { target, baseline: decodeURIComponent(match[2]), text: match[3], start: match.index, end: match.index + match[0].length };
  });
}

export function hasUnsentEdit(note: EditableNote): boolean {
  return note.text.trim() !== note.baseline.trim();
}

/** Indexes existing writable sections and refuses to drop any unsent edit that is not regenerated. */
export function previousEditableNotes(existing: string | null, incoming: NoteTarget[]): Map<NoteTarget, EditableNote> {
  const old = new Map(readEditableNotes(existing ?? '').map((note) => [note.target, note]));
  const targets = new Set(incoming);
  if ([...old.values()].some((note) => !targets.has(note.target) && hasUnsentEdit(note))) {
    throw new Error(incoming.length
      ? 'An unsent note is no longer in the sync selection. Send it before changing the filter.'
      : 'Unsent note edits would be removed. Send them before disabling write-back sections.');
  }
  return old;
}

export function editableBlock(previous: EditableNote | undefined, target: NoteTarget, text: string): string {
  const remote = text.trim();
  // A local edit stays in the vault until the user sends it or resolves the remote conflict.
  const local = previous && hasUnsentEdit(previous) ? previous.text.trim() : remote;
  const baseline = previous && local !== remote ? previous.baseline : remote;
  return `${startMarker(target, baseline)}\n${local}\n${endMarker(target)}`;
}

export function mergeEditableNotes(existing: string | null, generated: string, notes: { target: NoteTarget; text: string }[]): string {
  const old = previousEditableNotes(existing, notes.map((note) => note.target));
  if (!notes.length) return generated;
  const blocks = notes.map(({ target, text }) => editableBlock(old.get(target), target, text));
  return `${generated.trimEnd()}\n\n## Notes to send to Readwise\n\n${blocks.join('\n\n')}\n`;
}

export function markSent(contents: string, target: NoteTarget, sent: string): string {
  const note = readEditableNotes(contents).find((item) => item.target === target);
  if (!note) throw new Error(`Writable section ${target} disappeared.`);
  return `${contents.slice(0, note.start)}${startMarker(target, sent)}\n${note.text}\n${endMarker(target)}${contents.slice(note.end)}`;
}
