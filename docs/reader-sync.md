# Reader document sync

Readwise Sync can import Reader documents bearing a chosen tag. It uses the [Reader Document LIST API](https://readwise.io/reader_api) with `tag`, `withHtmlContent=true`, and `withRawSourceUrl=true`.

## Configure

1. Enter a Readwise access token in General settings.
2. In the Reader tab, enter the exact Reader tag key and choose a vault folder.
3. Enable **Sync tagged reader documents**.
4. Run **Sync tagged Reader documents** from the command palette, or run the normal Readwise highlights sync.

The first Reader sync downloads every tagged document. Later syncs list the tagged documents without their content, then download content only for documents that are new or changed since the last successful Reader sync. A note whose `reader_updated_at` matches Reader is left alone. Run **Sync tagged Reader documents (full refresh)** after changing the document template or YAML template, or when a highlight note appeared after its document was imported. Combined layout always refreshes every document, because it copies highlight notes that change independently.

The listing still includes every tagged document. **When a document loses the tag** chooses what happens to its note: keep it (the default), mark it with `reader_tag_removed: true`, or move it to the trash. Trash keeps and marks any note with local writing or unsent note edits. Only notes imported under the current tag (their `reader_sync_tag` property) are affected, so changing the tag setting never removes older imports. The optional preview shows planned document paths before Reader writes. The Reader tab also offers a Nunjucks document template and separate or combined highlight layout. Successful Reader writes appear in the configurable sync log when logging is enabled; log templates can use `source` to distinguish Reader from Readwise.

## Output

The plugin saves HTML content as Markdown. Separate toggles control copying inline images and saving available PDF or EPUB source files in `_assets`. Both are on by default. Documents with neither HTML nor a saved source file report an error. Embedded media and externally hosted resources that cannot be downloaded may remain as links.

Each note has a stable `reader_id` property. It also stores the Reader URL, source URL, and update time. The body template receives Reader fields plus `content`, `source_file`, `highlight_link`, and `highlights`. `notes` is the Reader document note.

The separate **Document YAML template** controls tags and other properties. It accepts YAML without delimiters (or with `---` delimiters) and receives `reader_tag`, `tag_names`, `document`, and all Reader document fields. For example:

```yaml
tags:
  - my/imported-document
kind: reading
```

The plugin adds `reader_id`, `reader_url`, `reader_source_url`, `reader_updated_at`, and `reader_sync_tag` after rendering the template. These tracking fields remain under plugin control. Invalid YAML stops that document's write and reports an error.

With **Preserve local writing**, choose comment markers or a unique heading such as `## My notes`. In heading mode, text from that heading through the next heading at the same or higher level survives regeneration. A change from comment markers to heading mode carries existing marked text over. Edits outside the protected section may be replaced at the next sync.

## Highlights

The plugin matches a Reader document to a Readwise highlight note by Reader document ID first. Readwise reports that ID as `external_id` for Reader-sourced books, and the plugin stores it as `readwise_external_id` on tracked Readwise notes. Notes synced before this change get the property at their next update. Without an ID match, it falls back to an exact, unambiguous source URL match: `source_url` or `reader_source_url` frontmatter, then the default `Source URL:` line in the note body. A custom highlight template without any of these fields cannot be matched automatically.

In linked mode, the document contains a wiki link to the highlights note and the highlights note gets a managed link back. In combined mode, the current highlight note body is copied into the full document. The Readwise highlight note still exists as the sync source. Reader highlights are not fetched separately in this phase, and notes without a matching Readwise highlight note have no highlights section.

## API and sync limits

The [Reader API](https://readwise.io/reader_api) limits document LIST requests to 20 per minute and returns raw source URLs that expire after one hour. The plugin pages through the full tag selection and retries HTTP 429 responses using `Retry-After`. Large libraries and asset downloads can take time. [Explicit note write-back](note-writeback.md) is available for Reader document notes. The [Readwise changelog](https://docs.readwise.io/changelog) records current API changes.

## Related

- [README](../README.md) — Plugin overview and commands.
- [Note write-back](note-writeback.md) — Send edited notes to Readwise.
- [Book notes](book-notes.md) — Readwise sections in your own book notes.
