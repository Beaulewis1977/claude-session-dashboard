// Full-text search over names, descriptions, tags and message text (MiniSearch,
// pure JS). Built at startup, updated incrementally.

import MiniSearch, { type Options } from 'minisearch'
import type { SearchHit } from '@shared/api'

export interface SearchDoc {
  id: string
  title: string
  name: string
  description: string
  tags: string
  project: string
  text: string
}

const FIELDS = ['title', 'name', 'description', 'tags', 'project', 'text'] as const

const OPTIONS: Options<SearchDoc> = {
  fields: [...FIELDS],
  storeFields: [],
  searchOptions: {
    boost: { name: 4, title: 3, tags: 3, description: 2, project: 1.5 },
    prefix: true,
    fuzzy: (term) => (term.length > 4 ? 0.2 : false),
    combineWith: 'AND'
  }
}

export class SearchIndex {
  private index = new MiniSearch<SearchDoc>(OPTIONS)

  /** Serialised index, for the startup cache. */
  toJSON(): string {
    return JSON.stringify(this.index)
  }

  /** Replace the index with a serialised one. Returns false if it can't be loaded. */
  load(json: string): boolean {
    try {
      this.index = MiniSearch.loadJSON<SearchDoc>(json, OPTIONS)
      return true
    } catch {
      return false
    }
  }

  has(id: string): boolean {
    return this.index.has(id)
  }

  upsert(doc: SearchDoc): void {
    if (this.index.has(doc.id)) this.index.replace(doc)
    else this.index.add(doc)
  }

  remove(id: string): void {
    if (this.index.has(id)) this.index.discard(id)
  }

  get size(): number {
    return this.index.documentCount
  }

  search(query: string): SearchHit[] {
    const q = query.trim()
    if (!q) return []
    return this.index.search(q).map((r) => {
      const fields = new Set<string>()
      for (const f of Object.values(r.match)) for (const name of f) fields.add(name)
      return { key: String(r.id), score: r.score, fields: [...fields] }
    })
  }
}
