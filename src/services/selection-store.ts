/**
 * Selection persistence.
 *
 * Stores file-path lists in VS Code's workspaceState so they survive
 * editor restarts. Two namespaces:
 *   - "last":  the last selection (auto-restored if enabled)
 *   - "named": named sets, keyed by user-chosen name
 *
 * The store is thin and synchronous over the data; only `vscode.Memento`
 * methods are async. We use POSIX-style relative paths as the canonical
 * identifier (matching what the rest of the pipeline uses).
 */

import type * as vscode from 'vscode';

const KEY_LAST = 'aiHandoff.lastSelection';
const KEY_NAMED = 'aiHandoff.namedSets';

/**
 * Schema of what we store. Keep it boring and forward-compatible.
 */
interface StoredSelection {
  paths: string[];
  /** ISO timestamp of when the selection was saved. */
  savedAt: string;
}

interface NamedSets {
  [name: string]: StoredSelection;
}

/**
 * Wraps vscode.Memento to expose typed read/write of selections.
 *
 * The class is small on purpose — callers should reach for it directly
 * rather than wrapping selections in higher-level abstractions.
 */
export class SelectionStore {
  constructor(private readonly memento: vscode.Memento) {}

  // -- Last selection (auto-restore) ----------------------------------

  /**
   * Get the most recently saved selection, or `undefined` if none.
   */
  getLastSelection(): string[] | undefined {
    const stored = this.memento.get<StoredSelection>(KEY_LAST);
    return stored?.paths;
  }

  /**
   * Save the current selection as the "last" one.
   * Empty arrays are stored too — that's a valid state (no files selected).
   */
  async setLastSelection(paths: string[]): Promise<void> {
    const stored: StoredSelection = {
      paths: [...paths].sort(),
      savedAt: new Date().toISOString(),
    };
    await this.memento.update(KEY_LAST, stored);
  }

  /**
   * Clear the saved "last" selection.
   */
  async clearLastSelection(): Promise<void> {
    await this.memento.update(KEY_LAST, undefined);
  }

  // -- Named sets -----------------------------------------------------

  /**
   * Return all named sets (name → paths). Empty object if none.
   */
  listNamedSets(): Record<string, string[]> {
    const sets = this.memento.get<NamedSets>(KEY_NAMED) ?? {};
    const out: Record<string, string[]> = {};
    for (const [name, stored] of Object.entries(sets)) {
      out[name] = stored.paths;
    }
    return out;
  }

  /**
   * Return just the names of saved sets, alphabetically sorted.
   */
  listSetNames(): string[] {
    const sets = this.memento.get<NamedSets>(KEY_NAMED) ?? {};
    return Object.keys(sets).sort();
  }

  /**
   * Get a single named set, or `undefined` if not found.
   */
  getNamedSet(name: string): string[] | undefined {
    const sets = this.memento.get<NamedSets>(KEY_NAMED) ?? {};
    return sets[name]?.paths;
  }

  /**
   * Save (or overwrite) a named set. Name must be non-empty.
   */
  async saveNamedSet(name: string, paths: string[]): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) {
      throw new Error('Selection set name cannot be empty');
    }
    const sets = { ...(this.memento.get<NamedSets>(KEY_NAMED) ?? {}) };
    sets[trimmed] = {
      paths: [...paths].sort(),
      savedAt: new Date().toISOString(),
    };
    await this.memento.update(KEY_NAMED, sets);
  }

  /**
   * Delete a named set. No-op if the name doesn't exist.
   */
  async deleteNamedSet(name: string): Promise<void> {
    const sets = { ...(this.memento.get<NamedSets>(KEY_NAMED) ?? {}) };
    if (!(name in sets)) {
      return;
    }
    delete sets[name];
    await this.memento.update(KEY_NAMED, sets);
  }

  /**
   * Wipe all named sets. Useful for tests; not exposed as a command.
   */
  async clearAllNamedSets(): Promise<void> {
    await this.memento.update(KEY_NAMED, {});
  }
}

/**
 * Minimal in-memory Memento implementation, useful for tests where we
 * don't have a real ExtensionContext but want to exercise SelectionStore.
 *
 * Mirrors only the surface area we use; not a full Memento impl.
 */
export class InMemoryMemento implements vscode.Memento {
  private readonly data = new Map<string, unknown>();

  keys(): readonly string[] {
    return Array.from(this.data.keys());
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.data.get(key) as T | undefined) ?? defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) {
      this.data.delete(key);
    } else {
      // Deep copy so callers don't see internal references.
      this.data.set(key, JSON.parse(JSON.stringify(value)));
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  setKeysForSync(_keys: readonly string[]): void { /* no-op for tests */ }
}
