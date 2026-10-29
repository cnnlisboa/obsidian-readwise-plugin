import { getFrontMatterInfo, normalizePath, requestUrl, TFile } from 'obsidian';
import TurndownService from 'turndown';
import type { ReadwiseEnvironment } from './readwise-environment';
import { listTaggedReaderDocuments, type ReaderDocument } from './reader-api';
import { hasLocalWriting, LOCAL_END, LOCAL_START, preserveLocalSection } from './local-section';
import { renderReaderFrontmatter } from './reader-frontmatter';
import { hasUnsentEdit, mergeEditableNotes, readEditableNotes } from './writeback-sections';
import { createSyncReport, type SyncEvent, type SyncReport } from './sync-report';
import type { PluginContext } from 'types/plugin-context';
import { READWISE_EXTERNAL_ID_FIELD } from 'src/constants';
import { normalizeFilename } from 'utils/file-utils';

const LINK_START = '<!-- readwise-sync:reader-link:start -->';
const LINK_END = '<!-- readwise-sync:reader-link:end -->';

function vaultFolder(path: string): string {
  const trimmed = path.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.split('/').includes('..')) {
    throw new Error('Reader folder must be a vault-relative folder.');
  }
  return normalizePath(trimmed);
}

function notePath(folder: string, document: ReaderDocument, ctx: PluginContext): string {
  if (!/^[a-z0-9_-]+$/i.test(document.id)) throw new Error('Reader returned an invalid document ID.');
  const title = normalizeFilename(document.title || 'Untitled', ctx.settings).slice(0, 200).trim() || 'Untitled';
  return normalizePath(`${folder}/${title} ${document.id}.md`);
}

function wikiLink(path: string): string {
  return `[[${path.replace(/\.md$/i, '').replace(/[\]|]/g, ' ')}]]`;
}

