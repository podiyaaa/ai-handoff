/**
 * The message contract between the sidebar webview and the extension host.
 *
 * Pure, VS-Code-free types — this file must never import a `vscode` type.
 * That's deliberate, not incidental: today it just keeps `core/` consistent
 * with the rest of the codebase, but it's also what would let the *same*
 * webview UI (HTML/CSS/JS) eventually be hosted by a different IDE that can
 * embed a browser view (e.g. a JetBrains/JCEF tool window) and implements
 * this same protocol on its own side — only the plain data shape needs to
 * be portable, not any code. Anywhere a capability would naturally want a
 * native-API-specific type (e.g. `vscode.InputBoxOptions`), use a plain
 * structural shape instead and let the VS-Code-specific bridge
 * implementation (`src/ui/webview-host-bridge.ts`) do the translation.
 *
 * Three envelope kinds cross the wire:
 *   - `RequestEnvelope` (webview → host): "call this method with these params"
 *   - `ResponseEnvelope` (host → webview): the matching result or error,
 *     correlated by `id`. The host bridge always sends exactly one of these
 *     per request it receives, even if the handler throws — so a webview
 *     call can never hang forever waiting for a reply that never comes.
 *   - `EventEnvelope` (host → webview): unsolicited pushes (state changed,
 *     bookmarks changed, tree invalidated by the file watcher, etc.) that
 *     aren't a response to any particular request.
 *
 * Adding a new capability is one new entry in `BridgeMethods` or
 * `BridgeEvents` plus one handler — no new envelope types, no new plumbing.
 */

import type { DiffScope, HandoffStats, OutputFormat, TreeNodeInfo } from './types';

/** A single tree row skipped from the handoff, shown in the Skipped files list. */
export interface PanelSkippedFile {
  relativePath: string;
  reason: string;
  detail?: string;
}

/** A saved named selection set, shown in the Bookmarks list. */
export interface PanelBookmark {
  name: string;
  fileCount: number;
}

/**
 * Stats pre-formatted host-side (see `formatStatsForPanel` in
 * `ui/action-panel.ts`, reused unchanged) — the webview displays
 * `sizeFormatted`/`tokensFormatted` directly rather than duplicating
 * `formatBytes`/`formatTokenCount` logic client-side.
 */
export interface PanelStats extends HandoffStats {
  sizeFormatted: string;
  tokensFormatted: string;
}

/** Everything the Actions footer needs to render itself, pushed as one `state` event. */
export interface PanelState {
  stats: PanelStats;
  format: OutputFormat;
  showCustomInstructions: boolean;
  instructions: string;
  skipped: PanelSkippedFile[];
  gitDiffEnabled: boolean;
  diffScope: DiffScope;
  /** False when no workspace folder is open — the tree shows an explanatory empty state instead of a silently blank list. */
  hasWorkspace: boolean;
}

/**
 * Central registry — one entry per webview→host request/response capability.
 * `params`/`result` of `void` means the call carries/returns no payload
 * beyond the envelope itself.
 */
export interface BridgeMethods {
  'tree/getChildren': { params: { path: string | undefined }; result: TreeNodeInfoWire[] };
  /**
   * The flattened, ordered row list a virtualized renderer windows over —
   * see `FileTreeModel.getVisibleRows()`. Deliberately a single call
   * returning the whole (bounded-by-what's-expanded) list rather than a
   * paginated/windowed API: the flattening itself must stay host-side and
   * lazy, but once computed it's cheap to send whole, and this keeps the
   * webview from needing to duplicate any "what rows exist" logic.
   */
  'tree/getVisibleRows': { params: void; result: TreeNodeInfoWire[] };
  'tree/toggleFile': { params: { path: string; checked: boolean }; result: void };
  'tree/toggleDirectory': { params: { path: string; checked: boolean }; result: void };
  'tree/toggleExpand': { params: { path: string; expanded: boolean }; result: void };
  'tree/setSearchQuery': { params: { text: string }; result: { error: string | undefined } };
  /**
   * Called once by the webview on load. Returns the full current state
   * directly as the RPC result (rather than relying on the `state`/
   * `bookmarks` push events for the *first* delivery) — a push emitted
   * before the webview has registered its listener would be silently lost,
   * the same problem the old ActionPanelProvider's cached `currentState` +
   * webview-sent `ready` message solved.
   */
  'actions/ready': { params: void; result: { state: PanelState; bookmarks: PanelBookmark[] } };
  'actions/setFormat': { params: { format: OutputFormat }; result: void };
  'actions/setInstructions': { params: { text: string }; result: void };
  'actions/setDiffEnabled': { params: { enabled: boolean }; result: void };
  'actions/setDiffScope': { params: { scope: DiffScope }; result: void };
  'actions/generate': { params: void; result: void };
  'actions/overrideFile': { params: { path: string }; result: void };
  'bookmarks/save': { params: void; result: void };
  'bookmarks/load': { params: { name: string }; result: void };
  'bookmarks/delete': { params: { name: string }; result: void };
  'bookmarks/overrideWithCurrent': { params: { name: string }; result: void };
  /** Plain structural shape, not `vscode.InputBoxOptions` — see module doc. */
  'native/showInputBox': {
    params: { prompt: string; placeholder?: string; value?: string };
    result: string | undefined;
  };
  /** Plain structural shape, not `vscode.QuickPickOptions` — see module doc. */
  'native/showQuickPick': {
    params: { items: string[]; placeholder?: string };
    result: string | undefined;
  };
  'file/open': { params: { path: string }; result: void };
}

/** Central registry — one entry per host→webview push event. */
export interface BridgeEvents {
  state: PanelState;
  bookmarks: PanelBookmark[];
  /** `path: undefined` means "the root changed" (e.g. treat as fully invalidated). */
  'tree/invalidated': { path: string | undefined };
  'actions/generating': { busy: boolean };
  /** General-purpose error display for the Actions footer — not tree-specific. */
  error: { message: string };
}

export type BridgeMethodName = keyof BridgeMethods;
export type BridgeEventName = keyof BridgeEvents;

export interface RequestEnvelope<M extends BridgeMethodName = BridgeMethodName> {
  kind: 'request';
  id: string;
  method: M;
  params: BridgeMethods[M]['params'];
}

export type ResponseEnvelope<M extends BridgeMethodName = BridgeMethodName> =
  | { kind: 'response'; id: string; ok: true; result: BridgeMethods[M]['result'] }
  | { kind: 'response'; id: string; ok: false; error: { message: string } };

export interface EventEnvelope<E extends BridgeEventName = BridgeEventName> {
  kind: 'event';
  event: E;
  payload: BridgeEvents[E];
}

/**
 * A `core/types.ts` `TreeNodeInfo`, as it actually crosses the wire. Kept as
 * a separate alias (identical today) so the wire shape can diverge from the
 * host-side domain type later without every call site needing to know —
 * import `TreeNodeInfoWire` at bridge boundaries, `TreeNodeInfo` everywhere else.
 */
export type TreeNodeInfoWire = TreeNodeInfo;
