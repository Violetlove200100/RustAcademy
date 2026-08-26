/**
 * Production realtime provider.
 *
 * The transport is deliberately injected so lifecycle behavior can be tested
 * without a network connection. The default transport is the browser's native
 * WebSocket; the server protocol is JSON messages shaped as
 * `{ event, payload }`.
 */

import type {
  BidUpdate,
  RealtimeApiProvider,
  RealtimeConnectionState,
} from "@/hooks/realtimeApi";
import { errorReporter } from "@/lib/errorReporter";

const getWsUrl = (): string =>
  process.env.NEXT_PUBLIC_WS_URL?.replace(/\/$/, "") ?? "ws://localhost:4000";

const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;

export type RealtimeSocket = {
  onopen: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  send: (data: string) => void;
  close: () => void;
};

export type ProductionRealtimeProviderOptions = {
  webSocketFactory?: (url: string) => RealtimeSocket;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
};

function createBrowserSocket(url: string): RealtimeSocket {
  if (typeof WebSocket === "undefined") {
    throw new Error("Realtime WebSocket is unavailable in this environment.");
  }

  return new WebSocket(url);
}

function asError(value: unknown, fallback: string): Error {
  if (value instanceof Error) return value;
  if (typeof value === "string" && value.length > 0) return new Error(value);
  return new Error(fallback);
}

/**
 * A single reconnecting transport with one listener registry. A transport
 * failure does not clear application listeners or listing subscriptions: those
 * are intentionally replayed on the next successful connection. An explicit
 * disconnect is a terminal teardown and clears both registries.
 */
export class ProductionRealtimeProvider implements RealtimeApiProvider {
  private listeners: ((update: BidUpdate) => void)[] = [];
  private connectionListeners: ((state: RealtimeConnectionState) => void)[] = [];
  private errorListeners: ((error: Error) => void)[] = [];
  private subscribedListings = new Set<string>();
  private socket: RealtimeSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectAttempt = 0;
  private lifecycleToken = 0;
  private stopping = false;
  private _connectionState: RealtimeConnectionState = "disconnected";
  private readonly webSocketFactory: (url: string) => RealtimeSocket;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;

  constructor(options: ProductionRealtimeProviderOptions = {}) {
    this.webSocketFactory = options.webSocketFactory ?? createBrowserSocket;
    this.reconnectBaseMs = options.reconnectBaseMs ?? BACKOFF_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? BACKOFF_MAX_MS;
  }

  connect(): void {
    this.stopping = false;
    this.clearReconnectTimer();

    if (
      this._connectionState === "connected" ||
      this._connectionState === "connecting"
    ) {
      return;
    }

    const token = ++this.lifecycleToken;
    this.setConnectionState("connecting");

    try {
      const socket = this.webSocketFactory(getWsUrl());
      this.socket = socket;
      socket.onopen = () => {
        if (!this.isCurrentSocket(socket, token)) return;

        this.reconnectAttempt = 0;
        this.setConnectionState("connected");
        this.subscribedListings.forEach((listingId) =>
          this.sendEvent("marketplace:subscribe", { listingId }),
        );
      };
      socket.onmessage = (event) => {
        if (this.isCurrentSocket(socket, token)) {
          this.handleMessage(event.data);
        }
      };
      socket.onerror = (event) => {
        if (!this.isCurrentSocket(socket, token)) return;
        this.failConnection(
          asError(event, "Realtime WebSocket connection failed."),
          socket,
          token,
        );
      };
      socket.onclose = (event) => {
        if (!this.isCurrentSocket(socket, token)) return;
        this.failConnection(
          new Error(
            event.reason
              ? `Realtime WebSocket closed: ${event.reason}`
              : "Realtime WebSocket connection closed.",
          ),
          socket,
          token,
        );
      };
    } catch (error) {
      this.failConnection(asError(error, "Unable to create realtime connection."), null, token);
    }
  }

  disconnect(): void {
    this.stopping = true;
    this.lifecycleToken += 1;
    this.clearReconnectTimer();
    this.detachAndCloseSocket();
    this.reconnectAttempt = 0;
    this.setConnectionState("disconnected");

    // Explicit teardown must not retain callbacks or subscriptions belonging
    // to an unmounted page. Automatic reconnects never call this method.
    this.listeners = [];
    this.connectionListeners = [];
    this.errorListeners = [];
    this.subscribedListings.clear();
  }

  subscribeToListing(listingId: string): void {
    this.subscribedListings.add(listingId);
    if (this._connectionState === "connected") {
      this.sendEvent("marketplace:subscribe", { listingId });
    }
  }

  unsubscribeFromListing(listingId: string): void {
    this.subscribedListings.delete(listingId);
    if (this._connectionState === "connected") {
      this.sendEvent("marketplace:unsubscribe", { listingId });
    }
  }

  onBidUpdate(callback: (update: BidUpdate) => void): () => void {
    if (!this.listeners.includes(callback)) {
      this.listeners.push(callback);
    }

    return () => {
      const index = this.listeners.indexOf(callback);
      if (index >= 0) this.listeners.splice(index, 1);
    };
  }

