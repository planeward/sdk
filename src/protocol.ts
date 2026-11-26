/**
 * Planeward apps contract. Mirrors the Planeward server's
 * `apps/web/src/config/app/community-apps.ts` (in the Planeward repo, not this
 * template); keep both in sync.
 */

export const APP_SECRET_PREFIX = "pwa_" as const;

/** App backends send this header with `Authorization: Bearer pwa_…`. */
export const APP_INSTALLATION_HEADER = "x-planeward-installation" as const;

export const APP_VIEWER_TOKEN_TTL_SECONDS = 300 as const;

/** JWKS path on the Planeward app origin. */
export const APP_JWKS_PATH = "/api/auth/jwks" as const;

export const APP_SDK_PROTOCOL_VERSION = 1 as const;

export const DEFAULT_PLANEWARD_BASE_URL = "https://app.planeward.com" as const;

export const APP_MESSAGE = {
  /** app → host `{ type, version: 1 }` */
  ready: "planeward:app:ready",
  /** app → host `{ type, requestId }` */
  tokenRequest: "planeward:app:token-request",
  /** host → app `{ type, requestId, token, expiresAt, context }` */
  token: "planeward:app:token",
  /** host → app `{ type, theme, appearance? }` */
  theme: "planeward:app:theme",
  /** host → app `{ type, requestId, message }` */
  error: "planeward:app:error",
} as const;

export type AppView = "experience" | "dashboard";
export type AppViewerRole = "member" | "admin";
export type AppTheme = "light" | "dark";

/** Theme tokens the host may send: shadcn CSS variable names without `--`. */
export const APP_APPEARANCE_COLORS = [
  "background",
  "foreground",
  "card",
  "card-foreground",
  "popover",
  "popover-foreground",
  "primary",
  "primary-foreground",
  "secondary",
  "secondary-foreground",
  "muted",
  "muted-foreground",
  "accent",
  "accent-foreground",
  "destructive",
  "destructive-foreground",
  "border",
  "input",
  "ring",
  "chart-1",
  "chart-2",
  "chart-3",
  "chart-4",
  "chart-5",
  "sidebar",
  "sidebar-foreground",
  "sidebar-primary",
  "sidebar-primary-foreground",
  "sidebar-accent",
  "sidebar-accent-foreground",
  "sidebar-border",
  "sidebar-ring",
] as const;

export type AppAppearanceColor = (typeof APP_APPEARANCE_COLORS)[number];

/** The host's look for the current mode: colours, corner radius and font. */
export type AppAppearance = {
  colors: Partial<Record<AppAppearanceColor, string>>;
  radius?: string;
  /** `stylesheets` are `https://fonts.googleapis.com/` URLs only. */
  font?: { family: string; stylesheets: string[] };
};

export type AppContext = {
  view: AppView;
  channelId: string | null;
  theme: AppTheme;
  /** Sent by hosts that share their look; absent from older hosts. */
  appearance?: AppAppearance;
};

export type AppReadyMessage = {
  type: typeof APP_MESSAGE.ready;
  version: typeof APP_SDK_PROTOCOL_VERSION;
};

export type AppTokenRequestMessage = {
  type: typeof APP_MESSAGE.tokenRequest;
  requestId: string;
};

export type AppTokenMessage = {
  type: typeof APP_MESSAGE.token;
  requestId: string | null;
  token: string;
  /** Milliseconds since epoch. */
  expiresAt: number;
  context: AppContext;
};

export type AppThemeMessage = {
  type: typeof APP_MESSAGE.theme;
  theme: AppTheme;
  /** The new mode's appearance; absent from older hosts. */
  appearance?: AppAppearance;
};

export type AppErrorMessage = {
  type: typeof APP_MESSAGE.error;
  requestId: string | null;
  message: string;
};

export type AppToHostMessage = AppReadyMessage | AppTokenRequestMessage;
export type HostToAppMessage =
  AppTokenMessage | AppThemeMessage | AppErrorMessage;

