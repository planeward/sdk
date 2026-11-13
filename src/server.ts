import { createRemoteJWKSet, type JWTVerifyGetKey } from "jose";

import type {
  CommunityAppMember,
  CommunityAppMessage,
  CommunityAppMessageWrite,
  CommunityBadge,
  CommunityBadgeDeletion,
  CommunityBadgePatch,
  CommunityBadgeRevocation,
  CommunityBadgeWrite,
  CommunityChannel,
  CommunityCourse,
  CommunityCourseSummary,
  CommunityMemberBadge,
  CommunityMessage,
  CommunityModuleProgress,
  CommunityNotificationSend,
  CommunityNotificationSendResult,
  CursorListResponse,
  DataResponse,
  EventAttendanceSet,
  EventRegistration,
  EventRegistrationCancellation,
  EventRegistrationResult,
  FormSubmission,
  ListResponse,
  MemberFormSubmissionWrite,
  OperationQuery,
  OperationResponse,
  PlanewardEvent,
  PlanewardForm,
} from "./api-types";
import {
  APP_INSTALLATION_HEADER,
  APP_JWKS_PATH,
  DEFAULT_PLANEWARD_BASE_URL,
  type AppViewerTokenClaims,
} from "./protocol";
import { verifyPlanewardTokenWithKeys } from "./token";
import { isAppWebhookEnvelope, type AppWebhookEnvelope } from "./webhooks";

export { PlanewardTokenAudienceError } from "./token";

export {
  APP_INSTALLATION_HEADER,
  APP_JWKS_PATH,
  APP_SECRET_PREFIX,
  APP_VIEWER_TOKEN_TTL_SECONDS,
  DEFAULT_PLANEWARD_BASE_URL,
  type AppView,
  type AppViewerRole,
  type AppViewerTokenClaims,
} from "./protocol";

export type * from "./api-types";
export {
  APP_WEBHOOK_EVENTS,
  type AppInstalledData,
  type AppUninstalledData,
  type AppWebhookEnvelope,
  type AppWebhookEventDataMap,
  type AppWebhookEventName,
  type CommunityBadgeAwardData,
  type CommunityCourseCompletedData,
  type CommunityMembershipData,
  type CommunityMessageCreatedData,
  type CommunityMessageDeletedData,
  type CommunityModuleCompletedData,
  type CommunityReactionData,
  type EventRegistrationData,
  type FormSubmittedData,
} from "./webhooks";

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

export type ListCommunityMembersParams = OperationQuery<"listCommunityMembers">;
export type ListCommunityMessagesParams =
  OperationQuery<"listCommunityMessages">;
export type ListCommunityCoursesParams = OperationQuery<"listCommunityCourses">;
export type ListCommunityMemberProgressParams =
  OperationQuery<"listCommunityMemberProgress">;
export type ListEventsParams = OperationQuery<"listEvents">;
export type ListFormsParams = OperationQuery<"listForms">;

export type CreateCommunityMessageInput = CommunityAppMessageWrite;
/** App callers always act for a community member. */
export type EventRegistrationInput = { memberId: string };
export type SetEventAttendanceInput = Omit<
  EventAttendanceSet,
  "memberId" | "contactId"
> & { memberId: string };
export type CreateFormSubmissionInput = {
  memberId: string;
  /**
   * Answers keyed by field `slug` (or `id`) from the form's `fields`,
   * validated against that definition like a public submission.
   */
  fields: MemberFormSubmissionWrite["fields"];
};

