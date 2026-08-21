/**
 * Mock realtime provider.
 *
 * Simulates a WebSocket that emits random bid updates on a 5-second
 * interval. Used in local dev (NEXT_PUBLIC_API_MOCK=true) and tests.
 *
 * In tests you typically do NOT want the interval firing; pass
 * `autoStart = false` and call `triggerBidUpdate()` manually instead.
 *
 * Lifecycle hardening (issue #526):
 *   - disconnect() clears listeners and status-listeners so stale callbacks
 *     do not accumulate across reconnects.
 *   - triggerBidUpdate() is a no-op when the provider is disconnected so
 *     test helpers cannot accidentally deliver updates after teardown.
 *   - Iterates a snapshot of listeners in _emitRandomUpdate / triggerBidUpdate
 *     so unsubscribing inside a callback is safe.
 *   - onStatusChange fires on every connect/disconnect/error so UI can react
 *     reactively rather than polling isConnected.
 *   - simulateConnectionError() lets unit tests exercise the error path.
 */

import type { BidUpdate, RealtimeApiProvider, RealtimeStatus } from "@/hooks/realtimeApi";

export class MockRealtimeProvider implements RealtimeApiProvider {
  private listeners: ((update: BidUpdate) => void)[] = [];
  private statusListeners: ((status: RealtimeStatus) => void)[] = [];
  private subscribedListings: Set<string> = new Set();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private _isConnected = false;
  private _lastError: string | null = null;
  private readonly autoStart: boolean;

  constructor({ autoStart = true }: { autoStart?: boolean } = {}) {
    this.autoStart = autoStart;
  }

  connect(): void {
    if (this._isConnected) return;
    this._isConnected = true;
    this._lastError = null;
    this._emitStatus();

    if (this.autoStart) {
      // 30 % chance of emitting a random update every 5 s
      this.intervalId = setInterval(() => {
        if (this.subscribedListings.size > 0 && Math.random() < 0.3) {
          this._emitRandomUpdate();
        }
      }, 5_000);
    }
  }

  disconnect(): void {
    this._isConnected = false;
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Emit the disconnected status BEFORE clearing listeners so any
    // subscriber that wants to react (e.g. show an error banner) can do so.
    this._emitStatus();
    // Clear all registered listeners so stale callbacks cannot fire after
    // the provider is torn down and re-connected (issue #526).
    this.listeners = [];
    this.statusListeners = [];
  }

  subscribeToListing(listingId: string): void {
    this.subscribedListings.add(listingId);
  }

  unsubscribeFromListing(listingId: string): void {
    this.subscribedListings.delete(listingId);
  }

  onBidUpdate(callback: (update: BidUpdate) => void): () => void {
    this.listeners.push(callback);
    return () => {
      const idx = this.listeners.indexOf(callback);
      if (idx > -1) this.listeners.splice(idx, 1);
    };
  }

  onStatusChange(callback: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.push(callback);
    // Always emit the current status immediately so callers don't have to
    // wait for the next status transition.
    callback({ isConnected: this._isConnected, error: this._lastError });
    return () => {
      const idx = this.statusListeners.indexOf(callback);
      if (idx > -1) this.statusListeners.splice(idx, 1);
    };
  }

  get isConnected(): boolean {
    return this._isConnected;
  }

  /**
   * Imperatively emit a bid update — handy in unit tests where you
   * want full control over what arrives over the "wire".
   *
   * No-ops when the provider is disconnected so test helpers cannot
   * accidentally deliver updates after teardown (issue #526).
   */
  triggerBidUpdate(update: BidUpdate): void {
    if (!this._isConnected) return;
    // Snapshot the array so that unsubscribing inside a callback is safe.
    [...this.listeners].forEach((cb) => cb(update));
  }

  /**
   * Simulate a connection error (issue #526).
   *
   * Fires onStatusChange with isConnected=false and the given message so
   * unit / integration tests can verify the error-banner path without
   * needing a real network failure.
   */
  simulateConnectionError(message: string): void {
    this._isConnected = false;
    this._lastError = message;
    this._emitStatus();
  }

  private _emitRandomUpdate(): void {
    const ids = Array.from(this.subscribedListings);
    if (ids.length === 0) return;

    const listingId = ids[Math.floor(Math.random() * ids.length)];
    const newBid =
      Math.floor(Math.random() * 5_000) + 1_000 + Math.floor(Math.random() * 150) + 50;

    const update: BidUpdate = {
      listingId,
      username: `user${Math.floor(Math.random() * 1_000)}`,
      newBid,
      bidderAddress: `G${Math.random().toString(36).substring(2, 15).toUpperCase()}...${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      timestamp: new Date(),
    };

    // Snapshot the array so that unsubscribing inside a callback is safe.
    [...this.listeners].forEach((cb) => cb(update));
  }

  private _emitStatus(): void {
    const status: RealtimeStatus = {
      isConnected: this._isConnected,
      error: this._lastError,
    };
    [...this.statusListeners].forEach((cb) => cb(status));
  }
}

/** Singleton used in non-test environments when mock mode is on. */
export const mockRealtimeProvider = new MockRealtimeProvider();