/** Viewer JWT claims (RS256, 5-minute expiry). */
export type AppViewerTokenClaims = {
  /** Planeward app URL. */
  iss: string;
  /** App id. */
  aud: string;
  /** Community membership id (member) or workspace membership id (staff). */
  sub: string;
  iat: number;
  exp: number;
  workspaceId: string;
  installationId: string;
  /** Set for `view = "experience"`. */
  channelId: string | null;
  view: AppView;
  role: AppViewerRole;
  name: string;
  avatar: string | null;
  /**
   * Keys from the app's permissions declaration granted to this viewer:
   * community keys in experience tokens, dashboard keys in dashboard tokens.
   * `verifyPlanewardToken` returns `[]` for a host that doesn't send it.
   */
  permissions: string[];
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTheme = (value: unknown): value is AppTheme =>
  value === "light" || value === "dark";

const isView = (value: unknown): value is AppView =>
  value === "experience" || value === "dashboard";

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

const isStringArray = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((item) => typeof item === "string");

export function isAppContext(value: unknown): value is AppContext {
  return (
    isRecord(value) &&
    isView(value.view) &&
    isNullableString(value.channelId) &&
    isTheme(value.theme)
  );
}

const MAX_CSS_VALUE_LENGTH = 64;
const MAX_FONT_FAMILY_LENGTH = 200;
const MAX_FONT_STYLESHEET_LENGTH = 500;
const MAX_FONT_STYLESHEETS = 4;
const FONT_STYLESHEET_PREFIX = "https://fonts.googleapis.com/";
/** Characters and functions that could break out of, or load from, a CSS value. */
const UNSAFE_CSS_VALUE = /[;{}<>\\]|url\(|expression\(/i;

const safeCssValue = (value: unknown, maxLength: number): string | null =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= maxLength &&
  !UNSAFE_CSS_VALUE.test(value)
    ? value
    : null;

const isFontStylesheet = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length <= MAX_FONT_STYLESHEET_LENGTH &&
  value.startsWith(FONT_STYLESHEET_PREFIX);

/**
 * Sanitise an appearance from the host: known colour keys only, CSS values
 * without `;{}<>\`, `url(` or `expression(`, Google Fonts stylesheets only.
 * Returns `undefined` when nothing usable is left.
 */
export function parseAppAppearance(value: unknown): AppAppearance | undefined {
  if (!isRecord(value)) return undefined;

  const colors: Partial<Record<AppAppearanceColor, string>> = {};
  if (isRecord(value.colors)) {
    for (const key of APP_APPEARANCE_COLORS) {
      const color = safeCssValue(value.colors[key], MAX_CSS_VALUE_LENGTH);
      if (color !== null) colors[key] = color;
    }
  }
  const appearance: AppAppearance = { colors };

  const radius = safeCssValue(value.radius, MAX_CSS_VALUE_LENGTH);
  if (radius !== null) appearance.radius = radius;

  if (isRecord(value.font)) {
    const family = safeCssValue(value.font.family, MAX_FONT_FAMILY_LENGTH);
    if (family !== null) {
      const stylesheets = Array.isArray(value.font.stylesheets)
        ? value.font.stylesheets
            .filter(isFontStylesheet)
            .slice(0, MAX_FONT_STYLESHEETS)
        : [];
      appearance.font = { family, stylesheets };
    }
  }

  return Object.keys(colors).length > 0 || appearance.radius || appearance.font
    ? appearance
    : undefined;
}

/** Copies `appearance` in only when it parses, so the key is absent otherwise. */
function withAppearance<T extends object>(
  base: T,
  raw: unknown
): T & { appearance?: AppAppearance } {
  const appearance = parseAppAppearance(raw);
  return appearance ? { ...base, appearance } : base;
}

/** Narrow an unknown `postMessage` payload to a host → app message. */
export function parseHostMessage(value: unknown): HostToAppMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case APP_MESSAGE.token: {
      const ctx = value.context;
      if (
        !isNullableString(value.requestId) ||
        typeof value.token !== "string" ||
        value.token.length === 0 ||
        typeof value.expiresAt !== "number" ||
        !Number.isFinite(value.expiresAt) ||
        !isAppContext(ctx)
      ) {
        return null;
      }
      return {
        type: APP_MESSAGE.token,
        requestId: value.requestId,
        token: value.token,
        expiresAt: value.expiresAt,
        context: withAppearance(
          { view: ctx.view, channelId: ctx.channelId, theme: ctx.theme },
          ctx.appearance
        ),
      };
    }
    case APP_MESSAGE.theme:
      return isTheme(value.theme)
        ? withAppearance(
            { type: APP_MESSAGE.theme, theme: value.theme },
            value.appearance
          )
        : null;
    case APP_MESSAGE.error:
      return isNullableString(value.requestId) &&
        typeof value.message === "string"
        ? (value as AppErrorMessage)
        : null;
    default:
      return null;
  }
}

/**
 * Checks verified claims. `permissions` must be a string array: the verifier
 * fills a missing claim (hosts from before app permissions) with `[]` first.
 */
export function isAppViewerTokenClaims(
  value: unknown
): value is AppViewerTokenClaims {
  return (
    isRecord(value) &&
    typeof value.iss === "string" &&
    typeof value.aud === "string" &&
    typeof value.sub === "string" &&
    typeof value.iat === "number" &&
    typeof value.exp === "number" &&
    typeof value.workspaceId === "string" &&
    typeof value.installationId === "string" &&
    isNullableString(value.channelId) &&
    isView(value.view) &&
    (value.role === "member" || value.role === "admin") &&
    typeof value.name === "string" &&
    isNullableString(value.avatar) &&
    isStringArray(value.permissions)
  );
}
