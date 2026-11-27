import { decodeJwt } from "jose";

import {
  APP_APPEARANCE_COLORS,
  APP_MESSAGE,
  APP_SDK_PROTOCOL_VERSION,
  parseAppAppearance,
  parseHostMessage,
  type AppAppearance,
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
  /**
   * How long to wait for the host's first token, and for each token request
   * attempt, in milliseconds. Defaults to 20000. The `ready` hello is resent
   * every second until the host answers, and a token request that times out
   * or errors is retried twice before `getToken` rejects.
   */
  timeoutMs?: number;
};

export type PlanewardApp = {
  /** Resolves with the viewer context after the host's first token message. */
  ready: Promise<AppContext>;
  /** The current context, or `null` before `ready` resolves. */
  readonly context: AppContext | null;
  /** Returns a viewer token, requesting a fresh one when it expires within 30s. */
  getToken: () => Promise<string>;
  /**
   * Whether the current token grants `key` (its `permissions` claim). False
   * before `ready`. Use it to shape the UI; your backend must check the
   * verified claims with `can(viewer, key)` from `@planeward/sdk/server`.
   */
  can: (key: string) => boolean;
  /**
   * Called when the host's theme or appearance changes, with the new
   * appearance (`undefined` from hosts that don't send one). Pass it to
   * `applyAppearance`. Returns an unsubscribe function.
   */
  onThemeChange: (
    callback: (theme: AppTheme, appearance: AppAppearance | undefined) => void
  ) => () => void;
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

const DEFAULT_TIMEOUT_MS = 20_000;
const REFRESH_BEFORE_EXPIRY_MS = 30_000;
/** The hello is resent this often until the host sends its first token. */
const HELLO_INTERVAL_MS = 1_000;
/** Attempts per token request (the first plus two retries). */
const TOKEN_REQUEST_ATTEMPTS = 3;
const TOKEN_RETRY_DELAY_MS = 1_000;

const NOT_IN_HOST_ERROR =
  "Not running inside Planeward: no response from the host.";

/** The `permissions` claim, read without verifying (UI hints only). */
function tokenPermissions(token: string): ReadonlySet<string> {
  try {
    const { permissions } = decodeJwt(token);
    return new Set(
      Array.isArray(permissions)
        ? permissions.filter((key): key is string => typeof key === "string")
        : []
    );
  } catch {
    return new Set();
  }
}

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

/** Parsed appearances have a fixed key order, so this compares by value. */
const appearanceKey = (appearance: AppAppearance | undefined) =>
  appearance ? JSON.stringify(appearance) : "";

type AppliedAppearance = {
  properties: ReadonlySet<string>;
  links: ReadonlyMap<string, HTMLLinkElement>;
};

const appliedAppearances = new WeakMap<HTMLElement, AppliedAppearance>();

/**
 * Apply the host's appearance to `root` as CSS variables: `--<colour>` (e.g.
 * `--primary`), `--radius` and `--font-sans`, plus one
 * `<link rel="stylesheet" data-planeward-font>` per font stylesheet. Values
 * are sanitised again and set with `style.setProperty`. Calling it again
 * replaces the previous values; `null` or `undefined` clears them. Returns a
 * cleanup that removes what this call applied (a no-op once a later call has
 * replaced it).
 */
export function applyAppearance(
  appearance: AppAppearance | null | undefined,
  root: HTMLElement = document.documentElement
): () => void {
  const previous = appliedAppearances.get(root);
  // Callers may pass their own object, so sanitise it like a host message.
  const parsed = parseAppAppearance(appearance);

  const properties = new Map<string, string>();
  if (parsed) {
    for (const key of APP_APPEARANCE_COLORS) {
      const value = parsed.colors[key];
      if (value) properties.set(`--${key}`, value);
    }
    if (parsed.radius) properties.set("--radius", parsed.radius);
    if (parsed.font) properties.set("--font-sans", parsed.font.family);
  }
  for (const name of previous?.properties ?? []) {
    if (!properties.has(name)) root.style.removeProperty(name);
  }
  for (const [name, value] of properties) root.style.setProperty(name, value);

  const doc = root.ownerDocument;
  const links = new Map<string, HTMLLinkElement>();
  for (const href of parsed?.font?.stylesheets ?? []) {
    if (links.has(href)) continue;
    let link = previous?.links.get(href);
    if (!link) {
      link = doc.createElement("link");
      link.setAttribute("rel", "stylesheet");
      link.setAttribute("href", href);
      link.setAttribute("data-planeward-font", "");
      doc.head.appendChild(link);
    }
    links.set(href, link);
  }
  for (const [href, link] of previous?.links ?? []) {
    if (!links.has(href)) link.remove();
  }

  const applied: AppliedAppearance = {
    properties: new Set(properties.keys()),
    links,
  };
  appliedAppearances.set(root, applied);
  return () => {
    if (appliedAppearances.get(root) !== applied) return;
    appliedAppearances.delete(root);
    for (const name of applied.properties) root.style.removeProperty(name);
    for (const link of applied.links.values()) link.remove();
  };
}

type PendingRequest = {
  /** Id of the latest attempt; only its answer settles the request. */
  requestId: string;
  attempts: number;
  promise: Promise<string>;
  resolve: (token: string) => void;
  reject: (error: Error) => void;
  /** The attempt's timeout, or the delay before the next attempt. */
  timer: ReturnType<typeof setTimeout> | undefined;
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
  let token: {
    value: string;
    expiresAt: number;
    permissions: ReadonlySet<string>;
  } | null = null;
  let pending: PendingRequest | null = null;
  let destroyed = false;
  const themeListeners = new Set<
    (theme: AppTheme, appearance: AppAppearance | undefined) => void
  >();

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
    settleReady(new Error(NOT_IN_HOST_ERROR));
  }, timeoutMs);
  // The host may not be listening yet, or its first token fetch may fail, so
  // keep saying hello until a token arrives.
  const helloTimer = setInterval(sayHello, HELLO_INTERVAL_MS);

  function sayHello() {
    // The hello carries no secret, so "*" is acceptable when no origin is configured.
    post(
      { type: APP_MESSAGE.ready, version: APP_SDK_PROTOCOL_VERSION },
      options.allowedHostOrigins?.[0] ?? "*"
    );
  }

  function settleReady(result: AppContext | Error) {
    if (readySettled) return;
    readySettled = true;
    clearTimeout(readyTimer);
    clearInterval(helloTimer);
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
    token = {
      value: message.token,
      expiresAt: message.expiresAt,
      permissions: tokenPermissions(message.token),
    };
    const previous = context;
    context = { ...message.context };
    if (pending && message.requestId === pending.requestId) {
      settlePending(message.token);
    }
    if (!readySettled) {
      settleReady(context);
    } else if (previous) {
      emitIfThemeChanged(previous);
    }
  }

  function emitIfThemeChanged(previous: AppContext) {
    if (!context) return;
    if (
      previous.theme === context.theme &&
      appearanceKey(previous.appearance) === appearanceKey(context.appearance)
    ) {
      return;
    }
    for (const listener of themeListeners) {
      listener(context.theme, context.appearance);
    }
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
        if (context) {
          const previous = context;
          const { appearance: _previousAppearance, ...rest } = context;
          context = message.appearance
            ? { ...rest, theme: message.theme, appearance: message.appearance }
            : { ...rest, theme: message.theme };
          emitIfThemeChanged(previous);
        }
        break;
      case APP_MESSAGE.error:
        if (pending && message.requestId === pending.requestId) {
          failAttempt(pending, new Error(message.message));
        }
        break;
    }
  }

  function sendAttempt(request: PendingRequest, origin: string) {
    request.requestId = randomRequestId();
    request.timer = setTimeout(() => {
      failAttempt(
        request,
        new Error(
          `Planeward host did not return a token within ${timeoutMs}ms.`
        )
      );
    }, timeoutMs);
    post(
      { type: APP_MESSAGE.tokenRequest, requestId: request.requestId },
      origin
    );
  }

  /** Retries after a short delay; rejects once every attempt has failed. */
  function failAttempt(request: PendingRequest, error: Error) {
    if (pending !== request) return;
    clearTimeout(request.timer);
    request.attempts += 1;
    if (request.attempts >= TOKEN_REQUEST_ATTEMPTS || pinnedOrigin === null) {
      settlePending(error);
      return;
    }
    const origin = pinnedOrigin;
    request.timer = setTimeout(() => {
      if (pending === request) sendAttempt(request, origin);
    }, TOKEN_RETRY_DELAY_MS);
  }

  function requestToken(): Promise<string> {
    if (pending) return pending.promise;
    if (pinnedOrigin === null) {
      return Promise.reject(new Error(NOT_IN_HOST_ERROR));
    }
    let resolve!: (token: string) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const request: PendingRequest = {
      requestId: "",
      attempts: 0,
      promise,
      resolve,
      reject,
      timer: undefined,
    };
    pending = request;
    sendAttempt(request, pinnedOrigin);
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
  sayHello();

  return {
    ready,
    get context() {
      return context;
    },
    getToken,
    can: (key) => token?.permissions.has(key) ?? false,
    onThemeChange(callback) {
      themeListeners.add(callback);
      return () => {
        themeListeners.delete(callback);
      };
    },
    destroy,
  };
}
