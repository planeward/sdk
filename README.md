# @planeward/sdk

Build apps that run inside a Planeward community. Your app is loaded in an iframe as a member channel or a staff dashboard view. This SDK covers the iframe handshake, viewer token verification, webhook verification, and a typed API client.

## Install

```bash
npm install @planeward/sdk
```

## Browser: get the viewer token

```ts
import { createPlanewardApp } from "@planeward/sdk";

const app = createPlanewardApp({
  // Optional. Without it, the SDK pins to the first host origin that sends a token.
  allowedHostOrigins: ["https://acme.planeward.site"],
  timeoutMs: 10_000,
});

const context = await app.ready; // { view, channelId, theme }
const token = await app.getToken(); // cached, refreshed ~30s before expiry

await fetch("/api/me", { headers: { Authorization: `Bearer ${token}` } });

const unsubscribe = app.onThemeChange((theme) => {
  document.documentElement.dataset.theme = theme;
});

// On teardown
unsubscribe();
app.destroy();
```

`ready` rejects with "Not running inside a Planeward community" when no host answers in time. Importing the module is SSR-safe; call `createPlanewardApp()` in the browser only (for example inside `useEffect`). Do not rely on third-party cookies inside the iframe; send the token to your backend instead.

## Server: verify the viewer

```ts
import { verifyPlanewardToken } from "@planeward/sdk/server";

const viewer = await verifyPlanewardToken(token, { appId: "app_123" });
// viewer.sub, viewer.name, viewer.role ("member" | "admin"), viewer.installationId, ...
```

The token is an RS256 JWT that expires after 5 minutes. It is checked against `https://app.planeward.com/api/auth/jwks`, and the function throws when it is invalid. Pass `baseUrl` to target another Planeward deployment.

A valid token issued for a different app throws `PlanewardTokenAudienceError` (`tokenAudience`, `expectedAppId`) with the message `Token is for app "<aud>", but this backend expects "<appId>". Check PLANEWARD_APP_ID.` Run one app id per deployment.

## Server: call the Planeward API

```ts
import {
  createPlanewardClient,
  PlanewardApiError,
} from "@planeward/sdk/server";

const pw = createPlanewardClient({
  secret: process.env.PLANEWARD_APP_SECRET!, // pwa_...
  installationId: viewer.installationId,
});

const { data: members, meta } = await pw.community.members.list({ limit: 50 });
const { data: member } = await pw.community.members.get(viewer.sub);
await pw.community.messages.create(channelId, { body: "Hello from my app" });
```

Failed requests throw `PlanewardApiError` with `status` and the API's `error` message. Calls are limited to the scopes the installer granted; a 403 for a missing scope sets `missingScope` to a permission key the app can be granted (for example `EVENTS_READ`, or `FORMS_SUBMIT` on `forms.list()`). `missingScope` is undefined for every other error. Statuses worth handling:

| Status | `error`                                                                 | When                                                                                                                                                        |
| ------ | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `Invalid JSON body.`, or a readable validation message naming the field | Bad request body or query, or form answers that fail the form's rules                                                                                       |
| 403    | `This app is in local development and only works in its own workspace.` | Your app's URLs are still `localhost` and the installation is in another workspace                                                                          |
| 409    | `Member is not active.` or `Member has no primary contact.`             | The member is suspended or revoked, or (registration, form submit) their customer has no email and several contacts, so staff must pick the primary contact |
| 429    | `Too many API requests. Try again shortly.`                             | Over the rate limit; wait for `Retry-After`. Counted before the scope check, so calls that fail with 403 still count                                        |

