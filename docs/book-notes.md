# Book notes

Readwise Sync can write a Readwise section into notes you keep for each book. The section holds the book's document note and its highlights, with each highlight's comment below it. Everything outside the section stays yours: the plugin never changes it.

## Configure

1. In the **Book notes** tab, enable **Write into my book notes**.
2. Under **Routes**, write one line per folder: the Readwise categories, a colon, and the vault folder holding those notes. Subfolders are included. The Readwise library and Reader folders are always excluded. For example:

   ```text
   books: Inventory/Books
   articles, podcasts: Inventory/Articles
   ```

   Categories without a route continue to get only their normal Readwise note.
3. Run a Readwise sync. A full resync (or **Delete library and resync**) fills every book note once; later incremental syncs update the books that changed.

Book notes are written after the Readwise notes, so embeds always point at existing files. If a book note fails, the sync stops before saving its checkpoint, and the next sync retries that book.

## Matching

The plugin matches a Readwise book to a note in this order:

1. **Book ID property.** A note whose `readwiseID` property (configurable) holds the Readwise book ID always matches. The value can be the number, such as `42829839`, or a book review link, such as `https://readwise.io/bookreview/42829839`. A note with this property set is never matched to a different book by title.
2. **Title.** With **Match by title** on, the Readwise title, both with and without its subtitle, is compared to the note's filename, its filename without a trailing `(Author)`, its `title` property, and its aliases. Case, accents, and punctuation are ignored. For example, `$100M Offers- How to Make Offers So Good…` matches `100M Offers (Alex Hormozi).md`.

When several notes match, the book is skipped and the sync log records the candidate paths. Add the ID property to the right note to resolve it. With **Record the book ID after a title match** on (the default), a title match adds the ID property, so a later rename doesn't break the match.

The plugin writes the ID as a number. Notes in a route folder are never treated as Readwise notes, even when the ID property has the same name as the Readwise tracking property and **Track across vault** is on.

With **Create missing book notes**, a book without a match gets a new note in its route folder. Its filename and initial contents, including YAML, come from their own templates. The contents template also receives `now`, so `{{ now | date("YYYYMMDDHHmmssSSS") }}` gives a timestamp ID. Templater syntax is not run.

## The Readwise section

The section sits between two comment markers:

```markdown
<!-- readwise-sync:book:start -->
## Readwise
…
<!-- readwise-sync:book:end -->
```

**Where to add the section** decides where it goes the first time: the end of the note, the top of the note below its properties, or directly below a heading you choose. A note without that heading gets the heading added at the end. After that, you can move the markers, with everything between them, anywhere in the note; later syncs replace only what is between them. Missing or duplicated markers stop that note's update instead of guessing.

The **Readwise section template** is Nunjucks. It receives `title`, `author`, `category`, `document_note`, `summary`, `readwise_url`, `source_url`, `tags`, `readwise_link` (a link to the Readwise note), `book`, and `highlights`. Each highlight has `id`, `text`, `note`, `location`, `url`, `tags`, `embed`, `link`, `quote`, `display`, and `comment`.

**Highlight display** controls `display`:

- **Embed:** `![[Readwise note#^id]]`. **Highlight block ID** must match the `^` marker in your highlight template: `{{ id }}` for the default template, or `rw{{ id }}H` for a template that ends highlights with `^rw{{id}}H`. With atomic highlights, the embed points at the highlight's own note instead.
- **Quoted text:** the highlight as a blockquote. It needs no Readwise note.
- **Quoted text with link:** the blockquote followed by a link to the highlight.

## Document notes

Readwise lists one document note per book. With **Document note only in the book note** on, the Readwise note leaves it out whenever a book note receives it. Book document notes are read-only: the [Readwise Book UPDATE API](https://readwise.io/api_deets) has no `document_note` field. See [Note write-back](note-writeback.md).

## Editing comments in either place

With **Editable highlight notes** on (Highlights tab), each `comment` is a writable block using the same markers as the Readwise note. Edit a comment below its embed or in the Readwise note, then run **Send edited notes to Readwise** with that note open, or **Send all edited notes to Readwise** from anywhere. The vault-wide command sends a comment once even when both copies hold the same edit, and refuses when they differ. After a successful send, the next sync refreshes the other copy. If both copies were edited differently, the second send stops with a conflict; **Review note write-back conflicts** shows both versions. An unsent edit is never discarded by a sync: turning write-back off while one exists makes that book note's update fail until you send or revert it.

## Highlight tag filter

**Filter highlights by tag** (Highlights tab) keeps only highlights with chosen Readwise tags, or skips them. It applies to Readwise notes and book notes alike. A highlight that gains or loses a tag appears or disappears at the next sync of its book. An unsent comment edit on a highlight that would disappear stops that note's update until you send or revert the edit.

## Related

- [Reader document sync](reader-sync.md) — Full documents selected by a Reader tag.
- [Note write-back](note-writeback.md) — Sending edited notes to Readwise.
- [Migrating from Readwise Mirror](migration.md) — Taking over notes from the original plugin.