export type PlanewardClient = {
  community: {
    channels: {
      /** Text and app channels `@everyone` can view, in sidebar order. */
      list: () => Promise<{ data: CommunityChannel[] }>;
    };
    messages: {
      /** Newest first. Pass `meta.nextCursor` as `cursor` until it is null. */
      list: (
        channelId: string,
        params?: ListCommunityMessagesParams
      ) => Promise<CursorListResponse<CommunityMessage>>;
      /** Post as the app. */
      create: (
        channelId: string,
        input: CreateCommunityMessageInput
      ) => Promise<DataResponse<CommunityAppMessage>>;
    };
    members: {
      list: (
        params?: ListCommunityMembersParams
      ) => Promise<ListResponse<CommunityAppMember>>;
      get: (memberId: string) => Promise<DataResponse<CommunityAppMember>>;
      progress: {
        list: (
          memberId: string,
          params?: ListCommunityMemberProgressParams
        ) => Promise<{ data: CommunityModuleProgress[] }>;
        /** `PUT`; safe to repeat. */
        complete: (
          memberId: string,
          moduleId: string
        ) => Promise<DataResponse<CommunityModuleProgress>>;
        /** `DELETE`; safe to repeat. */
        uncomplete: (
          memberId: string,
          moduleId: string
        ) => Promise<DataResponse<CommunityModuleProgress>>;
      };
      badges: {
        /** `PUT`; safe to repeat. */
        award: (
          memberId: string,
          badgeId: string
        ) => Promise<DataResponse<CommunityMemberBadge>>;
        /** `DELETE`; safe to repeat. */
        revoke: (
          memberId: string,
          badgeId: string
        ) => Promise<CommunityBadgeRevocation>;
      };
    };
    courses: {
      list: (
        params?: ListCommunityCoursesParams
      ) => Promise<ListResponse<CommunityCourseSummary>>;
      /** Published course with its chapters and modules. */
      get: (courseId: string) => Promise<DataResponse<CommunityCourse>>;
    };
    badges: {
      /** The app's badges in this workspace. */
      list: () => Promise<{ data: CommunityBadge[] }>;
      /** Creates the badge, or updates the one with the same `key`. */
      upsert: (
        input: CommunityBadgeWrite
      ) => Promise<DataResponse<CommunityBadge>>;
      update: (
        badgeId: string,
        input: CommunityBadgePatch
      ) => Promise<DataResponse<CommunityBadge>>;
      /** Deletes the badge and every award of it. */
      delete: (badgeId: string) => Promise<CommunityBadgeDeletion>;
    };
    notifications: {
      /**
       * Sends a bell and push notification, titled with the app's name, to up
       * to 100 members. `href` is a path inside your app, such as
       * `/orders/123`. Members who turned your app's notifications off are
       * still listed in `accepted`. Pass `key` to make a retry safe. Apps can't
       * send email or set the title.
       */
      send: (
        input: CommunityNotificationSend
      ) => Promise<DataResponse<CommunityNotificationSendResult>>;
    };
  };
  events: {
    /** Events with `showInCommunity` on. */
    list: (params?: ListEventsParams) => Promise<ListResponse<PlanewardEvent>>;
    get: (eventId: string) => Promise<DataResponse<PlanewardEvent>>;
    registrations: {
      /** Safe to repeat; `data.created` is false when already registered. */
      create: (
        eventId: string,
        input: EventRegistrationInput
      ) => Promise<EventRegistrationResult>;
      /** Safe to repeat; `data.cancelled` is false when not registered. */
      cancel: (
        eventId: string,
        input: EventRegistrationInput
      ) => Promise<EventRegistrationCancellation>;
    };
    attendance: {
      set: (
        eventId: string,
        input: SetEventAttendanceInput
      ) => Promise<DataResponse<EventRegistration>>;
    };
  };
  forms: {
    /** Published forms with `showInCommunity` on. */
    list: (params?: ListFormsParams) => Promise<ListResponse<PlanewardForm>>;
    submissions: {
      /** Submits the published form as the member. */
      create: (
        formId: string,
        input: CreateFormSubmissionInput
      ) => Promise<DataResponse<FormSubmission>>;
    };
  };
};