Every id you pass is one URL path segment. The client throws a `TypeError` before sending anything when an id is empty, `.` or `..`, or contains `/` or `\` (also when percent-encoded, such as `%2e%2e` or `%2F`), so an untrusted id can't reach another endpoint: `members.badges.revoke("..", badgeId)` would otherwise become `DELETE /community/badges/{badgeId}`.

| Method                                                                        | Request                                                         | Scope                       |
| ----------------------------------------------------------------------------- | --------------------------------------------------------------- | --------------------------- |
| `community.channels.list()`                                                   | `GET /community/channels`                                       | `COMMUNITY_MESSAGES_READ`   |
| `community.messages.list(channelId, { cursor, limit })`                       | `GET /community/channels/{channelId}/messages`                  | `COMMUNITY_MESSAGES_READ`   |
| `community.messages.create(channelId, { body, replyToId })`                   | `POST /community/channels/{channelId}/messages`                 | `COMMUNITY_MESSAGES_WRITE`  |
| `community.members.list({ limit, offset, search })`, `.get(memberId)`         | `GET /community/members[/{memberId}]`                           | `COMMUNITY_MEMBERS_READ`    |
| `community.courses.list({ limit, offset })`, `.get(courseId)`                 | `GET /community/courses[/{courseId}]`                           | `COURSES_READ`              |
| `community.members.progress.list(memberId, { courseId })`                     | `GET /community/members/{memberId}/progress`                    | `COURSES_READ`              |
| `community.members.progress.complete(memberId, moduleId)`, `.uncomplete(...)` | `PUT` / `DELETE .../progress/{moduleId}`                        | `COURSE_PROGRESS_WRITE`     |
| `community.badges.list()`, `.upsert({ key, name, color, description })`       | `GET` / `POST /community/badges`                                | `COMMUNITY_BADGES_WRITE`    |
| `community.badges.update(badgeId, patch)`, `.delete(badgeId)`                 | `PATCH` / `DELETE /community/badges/{badgeId}`                  | `COMMUNITY_BADGES_WRITE`    |
| `community.members.badges.award(memberId, badgeId)`, `.revoke(...)`           | `PUT` / `DELETE /community/members/{memberId}/badges/{badgeId}` | `COMMUNITY_BADGES_WRITE`    |
| `events.list({ limit, offset })`, `.get(eventId)`                             | `GET /events[/{eventId}]`                                       | `EVENTS_READ`               |
| `events.registrations.create(eventId, { memberId })`, `.cancel(...)`          | `POST` / `DELETE /events/{eventId}/registrations`               | `EVENT_REGISTRATIONS_WRITE` |
| `events.attendance.set(eventId, { memberId, attendance })`                    | `PUT /events/{eventId}/attendance`                              | `EVENT_REGISTRATIONS_WRITE` |
| `forms.list({ limit, offset, search })`                                       | `GET /forms`                                                    | `FORMS_SUBMIT`              |
| `forms.submissions.create(formId, { memberId, fields })`                      | `POST /forms/{formId}/submissions`                              | `FORMS_SUBMIT`              |

Paths are under `/api/v1`. Methods that act for a member take `memberId`, the community membership id (`viewer.sub` for a member viewer); the member must be active. A member without a CRM contact gets one on their first registration or form submission.

Apps only see events and forms that staff marked "Show in community":

- **Events** never include the CRM pipeline (`pipeline`, `pipelineId`), and registrations leave out `contact` and `opportunityId`. An event's `form` and `formId` are set only when that form is published and shown in community, so the app can list and submit it; otherwise both are `null`.
- **Forms** from `forms.list()` are published, with the real `submissionCount`, the field definition in `fields` (`FormDefinition` → `FormSection` → `FormField`) and only the render part of `settings`: `respondent`, `theme` and `css`. Answer each field under its `slug` (or `id`); see `FormAnswerValue`.
- **Courses** are the published ones sold through at least one product, and progress covers only those courses.

```ts
const { data: channels } = await pw.community.channels.list();
let cursor: string | undefined;
do {
  const page = await pw.community.messages.list(channels[0]!.id, { cursor });
  cursor = page.meta.nextCursor ?? undefined;
} while (cursor);

const { data: badge } = await pw.community.badges.upsert({
  key: "first-post",
  name: "First post",
  color: "#f59e0b",
});
await pw.community.members.badges.award(memberId, badge.id);

