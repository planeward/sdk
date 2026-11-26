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

const DEFAULT_TIMEOUT_MS = 10_000;
const REFRESH_BEFORE_EXPIRY_MS = 30_000;

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
          settlePending(new Error(message.message));
        }
        break;
    }
  }

  function requestToken(): Promise<string> {
    if (pending) return pending.promise;
    if (pinnedOrigin === null) {
      return Promise.reject(new Error(NOT_IN_HOST_ERROR));
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
