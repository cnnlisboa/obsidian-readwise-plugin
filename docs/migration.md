# Migrating from Readwise Mirror

Readwise Sync can take over the notes written by the original Readwise Mirror plugin. Both plugins find notes by the same kind of tracking property: a frontmatter field holding the book's Readwise review link, such as `readwiseID: https://readwise.io/bookreview/42829839`. When the two plugins use the same tracking property and library folder, Readwise Sync updates the existing notes in place instead of creating copies.

## Steps

1. **Back up the vault.**
2. **Disable Readwise Mirror.** Readwise Sync refuses to sync while Readwise Mirror is enabled and writes to the same library folder, because both would rewrite the same notes.
3. **Match the settings.** Copy the tracking property, filename template, and frontmatter, header, and highlight templates from Readwise Mirror. Keep **Enable file tracking** on.
4. **Point Readwise Sync at the old folder.** Set **Library folder name** to Readwise Mirror's folder, such as `Inventory/Readwise`.
5. **Preview the first sync.** Turn on **Preview sync changes** and run **Download entire Readwise library (force)**. The preview lists **Update** for existing notes and **Create** only for books without a note. Expand a few text changes to confirm that the templates match. Many unexpected **Create** lines mean the tracking property or folder differs.
6. **Remove Readwise Mirror** after a successful sync.

The old `Readwise Sync` folder, if you synced there while testing, is no longer used after step 4. Delete it once the old folder works.

## Related

- [README](../README.md) — Plugin overview and commands.
- [Book notes](book-notes.md) — Readwise sections in your own book notes.