try {
  await pw.events.registrations.create(eventId, { memberId });
} catch (error) {
  if (error instanceof PlanewardApiError && error.missingScope) {
    console.warn(`Ask the installer to grant ${error.missingScope}`);
  }
}
```

### Types

Request and response types are generated from the [Planeward OpenAPI spec](https://docs.planeward.com/openapi.json). `@planeward/sdk/server` exports friendly names (`CommunityAppMember`, `CommunityChannel`, `CommunityMessage`, `CommunityCourse`, `CommunityModuleProgress`, `CommunityBadge`, `PlanewardEvent`, `EventRegistration`, `PlanewardForm`, `FormDefinition`, `FormField`, `FormAnswerValue`, `FormSubmission`, ...). The raw `openapi-typescript` output is at `@planeward/sdk/openapi`:

```ts
import type { components, paths } from "@planeward/sdk/openapi";

type Member = components["schemas"]["CommunityMember"];
type ChannelsResponse =
  paths["/community/channels"]["get"]["responses"][200]["content"]["application/json"];
```

## Webhooks

```ts
import {
  parsePlanewardWebhook,
  PLANEWARD_SIGNATURE_HEADER,
  verifyPlanewardWebhook,
} from "@planeward/sdk/server";

export async function POST(request: Request) {
  const rawBody = await request.text();
  const valid = await verifyPlanewardWebhook({
    rawBody,
    signature: request.headers.get(PLANEWARD_SIGNATURE_HEADER),
    secret: process.env.PLANEWARD_WEBHOOK_SECRET!,
  });
  if (!valid) return new Response("Invalid signature", { status: 401 });

  const webhook = parsePlanewardWebhook(rawBody);
  // Dedupe retries on the x-planeward-delivery header.
  switch (webhook.event) {
    case "community.message.created":
      // webhook.data: { channelId, memberId, authorKind, body, ... }
      break;
    case "community.badge.awarded":
      // webhook.data: { badgeId, badgeKey, memberId, ... }
      break;
  }
  return new Response(null, { status: 204 });
}
```

The envelope is `{ event, data, timestamp, installationId, workspaceId }`, a union discriminated on `event`, so a `switch` narrows `data`. `APP_WEBHOOK_EVENTS` lists every event an app can receive; each one needs a scope:

| Events                                                                                                             | Scope                                                     |
| ------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `app.installed`, `app.uninstalled`                                                                                 | none                                                      |
| `community.membership.*`, `community.badge.awarded`, `community.badge.revoked`                                     | `COMMUNITY_MEMBERS_READ`                                  |
| `community.message.created`, `community.message.deleted`, `community.reaction.added`, `community.reaction.removed` | `COMMUNITY_MESSAGES_READ` (channels `@everyone` can view) |
| `community.module.completed`, `community.course.completed` (once per member and course)                            | `COURSES_READ`                                            |
| `event.registered`, `event.registration_cancelled`, `event.attendance_classified`                                  | `EVENTS_READ` (events shown in community)                 |
| `form.submitted`                                                                                                   | `FORMS_SUBMIT` (forms shown in community)                 |

Events added to Planeward after your SDK version still parse; ignore an `event` you don't handle. `community.course.completed` goes out at most once per member and course: uncompleting and completing the last module again doesn't repeat it.

`verifyPlanewardWebhook` is async because it uses Web Crypto, so it runs on Node 18+, edge runtimes and Workers. Verify against the raw body string before parsing it.

## Development

`pnpm generate` regenerates `src/generated/openapi.ts` from `PLANEWARD_OPENAPI` (a path or URL), else `../../workbench/apps/docs/openapi/v1.yaml` when a Planeward checkout sits next to this repo, else `https://docs.planeward.com/openapi.json`. Commit the output. CI regenerates from the hosted spec and fails on a diff.

## Releasing

1. On `main`, run `pnpm release` (or `pnpm release patch|minor|major`). bumpp updates `package.json`, commits `chore(release): vX.Y.Z` and creates the tag `vX.Y.Z`.
2. Push the commit and tag: `git push --follow-tags`.

The `Release` workflow (`.github/workflows/release.yml`) runs on that tag in the `Release` environment. It checks that the tag matches `package.json`, builds, typechecks, tests, lints, publishes to npm with trusted publishing (OIDC, with provenance), creates a GitHub release and moves the `latest` tag to the released commit. No npm token is stored in the repo. To retry a failed release, re-run the workflow run.

To check a release locally: `pnpm build && pnpm test && pnpm pack --dry-run`.

## License

MIT
