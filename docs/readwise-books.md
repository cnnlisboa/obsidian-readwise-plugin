# Readwise Books, highlight rules and chapters

Three optional features, each off until you turn it on. They are configured in the **Readwise Books** and **Rules and chapters** settings tabs.

## Book notes ⇄ Readwise Books

**Sync book notes with Readwise Books** compares your book notes (default folder `Inventory/Books`) with [Readwise Books](https://readwise.io/books_api) after each library sync, or on demand with **Sync book notes with Readwise Books now**.

Obsidian is the source of truth:

| Property | Readwise → note | Note → Readwise |
|---|---|---|
| `status` | Written **once**: the finished status (`Done`) when a book is finished in Readwise (in KOReader, for example). Never `Active` or anything else. | A status you change is sent, mapped to a shelf. Unmapped statuses (`Seed`, `Review`) are left alone. |
| `rating` | Filled if empty, as a number. | Sent when you change it. Stars are read too. `6` or `7` stay in the note and are sent as `5`. |
| `start`, `finished` | Filled if empty. | Sent when you change them. |
| `pages` | Filled from the edition if empty. | Sent as the book's page count. |
| `format` | `Digital`, `Audio` or `Physical` is added when Readwise knows it. Nothing is removed. | — |
| `readwiseBooksID`, `isbn` | Set once. | — |
| `highlights` | Link to the book's Readwise highlights note. The highlights note gets `book` linking back. | — |

On the first sync, a note that is further along than Readwise (for example `Done` while Readwise says *Want to read*) moves Readwise forward. A note that is behind (`Backlog` while the device says *Currently reading*) is left for you to change.

The **status mapping** table lists every note status and its shelf. Add your own statuses there.

Notes are matched by `readwiseBooksID`, then ISBN, then title (or alias) with a compatible author. A title that matches two notes is never guessed.

### Suggestions for books without a note

After a sync, Readwise Books entries on the chosen shelves (default *Currently reading*) that have no note are offered:

- **Create note** opens the Book Search plugin pre-filled with the ISBN (or title and author). You pick the edition, and Book Search writes the note with your template and cover. The plugin then stamps the Readwise Books id. Without Book Search, the fallback template is filled from Readwise.
- **Not now** hides the book until the next sync.
- **Don't suggest again** hides it for good. **Clear list** in settings brings these books back.

The first time there are suggestions, you're asked whether to stop suggesting every book that exists now, so only books added later are suggested. The command **Stop suggesting notes for all current Readwise Books** does the same at any time. **Show book note suggestions** opens the list.

**Add this book to Readwise Books** (command, in a book note) creates the Readwise Books entry by ISBN or by title and author. **Add new book notes to Readwise Books** does this at every sync.

## Highlight rules

A rule turns tagged highlights into notes. The built-in **Reference** rule fires on `reference/<kind>`: `reference/book`, `reference/person`, `reference/research`, or any new kind. The tag can be:

- a real Readwise tag (from KOReader's **Readwise tags…**, Reader, or Readwise);
- `#reference/book` or `.reference/book` typed in the highlight note.

Each highlight is processed once:

1. A note is created in the rule's folder. The default is the vault root; **Folders per kind** sets one per kind. The note holds the quote, your note, and links to the book note and to Readwise.
2. The note is read back to verify it contains the highlight.
3. The highlight gets the `rw-processed` tag in Readwise.
4. After the grace period (3 days), the highlight is deleted from Readwise. While **Dry run** is on (the default), nothing is deleted. **Review highlights waiting to be deleted** lists what would go, with **Keep in Readwise** for each.

A highlight made in Reader is deleted in Reader, which also removes it from Readwise. Deleting it in Readwise alone doesn't stick. The plugin keeps the text, book and position of every processed highlight, so nothing depends on the highlight surviving. **Run highlight rules now** runs the rules over the whole library.

## Chapters

- **Copy chapter notes into book notes.** A chapter heading highlight (`.h1`, `.h2`, `.h3`) with your own text below the heading line is copied to the book note. It goes between `<!-- chapter-notes:start -->` and `<!-- chapter-notes:end -->`, under a `### Chapter title`, in reading order. The section is created at the end of the note if it's missing. Text you edit there is never overwritten. The heading highlight stays in Readwise. This runs with the rules.
- **Group highlights by chapter** renders heading highlights as headings in the highlights note. They no longer appear as quotes. **Heading level of an h1 chapter** sets where chapters sit relative to your highlight template's headings.

## Editing a highlight

**Edit Readwise highlight under cursor** (command), or the ✏️ after each Readwise link in reading view, opens the highlight's text, note and tags. Saving writes to Readwise and re-syncs the note. For highlights made in Reader, only the note and tags can change, because Reader's API can't change the passage.

## Related

- [README](../README.md)
- [Book notes](book-notes.md): the Readwise section inside your book notes.
- [Migrating from Readwise Mirror](migration.md)
