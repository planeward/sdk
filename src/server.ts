import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

import {
  APP_INSTALLATION_HEADER,
  APP_JWKS_PATH,
  DEFAULT_PLANEWARD_BASE_URL,
  isAppWebhookEnvelope,
  type AppViewerTokenClaims,
  type AppWebhookEnvelope,
  type CommunityAppMember,
  type CommunityAppMessage,
  type DataResponse,
  type ListResponse,
} from "./protocol";
import { verifyPlanewardTokenWithKeys } from "./token";

export { PlanewardTokenAudienceError } from "./token";

export {
  APP_INSTALLATION_HEADER,
  APP_JWKS_PATH,
  APP_SECRET_PREFIX,
  APP_VIEWER_TOKEN_TTL_SECONDS,
  APP_WEBHOOK_EVENTS,
  DEFAULT_PLANEWARD_BASE_URL,
  type AppView,
  type AppViewerRole,
  type AppViewerTokenClaims,
  type AppWebhookEnvelope,
  type CommunityAppMember,
  type CommunityAppMessage,
  type DataResponse,
  type ListResponse,
} from "./protocol";

export const PLANEWARD_SIGNATURE_HEADER = "x-planeward-signature" as const;
/** Stable per delivery; dedupe retried deliveries on it. */
export const PLANEWARD_DELIVERY_HEADER = "x-planeward-delivery" as const;
export const PLANEWARD_EVENT_HEADER = "x-planeward-event" as const;

const normalizeBaseUrl = (baseUrl: string) => baseUrl.replace(/\/+$/, "");

// ---------------------------------------------------------------------------
// Viewer token verification
// ---------------------------------------------------------------------------

export type VerifyPlanewardTokenOptions = {
  /** Your app id; must equal the token's `aud`. */
  appId: string;
  /** Planeward app URL. Defaults to `https://app.planeward.com`. */
  baseUrl?: string;
};

const jwksByBaseUrl = new Map<string, JWTVerifyGetKey>();

function getRemoteJwks(baseUrl: string): JWTVerifyGetKey {
  let jwks = jwksByBaseUrl.get(baseUrl);
  if (!jwks) {
    jwks = createRemoteJWKSet(new URL(APP_JWKS_PATH, `${baseUrl}/`));
    jwksByBaseUrl.set(baseUrl, jwks);
  }
  return jwks;
}

/**
 * Verify a viewer token from `app.getToken()` against Planeward's JWKS.
 * Throws when the signature, issuer, audience, expiry or claims are invalid.
 * A token for another app throws `PlanewardTokenAudienceError`.
 */
export function verifyPlanewardToken(
  token: string,
  { appId, baseUrl = DEFAULT_PLANEWARD_BASE_URL }: VerifyPlanewardTokenOptions
): Promise<AppViewerTokenClaims> {
  const issuer = normalizeBaseUrl(baseUrl);
  return verifyPlanewardTokenWithKeys(token, getRemoteJwks(issuer), {
    appId,
    issuer,
  });
}

// ---------------------------------------------------------------------------
// REST client
// ---------------------------------------------------------------------------

export type CreatePlanewardClientOptions = {
  /** App secret (`pwa_…`). Keep it on your server. */
  secret: string;
  /** Installation to act on, from the viewer token or a webhook. */
  installationId: string;
  /** Planeward app URL. Defaults to `https://app.planeward.com`. */
  baseUrl?: string;
  fetch?: typeof fetch;
};

export type ListCommunityMembersParams = {
  limit?: number;
  offset?: number;
  search?: string;
};

export type CreateCommunityMessageInput = {
  /** 1 to 4000 characters. */
  body: string;
  replyToId?: string;
};

export type PlanewardClient = {
  community: {
    members: {
      list: (
        params?: ListCommunityMembersParams
      ) => Promise<ListResponse<CommunityAppMember>>;
      get: (memberId: string) => Promise<DataResponse<CommunityAppMember>>;
    };
    messages: {
      create: (
        channelId: string,
        input: CreateCommunityMessageInput
      ) => Promise<DataResponse<CommunityAppMessage>>;
    };
  };
};

export class PlanewardApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "PlanewardApiError";
    this.status = status;
  }
}

export function createPlanewardClient({
  secret,
  installationId,
  baseUrl = DEFAULT_PLANEWARD_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
}: CreatePlanewardClientOptions): PlanewardClient {
  const origin = normalizeBaseUrl(baseUrl);

  async function request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      [APP_INSTALLATION_HEADER]: installationId,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetchImpl(`${origin}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    const text = await response.text();
    let json: unknown = null;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = null;
      }
    }

    if (!response.ok) {
      const message =
        json &&
        typeof json === "object" &&
        "error" in json &&
        typeof json.error === "string"
          ? json.error
          : `Planeward API request failed with status ${response.status}.`;
      throw new PlanewardApiError(response.status, message);
    }
    return json as T;
  }

  return {
    community: {
      members: {
        list(params = {}) {
          const query = new URLSearchParams();
          if (params.limit !== undefined)
            query.set("limit", String(params.limit));
          if (params.offset !== undefined)
            query.set("offset", String(params.offset));
          if (params.search) query.set("search", params.search);
          const qs = query.toString();
          return request(
            "GET",
            `/api/v1/community/members${qs ? `?${qs}` : ""}`
          );
        },
        get(memberId) {
          return request(
            "GET",
            `/api/v1/community/members/${encodeURIComponent(memberId)}`
          );
        },
      },
      messages: {
        create(channelId, input) {
          return request(
            "POST",
            `/api/v1/community/channels/${encodeURIComponent(channelId)}/messages`,
            input
          );
        },
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

export type VerifyPlanewardWebhookInput = {
  /** The exact request body string, before JSON parsing. */
  rawBody: string;
  /** The `x-planeward-signature` header, `sha256=<hex>`. */
  signature: string | null | undefined;
  /** The app's webhook signing secret. */
  secret: string;
};

const textEncoder = new TextEncoder();

function hexToBytes(hex: string): Uint8Array<ArrayBuffer> | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/i.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Check the `x-planeward-signature` header against an HMAC-SHA256 of the raw
 * body. Async because it uses Web Crypto (Node 18+, edge runtimes, Workers).
 * The comparison is constant-time via `crypto.subtle.verify`.
 */
export async function verifyPlanewardWebhook({
  rawBody,
  signature,
  secret,
}: VerifyPlanewardWebhookInput): Promise<boolean> {
  if (!signature || !signature.startsWith("sha256=")) return false;
  const expected = hexToBytes(signature.slice("sha256=".length));
  if (!expected || expected.length !== 32) return false;

  const key = await globalThis.crypto.subtle.importKey(
    "raw",
    textEncoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"]
  );
  return globalThis.crypto.subtle.verify(
    "HMAC",
    key,
    expected,
    textEncoder.encode(rawBody)
  );
}

/** Parse a webhook body into a typed envelope. Throws on an invalid shape. */
export function parsePlanewardWebhook(rawBody: string): AppWebhookEnvelope {
  const value: unknown = JSON.parse(rawBody);
  if (!isAppWebhookEnvelope(value)) {
    throw new Error("Invalid Planeward webhook payload.");
  }
  return value;
}
