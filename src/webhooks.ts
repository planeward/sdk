/**
 * Webhook events Planeward delivers to an app's `webhookUrl`. Payloads mirror
 * what apps receive in the Planeward repo: `event.*` and `form.submitted` use
 * the app schemas in `apps/web/src/config/webhook/webhook-event-payloads.ts`
 * (`appEventRegistrationSchema`, `appFormSubmittedSchema`), every other event
 * the workspace schema there, and `app.*` events come from
 * `apps/web/src/server/apps/installations.ts`. Field names match exactly.
 * They are not part of the OpenAPI spec.
 */
import type { AttendanceStatus } from "./api-types";

export type AppInstalledData = {
  installationId: string;
  workspaceId: string;
  workspaceName: string;
  /** API permission keys the installer granted, e.g. `COMMUNITY_MEMBERS_READ`. */
  grantedPermissions: string[];
  /** ISO 8601. */
  installedAt: string;
};

export type AppUninstalledData = {
  installationId: string;
  workspaceId: string;
  /** ISO 8601. */
  uninstalledAt: string;
};

/** `community.membership.*`. Needs `COMMUNITY_MEMBERS_READ`. */
export type CommunityMembershipData = {
  /** `CommunityMembership.id`, the `memberId` in API calls. */
  id: string;
  communityId: string;
  customerId: string;
  source: "SUBSCRIPTION" | "COMPLIMENTARY";
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
};

/**
 * `community.message.created`. Needs `COMMUNITY_MESSAGES_READ`; sent only for
 * channels `@everyone` can view. The app's own posts come back too, with
 * `authorKind: "app"` and its `appInstallationId`.
 */
export type CommunityMessageCreatedData = {
  id: string;
  communityId: string;
  channelId: string;
  replyToId: string | null;
  authorKind: "member" | "staff" | "app";
  /** `CommunityMembership.id`, or null when staff or an app acted. */
  memberId: string | null;
  /** Set when an app posted. */
  appInstallationId: string | null;
  authorName: string;
  body: string;
  /** ISO 8601. */
  createdAt: string;
};

/** `community.message.deleted`. Needs `COMMUNITY_MESSAGES_READ`. */
export type CommunityMessageDeletedData = {
  id: string;
  communityId: string;
  channelId: string;
  /** Author's `CommunityMembership.id`, or null when staff or an app posted. */
  memberId: string | null;
  /** ISO 8601. */
  timestamp: string;
};

/** `community.reaction.added` and `community.reaction.removed`. Needs `COMMUNITY_MESSAGES_READ`. */
export type CommunityReactionData = {
  messageId: string;
  communityId: string;
  channelId: string;
  emoji: string;
  /** `CommunityMembership.id`, or null when staff or an app acted. */
  memberId: string | null;
  /** ISO 8601. */
  timestamp: string;
};

/** `community.module.completed`. Needs `COURSES_READ`. */
export type CommunityModuleCompletedData = {
  moduleId: string;
  moduleTitle: string;
  chapterId: string;
  courseId: string;
  courseTitle: string;
  communityId: string;
  memberId: string;
  /** ISO 8601. */
  completedAt: string;
};

/**
 * `community.course.completed`. Needs `COURSES_READ`. Sent at most once per
 * member and course.
 */
export type CommunityCourseCompletedData = {
  courseId: string;
  courseTitle: string;
  communityId: string;
  memberId: string;
  /** ISO 8601. */
  completedAt: string;
};

/** `community.badge.awarded` and `community.badge.revoked`. Needs `COMMUNITY_MEMBERS_READ`. */
export type CommunityBadgeAwardData = {
  badgeId: string;
  /** The app's stable key for the badge. */
  badgeKey: string;
  appId: string;
  memberId: string;
  /** ISO 8601. */
  timestamp: string;
};

/**
 * `event.registered`, `event.registration_cancelled`,
 * `event.attendance_classified`. Needs `EVENTS_READ`; sent only for events
 * shown in the community.
 */
export type EventRegistrationData = {
  /** Registration id. */
  id: string;
  eventId: string;
  contactId: string;
  /** `CommunityMembership.id` of the member whose customer has this contact as primary contact, or null. */
  memberId: string | null;
  attendance: AttendanceStatus;
};

/**
 * `form.submitted`. Needs `FORMS_SUBMIT`; sent only for published forms shown
 * in the community.
 */
export type FormSubmittedData = {
  /** Submission id. */
  id: string;
  formId: string;
  contactId: string | null;
  /** `CommunityMembership.id` of the member whose customer has this contact as primary contact, or null. */
  memberId: string | null;
  source: "HOST" | "SITE" | "EMBED";
};

/** `data` of every event an app can receive, keyed by event name. */
export type AppWebhookEventDataMap = {
  "app.installed": AppInstalledData;
  "app.uninstalled": AppUninstalledData;
  "community.membership.granted": CommunityMembershipData;
  "community.membership.complimentary": CommunityMembershipData;
  "community.membership.suspended": CommunityMembershipData;
  "community.membership.resumed": CommunityMembershipData;
  "community.membership.revoked": CommunityMembershipData;
  "community.message.created": CommunityMessageCreatedData;
  "community.message.deleted": CommunityMessageDeletedData;
  "community.reaction.added": CommunityReactionData;
  "community.reaction.removed": CommunityReactionData;
  "community.module.completed": CommunityModuleCompletedData;
  "community.course.completed": CommunityCourseCompletedData;
  "community.badge.awarded": CommunityBadgeAwardData;
  "community.badge.revoked": CommunityBadgeAwardData;
  "event.registered": EventRegistrationData;
  "event.registration_cancelled": EventRegistrationData;
  "event.attendance_classified": EventRegistrationData;
  "form.submitted": FormSubmittedData;
};

export type AppWebhookEventName = keyof AppWebhookEventDataMap;

export const APP_WEBHOOK_EVENTS = [
  "app.installed",
  "app.uninstalled",
  "community.membership.granted",
  "community.membership.complimentary",
  "community.membership.suspended",
  "community.membership.resumed",
  "community.membership.revoked",
  "community.message.created",
  "community.message.deleted",
  "community.reaction.added",
  "community.reaction.removed",
  "community.module.completed",
  "community.course.completed",
  "community.badge.awarded",
  "community.badge.revoked",
  "event.registered",
  "event.registration_cancelled",
  "event.attendance_classified",
  "form.submitted",
] as const satisfies readonly AppWebhookEventName[];

/**
 * Body POSTed to the app's `webhookUrl`, discriminated on `event`:
 * `switch (envelope.event)` narrows `data`. Pass an event name to get one
 * member, e.g. `AppWebhookEnvelope<"form.submitted">`.
 */
export type AppWebhookEnvelope<
  E extends AppWebhookEventName = AppWebhookEventName,
> = {
  [K in E]: {
    event: K;
    data: AppWebhookEventDataMap[K];
    /** ISO 8601. */
    timestamp: string;
    installationId: string;
    workspaceId: string;
  };
}[E];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Checks the envelope shape, not `data`. Events newer than this SDK version
 * pass too; ignore an `event` you don't handle.
 */
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
