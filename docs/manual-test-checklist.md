# Manual test checklist

Run these in Obsidian after reloading Readwise Sync. Keep **Preview sync changes** on for the first runs, and back up the vault first.

## Setup

- [ ] Readwise Mirror stays disabled. Readwise Sync settings show your old templates, `readwiseID` as the tracking property, and the `= {{title}}` filename template.
- [ ] **Test Readwise API key** → success.

## 1. Reliable sync

- [ ] **Download entire Readwise library (force)** → `Readwise Sync/` gets category folders; `Inventory/Readwise` is unchanged.
- [ ] Note counts per category roughly match Readwise (a much smaller count means paging stopped early).
- [ ] Notes look like your old ones: `= Title` filenames, the same frontmatter, `## rw…` highlights with `^rw…H` markers.
- [ ] Add a highlight in Readwise, then **Sync new highlights** → only that book updates.
- [ ] **Filter by tag** with one tagged book, then **Delete Readwise library** and a full download → only that book. Turn the filter off.
- [ ] Two books with the same title get two separate notes; a second sync keeps their names.
- [ ] Rename a synced note, then sync → the same note updates, with no copy.
- [ ] Optional: go offline mid-sync → error; **Retry failed Readwise items** (or the next sync) writes the missed books.

## 2. Controlled output

- [ ] Preview shows planned actions plus expandable **Text changes** with `-`/`+` lines. **Cancel** writes nothing.
- [ ] Change the log filename, path override, and templates → the next entry follows them, and skipped books show their reason.
- [ ] Notifications off → quiet syncs.
- [ ] Local writing between the markers survives a forced re-download; text outside them is replaced.
- [ ] Heading mode (`## My notes`) carries the marker text over; subheadings survive.
- [ ] Frontmatter template preview updates and flags invalid YAML.

## 3. Reader

- [ ] Tag 2–3 Reader documents (an article, a PDF, one with images), set the tag, and run **Sync tagged Reader documents**.
- [ ] Full text, headings, `_assets` images, and the PDF link are present.
- [ ] YAML has your custom tags plus `reader_id`, `reader_url`, `reader_sync_tag`.
- [ ] Linked layout: links in both directions (run a full Readwise sync first so `readwise_external_id` exists).
- [ ] Combined layout: highlights appear inside the document.
- [ ] Sync again with nothing changed → the preview says the documents were skipped as unchanged.
- [ ] Edit one document in Reader, then sync → only that note updates.
- [ ] Change the document template, then **Sync tagged Reader documents (full refresh)** → all notes re-render.
- [ ] Remove the tag from one document, once per option: Keep / Mark (`reader_tag_removed: true`) / Trash (a note with local writing is marked instead).
- [ ] Change the Reader tag setting → older imports are untouched.

## 4. Book notes

- [ ] Enable **Write into my book notes** (routes: `books: Inventory/Books`). Run a full sync and read the preview, including the book note diffs and any skipped books.
- [ ] Five book notes: the section is at the end, `readwiseID` holds the number, and the callout and YAML are unchanged.
- [ ] Embeds show the highlight text (`![[= Title#^rw…H]]`), and comments appear below them.
- [ ] Books with a book note no longer show `# Note` in the Readwise note (**Document note only in the book note** is on).
- [ ] A skipped book: add `readwiseID` to the right note, then sync → filled.
- [ ] Move the section to the top, then sync → it stays there.
- [ ] Rename a book note, then sync → it still updates.
- [ ] **Where to add the section**: try top and **Below a heading** on a note with no section yet.
- [ ] **Highlight display**: embed, quote, link.
- [ ] **Create missing book notes** → a new note matches your Book.md layout, with no Templater code left.
- [ ] Optional route: `articles: Inventory/Articles` → articles go to that folder.
- [ ] **Filter highlights by tag**: include one tag → only those highlights appear in both notes.

## 5. Write-back (sends real data)

- [ ] Turn on **Editable highlight notes**, then sync → **Notes to send to Readwise** appears in Readwise notes, and comments in book notes become writable blocks.
- [ ] Edit a comment in a book note, then **Send edited notes to Readwise** → the dialog shows the change; after confirming, readwise.io shows it.
- [ ] Sync → the Readwise note shows the new comment.
- [ ] Edit the same comment identically in both notes, then **Send all edited notes to Readwise** → sent once, and both notes are marked sent.
- [ ] Edit it differently in the two notes → refused before sending.
- [ ] Edit on readwise.io and in Obsidian → blocked; **Review note write-back conflicts** shows both versions.
- [ ] An unsent edit survives a sync.
- [ ] Reader document note: enable **Editable reader document notes**, edit, send → Reader shows it.

## Tools

- [ ] **Show sync info for current note** on a Readwise note, a book note, and a Reader document → correct IDs, related notes (clickable), and unsent edits.

## Mobile

- [ ] On the phone: the plugin enables, all settings tabs are usable, and a small sync completes.

## Migration (when ready)

- [ ] Follow [Migrating from Readwise Mirror](migration.md): set **Library folder name** to `Inventory/Readwise` and preview a full download → mostly **Update**, few **Create**.
