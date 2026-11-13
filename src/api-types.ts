/**
 * Friendly names for the Planeward API types generated from the OpenAPI spec
 * (`src/generated/openapi.ts`). The raw `paths`, `components` and
 * `operations` are exported from `@planeward/sdk/openapi`.
 */
import type { components, operations } from "./generated/openapi";

type Schemas = components["schemas"];

export type ListMeta = Schemas["ListMeta"];
export type CursorMeta = Schemas["CursorMeta"];
export type ApiError = Schemas["Error"];
export type ForbiddenError = Schemas["ForbiddenError"];

export type ListResponse<T> = { data: T[]; meta: ListMeta };
export type CursorListResponse<T> = { data: T[]; meta: CursorMeta };
export type DataResponse<T> = { data: T };

// Community ------------------------------------------------------------------

export type CommunityAppMember = Schemas["CommunityMember"];
export type CommunityMemberBadge = Schemas["CommunityMemberBadge"];
export type CommunityNamedRef = Schemas["CommunityNamedRef"];
export type CommunityAppMessage = Schemas["CommunityAppMessage"];
export type CommunityAppMessageWrite = Schemas["CommunityAppMessageWrite"];
export type CommunityChannel = Schemas["CommunityChannel"];
export type CommunityMessage = Schemas["CommunityMessage"];
export type CommunityMessageAuthor = Schemas["CommunityMessageAuthor"];
export type CommunityReactionCount = Schemas["CommunityReactionCount"];
export type CommunityCourseSummary = Schemas["CommunityCourseSummary"];
export type CommunityCourse = Schemas["CommunityCourse"];
export type CommunityChapter = Schemas["CommunityChapter"];
export type CommunityModuleOutline = Schemas["CommunityModuleOutline"];
export type CommunityModuleProgress = Schemas["CommunityModuleProgress"];
export type CommunityBadge = Schemas["CommunityBadge"];
export type CommunityBadgeWrite = Schemas["CommunityBadgeWrite"];
export type CommunityBadgePatch = Schemas["CommunityBadgePatch"];
export type CommunityNotificationSend = Schemas["CommunityNotificationSend"];
export type CommunityNotificationSkipReason =
  Schemas["CommunityNotificationSkipReason"];
export type CommunityNotificationSkip = Schemas["CommunityNotificationSkip"];
export type CommunityNotificationSendResult =
  Schemas["CommunityNotificationSendResult"];

// Events and forms -----------------------------------------------------------

/** A Planeward event (webinar or live session). Named to avoid the DOM `Event`. */
export type PlanewardEvent = Schemas["Event"];
export type EventAttendanceCounts = Schemas["EventAttendanceCounts"];
export type AttendanceStatus = Schemas["AttendanceStatus"];
export type EventRegistration = Schemas["EventRegistration"];
export type EventRegistrationWrite = Schemas["EventRegistrationWrite"];
export type EventAttendanceSet = Schemas["EventAttendanceSet"];
/** A Planeward CRM form. */
export type PlanewardForm = Schemas["Form"];
/** A form's pages and fields (`PlanewardForm["fields"]`). */
export type FormDefinition = Schemas["FormDefinition"];
export type FormSection = Schemas["FormSection"];
/** One field of a form; answer it under its `slug` (or `id`). */
export type FormField = Schemas["FormField"];
export type FormFieldOption = Schemas["FormFieldOption"];
/** One answer in `MemberFormSubmissionWrite["fields"]`. */
export type FormAnswerValue = Schemas["FormAnswerValue"];
export type FormSubmission = Schemas["FormSubmission"];
export type MemberFormSubmissionWrite = Schemas["MemberFormSubmissionWrite"];

// Operation helpers ----------------------------------------------------------

type JsonContent<T> = T extends { content: { "application/json": infer B } }
  ? B
  : never;

/** JSON body of `operations[Op]`'s `Status` response. */
export type OperationResponse<
  Op extends keyof operations,
  Status extends number = 200,
> = operations[Op]["responses"] extends infer R
  ? Status extends keyof R
    ? JsonContent<R[Status]>
    : never
  : never;

/** Query parameters of `operations[Op]`. */
export type OperationQuery<Op extends keyof operations> = NonNullable<
  operations[Op]["parameters"]["query"]
>;

/** `POST /events/{eventId}/registrations` result. */
export type EventRegistrationResult = OperationResponse<
  "registerEventContact",
  201
>;
/** `DELETE /events/{eventId}/registrations` result. */
export type EventRegistrationCancellation =
  OperationResponse<"cancelEventRegistration">;
/** `DELETE /community/badges/{badgeId}` result. */
export type CommunityBadgeDeletion = OperationResponse<"deleteCommunityBadge">;
/** `DELETE /community/members/{memberId}/badges/{badgeId}` result. */
export type CommunityBadgeRevocation =
  OperationResponse<"revokeCommunityBadge">;
/** `POST /community/notifications` result. */
export type CommunityNotificationSendResponse =
  OperationResponse<"sendCommunityNotifications">;
