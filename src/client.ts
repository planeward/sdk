import {
  APP_MESSAGE,
  APP_SDK_PROTOCOL_VERSION,
  parseHostMessage,
  type AppContext,
  type AppTheme,
  type AppToHostMessage,
  type AppTokenMessage,
} from "./protocol";

export type CreatePlanewardAppOptions = {
  /**
   * Host origins allowed to talk to this app, e.g. `["https://acme.planeward.site"]`.
   * When omitted, the SDK pins to the origin of the first valid token message
   * from `window.parent` and ignores every other origin afterwards.
   */
  allowedHostOrigins?: string[];
  /** Handshake and token request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
};

export type PlanewardApp = {
  /** Resolves with the viewer context after the host's first token message. */
  ready: Promise<AppContext>;
  /** The current context, or `null` before `ready` resolves. */
  readonly context: AppContext | null;
  /** Returns a viewer token, requesting a fresh one when it expires within 30s. */
  getToken: () => Promise<string>;
  /** Called when the host theme changes. Returns an unsubscribe function. */
  onThemeChange: (callback: (theme: AppTheme) => void) => () => void;
  /** Removes listeners and rejects pending requests. */
  destroy: () => void;
};

/** The subset of `window` the client uses; injectable for tests. */
export type PlanewardAppWindow = {
  parent: { postMessage: (message: unknown, targetOrigin: string) => void };
  addEventListener: (
    type: "message",
    listener: (event: MessageEvent) => void
  ) => void;
  removeEventListener: (
    type: "message",
    listener: (event: MessageEvent) => void
  ) => void;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const REFRESH_BEFORE_EXPIRY_MS = 30_000;

const NOT_IN_COMMUNITY_ERROR =
  "Not running inside a Planeward community: no response from the host.";

function randomRequestId(): string {
  const cryptoApi = globalThis.crypto;
  if (typeof cryptoApi?.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  cryptoApi.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join(
    ""
  );
}

type PendingRequest = {
  requestId: string;
  promise: Promise<string>;
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

export function createPlanewardAppForWindow(
  win: PlanewardAppWindow,
  options: CreatePlanewardAppOptions = {}
): PlanewardApp {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowedOrigins = options.allowedHostOrigins?.length
    ? new Set(options.allowedHostOrigins)
    : null;

  let pinnedOrigin: string | null = null;
  let context: AppContext | null = null;
  let token: { value: string; expiresAt: number } | null = null;
  let pending: PendingRequest | null = null;
  let destroyed = false;
  const themeListeners = new Set<(theme: AppTheme) => void>();

  let resolveReady!: (context: AppContext) => void;
  let rejectReady!: (error: Error) => void;
  let readySettled = false;
  const ready = new Promise<AppContext>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  // Avoid unhandled rejections when the caller never awaits `ready`.
  ready.catch(() => undefined);

  const readyTimer = setTimeout(() => {
    settleReady(new Error(NOT_IN_COMMUNITY_ERROR));
  }, timeoutMs);

  function settleReady(result: AppContext | Error) {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    if (result instanceof Error) rejectReady(result);
    else resolveReady(result);
  }

  function post(message: AppToHostMessage, targetOrigin: string) {
    win.parent.postMessage(message, targetOrigin);
  }

  function settlePending(result: string | Error) {
    const current = pending;
    if (!current) return;
    pending = null;
    clearTimeout(current.timer);
    if (typeof result === "string") current.resolve(result);
    else current.reject(result);
  }

  function acceptToken(message: AppTokenMessage) {
    token = { value: message.token, expiresAt: message.expiresAt };
    const previousTheme = context?.theme;
    context = { ...message.context };
    if (pending && message.requestId === pending.requestId) {
      settlePending(message.token);
    }
    if (!readySettled) {
      settleReady(context);
    } else if (previousTheme && previousTheme !== context.theme) {
      emitTheme(context.theme);
    }
  }

  function emitTheme(theme: AppTheme) {
    for (const listener of themeListeners) listener(theme);
  }

  function onMessage(event: MessageEvent) {
    if (destroyed || event.source !== win.parent) return;
    if (allowedOrigins && !allowedOrigins.has(event.origin)) return;
    if (pinnedOrigin !== null && event.origin !== pinnedOrigin) return;

    const message = parseHostMessage(event.data);
    if (!message) return;

    if (pinnedOrigin === null) {
      // Only a valid token message may establish the host origin.
      if (message.type !== APP_MESSAGE.token) return;
      pinnedOrigin = event.origin;
    }

    switch (message.type) {
      case APP_MESSAGE.token:
        acceptToken(message);
        break;
      case APP_MESSAGE.theme:
        if (context && context.theme !== message.theme) {
          context = { ...context, theme: message.theme };
          emitTheme(message.theme);
        }
        break;
      case APP_MESSAGE.error:
        if (pending && message.requestId === pending.requestId) {
          settlePending(new Error(message.message));
        }
        break;
    }
  }

  function requestToken(): Promise<string> {
    if (pending) return pending.promise;
    if (pinnedOrigin === null) {
      return Promise.reject(new Error(NOT_IN_COMMUNITY_ERROR));
    }
    const requestId = randomRequestId();
    let resolve!: (token: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      if (pending?.requestId === requestId) {
        settlePending(
          new Error(
            `Planeward host did not return a token within ${timeoutMs}ms.`
          )
        );
      }
    }, timeoutMs);
    pending = { requestId, promise, resolve, reject, timer };
    post({ type: APP_MESSAGE.tokenRequest, requestId }, pinnedOrigin);
    return promise;
  }

  async function getToken(): Promise<string> {
    if (destroyed) throw new Error("Planeward app was destroyed.");
    await ready;
    if (token && token.expiresAt - Date.now() > REFRESH_BEFORE_EXPIRY_MS) {
      return token.value;
    }
    return requestToken();
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    win.removeEventListener("message", onMessage);
    themeListeners.clear();
    const error = new Error("Planeward app was destroyed.");
    settleReady(error);
    settlePending(error);
  }

  win.addEventListener("message", onMessage);
  // The hello carries no secret, so "*" is acceptable when no origin is configured.
  post(
    { type: APP_MESSAGE.ready, version: APP_SDK_PROTOCOL_VERSION },
    options.allowedHostOrigins?.[0] ?? "*"
  );

  return {
    ready,
    get context() {
      return context;
    },
    getToken,
    onThemeChange(callback) {
      themeListeners.add(callback);
      return () => {
        themeListeners.delete(callback);
      };
    },
    destroy,
  };
}