export class PlanewardApiError extends Error {
  readonly status: number;
  /**
   * On a 403 for a missing scope: the permission key the app needs, e.g.
   * `EVENTS_READ`. Undefined for every other error (400, 404, 409, 429, …),
   * where `status` and `message` carry the API's `{ error }`.
   */
  readonly missingScope?: string;

  constructor(status: number, message: string, missingScope?: string) {
    super(message);
    this.name = "PlanewardApiError";
    this.status = status;
    this.missingScope = missingScope;
  }
}

type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
type QueryValue = string | number | undefined;

const API_PREFIX = "/api/v1";

/**
 * One URL path segment. Throws a `TypeError` for values that would change
 * the path once a URL parser or proxy normalises it: empty, `.` or `..`, or
 * anything containing `/` or a backslash, checked both as given and
 * percent-decoded (`%2e%2e`, `%2F`). `members.badges.revoke("..", id)` would
 * otherwise reach `DELETE /community/badges/{id}`.
 */
function segment(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("Planeward path segment must be a string.");
  }
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Malformed escapes are sent encoded (`%` becomes `%25`).
  }
  for (const candidate of [value, decoded]) {
    if (
      candidate === "" ||
      candidate === "." ||
      candidate === ".." ||
      /[/\\]/.test(candidate)
    ) {
      throw new TypeError(
        `Invalid Planeward path segment: ${JSON.stringify(value)}.`
      );
    }
  }
  return encodeURIComponent(value);
}

function withQuery(path: string, params: Record<string, QueryValue> = {}) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") query.set(key, String(value));
  }
  const qs = query.toString();
  return qs ? `${path}?${qs}` : path;
}

const readString = (value: unknown, key: string): string | undefined =>
  value &&
  typeof value === "object" &&
  key in value &&
  typeof (value as Record<string, unknown>)[key] === "string"
    ? ((value as Record<string, unknown>)[key] as string)
    : undefined;

