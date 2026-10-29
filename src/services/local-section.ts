export const LOCAL_START = '<!-- readwise-obsidian:local:start -->';
export const LOCAL_END = '<!-- readwise-obsidian:local:end -->';

export type LocalSectionMode = 'markers' | 'heading';

interface HeadingSection {
  start: number;
  end: number;
  content: string;
}

function markerContent(existing: string): string | null {
  if (!existing.includes(LOCAL_START) && !existing.includes(LOCAL_END)) return null;
  const start = existing.indexOf(LOCAL_START);
  const end = existing.indexOf(LOCAL_END);
  if (start < 0 || end < start || existing.indexOf(LOCAL_START, start + LOCAL_START.length) >= 0 ||
      existing.indexOf(LOCAL_END, end + LOCAL_END.length) >= 0) {
    throw new Error('The existing local section has missing or duplicate markers.');
  }
  return existing.slice(start + LOCAL_START.length, end);
}

function headingSpec(heading: string): { level: number; title: string; line: string } {
  const match = /^(#{1,6})[ \t]+(.+?)\s*$/.exec(heading.trim());
  if (!match) throw new Error('Local heading must be a Markdown heading, such as ## My notes.');
  return { level: match[1].length, title: match[2].replace(/\s+#+\s*$/, '').trim(), line: heading.trim() };
}

function findHeadingSection(text: string, heading: string): HeadingSection | null {
  const { level, title } = headingSpec(heading);
  const lines = text.split('\n');
  let start = -1;
  let end = lines.length;
  let fence: { char: string; length: number } | null = null;
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].replace(/\r$/, '');
    const fenceMatch = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fenceMatch) {
      if (!fence) fence = { char: fenceMatch[1][0], length: fenceMatch[1].length };
      else if (fence.char === fenceMatch[1][0] && fenceMatch[1].length >= fence.length) fence = null;
      continue;
    }
    if (fence) continue;
    const match = /^ {0,3}(#{1,6})[ \t]+(.+?)\s*$/.exec(line);
    if (!match) continue;
    const foundLevel = match[1].length;
    const foundTitle = match[2].replace(/\s+#+\s*$/, '').trim();
    if (foundLevel === level && foundTitle === title) {
      if (start >= 0) throw new Error(`The local heading appears more than once: ${heading}`);
      start = index;
    } else if (start >= 0 && foundLevel <= level && end === lines.length) {
      end = index;
    }
  }
  return start < 0 ? null : { start, end, content: lines.slice(start + 1, end).join('\n') };
}

export function preserveLocalSection(
  existing: string | null,
  generated: string,
  enabled: boolean,
  mode: LocalSectionMode = 'markers',
  heading = '## My notes'
): string {
  if (!enabled) return generated;
  if (generated.includes(LOCAL_START) || generated.includes(LOCAL_END)) {
    throw new Error('The generated template contains reserved local-section markers.');
  }

  const oldMarkers = existing ? markerContent(existing) : null;
  if (mode === 'markers') {
    const oldHeading = oldMarkers === null && existing ? findHeadingSection(existing, heading)?.content : null;
    const local = oldMarkers ?? oldHeading ?? '\n';
    return `${generated.trimEnd()}\n\n${LOCAL_START}${local}${LOCAL_END}\n`;
  }

  const spec = headingSpec(heading);
  const oldHeading = existing ? findHeadingSection(existing, heading)?.content : null;
  const local = oldHeading ?? oldMarkers;
  const newHeading = findHeadingSection(generated, heading);
  if (!newHeading) return `${generated.trimEnd()}\n\n${spec.line}\n${local?.trim() ?? ''}\n`;
  const lines = generated.split('\n');
  const content = local === null ? newHeading.content : local.trim();
  lines.splice(newHeading.start + 1, newHeading.end - newHeading.start - 1,
    ...(local === null ? [content] : newHeading.end < lines.length ? [content, ''] : [content]));
  return `${lines.join('\n').trimEnd()}\n`;
}
