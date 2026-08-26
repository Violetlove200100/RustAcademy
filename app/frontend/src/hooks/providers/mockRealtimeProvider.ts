/**
 * Mock realtime provider used in local development and tests.
 *
 * A simulated connection loss retains application subscriptions and listeners
 * so a subsequent connect() behaves like a real reconnect. Explicit
 * disconnect() is terminal and clears them so an unmounted consumer cannot
 * receive stale updates later.
 */

import type {
  BidUpdate,
  RealtimeApiProvider,
  RealtimeConnectionState,
} from "@/hooks/realtimeApi";
import { errorReporter } from "@/lib/errorReporter";

export class MockRealtimeProvider implements RealtimeApiProvider {
  private listeners: ((update: BidUpdate) => void)[] = [];
  private connectionListeners: ((state: RealtimeConnectionState) => void)[] = [];
  private errorListeners: ((error: Error) => void)[] = [];
  private subscribedListings = new Set<string>();
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private _connectionState: RealtimeConnectionState = "disconnected";
  private readonly autoStart: boolean;

  constructor({ autoStart = true }: { autoStart?: boolean } = {}) {
    this.autoStart = autoStart;
  }

  connect(): void {
    if (this._connectionState !== "disconnected") return;
    this.setConnectionState("connecting");
    this.setConnectionState("connected");

    if (this.autoStart && this.intervalId === null) {
      this.intervalId = setInterval(() => {
        if (this.subscribedListings.size > 0 && Math.random() < 0.3) {
          this.emitRandomUpdate();
        }
      }, 5_000);
    }
  }

  disconnect(): void {
    this.clearInterval();
    this.setConnectionState("disconnected");

    // Explicit teardown must not retain callbacks or subscriptions belonging
    // to an unmounted consumer.
    this.listeners = [];
    this.connectionListeners = [];
    this.errorListeners = [];
    this.subscribedListings.clear();
  }

  subscribeToListing(listingId: string): void {
    this.subscribedListings.add(listingId);
  }

  unsubscribeFromListing(listingId: string): void {
    this.subscribedListings.delete(listingId);
  }

  onBidUpdate(callback: (update: BidUpdate) => void): () => void {
    if (!this.listeners.includes(callback)) this.listeners.push(callback);
    return () => this.remove(this.listeners, callback);
  }

  onConnectionStateChange(
    callback: (state: RealtimeConnectionState) => void,
  ): () => void {
    if (!this.connectionListeners.includes(callback)) {
      this.connectionListeners.push(callback);
    }
    callback(this._connectionState);
    return () => this.remove(this.connectionListeners, callback);
  }

  onError(callback: (error: Error) => void): () => void {
    if (!this.errorListeners.includes(callback)) this.errorListeners.push(callback);
    return () => this.remove(this.errorListeners, callback);
  }

  get isConnected(): boolean {
    return this._connectionState === "connected";
  }

  get connectionState(): RealtimeConnectionState {
    return this._connectionState;
  }

  /** Deliver an update manually in tests. */
  triggerBidUpdate(update: BidUpdate): void {
    if (!this.isConnected) return;
    this.notify(update);
  }

  /** Simulate a transport failure without destroying reconnectable state. */
  triggerConnectionLoss(error = new Error("Mock realtime connection lost.")): void {
    if (!this.isConnected) return;
    this.clearInterval();
    this.setConnectionState("disconnected");
    errorReporter.reportRealtimeError(error, { extra: { provider: "mock" } });
    [...this.errorListeners].forEach((callback) => callback(error));
  }

  private setConnectionState(state: RealtimeConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    [...this.connectionListeners].forEach((callback) => callback(state));
  }

  private notify(update: BidUpdate): void {
    [...this.listeners].forEach((callback) => callback(update));
  }

  private emitRandomUpdate(): void {
    const ids = Array.from(this.subscribedListings);
    if (ids.length === 0) return;

    const listingId = ids[Math.floor(Math.random() * ids.length)];
    const update: BidUpdate = {
      listingId,
      username: `user${Math.floor(Math.random() * 1_000)}`,
      newBid:
        Math.floor(Math.random() * 5_000) +
        1_000 +
        Math.floor(Math.random() * 150) +
        50,
      bidderAddress: `G${Math.random().toString(36).substring(2, 15).toUpperCase()}...${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      timestamp: new Date(),
    };
    this.notify(update);
  }

  private clearInterval(): void {
    if (this.intervalId === null) return;
    clearInterval(this.intervalId);
    this.intervalId = null;
  }

  private remove<T>(items: T[], item: T): void {
    const index = items.indexOf(item);
    if (index >= 0) items.splice(index, 1);
  }
}

/** Singleton used in non-test environments when mock mode is on. */
export const mockRealtimeProvider = new MockRealtimeProvider();
