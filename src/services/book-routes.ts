import { normalizePath } from 'obsidian';
import type { PluginSettings } from 'types/settings';

export interface BookRoute {
  categories: string[];
  folder: string;
}

/** Parses lines such as "books, podcasts: Inventory/Books". */
export function parseBookRoutes(text: string): BookRoute[] {
  const routes: BookRoute[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf(':');
    const categories = line.slice(0, separator).split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
    const folder = line.slice(separator + 1).trim();
    if (separator < 0 || !categories.length || !folder || folder.startsWith('/') || folder.split('/').includes('..')) {
      throw new Error(`Invalid book note route "${line}". Use "category: vault/folder".`);
    }
    routes.push({ categories, folder: normalizePath(folder) });
  }
  return routes;
}

export function bookRouteFolder(settings: PluginSettings, category: string): string | null {
  if (!settings.bookNotesEnabled) return null;
  const route = parseBookRoutes(settings.bookNoteRoutes).find((item) => item.categories.includes(category.toLowerCase()));
  return route?.folder ?? null;
}

/** Whether a path is inside a book note folder. Never throws, so tracking checks stay safe with invalid routes. */
export function inBookNoteFolder(path: string, settings: PluginSettings): boolean {
  if (!settings.bookNotesEnabled) return false;
  try {
    return parseBookRoutes(settings.bookNoteRoutes).some((route) => path.startsWith(`${route.folder}/`));
  } catch {
    return false;
  }
}
