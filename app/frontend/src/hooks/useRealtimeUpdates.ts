"use client";

import { useState, useEffect, useCallback } from 'react';

type BidUpdate = {
  listingId: string;
  username: string;
  newBid: number;
  bidderAddress: string;
  timestamp: Date;
  /** Authoritative total bid count, when the backend provides one. */
  bidCount?: number;
};

type RealtimeStatus = {
  isConnected: boolean;
  error: string | null;
};

type RealtimeUpdatesHook = {
  isConnected: boolean;
  lastUpdate: Date | null;
  realtimeError: string | null;
  subscribeToListing: (listingId: string, currentBid?: number) => void;
  unsubscribeFromListing: (listingId: string) => void;
  onBidUpdate: (callback: (update: BidUpdate) => void) => () => void;
};

// Mock WebSocket simulation for real-time bid updates.
// Deliveries are NOT guaranteed to be fresh: like a real websocket feed, this
// occasionally replays a previous bid (duplicate / out-of-order delivery), so
// consumers must guard before applying updates (see lib/bidUpdates.ts).
export class MockWebSocket {
  private listeners: ((update: BidUpdate) => void)[] = [];
  private statusListeners: ((status: RealtimeStatus) => void)[] = [];
  private subscribedListings: Set<string> = new Set();
  private lastBids: Map<string, number> = new Map();
  private intervalId: NodeJS.Timeout | null = null;
  private isConnected = false;
  private lastError: string | null = null;

  connect() {
    this.isConnected = true;
    this.lastError = null;
    this._emitStatus();

    // Simulate periodic bid updates
    this.intervalId = setInterval(() => {
      if (this.subscribedListings.size > 0 && Math.random() < 0.3) { // 30% chance every 5 seconds
        this.simulateBidUpdate();
      }
    }, 5000);
  }

  disconnect() {
    this.isConnected = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    // Emit the disconnected status BEFORE clearing listeners so any
    // subscriber that wants to react can do so (issue #526).
    this._emitStatus();
    // Clear all listeners on disconnect so stale callbacks do not accumulate
    // across reconnects (issue #526).
    this.listeners = [];
    this.statusListeners = [];
  }

  subscribe(listingId: string, currentBid?: number) {
    this.subscribedListings.add(listingId);
    if (currentBid !== undefined) {
      this.lastBids.set(
        listingId,
        Math.max(this.lastBids.get(listingId) ?? 0, currentBid),
      );
    }
  }

  unsubscribe(listingId: string) {
    this.subscribedListings.delete(listingId);
  }

  onBidUpdate(callback: (update: BidUpdate) => void) {
    // Guard against duplicate registrations of the same function reference
    // (issue #526) — prevents stale callbacks from accumulating when callers
    // register without first calling the returned unsubscribe.
    if (this.listeners.includes(callback)) {
      return () => {
        const index = this.listeners.indexOf(callback);
        if (index > -1) {
          this.listeners.splice(index, 1);
        }
      };
    }
    this.listeners.push(callback);
    return () => {
      const index = this.listeners.indexOf(callback);
      if (index > -1) {
        this.listeners.splice(index, 1);
      }
    };
  }

  onStatusChange(callback: (status: RealtimeStatus) => void): () => void {
    this.statusListeners.push(callback);
    // Emit current status immediately so callers don't have to wait for a transition.
    callback({ isConnected: this.isConnected, error: this.lastError });
    return () => {
      const idx = this.statusListeners.indexOf(callback);
      if (idx > -1) this.statusListeners.splice(idx, 1);
    };
  }

  private simulateBidUpdate() {
    const subscribedArray = Array.from(this.subscribedListings);
    if (subscribedArray.length === 0) return;

    const randomListingId = subscribedArray[Math.floor(Math.random() * subscribedArray.length)];
    const lastBid = this.lastBids.get(randomListingId) ?? 500;

    // ~20% of deliveries replay the previous bid, simulating the duplicate /
    // out-of-order messages a real feed can produce. Consumers must discard
    // any update that does not raise the current bid.
    const isStaleReplay = this.lastBids.has(randomListingId) && Math.random() < 0.2;
    const newBid = isStaleReplay
      ? lastBid
      : lastBid + Math.floor(Math.random() * 100) + 50; // 50-150 USDC increase
    if (!isStaleReplay) {
      this.lastBids.set(randomListingId, newBid);
    }

    const update: BidUpdate = {
      listingId: randomListingId,
      username: `user${Math.floor(Math.random() * 1000)}`, // Mock username
      newBid,
      bidderAddress: `G${Math.random().toString(36).substring(2, 15).toUpperCase()}...${Math.random().toString(36).substring(2, 6).toUpperCase()}`,
      timestamp: new Date()
    };

    // Iterate a snapshot so unsubscribing inside a callback is safe (issue #526).
    [...this.listeners].forEach(listener => listener(update));
  }

  get connectionStatus() {
    return this.isConnected;
  }

  private _emitStatus(): void {
    const status: RealtimeStatus = { isConnected: this.isConnected, error: this.lastError };
    [...this.statusListeners].forEach((cb) => cb(status));
  }
}

// Singleton instance
const mockWebSocket = new MockWebSocket();

export function useRealtimeUpdates(): RealtimeUpdatesHook {
  const [isConnected, setIsConnected] = useState(mockWebSocket.connectionStatus);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  useEffect(() => {
    mockWebSocket.connect();

    // Reactive status subscription (issue #526).
    const unsubscribeStatus = mockWebSocket.onStatusChange((status) => {
      setIsConnected(status.isConnected);
      setRealtimeError(status.error);
    });

    return () => {
      unsubscribeStatus();
      mockWebSocket.disconnect();
    };
  }, []);

  const subscribeToListing = useCallback(
    (listingId: string, currentBid?: number) => {
      mockWebSocket.subscribe(listingId, currentBid);
    },
    [],
  );

  const unsubscribeFromListing = useCallback((listingId: string) => {
    mockWebSocket.unsubscribe(listingId);
  }, []);

  const onBidUpdate = useCallback((callback: (update: BidUpdate) => void) => {
    return mockWebSocket.onBidUpdate((update) => {
      setLastUpdate(update.timestamp);
      callback(update);
    });
  }, []);

  return {
    isConnected,
    realtimeError,
    lastUpdate,
    subscribeToListing,
    unsubscribeFromListing,
    onBidUpdate,
  };
}

export type { BidUpdate };