"use client";

import { useState, useEffect, useMemo, useCallback } from "react";
import type { MarketplaceListing } from "@/hooks/marketplaceApi";
import { useMarketplaceApi } from "@/hooks/MarketplaceApiContext";
import { useRealtimeApi } from "@/hooks/RealtimeApiContext";
import type { RealtimeConnectionState } from "@/hooks/realtimeApi";
import { applyBidUpdate, applyLocalBid } from "@/lib/bidUpdates";

export type UseMarketDataResult = {
  listings: MarketplaceListing[];
  loading: boolean;
  lastUpdate: Date | null;
  realtimeError: string | null;
  isConnected: boolean;
  connectionState: RealtimeConnectionState;
  applyBid: (username: string, amount: number) => void;
};

/**
 * Fetches marketplace data and owns its realtime subscription lifecycle.
 * Listing IDs, rather than the changing listing objects, drive the
 * subscription effect so bid updates cannot cause subscription storms.
 */
export function useMarketData(): UseMarketDataResult {
  const [listings, setListings] = useState<MarketplaceListing[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdate, setLastUpdate] = useState<Date | null>(null);
  const [realtimeError, setRealtimeError] = useState<string | null>(null);
  const [connectionState, setConnectionState] = useState<RealtimeConnectionState>(
    "disconnected",
  );

  const marketplaceApi = useMarketplaceApi();
  const realtimeApi = useRealtimeApi();

  const listingIds = useMemo(
    () => listings.map((listing) => listing.id),
    [listings],
  );
  const listingIdsKey = listingIds.join("\u0000");

  useEffect(() => {
    let cancelled = false;

    setLoading(true);
    marketplaceApi
      .fetchListings()
      .then((data) => {
        if (cancelled) return;
        setListings(data);
        setLoading(false);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoading(false);
        console.error("[useMarketData] Failed to fetch listings:", error);
      });

    return () => {
      cancelled = true;
    };
  }, [marketplaceApi]);

  useEffect(() => {
    const currentState = realtimeApi.connectionState ??
      (realtimeApi.isConnected ? "connected" : "disconnected");
    setConnectionState(currentState);

    const unsubscribeState = realtimeApi.onConnectionStateChange?.((state) => {
      setConnectionState(state);
      if (state === "connected") setRealtimeError(null);
      if (state === "disconnected") {
        setRealtimeError((current) => current ?? "Connection lost. Retrying…");
      }
    });
    const unsubscribeError = realtimeApi.onError?.((error) => {
      setRealtimeError(error.message || "Realtime connection failed.");
    });

    return () => {
      unsubscribeState?.();
      unsubscribeError?.();
    };
  }, [realtimeApi]);

  useEffect(() => {
    if (listingIds.length === 0) return;

    listingIds.forEach((id) => realtimeApi.subscribeToListing(id));
    return () => {
      listingIds.forEach((id) => realtimeApi.unsubscribeFromListing(id));
    };
    // listingIdsKey changes only when the set/order of listing IDs changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [realtimeApi, listingIdsKey]);

  useEffect(() => {
    const unsubscribe = realtimeApi.onBidUpdate((update) => {
      setLastUpdate(update.timestamp);
      setListings((currentListings) =>
        applyBidUpdate(currentListings, {
          listingId: update.listingId,
          newBid: update.newBid,
          bidCount: update.bidCount,
        }),
      );
    });

    return unsubscribe;
  }, [realtimeApi]);

  const applyBid = useCallback((username: string, amount: number) => {
    setListings((currentListings) =>
      applyLocalBid(currentListings, username, amount),
    );
  }, []);

  return {
    listings,
    loading,
    lastUpdate,
    realtimeError,
    isConnected: connectionState === "connected",
    connectionState,
    applyBid,
  };
}
