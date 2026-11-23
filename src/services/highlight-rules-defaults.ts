// Defaults for tag-triggered rules, kept free of imports so settings can load them.

export interface HighlightRule {
  name: string;
  /** Tag prefix, e.g. "reference/". The part after it is the kind. */
  tagPrefix: string;
  enabled: boolean;
  /** Folder for kinds without their own (empty = vault root). */
  folder: string;
  /** kind -> folder. */
  kindFolders: Record<string, string>;
  filenameTemplate: string;
  noteTemplate: string;
  deleteAfterGrace: boolean;
}

export const DEFAULT_RULE_TEMPLATE = `---
tags:
  - {{ tag }}
source: "[[{{ book_title }}]]"
created: {{ date }}
---
> {{ text }}
{% if note %}
{{ note }}
{% endif %}
From {{ book_link }}{% if author %} by {{ author }}{% endif %}, location {{ location }} · [Readwise]({{ readwise_url }})
`;

export const DEFAULT_RULES: HighlightRule[] = [{
  name: 'Reference',
  tagPrefix: 'reference/',
  enabled: true,
  folder: '',
  kindFolders: {},
  filenameTemplate: '{{ kind | capitalize }} - {{ text | truncate(60, true, "") }}',
  noteTemplate: DEFAULT_RULE_TEMPLATE,
  deleteAfterGrace: true,
}];

