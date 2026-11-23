export interface PluginSettings {
  baseFolderName: string; // Base folder where synced notes will be stored
  apiToken: string | null; // Readwise API authentication token
  lastUpdated: string | null; // Timestamp of last successful sync
  failedBookIds: number[]; // Readwise books whose last write failed, for the retry command
  readerLastSync: string | null; // Start of the last successful incremental Reader sync
  autoSync: boolean; // Whether to automatically sync on startup
  syncIntervalMinutes: number; // 0 disables repeated syncs
  selectiveSync: boolean; // Review document selection during ordinary library syncs
  selectiveSyncInitiallyChecked: boolean;
  ignoredDocuments: Record<string, IgnoredDocument>;
  statusBarMode: 'full' | 'compact' | 'hidden'; // Status bar widget display
  previewSync: boolean; // Review planned vault changes before writing
  preserveLocalSection: boolean; // Keep the editable local section across syncs
  localSectionMode: 'markers' | 'heading';
  localSectionHeading: string;
  readerEnabled: boolean;
  readerTag: string;
  readerFolder: string;
  readerOutputMode: 'separate' | 'combined';
  readerLinkHighlights: boolean;
  readerDownloadImages: boolean;
  readerDownloadSourceFiles: boolean;
  readerDocumentTemplate: string;
  readerYamlTemplate: string;
  readerTagRemoved: 'keep' | 'mark' | 'trash'; // What to do with a note whose Reader document lost the tag
  bookNotesEnabled: boolean; // Write a Readwise section into matching personal book notes
  bookNoteRoutes: string; // Lines of "category, category: folder" routing books to personal notes
  bookNoteIdProperty: string; // Property linking a book note to its Readwise book ID
  bookNoteMatchByTitle: boolean; // Fall back to filename, alias, or title property matching
  bookNoteStampId: boolean; // Record the Readwise book ID on a note matched by title
  bookNoteCreateMissing: boolean; // Create a book note when none matches
  bookNoteFilenameTemplate: string;
  bookNoteNewTemplate: string; // Initial contents for created book notes
  bookNoteSectionTemplate: string; // Managed Readwise section inside the book note
  bookNoteHighlightStyle: 'embed' | 'quote' | 'link';
  bookNoteBlockId: string; // Nunjucks template for the highlight block ID that embeds point at
  bookNotePlacement: 'append' | 'prepend' | 'heading'; // Where a new Readwise section goes
  bookNotePlacementHeading: string;
  bookNoteDocumentNoteOnly: boolean; // Omit the document note from the Readwise note when a book note receives it
  writebackReaderNotes: boolean;
  writebackHighlightNotes: boolean;
  highlightSortOldestToNewest: boolean; // Sort highlights chronologically from oldest to newest
  highlightSortByLocation: boolean; // Sort highlights by their location in the document
  highlightDiscard: boolean; // Filter out discarded highlights
  highlightTagFilter: 'off' | 'include' | 'exclude'; // Filter highlights by their Readwise tags
  highlightFilterTags: string; // Comma-separated highlight tags for the filter
  syncNotesOnly: boolean; // Only sync highlights that have notes attached
  colonSubstitute: string; // String to replace colons in filenames
  logFile: boolean; // Whether to save sync logs to a file
  logFileName: string; // Name of the sync log file
  logFilePath: string; // Optional vault-relative override for the sync log path
  logTitleTemplate: string; // Nunjucks template for the log entry title
  logBodyTemplate: string; // Nunjucks template for the log entry body
  syncNotifications: boolean; // Show Obsidian notifications during sync
  frontMatter: boolean; // Whether to include YAML frontmatter in notes
  frontMatterTemplate: string; // Template for YAML frontmatter content
  headerTemplate: string; // Template for document header content
  highlightTemplate: string; // Template for individual highlights
  useSlugify: boolean; // Whether to slugify filenames
  slugifySeparator: string; // Character to use as separator in slugified names
  slugifyLowercase: boolean; // Convert slugified names to lowercase
  trackFiles: boolean; // Track files using unique Readwise URLs
  trackingProperty: string; // Frontmatter property for storing tracking URL
  trackAcrossVault: boolean; // Track files across the entire vault, not just within the base folder
  deleteDuplicates: boolean; // Remove duplicate files instead of marking them
  enableFileNameUpdates: boolean; // Allow updating of file names
  protectFrontmatter: boolean; // Protect specified frontmatter fields from updates
  protectedFields: string; // List of frontmatter fields to protect
  updateFrontmatter: boolean; // Allow updating of non-protected frontmatter fields
  syncPropertiesToReadwise: boolean; // Sync title/author changes back to Readwise
  titleProperty: string; // Frontmatter property for syncing title
  authorProperty: string; // Frontmatter property for syncing author
  debugMode: boolean; // Enable debug mode for detailed logging
  useCustomFilename: boolean; // Use custom filename template
  filenameTemplate: string; // Template for generating filenames
  filterNotesByTag: boolean; // Whether to filter books by tag
  filteredTags: string[]; // list of tags to include/exclude
  atomicHighlights: boolean; // Whether to use atomic highlights
  atomicParentProperty: string; // `Parent`property
  atomicInheritParentFrontmatter: boolean; // Inherit parent frontmatter
  atomicConditionalAtomize: boolean; // Only atomize notes with a specific property set

  rulesEnabled: boolean; // Tag-triggered highlight rules
  rulesDryRun: boolean; // Never delete processed highlights while on
  rulesGraceDays: number;
  rulesProcessedTag: string;
  highlightRules: import('services/highlight-rules-defaults').HighlightRule[];
  processedHighlights: Record<string, import('services/highlight-rules').ProcessedRecord>;
  chapterNotesEnabled: boolean; // Copy chapter notes into book notes
  showEditButton: boolean; // ✏️ next to highlight links in reading view
  groupByChapters: boolean; // Render h1/h2/h3 heading highlights as headings in highlights notes
  chapterHeadingBase: number; // Markdown level used for an h1 chapter (h2 = base + 1 ...)

  // ---- Readwise Books (PLAN-readwise-books.md)
  booksEnabled: boolean; // Sync personal book notes with Readwise Books
  booksNoteFolder: string; // Where personal book notes live
  booksPropertyNames: BooksPropertyNamesSetting;
  booksStatusMap: Record<string, string>; // Obsidian status -> shelf ('' = not synced)
  booksFinishedStatus: string; // Written once when a book is finished
  booksFormats: boolean; // Add formats implied by Readwise (add-only)
  booksHighlightsProperty: string; // Book note -> highlights note link
  booksBookProperty: string; // Highlights note -> book note link
  booksState: Record<string, import('services/books-model').BookSyncState>;
  booksPendingPatches: import('services/books-model').BookPatch[];
  booksSuggest: boolean; // Offer to create notes for books without one
  booksSuggestShelves: string[];
  booksSuggestExcluded: number[];
  booksSuggestBaselineDone: boolean;
  booksSuggestQuery: 'isbn' | 'title';
  booksFallbackTemplate: string; // Used when Book Search isn't available
  booksAutoPushNew: boolean; // Add notes with a mapped status but no Books id to Readwise Books at sync
  booksLastSync: string | null;
}

export interface BooksPropertyNamesSetting {
  status: string;
  rating: string;
  start: string;
  finished: string;
  format: string;
  pages: string;
  id: string;
  isbn: string;
}

export interface IgnoredDocument {
  mode: 'untilChanged' | 'always';
  signature: string;
  title: string;
  author: string;
  category: string;
  cover: string;
  highlightCount: number;
}
