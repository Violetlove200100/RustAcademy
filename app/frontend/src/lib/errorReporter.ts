export type ErrorContext = {
  requestId?: string;
  correlationId?: string;
  userId?: string;
  route?: string;
  componentStack?: string;
  extra?: Record<string, unknown>;
};

const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const PHONE_RE = /(\+?[\d\s\-()]{10,})/g;
const CARD_RE = /\b\d{4}[\s-]?\d{4}[\s-]?\d{4}[\s-]?\d{4}\b/g;

export function redactPII(value: unknown): unknown {
  if (typeof value === "string") {
    // Cards before phones: PHONE_RE also matches 16-digit card numbers.
    return value
      .replace(EMAIL_RE, "[REDACTED_EMAIL]")
      .replace(CARD_RE, "[REDACTED_CARD]")
      .replace(PHONE_RE, "[REDACTED_PHONE]");
  }

  if (Array.isArray(value)) {
    return value.map(redactPII);
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, redactPII(child)])
    );
  }

  return value;
}

class ErrorReporter {
  async captureError(error: Error, context?: ErrorContext): Promise<void> {
    const enabled = process.env.NEXT_PUBLIC_ERROR_REPORTING_ENABLED === "true";
    const environment = process.env.NEXT_PUBLIC_VERCEL_ENV || process.env.NODE_ENV || "unknown";
    const appVersion = process.env.NEXT_PUBLIC_APP_VERSION || "unknown";
    const errorPayload = {
      timestamp: new Date().toISOString(),
      error: redactPII({
        message: error.message,
        stack: error.stack,
      }),
      context: redactPII(context ?? {}),
      appVersion,
      environment,
    };

    if (!enabled || environment === "development") {
      console.warn(
        "Client error reporting is disabled. Error payload:",
        errorPayload
      );
      return;
    }

    const url = process.env.NEXT_PUBLIC_ERROR_REPORTING_URL;
    if (!url) {
      console.warn(
        "Client error reporting URL is not configured. Error payload:",
        errorPayload
      );
      return;
    }

    try {
      await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(errorPayload),
      });
    } catch (sendError) {
      console.warn("Failed to send client error report:", sendError, errorPayload);
    }
  }

  /**
   * Convenience wrapper for realtime provider failures (issue #526).
   *
   * Attaches a `type: "realtime"` tag to the context so errors from
   * WebSocket / reconnect paths can be filtered in telemetry dashboards
   * without changing the shape of captureError.
   *
   * @param error  - The underlying error (e.g. a Socket.io connect_error).
   * @param context - Optional additional context (e.g. wsUrl, attempt count).
   */
  reportRealtimeError(error: Error, context?: Omit<ErrorContext, "extra"> & { extra?: Record<string, unknown> }): void {
    const enrichedContext: ErrorContext = {
      ...context,
      extra: {
        type: "realtime",
        ...context?.extra,
      },
    };

    // Fire-and-forget — realtime errors should not block the UI.
    void this.captureError(error, enrichedContext);
  }
}

export const errorReporter = new ErrorReporter();
export default errorReporter;
