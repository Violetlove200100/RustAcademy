import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ProductionRealtimeProvider,
  type RealtimeSocket,
} from "@/hooks/providers/productionRealtimeProvider";
import { errorReporter } from "@/lib/errorReporter";
import type { BidUpdate } from "@/hooks/realtimeApi";

class FakeSocket implements RealtimeSocket {
  onopen: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  sent: string[] = [];
  closed = false;

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
  }

  open(): void {
    this.onopen?.(new Event("open"));
  }

  fail(): void {
    this.onerror?.(new Event("error"));
  }

  message(update: BidUpdate): void {
    this.onmessage?.(
      new MessageEvent("message", {
        data: JSON.stringify({ event: "bid:update", payload: update }),
      }),
    );
  }
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("ProductionRealtimeProvider", () => {
  it("reconnects once after a failure and replays subscriptions without duplicating listeners", () => {
    vi.useFakeTimers();
    const sockets: FakeSocket[] = [];
    const factory = vi.fn(() => {
      const socket = new FakeSocket();
      sockets.push(socket);
      return socket;
    });
    const provider = new ProductionRealtimeProvider({
      webSocketFactory: factory,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    const received: BidUpdate[] = [];
    const listener = (update: BidUpdate) => received.push(update);

    provider.subscribeToListing("listing-1");
    provider.onBidUpdate(listener);
    provider.onBidUpdate(listener);
    provider.connect();
    expect(provider.connectionState).toBe("connecting");

    sockets[0].open();
    expect(provider.isConnected).toBe(true);
    expect(JSON.parse(sockets[0].sent[0])).toEqual({
      event: "marketplace:subscribe",
      payload: { listingId: "listing-1" },
    });

    sockets[0].fail();
    expect(provider.isConnected).toBe(false);
    vi.advanceTimersByTime(10);
    expect(factory).toHaveBeenCalledTimes(2);

    sockets[1].open();
    expect(JSON.parse(sockets[1].sent[0])).toEqual({
      event: "marketplace:subscribe",
      payload: { listingId: "listing-1" },
    });
    sockets[1].message({
      listingId: "listing-1",
      username: "alice",
      newBid: 1250,
      bidderAddress: "GABC...XYZ",
      timestamp: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(received).toHaveLength(1);
    expect(provider.connectionState).toBe("connected");
  });

  it("reports failures and clears pending reconnect work on explicit teardown", () => {
    vi.useFakeTimers();
    const socket = new FakeSocket();
    const reportSpy = vi
      .spyOn(errorReporter, "reportRealtimeError")
      .mockImplementation(() => undefined);
    const provider = new ProductionRealtimeProvider({
      webSocketFactory: () => socket,
      reconnectBaseMs: 10,
      reconnectMaxMs: 10,
    });
    const callback = vi.fn();
    provider.onError(callback);
    provider.connect();
    socket.fail();

    expect(callback).toHaveBeenCalledWith(expect.any(Error));
    expect(reportSpy).toHaveBeenCalledTimes(1);

    provider.disconnect();
    vi.advanceTimersByTime(100);
    expect(socket.closed).toBe(true);
    expect(provider.connectionState).toBe("disconnected");
  });
});
