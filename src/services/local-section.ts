export const LOCAL_START = '<!-- readwise-obsidian:local:start -->';
export const LOCAL_END = '<!-- readwise-obsidian:local:end -->';

export function preserveLocalSection(existing: string | null, generated: string, enabled: boolean): string {
  if (!enabled) return generated;
  if (generated.includes(LOCAL_START) || generated.includes(LOCAL_END)) {
    throw new Error('The generated template contains reserved local-section markers.');
  }

  let local = '\n';
  if (existing?.includes(LOCAL_START) || existing?.includes(LOCAL_END)) {
    const start = existing.indexOf(LOCAL_START);
    const end = existing.indexOf(LOCAL_END);
    if (start < 0 || end < start || existing.indexOf(LOCAL_START, start + LOCAL_START.length) >= 0 ||
        existing.indexOf(LOCAL_END, end + LOCAL_END.length) >= 0) {
      throw new Error('The existing local section has missing or duplicate markers.');
    }
    local = existing.slice(start + LOCAL_START.length, end);
  }
  return `${generated.trimEnd()}\n\n${LOCAL_START}${local}${LOCAL_END}\n`;
}