export function createPlanewardClient({
  secret,
  installationId,
  baseUrl = DEFAULT_PLANEWARD_BASE_URL,
  fetch: fetchImpl = globalThis.fetch,
}: CreatePlanewardClientOptions): PlanewardClient {
  const origin = normalizeBaseUrl(baseUrl);

  async function request<T>(
    method: HttpMethod,
    path: string,
    body?: unknown
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${secret}`,
      [APP_INSTALLATION_HEADER]: installationId,
      Accept: "application/json",
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";

    const response = await fetchImpl(`${origin}${API_PREFIX}${path}`, {
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
      throw new PlanewardApiError(
        response.status,
        readString(json, "error") ??
          `Planeward API request failed with status ${response.status}.`,
        response.status === 403 ? readString(json, "missingScope") : undefined
      );
    }
    return json as T;
  }

  const member = (memberId: string) =>
    `/community/members/${segment(memberId)}`;
  const event = (eventId: string) => `/events/${segment(eventId)}`;

  return {
    community: {
      channels: {
        list: async () =>
          request<OperationResponse<"listCommunityChannels">>(
            "GET",
            "/community/channels"
          ),
      },
      messages: {
        list: async (channelId, params = {}) =>
          request<OperationResponse<"listCommunityMessages">>(
            "GET",
            withQuery(
              `/community/channels/${segment(channelId)}/messages`,
              params
            )
          ),
        create: async (channelId, input) =>
          request<OperationResponse<"createCommunityAppMessage", 201>>(
            "POST",
            `/community/channels/${segment(channelId)}/messages`,
            input
          ),
      },
      members: {
        list: async (params = {}) =>
          request<OperationResponse<"listCommunityMembers">>(
            "GET",
            withQuery("/community/members", params)
          ),
        get: async (memberId) =>
          request<OperationResponse<"getCommunityMember">>(
            "GET",
            member(memberId)
          ),
        progress: {
          list: async (memberId, params = {}) =>
            request<OperationResponse<"listCommunityMemberProgress">>(
              "GET",
              withQuery(`${member(memberId)}/progress`, params)
            ),
          complete: async (memberId, moduleId) =>
            request<OperationResponse<"completeCommunityModule">>(
              "PUT",
              `${member(memberId)}/progress/${segment(moduleId)}`
            ),
          uncomplete: async (memberId, moduleId) =>
            request<OperationResponse<"uncompleteCommunityModule">>(
              "DELETE",
              `${member(memberId)}/progress/${segment(moduleId)}`
            ),
        },
        badges: {
          award: async (memberId, badgeId) =>
            request<OperationResponse<"awardCommunityBadge">>(
              "PUT",
              `${member(memberId)}/badges/${segment(badgeId)}`
            ),
          revoke: async (memberId, badgeId) =>
            request<OperationResponse<"revokeCommunityBadge">>(
              "DELETE",
              `${member(memberId)}/badges/${segment(badgeId)}`
            ),
        },
      },
      courses: {
        list: async (params = {}) =>
          request<OperationResponse<"listCommunityCourses">>(
            "GET",
            withQuery("/community/courses", params)
          ),
        get: async (courseId) =>
          request<OperationResponse<"getCommunityCourse">>(
            "GET",
            `/community/courses/${segment(courseId)}`
          ),
      },
      badges: {
        list: async () =>
          request<OperationResponse<"listCommunityBadges">>(
            "GET",
            "/community/badges"
          ),
        upsert: async (input) =>
          request<OperationResponse<"upsertCommunityBadge", 201>>(
            "POST",
            "/community/badges",
            input
          ),
        update: async (badgeId, input) =>
          request<OperationResponse<"updateCommunityBadge">>(
            "PATCH",
            `/community/badges/${segment(badgeId)}`,
            input
          ),
        delete: async (badgeId) =>
          request<OperationResponse<"deleteCommunityBadge">>(
            "DELETE",
            `/community/badges/${segment(badgeId)}`
          ),
      },
      notifications: {
        send: async (input) =>
          request<OperationResponse<"sendCommunityNotifications">>(
            "POST",
            "/community/notifications",
            input
          ),
      },
    },
    events: {
      list: async (params = {}) =>
        request<OperationResponse<"listEvents">>(
          "GET",
          withQuery("/events", params)
        ),
      get: async (eventId) =>
        request<OperationResponse<"getEvent">>("GET", event(eventId)),
      registrations: {
        create: async (eventId, { memberId }) =>
          request<OperationResponse<"registerEventContact", 201>>(
            "POST",
            `${event(eventId)}/registrations`,
            { memberId }
          ),
        cancel: async (eventId, { memberId }) =>
          request<OperationResponse<"cancelEventRegistration">>(
            "DELETE",
            withQuery(`${event(eventId)}/registrations`, { memberId })
          ),
      },
      attendance: {
        set: async (eventId, input) =>
          request<OperationResponse<"setEventAttendance">>(
            "PUT",
            `${event(eventId)}/attendance`,
            input
          ),
      },
    },
    forms: {
      list: async (params = {}) =>
        request<OperationResponse<"listForms">>(
          "GET",
          withQuery("/forms", params)
        ),
      submissions: {
        create: async (formId, input) =>
          request<OperationResponse<"submitFormAsMember", 201>>(
            "POST",
            `/forms/${segment(formId)}/submissions`,
            input
          ),
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

/**
 * Parse a webhook body into an envelope discriminated on `event`; switch on
 * `envelope.event` to narrow `data`. Throws on an invalid envelope shape.
 * Events newer than this SDK version are returned as-is: ignore an `event`
 * you don't handle.
 */
export function parsePlanewardWebhook(rawBody: string): AppWebhookEnvelope {
  const value: unknown = JSON.parse(rawBody);
  if (!isAppWebhookEnvelope(value)) {
    throw new Error("Invalid Planeward webhook payload.");
  }
  return value;
}
