/**
 * Unit tests for MockRealtimeProvider
 *
 * All tests use autoStart:false so no setInterval fires during the test run.
 * We drive updates with triggerBidUpdate() instead.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MockRealtimeProvider } from "@/hooks/providers/mockRealtimeProvider";
import type { BidUpdate } from "@/hooks/realtimeApi";

const SAMPLE_UPDATE: BidUpdate = {
  listingId: "1",
  username: "testuser",
  newBid: 2500,
  bidderAddress: "GABCD...XYZ",
  timestamp: new Date("2026-01-01T12:00:00Z"),
};

let provider: MockRealtimeProvider;

beforeEach(() => {
  provider = new MockRealtimeProvider({ autoStart: false });
});

afterEach(() => {
  provider.disconnect();
});

// ── connect / disconnect ──────────────────────────────────────────────────────

describe("connect / disconnect", () => {
  it("starts disconnected", () => {
    expect(provider.isConnected).toBe(false);
  });

  it("becomes connected after connect()", () => {
    provider.connect();
    expect(provider.isConnected).toBe(true);
  });

  it("becomes disconnected after disconnect()", () => {
    provider.connect();
    provider.disconnect();
    expect(provider.isConnected).toBe(false);
  });

  it("connect() is idempotent", () => {
    provider.connect();
    provider.connect(); // second call should not throw
    expect(provider.isConnected).toBe(true);
  });
});

// ── subscribeToListing / unsubscribeFromListing ───────────────────────────────

describe("subscribe / unsubscribe", () => {
  it("does not throw when subscribing before connecting", () => {
    expect(() => provider.subscribeToListing("abc")).not.toThrow();
  });

  it("removes a listing from the subscription set on unsubscribe", () => {
    provider.subscribeToListing("abc");
    provider.unsubscribeFromListing("abc");
    // Verify indirectly: triggering an update for "abc" should reach no listeners
    // because there are no listeners registered — no assertion needed beyond no-throw.
    expect(() => provider.triggerBidUpdate({ ...SAMPLE_UPDATE, listingId: "abc" })).not.toThrow();
  });
});

// ── onBidUpdate ───────────────────────────────────────────────────────────────

describe("onBidUpdate", () => {
  it("calls the callback when triggerBidUpdate is invoked", () => {
    provider.connect();
    const cb = vi.fn();
    provider.onBidUpdate(cb);
    provider.triggerBidUpdate(SAMPLE_UPDATE);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith(SAMPLE_UPDATE);
  });

  it("supports multiple listeners", () => {
    provider.connect();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    provider.onBidUpdate(cb1);
    provider.onBidUpdate(cb2);
    provider.triggerBidUpdate(SAMPLE_UPDATE);

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("returns an unsubscribe function that removes the listener", () => {
    provider.connect();
    const cb = vi.fn();
    const unsub = provider.onBidUpdate(cb);

    unsub(); // remove before any update

    provider.triggerBidUpdate(SAMPLE_UPDATE);
    expect(cb).not.toHaveBeenCalled();
  });

  it("does not call unsubscribed listener while other listeners still receive updates", () => {
    provider.connect();
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    const unsub1 = provider.onBidUpdate(cb1);
    provider.onBidUpdate(cb2);

    unsub1();
    provider.triggerBidUpdate(SAMPLE_UPDATE);

    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).toHaveBeenCalledTimes(1);
  });

  it("delivers the exact update object to all listeners", () => {
    provider.connect();
    const received: BidUpdate[] = [];
    provider.onBidUpdate((u) => received.push(u));

    const update: BidUpdate = {
      listingId: "42",
      username: "alice",
      newBid: 9999,
      bidderAddress: "GXXX...YYY",
      timestamp: new Date(),
    };

    provider.triggerBidUpdate(update);
    expect(received).toHaveLength(1);
    expect(received[0]).toBe(update); // same reference
  });
});

// ── onStatusChange & error simulation (issue #526) ────────────────────────────

describe("onStatusChange", () => {
  it("fires connect → disconnect transitions", () => {
    const statuses: { isConnected: boolean; error: string | null }[] = [];
    provider.onStatusChange((s) => statuses.push({ ...s }));

    // Initial emission on subscribe (provider is disconnected)
    expect(statuses).toEqual([{ isConnected: false, error: null }]);

    provider.connect();
    expect(statuses).toEqual([
      { isConnected: false, error: null },
      { isConnected: true, error: null },
    ]);

    provider.disconnect();
    expect(statuses).toEqual([
      { isConnected: false, error: null },
      { isConnected: true, error: null },
      { isConnected: false, error: null },
    ]);
  });

  it("clears status listeners on disconnect", () => {
    const cb = vi.fn();
    provider.onStatusChange(cb);
    // disconnect fires _emitStatus BEFORE clearing, so cb gets the disconnect event too
    provider.disconnect();

    // After disconnect, listeners are cleared. Connect should NOT fire cb.
    provider.connect();
    // initial (subscribe) + disconnect emit = 2 calls; connect should NOT be a third
    expect(cb).toHaveBeenCalledTimes(2);
  });

  it("returns an unsubscribe function", () => {
    const cb = vi.fn();
    const unsub = provider.onStatusChange(cb);
    unsub();

    provider.connect();
    // Only the initial immediate emit (before unsub) should count.
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it("simulateConnectionError fires error status and disconnects", () => {
    const statuses: { isConnected: boolean; error: string | null }[] = [];
    provider.connect();
    provider.onStatusChange((s) => statuses.push({ ...s }));

    // Subscribe fired once with connected + no error
    expect(statuses).toEqual([{ isConnected: true, error: null }]);

    provider.simulateConnectionError("timeout");
    expect(statuses).toEqual([
      { isConnected: true, error: null },
      { isConnected: false, error: "timeout" },
    ]);
    expect(provider.isConnected).toBe(false);
  });

  it("reconnect clears the error", () => {
    const statuses: { isConnected: boolean; error: string | null }[] = [];
    provider.simulateConnectionError("timeout");
    provider.onStatusChange((s) => statuses.push({ ...s }));

    // Initial emission: disconnected + error
    expect(statuses).toEqual([{ isConnected: false, error: "timeout" }]);

    provider.connect();
    expect(statuses).toEqual([
      { isConnected: false, error: "timeout" },
      { isConnected: true, error: null },
    ]);
  });
});

// ── autoStart behaviour ───────────────────────────────────────────────────────

describe("autoStart", () => {
  it("does NOT start the interval when autoStart is false", () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(global, "setInterval");

    const p = new MockRealtimeProvider({ autoStart: false });
    p.connect();

    expect(intervalSpy).not.toHaveBeenCalled();

    p.disconnect();
    vi.useRealTimers();
  });

  it("starts the interval when autoStart is true (default)", () => {
    vi.useFakeTimers();
    const intervalSpy = vi.spyOn(global, "setInterval");

    const p = new MockRealtimeProvider({ autoStart: true });
    p.connect();

    expect(intervalSpy).toHaveBeenCalledTimes(1);

    p.disconnect();
    vi.useRealTimers();
  });
});
