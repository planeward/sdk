/**
 * Planeward Community Apps contract. Mirrors the Planeward server's
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
  /** host → app `{ type, theme }` */
  theme: "planeward:app:theme",
  /** host → app `{ type, requestId, message }` */
  error: "planeward:app:error",
} as const;

export type AppView = "experience" | "dashboard";
export type AppViewerRole = "member" | "admin";
export type AppTheme = "light" | "dark";

export type AppContext = {
  view: AppView;
  channelId: string | null;
  theme: AppTheme;
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
};

export const APP_WEBHOOK_EVENTS = ["app.installed", "app.uninstalled"] as const;

export type AppWebhookEnvelope = {
  event: string;
  data: unknown;
  timestamp: string;
  installationId: string;
  workspaceId: string;
};

export type CommunityAppMember = {
  id: string;
  customerId: string;
  username: string | null;
  displayName: string;
  avatarUrl: string | null;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  accessPlans: { id: string; name: string }[];
  roles: { id: string; name: string }[];
  /** ISO 8601. */
  joinedAt: string;
};

export type CommunityAppMessage = {
  id: string;
  channelId: string;
  body: string;
  replyToId: string | null;
  createdAt: string;
  author: { kind: "app"; installationId: string; name: string };
};

export type ListResponse<T> = {
  data: T[];
  meta: { total: number; limit: number; offset: number };
};

export type DataResponse<T> = { data: T };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isTheme = (value: unknown): value is AppTheme =>
  value === "light" || value === "dark";

const isView = (value: unknown): value is AppView =>
  value === "experience" || value === "dashboard";

const isNullableString = (value: unknown): value is string | null =>
  value === null || typeof value === "string";

export function isAppContext(value: unknown): value is AppContext {
  return (
    isRecord(value) &&
    isView(value.view) &&
    isNullableString(value.channelId) &&
    isTheme(value.theme)
  );
}

/** Narrow an unknown `postMessage` payload to a host → app message. */
export function parseHostMessage(value: unknown): HostToAppMessage | null {
  if (!isRecord(value)) return null;
  switch (value.type) {
    case APP_MESSAGE.token:
      return isNullableString(value.requestId) &&
        typeof value.token === "string" &&
        value.token.length > 0 &&
        typeof value.expiresAt === "number" &&
        Number.isFinite(value.expiresAt) &&
        isAppContext(value.context)
        ? (value as AppTokenMessage)
        : null;
    case APP_MESSAGE.theme:
      return isTheme(value.theme) ? (value as AppThemeMessage) : null;
    case APP_MESSAGE.error:
      return isNullableString(value.requestId) &&
        typeof value.message === "string"
        ? (value as AppErrorMessage)
        : null;
    default:
      return null;
  }
}

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
    isNullableString(value.avatar)
  );
}

export function isAppWebhookEnvelope(
  value: unknown
): value is AppWebhookEnvelope {
  return (
    isRecord(value) &&
    typeof value.event === "string" &&
    "data" in value &&
    typeof value.timestamp === "string" &&
    typeof value.installationId === "string" &&
    typeof value.workspaceId === "string"
  );
}