function combinedHighlightBody(text: string): string {
  const body = text.slice(getFrontMatterInfo(text).contentStart);
  return body
    .replace(/<!-- readwise-sync:reader-link:start -->[\s\S]*?<!-- readwise-sync:reader-link:end -->/g, '')
    .replaceAll(LOCAL_START, '')
    .replaceAll(LOCAL_END, '')
    .replace(/## Notes to send to Readwise\n[\s\S]*$/g, '')
    .trim();
}

function hashUrl(url: string): string {
  let value = 2166136261;
  for (const char of url) value = Math.imul(value ^ char.charCodeAt(0), 16777619);
  return (value >>> 0).toString(16).padStart(8, '0');
}

async function ensureFolder(ctx: PluginContext, path: string): Promise<void> {
  const segments = path.split('/');
  for (let index = 1; index <= segments.length; index++) {
    const current = segments.slice(0, index).join('/');
    if (!(await ctx.app.vault.adapter.exists(current, false))) await ctx.app.vault.createFolder(current);
  }
}

async function downloadAsset(ctx: PluginContext, url: string, path: string): Promise<boolean> {
  if (await ctx.app.vault.adapter.exists(path, false)) return true;
  const response = await requestUrl({ url, throw: false });
  if (response.status < 200 || response.status >= 300) return false;
  await ctx.app.vault.createBinary(path, response.arrayBuffer);
  return true;
}

async function contentMarkdown(ctx: PluginContext, document: ReaderDocument, folder: string): Promise<string> {
  if (!document.html_content) return '';
  const html = new DOMParser().parseFromString(document.html_content, 'text/html');
  const assetFolder = normalizePath(`${folder}/_assets`);
  for (const image of ctx.settings.readerDownloadImages ? Array.from(html.querySelectorAll('img[src]')) : []) {
    const src = image.getAttribute('src');
    if (!src) continue;
    let url: URL;
    try {
      url = new URL(src, document.source_url || document.url);
    } catch { continue; }
    if (!['http:', 'https:'].includes(url.protocol)) continue;
    const extension = /\.(png|jpe?g|gif|webp|svg|avif)$/i.exec(url.pathname)?.[1]?.toLowerCase() ?? 'bin';
    const path = normalizePath(`${assetFolder}/${document.id}-${hashUrl(url.href)}.${extension}`);
    try {
      await ensureFolder(ctx, assetFolder);
      if (await downloadAsset(ctx, url.href, path)) image.setAttribute('src', `./_assets/${path.split('/').pop()}`);
    } catch (error) {
      ctx.logger.warn(`Reader image could not be copied: ${url.origin}`, error);
    }
  }
  return new TurndownService({ headingStyle: 'atx', codeBlockStyle: 'fenced' }).turndown(html.body).trim();
}

async function findHighlightNoteByBody(ctx: PluginContext, document: ReaderDocument, folder: string): Promise<TFile | undefined> {
  const candidates = ctx.app.vault.getMarkdownFiles().filter((file) =>
    file.path.startsWith(`${ctx.settings.baseFolderName}/`) && !file.path.startsWith(`${folder}/`));
  // Readwise records the Reader document ID as external_id; prefer it over URL matching.
  const byId = candidates.filter((file) =>
    ctx.app.metadataCache.getFileCache(file)?.frontmatter?.[READWISE_EXTERNAL_ID_FIELD] === document.id);
  if (byId.length === 1) return byId[0];
  if (byId.length > 1 || !document.source_url) return undefined;
  const matches: TFile[] = [];
  for (const file of candidates) {
    const metadata = ctx.app.metadataCache.getFileCache(file)?.frontmatter;
    const indexed = metadata?.source_url === document.source_url || metadata?.reader_source_url === document.source_url;
    const bodyMatch = indexed || (await ctx.app.vault.cachedRead(file)).split('\n')
      .some((line) => line.trim() === `Source URL: ${document.source_url}`);
    if (bodyMatch) matches.push(file);
    if (matches.length > 1) return undefined;
  }
  return matches[0];
}

async function linkHighlightBack(ctx: PluginContext, highlight: TFile, readerPath: string): Promise<void> {
  const block = `${LINK_START}\nFull Reader document: ${wikiLink(readerPath)}\n${LINK_END}`;
  await ctx.app.vault.process(highlight, (current) => {
    const start = current.indexOf(LINK_START);
    const end = current.indexOf(LINK_END);
    if (start < 0 && end < 0) return `${current.trimEnd()}\n\n${block}\n`;
    if (start < 0 || end < start || current.indexOf(LINK_START, start + LINK_START.length) >= 0) {
      throw new Error(`Broken Reader link markers in ${highlight.path}.`);
    }
    return `${current.slice(0, start)}${block}${current.slice(end + LINK_END.length)}`;
  });
}

export async function syncReaderDocuments(ctx: PluginContext, env: ReadwiseEnvironment, confirm: (actions: string[]) => Promise<boolean>): Promise<SyncReport> {
  const { apiToken, readerTag, readerEnabled } = ctx.settings;
  if (!readerEnabled) return createSyncReport([]);
  if (!apiToken || !readerTag.trim()) throw new Error('Reader sync needs an API token and a document tag.');
  const folder = vaultFolder(ctx.settings.readerFolder);
  const documents = await listTaggedReaderDocuments(apiToken, readerTag.trim());
  const existing = new Map<string, TFile>();
  for (const file of ctx.app.vault.getMarkdownFiles().filter((item) => item.path.startsWith(`${folder}/`))) {
    const id: unknown = ctx.app.metadataCache.getFileCache(file)?.frontmatter?.reader_id;
    if (typeof id === 'string') existing.set(id, file);
  }
  const tag = readerTag.trim();
  const tagged = new Set(documents.map((document) => document.id));
  // Only notes imported under the current tag are candidates, so changing the tag setting never trashes older imports.
  const untagged = [...existing.entries()].filter(([id, file]) =>
    !tagged.has(id) && ctx.app.metadataCache.getFileCache(file)?.frontmatter?.reader_sync_tag === tag).map(([, file]) => file);
  const actions = documents.map((document) => `${existing.has(document.id) ? 'Update' : 'Create'} ${notePath(folder, document, ctx)}`);
  if (ctx.settings.readerTagRemoved !== 'keep') {
    actions.push(...untagged.map((file) => `${ctx.settings.readerTagRemoved === 'trash' ? 'Trash (if it has no local writing)' : 'Mark as untagged'} ${file.path}`));
  }
  if (ctx.settings.previewSync && !(await confirm(actions))) return createSyncReport([]);
  await ensureFolder(ctx, folder);

  const events: SyncEvent[] = [];
  for (const document of documents) {
    const path = notePath(folder, document, ctx);
    try {
      const highlight = ctx.settings.readerLinkHighlights || ctx.settings.readerOutputMode === 'combined'
        ? await findHighlightNoteByBody(ctx, document, folder) : undefined;
      const content = await contentMarkdown(ctx, document, folder);
      let sourceFile = '';
      if (ctx.settings.readerDownloadSourceFiles && document.raw_source_url && ['pdf', 'epub'].includes(document.category)) {
        const assets = normalizePath(`${folder}/_assets`);
        const assetPath = normalizePath(`${assets}/${document.id}.${document.category}`);
        await ensureFolder(ctx, assets);
        if (await downloadAsset(ctx, document.raw_source_url, assetPath)) sourceFile = wikiLink(assetPath);
      }
      if (!content && !sourceFile) throw new Error('Reader did not provide HTML content or a downloadable source file.');
      const highlightLink = highlight ? wikiLink(highlight.path) : '';
      const highlightText = highlight && ctx.settings.readerOutputMode === 'combined' ? await ctx.app.vault.cachedRead(highlight) : '';
      const highlights = highlight
        ? ctx.settings.readerOutputMode === 'combined'
          ? combinedHighlightBody(highlightText)
          : `Highlights: ${highlightLink}`
        : '';
      const rendered = env.renderString(ctx.settings.readerDocumentTemplate, {
        ...document, content, source_file: sourceFile, highlight_link: highlightLink, highlights,
      });
      const generated = `${renderReaderFrontmatter(env, ctx.settings.readerYamlTemplate, document, tag)}${rendered.trim()}${sourceFile ? `\n\nSource file: ${sourceFile}` : ''}\n`;
      const old = existing.get(document.id) ?? ctx.app.vault.getFileByPath(path);
      const oldContents = old ? await ctx.app.vault.cachedRead(old) : null;
      const withEditableNote = mergeEditableNotes(oldContents, generated,
        ctx.settings.writebackReaderNotes ? [{ target: 'reader', text: document.notes ?? '' }] : []);
      if (old) {
        const current = oldContents ?? '';
        const next = preserveLocalSection(current, withEditableNote, ctx.settings.preserveLocalSection,
          ctx.settings.localSectionMode, ctx.settings.localSectionHeading);
        if (old.path !== path) {
          if (ctx.app.vault.getAbstractFileByPath(path)) throw new Error(`Target path already exists: ${path}`);
          await ctx.app.fileManager.renameFile(old, path);
        }
        if (current !== next) await ctx.app.vault.modify(old, next);
        events.push({ action: 'updated', path });
      } else {
        await ctx.app.vault.create(path, preserveLocalSection(null, withEditableNote, ctx.settings.preserveLocalSection,
          ctx.settings.localSectionMode, ctx.settings.localSectionHeading));
        events.push({ action: 'created', path });
      }
      if (highlight && ctx.settings.readerLinkHighlights) await linkHighlightBack(ctx, highlight, path);
    } catch (error) {
      events.push({ action: 'failed', path, detail: String(error) });
      ctx.logger.error(`Reader document sync failed at ${path}`, error);
    }
  }
  if (ctx.settings.readerTagRemoved !== 'keep') {
    for (const file of untagged) {
      try {
        const text = await ctx.app.vault.read(file);
        const keep = ctx.settings.readerTagRemoved === 'mark' || readEditableNotes(text).some(hasUnsentEdit) ||
          hasLocalWriting(text, ctx.settings.localSectionMode, ctx.settings.localSectionHeading);
        if (keep) {
          const marked = ctx.app.metadataCache.getFileCache(file)?.frontmatter?.reader_tag_removed === true;
          if (!marked) {
            await ctx.app.fileManager.processFrontMatter(file, (frontmatter: Record<string, unknown>) => {
              frontmatter.reader_tag_removed = true;
            });
            events.push({ action: 'untagged', path: file.path,
              detail: ctx.settings.readerTagRemoved === 'trash' ? 'Kept because it has local writing or unsent edits' : undefined });
          }
        } else {
          await ctx.app.fileManager.trashFile(file);
          events.push({ action: 'untagged', path: file.path, detail: 'Moved to trash' });
        }
      } catch (error) {
        events.push({ action: 'failed', path: file.path, detail: String(error) });
        ctx.logger.error(`Reader untagged handling failed at ${file.path}`, error);
      }
    }
  }
  const report = createSyncReport(events);
  if (report.counts.failed > 0) throw new Error(`${report.counts.failed} Reader documents failed to sync. First: ${events.find((event) => event.action === 'failed')?.path}`);
  return report;
}
