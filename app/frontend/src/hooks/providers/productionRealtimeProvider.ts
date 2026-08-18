/**
 * Production realtime provider.
 *
 * Connects to the real RustAcademy WebSocket server (Socket.io).
 * The TODO stubs below should be replaced with actual Socket.io calls
 * once the server contract is finalised.
 *
 * Environment variable:
 *   NEXT_PUBLIC_WS_URL — WebSocket server URL (e.g. wss://api.rustacademy.xyz)
 *   Defaults to ws://localhost:4000 when unset.
 *
 * Lifecycle hardening (issue #526):
 *   - connect() is idempotent: calling it while connected or while a
 *     reconnect is in flight is a no-op.
 *   - disconnect() cancels any pending reconnect timer so dead handlers
 *     cannot fire after the provider is torn down.
 *   - onBidUpdate returns an unsubscribe function; the listeners array is
 *     cleared on disconnect to prevent stale callbacks accumulating across
 *     reconnects.
 *   - Reconnect uses exponential back-off (1 s → 2 s → 4 s … capped at 30 s)
 *     and reports the failure via errorReporter after every attempt.
 */

import type { BidUpdate, RealtimeApiProvider } from "@/hooks/realtimeApi";
import { errorReporter } from "@/lib/errorReporter";

const getWsUrl = (): string =>
  process.env.NEXT_PUBLIC_WS_URL?.replace(/\/$/, "") ?? "ws://localhost:4000";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export class ProductionRealtimeProvider implements RealtimeApiProvider {
  private listeners: ((update: BidUpdate) => void)[] = [];
  private subscribedListings: Set<string> = new Set();
  private _isConnected = false;
  private _isConnecting = false;

  // TODO: replace `unknown` with the actual Socket.io client type once
  //       socket.io-client is imported: `import { Socket } from "socket.io-client"`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private socket: any = null;

  /** Tracks the pending setTimeout handle for reconnect back-off. */
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  /** Number of consecutive failed connect attempts, used for back-off. */
  private reconnectAttempt = 0;

  connect(): void {
    // Guard: already connected or in the middle of connecting.
    if (this._isConnected || this._isConnecting) return;

    this._isConnecting = true;

    // TODO: replace with real Socket.io initialisation, e.g.
    //   import { io } from "socket.io-client";
    //   this.socket = io(getWsUrl(), { transports: ["websocket"] });
    //   this.socket.on("connect", () => {
    //     this._isConnected = true;
    //     this._isConnecting = false;
    //     this.reconnectAttempt = 0;
    //     // Re-subscribe to listings that were tracked before reconnect
    //     this.subscribedListings.forEach((id) =>
    //       this.socket?.emit("marketplace:subscribe", { listingId: id }),
    //     );
    //   });
    //   this.socket.on("disconnect", (reason: string) => {
    //     this._isConnected = false;
    //     this._scheduleReconnect(new Error(`Socket disconnected: ${reason}`));
    //   });
    //   this.socket.on("connect_error", (err: Error) => {
    //     this._isConnecting = false;
    //     this._scheduleReconnect(err);
    //   });
    //   this.socket.on("bid:update", (update: BidUpdate) => { this._notify(update); });
    console.warn(
      `[ProductionRealtimeProvider] connect() called — ws url: ${getWsUrl()}. Socket.io not yet wired.`,
    );

    // Optimistic until real socket is wired; reset connecting flag.
    this._isConnected = true;
    this._isConnecting = false;
    this.reconnectAttempt = 0;
  }

  disconnect(): void {
    // Cancel any pending reconnect so it can't fire after teardown.
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    // TODO: this.socket?.disconnect();
    this._isConnected = false;
    this._isConnecting = false;
    this.socket = null;
    this.reconnectAttempt = 0;

    // Clear all listeners to prevent stale callbacks from accumulating
    // across reconnects (issue #526).
    this.listeners = [];
  }

  subscribeToListing(listingId: string): void {
    this.subscribedListings.add(listingId);
    // TODO: this.socket?.emit("marketplace:subscribe", { listingId });
  }

  unsubscribeFromListing(listingId: string): void {
    this.subscribedListings.delete(listingId);
    // TODO: this.socket?.emit("marketplace:unsubscribe", { listingId });
  }

  onBidUpdate(callback: (update: BidUpdate) => void): () => void {
    // Guard against duplicate registrations of the exact same function
    // reference (e.g. when connect() is called more than once without an
    // intervening disconnect in future real-socket paths).
    if (this.listeners.includes(callback)) {
      return () => this._removeListener(callback);
    }

    this.listeners.push(callback);
    return () => this._removeListener(callback);
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  private _removeListener(callback: (update: BidUpdate) => void): void {
    const idx = this.listeners.indexOf(callback);
    if (idx > -1) this.listeners.splice(idx, 1);
  }

  private _notify(update: BidUpdate): void {
    // Iterate over a snapshot so that unsubscribing inside a callback is safe.
    [...this.listeners].forEach((cb) => cb(update));
  }

  /**
   * Schedule a reconnect attempt with exponential back-off.
   * Reports each failure to errorReporter so it surfaces in telemetry.
   */
  private _scheduleReconnect(cause: Error): void {
    this._isConnected = false;
    this._isConnecting = false;

    const delayMs = Math.min(
      BACKOFF_BASE_MS * 2 ** this.reconnectAttempt,
      BACKOFF_MAX_MS,
    );
    this.reconnectAttempt += 1;

    errorReporter.reportRealtimeError(cause, {
      extra: {
        wsUrl: getWsUrl(),
        attempt: this.reconnectAttempt,
        nextRetryMs: delayMs,
      },
    });

    console.warn(
      `[ProductionRealtimeProvider] Connection lost. Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt}).`,
      cause,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
  }
}

/** Singleton — one connection per page load. */
export const productionRealtimeProvider = new ProductionRealtimeProvider();
