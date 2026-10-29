# Note write-back

Write-back is explicit and off by default. It supports Reader document notes through the [Reader Document UPDATE API](https://readwise.io/reader_api) and Readwise highlight notes through the [Readwise Highlight UPDATE API](https://readwise.io/api_deets).

## Use it

1. In the Reader tab, enable **Editable reader document notes** for imported Reader documents. In Highlights, enable **Editable highlight notes** for Readwise notes.
2. Sync to add **Notes to send to Readwise** near the end of each generated note.
3. Edit the text between the note markers. Leave the `<!-- readwise-sync:note:... -->` lines in place.
4. With that note active, run **Send edited notes to Readwise** and review the confirmation. **Send all edited notes to Readwise** sends every unsent edit in the vault at once.

The ordinary generated `Document note` and `Note:` text from templates is a read-only copy. Only the new writable sections are sent. A local edit in a writable section survives the next download sync. If the remote note changed since the section was generated, the send stops and leaves the local text in the vault for review. Run **Review note write-back conflicts** to compare the previous remote text, current remote text, and your local edit. If you approve, the command keeps your local edit and adopts the current remote text as its new baseline; it does not send anything. You can then run **Send edited notes to Readwise** if you still want to replace the remote note. Disabling a section or filtering out a highlight with unsent edits also stops that note's regeneration rather than discard its text.

The plugin sends nothing in the background. A send first reads the current remote note and compares it with the imported baseline; it then PATCHes the edited note after confirmation. The APIs do not provide a conditional PATCH, so a remote edit made between that comparison and the PATCH could still be overwritten. If a multi-highlight send fails partway through, earlier successful sends remain applied and their local baselines are updated.

## Current API boundary

The [Readwise Book UPDATE endpoint](https://readwise.io/api_deets) lists title, author, category, and cover fields, but not `document_note`. Therefore this plugin does not offer write-back of a document note for a book that exists only in the original Readwise API. A book imported as a Reader document can use the Reader document-note write-back path. The [Readwise changelog](https://docs.readwise.io/changelog) should be checked when this API boundary changes.

## Related

- [README](../README.md) — Plugin overview.
- [Reader document sync](reader-sync.md) — Document import and templates.
- [Book notes](book-notes.md) — Edit highlight comments from your book notes.
