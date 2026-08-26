import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { MarketplaceApiContext } from "@/hooks/MarketplaceApiContext";
import { RealtimeApiProvider } from "@/hooks/RealtimeApiContext";
import { MockRealtimeProvider } from "@/hooks/providers/mockRealtimeProvider";
import { useMarketData } from "@/hooks/useMarketData";
import type { MarketplaceApiProvider, MarketplaceListing } from "@/hooks/marketplaceApi";
import { errorReporter } from "@/lib/errorReporter";

const listing: MarketplaceListing = {
  id: "listing-1",
  username: "nova",
  currentBid: 1_000,
  buyNowPrice: null,
  ownerAddress: "GABC...XYZ",
  endsAt: new Date("2026-12-01T00:00:00.000Z"),
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  status: "auction",
  category: "brand",
  bidCount: 1,
  watchers: 2,
  verified: true,
};

function makeMarketplaceProvider(): MarketplaceApiProvider {
  return {
    fetchListings: vi.fn().mockResolvedValue([listing]),
    fetchUserBids: vi.fn().mockResolvedValue([]),
    fetchUserListings: vi.fn().mockResolvedValue([]),
    placeBid: vi.fn().mockResolvedValue({ success: true }),
    formatCountdown: vi.fn().mockReturnValue("1d"),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("useMarketData", () => {
  it("does not resubscribe when a bid changes, and clears the error after recovery", async () => {
    const realtime = new MockRealtimeProvider({ autoStart: false });
    const marketplace = makeMarketplaceProvider();
    const subscribeSpy = vi.spyOn(realtime, "subscribeToListing");
    const unsubscribeSpy = vi.spyOn(realtime, "unsubscribeFromListing");
    vi.spyOn(errorReporter, "reportRealtimeError").mockImplementation(() => undefined);

    const wrapper = ({ children }: { children: ReactNode }) => (
      <MarketplaceApiContext.Provider value={marketplace}>
        <RealtimeApiProvider provider={realtime}>{children}</RealtimeApiProvider>
      </MarketplaceApiContext.Provider>
    );
    const { result, unmount } = renderHook(() => useMarketData(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    act(() => {
      realtime.triggerBidUpdate({
        listingId: "listing-1",
        username: "alice",
        newBid: 1_100,
        bidderAddress: "GDEF...XYZ",
        timestamp: new Date("2026-01-01T00:01:00.000Z"),
      });
    });

    expect(result.current.listings[0].currentBid).toBe(1_100);
    expect(subscribeSpy).toHaveBeenCalledTimes(1);

    act(() => {
      realtime.triggerConnectionLoss();
    });
    expect(result.current.isConnected).toBe(false);
    expect(result.current.realtimeError).toContain("connection lost");

    act(() => {
      realtime.connect();
    });
    expect(result.current.isConnected).toBe(true);
    expect(result.current.realtimeError).toBeNull();

    unmount();
    expect(unsubscribeSpy).toHaveBeenCalledWith("listing-1");
  });
});
