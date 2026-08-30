/**
 * Host-side half of the webview bridge (see `src/core/bridge-protocol.ts`
 * for the wire format and the reasoning behind it). Wraps one
 * `vscode.Webview` and dispatches incoming `RequestEnvelope`s to registered
 * handlers, always posting back exactly one `ResponseEnvelope` per request —
 * ok or error, even if the handler throws — so a webview call can never
 * hang forever waiting for a reply that never arrives.
 */

import * as vscode from 'vscode';
import type {
  BridgeEventName,
  BridgeEvents,
  BridgeMethodName,
  BridgeMethods,
  EventEnvelope,
  RequestEnvelope,
  ResponseEnvelope,
} from '../core/bridge-protocol';

type AnyHandler = (params: unknown) => Promise<unknown> | unknown;

function isRequestEnvelope(message: unknown): message is RequestEnvelope {
  if (typeof message !== 'object' || message === null) {
    return false;
  }
  const m = message as Partial<RequestEnvelope>;
  return m.kind === 'request' && typeof m.id === 'string' && typeof m.method === 'string';
}

export class HostBridge implements vscode.Disposable {
  private readonly handlers = new Map<BridgeMethodName, AnyHandler>();
  private readonly listener: vscode.Disposable;

  constructor(private readonly webview: vscode.Webview) {
    this.listener = webview.onDidReceiveMessage((message: unknown) => {
      void this.dispatch(message);
    });
  }

  /**
   * Register the handler for one bridge method. Registering the same
   * method twice replaces the previous handler — callers are expected to
   * register each method exactly once, this just avoids a surprising crash
   * if a provider is ever re-initialized.
   */
  handle<M extends BridgeMethodName>(
    method: M,
    fn: (
      params: BridgeMethods[M]['params'],
    ) => Promise<BridgeMethods[M]['result']> | BridgeMethods[M]['result'],
  ): void {
    this.handlers.set(method, fn as AnyHandler);
  }

  /** Push an unsolicited event to the webview (not a response to any request). */
  emit<E extends BridgeEventName>(event: E, payload: BridgeEvents[E]): void {
    const envelope: EventEnvelope<E> = { kind: 'event', event, payload };
    void this.webview.postMessage(envelope);
  }

  private async dispatch(message: unknown): Promise<void> {
    if (!isRequestEnvelope(message)) {
      return;
    }
    const { id, method, params } = message;
    const handler = this.handlers.get(method);
    if (!handler) {
      await this.respond({
        kind: 'response',
        id,
        ok: false,
        error: { message: `AI Handoff: no handler registered for "${method}"` },
      });
      return;
    }
    try {
      const result = await handler(params);
      // `result` is `unknown` here — the Map's value type had to erase each
      // handler's specific signature to store heterogeneous handlers
      // together. Safe by construction: whatever handler ran was registered
      // for exactly this `method`, so its result always matches that
      // method's declared type; TypeScript just can't see through the Map.
      await this.respond({ kind: 'response', id, ok: true, result: result as never });
    } catch (e) {
      await this.respond({
        kind: 'response',
        id,
        ok: false,
        error: { message: e instanceof Error ? e.message : String(e) },
      });
    }
  }

  private async respond(envelope: ResponseEnvelope): Promise<void> {
    await this.webview.postMessage(envelope);
  }

  dispose(): void {
    this.listener.dispose();
    this.handlers.clear();
  }
}