  onConnectionStateChange(
    callback: (state: RealtimeConnectionState) => void,
  ): () => void {
    if (!this.connectionListeners.includes(callback)) {
      this.connectionListeners.push(callback);
    }
    callback(this._connectionState);

    return () => {
      const index = this.connectionListeners.indexOf(callback);
      if (index >= 0) this.connectionListeners.splice(index, 1);
    };
  }

  onError(callback: (error: Error) => void): () => void {
    if (!this.errorListeners.includes(callback)) {
      this.errorListeners.push(callback);
    }

    return () => {
      const index = this.errorListeners.indexOf(callback);
      if (index >= 0) this.errorListeners.splice(index, 1);
    };
  }

  get isConnected(): boolean {
    return this._connectionState === "connected";
  }

  get connectionState(): RealtimeConnectionState {
    return this._connectionState;
  }

  private isCurrentSocket(socket: RealtimeSocket, token: number): boolean {
    return !this.stopping && token === this.lifecycleToken && this.socket === socket;
  }

  private setConnectionState(state: RealtimeConnectionState): void {
    if (this._connectionState === state) return;
    this._connectionState = state;
    [...this.connectionListeners].forEach((callback) => callback(state));
  }

  private emitError(error: Error): void {
    errorReporter.reportRealtimeError(error, {
      extra: {
        wsUrl: getWsUrl(),
        attempt: this.reconnectAttempt + 1,
      },
    });
    [...this.errorListeners].forEach((callback) => callback(error));
  }

  private failConnection(
    cause: Error,
    socket: RealtimeSocket | null,
    token: number,
  ): void {
    if (this.stopping || token !== this.lifecycleToken) return;

    if (socket && this.socket === socket) {
      this.detachAndCloseSocket(socket);
    }
    this.socket = null;
    this.setConnectionState("disconnected");
    this.emitError(cause);
    this.scheduleReconnect(cause);
  }

  private scheduleReconnect(cause: Error): void {
    if (this.stopping || this.reconnectTimer !== null) return;

    const delayMs = Math.min(
      this.reconnectBaseMs * 2 ** this.reconnectAttempt,
      this.reconnectMaxMs,
    );
    this.reconnectAttempt += 1;

    console.warn(
      `[ProductionRealtimeProvider] Reconnecting in ${delayMs}ms (attempt ${this.reconnectAttempt}).`,
      cause,
    );

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopping) this.connect();
    }, delayMs);
  }

  private detachAndCloseSocket(socket = this.socket): void {
    if (!socket) return;
    socket.onopen = null;
    socket.onclose = null;
    socket.onerror = null;
    socket.onmessage = null;
    try {
      socket.close();
    } catch {
      // The transport is already closed; teardown remains complete.
    }
    if (this.socket === socket) this.socket = null;
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer === null) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private sendEvent(event: string, payload: Record<string, string>): void {
    if (!this.socket || this._connectionState !== "connected") return;
    try {
      this.socket.send(JSON.stringify({ event, payload }));
    } catch (error) {
      this.failConnection(
        asError(error, "Unable to send realtime subscription."),
        this.socket,
        this.lifecycleToken,
      );
    }
  }

  private handleMessage(data: unknown): void {
    let message: unknown = data;
    if (typeof data === "string") {
      try {
        message = JSON.parse(data) as unknown;
      } catch {
        return;
      }
    }

    if (!message || typeof message !== "object") return;
    const envelope = message as Record<string, unknown>;
    const eventName = envelope.event ?? envelope.type;
    if (eventName && eventName !== "bid:update") return;

    const candidate =
      envelope.payload && typeof envelope.payload === "object"
        ? envelope.payload
        : envelope.data && typeof envelope.data === "object"
          ? envelope.data
          : envelope;
    if (!candidate || typeof candidate !== "object") return;

    const update = candidate as Record<string, unknown>;
    if (
      typeof update.listingId !== "string" ||
      typeof update.username !== "string" ||
      typeof update.newBid !== "number" ||
      typeof update.bidderAddress !== "string"
    ) {
      return;
    }

    const timestamp =
      update.timestamp instanceof Date
        ? update.timestamp
        : new Date(
            typeof update.timestamp === "string" || typeof update.timestamp === "number"
              ? update.timestamp
              : Date.now(),
          );
    if (Number.isNaN(timestamp.getTime())) return;

    this._notify({
      listingId: update.listingId,
      username: update.username,
      newBid: update.newBid,
      bidderAddress: update.bidderAddress,
      timestamp,
      bidCount:
        typeof update.bidCount === "number" ? update.bidCount : undefined,
    });
  }

  private _notify(update: BidUpdate): void {
    [...this.listeners].forEach((callback) => callback(update));
  }
}

/** Singleton — one connection per page load. */
export const productionRealtimeProvider = new ProductionRealtimeProvider();
