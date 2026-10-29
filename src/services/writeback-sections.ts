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

export function mergeEditableNotes(existing: string | null, generated: string, notes: { target: NoteTarget; text: string }[]): string {
  const old = new Map(readEditableNotes(existing ?? '').map((note) => [note.target, note]));
  const incoming = new Set(notes.map((note) => note.target));
  if (!notes.length) {
    if ([...old.values()].some((note) => note.text.trim() !== note.baseline.trim())) {
      throw new Error('Unsent note edits would be removed. Send them before disabling write-back sections.');
    }
    return generated;
  }
  if ([...old.values()].some((note) => !incoming.has(note.target) && note.text.trim() !== note.baseline.trim())) {
    throw new Error('An unsent note is no longer in the sync selection. Send it before changing the filter.');
  }
  const blocks = notes.map(({ target, text }) => {
    const remote = text.trim();
    const previous = old.get(target);
    // A local edit stays in the vault until the user sends it or resolves the remote conflict.
    const local = previous && previous.text.trim() !== previous.baseline.trim() ? previous.text.trim() : remote;
    const baseline = previous && local !== remote ? previous.baseline : remote;
    return `${startMarker(target, baseline)}\n${local}\n${endMarker(target)}`;
  });
  return `${generated.trimEnd()}\n\n## Notes to send to Readwise\n\n${blocks.join('\n\n')}\n`;
}

export function markSent(contents: string, target: NoteTarget, sent: string): string {
  const note = readEditableNotes(contents).find((item) => item.target === target);
  if (!note) throw new Error(`Writable section ${target} disappeared.`);
  return `${contents.slice(0, note.start)}${startMarker(target, sent)}\n${note.text}\n${endMarker(target)}${contents.slice(note.end)}`;
}
