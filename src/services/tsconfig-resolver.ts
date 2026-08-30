/**
 * Resolves the tsconfig.json/jsconfig.json path-alias config (`baseUrl` +
 * `paths`) that applies to a given file, for `FileTreeModel.
 * resolveImportClosure()` to run bare-specifier alias matching against.
 *
 * Walks up directories from the importing file's own directory to the
 * owning workspace folder root (inclusive), looking for `tsconfig.json`
 * then `jsconfig.json` at each level — closest wins, matching `tsc`'s own
 * resolution. Once a config is found at a level, its (extends-merged)
 * result is final: no falling further up the tree, even if that config
 * turns out to have no `paths` at all.
 *
 * Follows a LOCAL relative `extends` chain only (`./`/`../`, bounded to 10
 * hops to guard against cycles) — an `extends` into a node_modules package
 * is out of scope, since path aliases are almost always declared in the
 * project's own config, not a shared base. Child config values override the
 * parent's on conflict.
 *
 * Caches parsed configs by resolved tsconfig/jsconfig absolute path for this
 * resolver's lifetime — no live invalidation on tsconfig edits for v1. Same
 * tradeoff `services/git-diff-reader.ts`'s `RepoRootCache` already makes for
 * repo layout (rarely changes mid-session, so pay the cost once).
 */

import * as path from 'path';
import * as vscode from 'vscode';
import { parseTsconfigPaths } from '../core/tsconfig-paths';

export interface ResolvedTsPaths {
  baseUrlAbs: string;
  paths: Record<string, string[]>;
}

const CONFIG_FILENAMES = ['tsconfig.json', 'jsconfig.json'];
const MAX_EXTENDS_HOPS = 10;

/** One config file's own values, plus its baseUrl already resolved to an absolute path (if it declared one). */
interface ConfigLevel {
  paths?: Record<string, string[]>;
  baseUrlAbs?: string;
}

export class TsconfigResolver {
  // Keyed by the resolved tsconfig/jsconfig absolute path that started the
  // extends chain — parsed (and its extends chain followed) once per path,
  // for this resolver's lifetime.
  private readonly chainCache = new Map<string, Promise<ConfigLevel | undefined>>();

  async resolveForFile(absoluteFilePath: string, workspaceFolderRoot: string): Promise<ResolvedTsPaths | undefined> {
    const root = path.resolve(workspaceFolderRoot);
    let dir = path.dirname(path.resolve(absoluteFilePath));

    for (;;) {
      for (const filename of CONFIG_FILENAMES) {
        const configPath = path.join(dir, filename);
        const level = await this.loadChain(configPath);
        if (level) {
          if (!level.paths || Object.keys(level.paths).length === 0) {
            // Closest config wins even when it has no paths — don't keep
            // walking up looking for one that does.
            return undefined;
          }
          const baseUrlAbs = level.baseUrlAbs ?? path.dirname(configPath);
          return { baseUrlAbs, paths: level.paths };
        }
      }
      if (dir === root) {
        break;
      }
      const parent = path.dirname(dir);
      if (parent === dir) {
        break; // reached the filesystem root without hitting workspaceFolderRoot
      }
      dir = parent;
    }
    return undefined;
  }

  /** Load one config file and follow its local relative `extends` chain, merging child-over-parent. */
  private async loadChain(configPath: string): Promise<ConfigLevel | undefined> {
    let pending = this.chainCache.get(configPath);
    if (!pending) {
      pending = this.loadChainUncached(configPath);
      this.chainCache.set(configPath, pending);
    }
    return pending;
  }

  private async loadChainUncached(configPath: string): Promise<ConfigLevel | undefined> {
    const levels: ConfigLevel[] = [];
    let currentPath: string | undefined = configPath;
    let hops = 0;

    while (currentPath && hops < MAX_EXTENDS_HOPS) {
      hops++;
      const text = await this.readFileIfExists(currentPath);
      if (text === undefined) {
        break;
      }
      const parsed = parseTsconfigPaths(text);
      if (!parsed) {
        break;
      }
      const dir = path.dirname(currentPath);
      const baseUrlAbs = parsed.config.baseUrl !== undefined ? path.resolve(dir, parsed.config.baseUrl) : undefined;
      levels.push({ paths: parsed.config.paths, baseUrlAbs });

      if (parsed.extends && (parsed.extends.startsWith('./') || parsed.extends.startsWith('../'))) {
        let next = path.resolve(dir, parsed.extends);
        if (!next.toLowerCase().endsWith('.json')) {
          next += '.json';
        }
        currentPath = next;
      } else {
        currentPath = undefined;
      }
    }

    if (levels.length === 0) {
      return undefined;
    }

    // levels[0] is the config we were asked to load (child-most); later
    // entries are progressively further ancestors via `extends`. Merge from
    // the furthest ancestor down so a child's own values win on conflict.
    let mergedPaths: Record<string, string[]> | undefined;
    let mergedBaseUrlAbs: string | undefined;
    for (let i = levels.length - 1; i >= 0; i--) {
      const level = levels[i];
      if (level.paths) {
        mergedPaths = { ...mergedPaths, ...level.paths };
      }
      if (level.baseUrlAbs !== undefined) {
        mergedBaseUrlAbs = level.baseUrlAbs;
      }
    }
    return { paths: mergedPaths, baseUrlAbs: mergedBaseUrlAbs };
  }

  private async readFileIfExists(absolutePath: string): Promise<string | undefined> {
    try {
      const stat = await vscode.workspace.fs.stat(vscode.Uri.file(absolutePath));
      if ((stat.type & vscode.FileType.File) === 0) {
        return undefined;
      }
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.file(absolutePath));
      return Buffer.from(bytes).toString('utf-8');
    } catch {
      return undefined;
    }
  }
}
