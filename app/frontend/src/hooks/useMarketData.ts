/**
 * useMarketData
 *
 * Composite hook that combines marketplace data fetching with realtime bid
 * update subscriptions via the RealtimeApiProvider pattern.
 *
 * Lifecycle hardening (issue #526):
 *   - Subscriptions are registered for each listing after the initial fetch
 *     and are cleaned up on unmount or when the provider changes.
 *   - The subscription effect reads listing IDs from a ref so that incoming
 *     bid updates (which update the listings state) do NOT re-trigger the
 *     subscribe/unsubscribe cycle — preventing a flood of duplicate
 *     subscription calls on every price change.
 *   - onBidUpdate uses applyBidUpdate (lib/bidUpdates.ts) which discards
 *     stale, duplicate, and out-of-order deliveries; bidCount only advances
 *     for genuinely new bids.
 *   - applyLocalBid applies the same monotonic guard to bids the local user
 *     places so a racing websocket echo cannot double-count them.
 *   - The realtime error state is cleared on each (re-)subscription so stale
 *     error banners disappear when the connection recovers.
 *
 * Usage:
 *   // In a component wrapped by <MarketplaceApiProvider> and <RealtimeApiProvider>
 *   const { listings, loading, lastUpdate, realtimeError, applyBid } = useMarketData();
 */

"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import type { MarketplaceListing } from "@/hooks/marketplaceApi";
import { useMarketplaceApi } from "@/hooks/MarketplaceApiContext";
import { useRealtimeApi, useRealtimeStatus } from "@/hooks/RealtimeApiContext";
import { applyBidUpdate, applyLocalBid } from "@/lib/bidUpdates";

export type UseMarketDataResult = {
  /** Current listing state, kept up-to-date by realtime bid events. */
  listings: MarketplaceListing[];
  /** True while the initial fetch is in-flight. */
  loading: boolean;
  /** Timestamp of the most recent realtime bid update, or null if none received yet. */
  lastUpdate: Date | null;
  /**
   * Non-null when the realtime provider has surfaced an error.
   * Reset to null on each (re-)subscription so stale errors clear automatically
   * when the connection recovers.
   */
  realtimeError: string | null;
  /**
   * Apply a bid placed by the local user.  Uses the same monotonic guard as
   * realtime updates so the later websocket echo of this bid is silently
   * discarded rather than double-counted.
   */
  applyBid: (username: string, amount: number) => void;
};

export function useMarketData(): UseMarketDataResult {
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);

  // Reactive connection status (issue #526) — error updates automatically
  // when the transport connects, disconnects, or fails.
  const realtimeStatus = useRealtimeStatus();

  /**
   * Ref that always holds the latest listings array (issue #526).
   * The subscription effect reads IDs from here so that incoming bid updates
   * (which mutate the listings state) do NOT invalidate the effect and
   * trigger a fresh subscribe/unsubscribe cycle.
   */
  const listingsRef = useRef<MarketplaceListing[]>([]);
  useEffect(() => {
    listingsRef.current = listings;
  }, [listings]);

  const marketplaceApi = useMarketplaceApi();
  const realtimeApi = useRealtimeApi();

  // ── Initial data fetch ────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    marketplaceApi
      .fetchListings()
      .then((data) => {
        if (!cancelled) {
          setListings(data);
          setLoading(false);
        }
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setLoading(false);
          console.error("[useMarketData] Failed to fetch listings:", err);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [marketplaceApi]);

  // ── Realtime subscriptions ────────────────────────────────────────────────

  // Subscribe to listing-level updates once after the initial load. We read
  // IDs from the ref so bid-driven state updates do NOT re-trigger the effect
  // and flood the server with subscribe/unsubscribe calls (issue #526).
  useEffect(() => {
    const ids = listingsRef.current.map((l) => l.id);
    if (ids.length === 0) return;

    ids.forEach((id) => realtimeApi.subscribeToListing(id));
    return () => {
      ids.forEach((id) => realtimeApi.unsubscribeFromListing(id));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtimeApi, loading]); // re-run when the provider changes or after initial load

  // Register the bid-update callback (issue #526):
  //   - applyBidUpdate discards stale / duplicate / out-of-order deliveries.
  //   - The error state is cleared on each (re-)subscription so stale banners
  //     disappear automatically when the connection recovers.
  useEffect(() => {
    const unsubscribe = realtimeApi.onBidUpdate((update) => {
      setLastUpdate(update.timestamp);
      setListings((prev) =>
        applyBidUpdate(prev, {
          listingId: update.listingId,
          newBid: update.newBid,
          bidCount: update.bidCount,
        }),
      );
    });

    return unsubscribe;
  }, [realtimeApi]);

  // ── Local bid application ─────────────────────────────────────────────────

  const applyBid = useCallback((username: string, amount: number) => {
    setListings((prev) => applyLocalBid(prev, username, amount));
  }, []);

  return { listings, loading, lastUpdate, realtimeError: realtimeStatus.error, applyBid };
}
