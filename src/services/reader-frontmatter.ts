import { parseYaml, stringifyYaml } from 'obsidian';
import type { ReadwiseEnvironment } from './readwise-environment';
import type { ReaderDocument } from './reader-api';

export function renderReaderFrontmatter(env: ReadwiseEnvironment, template: string, document: ReaderDocument, selectedTag: string): string {
  const rendered = env.renderString(template, {
    ...document,
    reader_tag: selectedTag,
    tag_names: Object.keys(document.tags ?? {}),
    document,
  }).trim();
  const yaml = rendered.startsWith('---\n') && rendered.endsWith('\n---')
    ? rendered.slice(4, -4).trim()
    : rendered;
  const parsed: unknown = yaml ? parseYaml(yaml) : {};
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Reader YAML template must render to a YAML mapping.');
  }
  const custom = parsed as Record<string, unknown>;
  const fields = {
    ...custom,
    reader_id: document.id,
    reader_url: document.url,
    reader_source_url: document.source_url ?? '',
    reader_updated_at: document.updated_at,
  };
  return `---\n${stringifyYaml(fields).trimEnd()}\n---\n\n`;
}
