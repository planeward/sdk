import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { before, describe, it } from "node:test";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";

import {
  APP_WEBHOOK_EVENTS,
  createPlanewardClient,
  parsePlanewardWebhook,
  PlanewardApiError,
  PlanewardTokenAudienceError,
  verifyPlanewardWebhook,
  type AppWebhookEnvelope,
  type AppWebhookEventName,
  type OperationQuery,
  type OperationResponse,
  type PlanewardClient,
} from "./server";
import { verifyPlanewardTokenWithKeys } from "./token";

const ISSUER = "https://app.planeward.test";
const APP_ID = "app_123";

const viewerClaims = {
  workspaceId: "ws_1",
  installationId: "inst_1",
  channelId: "chan_1",
  view: "experience",
  role: "member",
  name: "Ada",
  avatar: null,
};

describe("verifyPlanewardToken", () => {
  let privateKey: CryptoKey;
  let jwks: JWTVerifyGetKey;

  before(async () => {
    const pair = await generateKeyPair("RS256");
    privateKey = pair.privateKey;
    const jwk = await exportJWK(pair.publicKey);
    jwks = createLocalJWKSet({
      keys: [{ ...jwk, kid: "k1", alg: "RS256", use: "sig" }],
    });
  });

  const sign = (
    claims: Record<string, unknown> = viewerClaims,
    {
      audience = APP_ID,
      issuer = ISSUER,
      expiresIn = "5m",
    }: { audience?: string; issuer?: string; expiresIn?: string } = {}
  ) =>
    new SignJWT(claims)
      .setProtectedHeader({ alg: "RS256", kid: "k1" })
      .setIssuer(issuer)
      .setAudience(audience)
      .setSubject("cm_1")
      .setIssuedAt()
      .setExpirationTime(expiresIn)
      .sign(privateKey);

  it("returns typed claims for a valid token", async () => {
    const claims = await verifyPlanewardTokenWithKeys(await sign(), jwks, {
      appId: APP_ID,
      issuer: ISSUER,
    });
    assert.equal(claims.sub, "cm_1");
    assert.equal(claims.aud, APP_ID);
    assert.equal(claims.installationId, "inst_1");
    assert.equal(claims.role, "member");
  });

  it("rejects a token for another app", async () => {
    await assert.rejects(
      verifyPlanewardTokenWithKeys(await sign(), jwks, {
        appId: "app_other",
        issuer: ISSUER,
      })
    );
  });

  it("explains an audience mismatch with both app ids", async () => {
    const token = await sign(viewerClaims, { audience: "app_demo" });
    await assert.rejects(
      verifyPlanewardTokenWithKeys(token, jwks, {
        appId: APP_ID,
        issuer: ISSUER,
      }),
      (error: unknown) => {
        assert.ok(error instanceof PlanewardTokenAudienceError);
        assert.equal(error.tokenAudience, "app_demo");
        assert.equal(error.expectedAppId, APP_ID);
        assert.equal(
          error.message,
          'Token is for app "app_demo", but this backend expects "app_123". Check PLANEWARD_APP_ID.'
        );
        return true;
      }
    );
  });

  it("rejects a token from another issuer", async () => {
    const token = await sign(viewerClaims, { issuer: "https://evil.test" });
    await assert.rejects(
      verifyPlanewardTokenWithKeys(token, jwks, {
        appId: APP_ID,
        issuer: ISSUER,
      })
    );
  });

  it("rejects an expired token", async () => {
    const token = await sign(viewerClaims, { expiresIn: "-1m" });
    await assert.rejects(
      verifyPlanewardTokenWithKeys(token, jwks, {
        appId: APP_ID,
        issuer: ISSUER,
      })
    );
  });

  it("rejects a token with malformed custom claims", async () => {
    const token = await sign({ ...viewerClaims, role: "owner" });
    await assert.rejects(
      verifyPlanewardTokenWithKeys(token, jwks, {
        appId: APP_ID,
        issuer: ISSUER,
      }),
      /missing required claims/
    );
  });
});

describe("verifyPlanewardWebhook", () => {
  const secret = "whsec_test";
  const rawBody = JSON.stringify({
    event: "app.installed",
    data: { appId: APP_ID },
    timestamp: "2026-10-26T00:00:00.000Z",
    installationId: "inst_1",
    workspaceId: "ws_1",
  });
  // Same format as apps/web signWebhookBody.
  const signature = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;

  it("accepts a valid signature", async () => {
    assert.equal(
      await verifyPlanewardWebhook({ rawBody, signature, secret }),
      true
    );
  });

  it("rejects a tampered body, wrong secret, or malformed header", async () => {
    assert.equal(
      await verifyPlanewardWebhook({
        rawBody: `${rawBody} `,
        signature,
        secret,
      }),
      false
    );
    assert.equal(
      await verifyPlanewardWebhook({ rawBody, signature, secret: "nope" }),
      false
    );
    for (const bad of [
      null,
      "",
      signature.slice("sha256=".length),
      "sha256=zz",
      "sha1=abcd",
    ]) {
      assert.equal(
        await verifyPlanewardWebhook({ rawBody, signature: bad, secret }),
        false
      );
    }
  });

  it("parses the envelope", () => {
    const envelope = parsePlanewardWebhook(rawBody);
    assert.equal(envelope.event, "app.installed");
    assert.equal(envelope.installationId, "inst_1");
    assert.throws(() => parsePlanewardWebhook('{"event":"x"}'));
  });
});

const envelope = (event: string, data: unknown) =>
  JSON.stringify({
    event,
    data,
    timestamp: "2026-11-05T00:00:00.000Z",
    installationId: "inst_1",
    workspaceId: "ws_1",
  });

/** Returns a summary string; the point is that each branch type-checks. */
function describeWebhook(webhook: AppWebhookEnvelope): string {
  switch (webhook.event) {
    case "app.installed":
      return `installed ${webhook.data.grantedPermissions.join(",")}`;
    case "app.uninstalled":
      return `uninstalled ${webhook.data.uninstalledAt}`;
    case "community.membership.granted":
    case "community.membership.complimentary":
    case "community.membership.suspended":
    case "community.membership.resumed":
    case "community.membership.revoked":
      return `membership ${webhook.data.status}`;
    case "community.message.created":
      // @ts-expect-error `badgeKey` is not on a message payload.
      void webhook.data.badgeKey;
      return `message ${webhook.data.authorKind}: ${webhook.data.body}`;
    case "community.message.deleted":
      return `deleted ${webhook.data.id}`;
    case "community.reaction.added":
    case "community.reaction.removed":
      return `reaction ${webhook.data.emoji}`;
    case "community.module.completed":
      return `module ${webhook.data.moduleTitle}`;
    case "community.course.completed":
      return `course ${webhook.data.courseTitle}`;
    case "community.badge.awarded":
    case "community.badge.revoked":
      return `badge ${webhook.data.badgeKey} ${webhook.data.memberId}`;
    case "event.registered":
    case "event.registration_cancelled":
    case "event.attendance_classified":
      return `event ${webhook.data.eventId} ${webhook.data.attendance}`;
    case "form.submitted":
      return `form ${webhook.data.formId} ${webhook.data.source}`;
    default: {
      const unhandled: never = webhook;
      return `unknown ${(unhandled as { event: string }).event}`;
    }
  }
}

// Fails to compile when APP_WEBHOOK_EVENTS misses an event with a payload type.
const everyEventListed: [
  Exclude<AppWebhookEventName, (typeof APP_WEBHOOK_EVENTS)[number]>,
] extends [never]
  ? true
  : false = true;

describe("parsePlanewardWebhook union", () => {
  it("narrows data on event", () => {
    const webhook = parsePlanewardWebhook(
      envelope("community.message.created", {
        id: "m1",
        communityId: "c1",
        channelId: "ch1",
        replyToId: null,
        authorKind: "member",
        memberId: "cm_1",
        appInstallationId: null,
        authorName: "Ada",
        body: "Hi",
        createdAt: "2026-11-05T00:00:00.000Z",
      })
    );
    assert.equal(describeWebhook(webhook), "message member: Hi");

    const badge = parsePlanewardWebhook(
      envelope("community.badge.awarded", {
        badgeId: "b1",
        badgeKey: "first-post",
        appId: APP_ID,
        memberId: "cm_1",
        timestamp: "2026-11-05T00:00:00.000Z",
      })
    );
    assert.equal(describeWebhook(badge), "badge first-post cm_1");
  });

  it("lets a single-event envelope type be named", () => {
    const typed: AppWebhookEnvelope<"form.submitted"> = {
      event: "form.submitted",
      data: {
        id: "s1",
        formId: "f1",
        contactId: null,
        memberId: null,
        source: "HOST",
      },
      timestamp: "2026-11-05T00:00:00.000Z",
      installationId: "inst_1",
      workspaceId: "ws_1",
    };
    assert.equal(describeWebhook(typed), "form f1 HOST");
  });

  it("passes events newer than the SDK through untouched", () => {
    const webhook = parsePlanewardWebhook(envelope("future.event", { a: 1 }));
    assert.equal(describeWebhook(webhook), "unknown future.event");
  });

  it("lists every app event once", () => {
    assert.equal(everyEventListed, true);
    assert.equal(new Set(APP_WEBHOOK_EVENTS).size, APP_WEBHOOK_EVENTS.length);
  });
});

describe("createPlanewardClient", () => {
  it("sends auth headers and builds URLs", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const client = createPlanewardClient({
      secret: "pwa_secret",
      installationId: "inst_1",
      baseUrl: "https://app.planeward.test/",
      fetch: async (url, init) => {
        calls.push({ url: String(url), init: init ?? {} });
        return Response.json(
          { data: [], meta: { total: 0, limit: 10, offset: 0 } },
          { status: 200 }
        );
      },
    });
    const result = await client.community.members.list({
      limit: 10,
      search: "ada",
    });
    assert.deepEqual(result.meta, { total: 0, limit: 10, offset: 0 });
    assert.equal(
      calls[0]?.url,
      "https://app.planeward.test/api/v1/community/members?limit=10&search=ada"
    );
    const headers = calls[0]?.init.headers as Record<string, string>;
    assert.equal(headers.Authorization, "Bearer pwa_secret");
    assert.equal(headers["x-planeward-installation"], "inst_1");
  });

  it("posts messages as JSON", async () => {
    let captured: RequestInit | undefined;
    const client = createPlanewardClient({
      secret: "pwa_secret",
      installationId: "inst_1",
      fetch: async (url, init) => {
        assert.equal(
          String(url),
          "https://app.planeward.com/api/v1/community/channels/chan%201/messages"
        );
        captured = init;
        return Response.json({ data: { id: "m1" } }, { status: 201 });
      },
    });
    const result = await client.community.messages.create("chan 1", {
      body: "Hello",
    });
    assert.equal(result.data.id, "m1");
    assert.equal(captured?.method, "POST");
    assert.equal(captured?.body, JSON.stringify({ body: "Hello" }));
  });

  it("throws PlanewardApiError with the body's error message", async () => {
    const client = createPlanewardClient({
      secret: "pwa_secret",
      installationId: "inst_1",
      fetch: async () =>
        Response.json({ error: "Missing permission" }, { status: 403 }),
    });
    await assert.rejects(client.community.members.get("cm_1"), (error) => {
      assert.ok(error instanceof PlanewardApiError);
      assert.equal(error.status, 403);
      assert.equal(error.message, "Missing permission");
      return true;
    });
  });
});

// Every response type the client relies on must resolve (not `never`).
type IsNever<T> = [T] extends [never] ? true : false;
type ExpectResolved<T extends false> = T;
export type ClientResponseTypesResolve = [
  ExpectResolved<IsNever<OperationResponse<"listCommunityChannels">>>,
  ExpectResolved<IsNever<OperationResponse<"listCommunityMessages">>>,
  ExpectResolved<IsNever<OperationResponse<"createCommunityAppMessage", 201>>>,
  ExpectResolved<IsNever<OperationResponse<"listCommunityMembers">>>,
  ExpectResolved<IsNever<OperationResponse<"getCommunityMember">>>,
  ExpectResolved<IsNever<OperationResponse<"listCommunityMemberProgress">>>,
  ExpectResolved<IsNever<OperationResponse<"completeCommunityModule">>>,
  ExpectResolved<IsNever<OperationResponse<"uncompleteCommunityModule">>>,
  ExpectResolved<IsNever<OperationResponse<"awardCommunityBadge">>>,
  ExpectResolved<IsNever<OperationResponse<"revokeCommunityBadge">>>,
  ExpectResolved<IsNever<OperationResponse<"listCommunityCourses">>>,
  ExpectResolved<IsNever<OperationResponse<"getCommunityCourse">>>,
  ExpectResolved<IsNever<OperationResponse<"listCommunityBadges">>>,
  ExpectResolved<IsNever<OperationResponse<"upsertCommunityBadge", 201>>>,
  ExpectResolved<IsNever<OperationResponse<"updateCommunityBadge">>>,
  ExpectResolved<IsNever<OperationResponse<"deleteCommunityBadge">>>,
  ExpectResolved<IsNever<OperationResponse<"sendCommunityNotifications">>>,
  ExpectResolved<IsNever<OperationResponse<"listEvents">>>,
  ExpectResolved<IsNever<OperationResponse<"getEvent">>>,
  ExpectResolved<IsNever<OperationResponse<"registerEventContact", 201>>>,
  ExpectResolved<IsNever<OperationResponse<"cancelEventRegistration">>>,
  ExpectResolved<IsNever<OperationResponse<"setEventAttendance">>>,
  ExpectResolved<IsNever<OperationResponse<"listForms">>>,
  ExpectResolved<IsNever<OperationResponse<"submitFormAsMember", 201>>>,
  ExpectResolved<IsNever<OperationQuery<"listCommunityMessages">>>,
  ExpectResolved<IsNever<OperationQuery<"listCommunityMemberProgress">>>,
];

type RecordedCall = {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
};

function recordingClient(status = 200) {
  const calls: RecordedCall[] = [];
  const client = createPlanewardClient({
    secret: "pwa_secret",
    installationId: "inst_1",
    baseUrl: "https://app.planeward.test",
    fetch: async (url, init = {}) => {
      calls.push({
        url: String(url),
        method: init.method ?? "GET",
        headers: init.headers as Record<string, string>,
        body: typeof init.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json({ data: {} }, { status });
    },
  });
  return { client, calls };
}

const API = "https://app.planeward.test/api/v1";

const clientCases: {
  name: string;
  call: (client: PlanewardClient) => Promise<unknown>;
  method: string;
  url: string;
  body?: unknown;
}[] = [
  {
    name: "community.channels.list",
    call: (pw) => pw.community.channels.list(),
    method: "GET",
    url: `${API}/community/channels`,
  },
  {
    name: "community.messages.list",
    call: (pw) =>
      pw.community.messages.list("chan 1", { cursor: "abc", limit: 20 }),
    method: "GET",
    url: `${API}/community/channels/chan%201/messages?cursor=abc&limit=20`,
  },
  {
    name: "community.messages.list without params",
    call: (pw) => pw.community.messages.list("chan_1"),
    method: "GET",
    url: `${API}/community/channels/chan_1/messages`,
  },
  {
    name: "community.courses.list",
    call: (pw) => pw.community.courses.list({ limit: 5, offset: 10 }),
    method: "GET",
    url: `${API}/community/courses?limit=5&offset=10`,
  },
  {
    name: "community.courses.get",
    call: (pw) => pw.community.courses.get("course 1"),
    method: "GET",
    url: `${API}/community/courses/course%201`,
  },
  {
    name: "community.members.progress.list",
    call: (pw) =>
      pw.community.members.progress.list("cm_1", { courseId: "course_1" }),
    method: "GET",
    url: `${API}/community/members/cm_1/progress?courseId=course_1`,
  },
  {
    name: "community.members.progress.complete",
    call: (pw) => pw.community.members.progress.complete("cm_1", "mod_1"),
    method: "PUT",
    url: `${API}/community/members/cm_1/progress/mod_1`,
  },
  {
    name: "community.members.progress.uncomplete",
    call: (pw) => pw.community.members.progress.uncomplete("cm_1", "mod_1"),
    method: "DELETE",
    url: `${API}/community/members/cm_1/progress/mod_1`,
  },
  {
    name: "community.badges.list",
    call: (pw) => pw.community.badges.list(),
    method: "GET",
    url: `${API}/community/badges`,
  },
  {
    name: "community.badges.upsert",
    call: (pw) =>
      pw.community.badges.upsert({
        key: "first-post",
        name: "First post",
        color: "#ff8800",
      }),
    method: "POST",
    url: `${API}/community/badges`,
    body: { key: "first-post", name: "First post", color: "#ff8800" },
  },
  {
    name: "community.badges.update",
    call: (pw) => pw.community.badges.update("badge_1", { name: "Poster" }),
    method: "PATCH",
    url: `${API}/community/badges/badge_1`,
    body: { name: "Poster" },
  },
  {
    name: "community.badges.delete",
    call: (pw) => pw.community.badges.delete("badge_1"),
    method: "DELETE",
    url: `${API}/community/badges/badge_1`,
  },
  {
    name: "community.members.badges.award",
    call: (pw) => pw.community.members.badges.award("cm_1", "badge_1"),
    method: "PUT",
    url: `${API}/community/members/cm_1/badges/badge_1`,
  },
  {
    name: "community.members.badges.revoke",
    call: (pw) => pw.community.members.badges.revoke("cm_1", "badge_1"),
    method: "DELETE",
    url: `${API}/community/members/cm_1/badges/badge_1`,
  },
  {
    name: "community.notifications.send",
    call: (pw) =>
      pw.community.notifications.send({
        memberIds: ["cm_1", "cm_2"],
        body: "Your order #123 has shipped.",
        href: "/orders/123",
        key: "order-123-shipped",
      }),
    method: "POST",
    url: `${API}/community/notifications`,
    body: {
      memberIds: ["cm_1", "cm_2"],
      body: "Your order #123 has shipped.",
      href: "/orders/123",
      key: "order-123-shipped",
    },
  },
  {
    name: "events.list",
    call: (pw) => pw.events.list({ limit: 10 }),
    method: "GET",
    url: `${API}/events?limit=10`,
  },
  {
    name: "events.get",
    call: (pw) => pw.events.get("event_1"),
    method: "GET",
    url: `${API}/events/event_1`,
  },
  {
    name: "events.registrations.create",
    call: (pw) =>
      pw.events.registrations.create("event_1", { memberId: "cm_1" }),
    method: "POST",
    url: `${API}/events/event_1/registrations`,
    body: { memberId: "cm_1" },
  },
  {
    name: "events.registrations.cancel",
    call: (pw) =>
      pw.events.registrations.cancel("event_1", { memberId: "cm_1" }),
    method: "DELETE",
    url: `${API}/events/event_1/registrations?memberId=cm_1`,
  },
  {
    name: "events.attendance.set",
    call: (pw) =>
      pw.events.attendance.set("event_1", {
        memberId: "cm_1",
        attendance: "ATTENDED",
        joinedAt: "2026-11-05T18:00:00.000Z",
      }),
    method: "PUT",
    url: `${API}/events/event_1/attendance`,
    body: {
      memberId: "cm_1",
      attendance: "ATTENDED",
      joinedAt: "2026-11-05T18:00:00.000Z",
    },
  },
  {
    name: "forms.list",
    call: (pw) => pw.forms.list({ search: "intake" }),
    method: "GET",
    url: `${API}/forms?search=intake`,
  },
  {
    name: "forms.submissions.create",
    call: (pw) =>
      pw.forms.submissions.create("form_1", {
        memberId: "cm_1",
        fields: { goal: "Ship" },
      }),
    method: "POST",
    url: `${API}/forms/form_1/submissions`,
    body: { memberId: "cm_1", fields: { goal: "Ship" } },
  },
];

describe("createPlanewardClient endpoints", () => {
  for (const testCase of clientCases) {
    it(`${testCase.name} sends ${testCase.method} ${testCase.url.slice(API.length)}`, async () => {
      const { client, calls } = recordingClient();
      await testCase.call(client);
      assert.equal(calls.length, 1);
      const [call] = calls;
      assert.equal(call?.method, testCase.method);
      assert.equal(call?.url, testCase.url);
      assert.equal(call?.headers.Authorization, "Bearer pwa_secret");
      assert.equal(call?.headers["x-planeward-installation"], "inst_1");
      assert.equal(call?.headers.Accept, "application/json");
      if (testCase.body === undefined) {
        assert.equal(call?.body, undefined);
        assert.equal(call?.headers["Content-Type"], undefined);
      } else {
        assert.deepEqual(call?.body, testCase.body);
        assert.equal(call?.headers["Content-Type"], "application/json");
      }
    });
  }
});

describe("PlanewardApiError.missingScope", () => {
  const failing = (status: number, body: unknown) =>
    createPlanewardClient({
      secret: "pwa_secret",
      installationId: "inst_1",
      fetch: async () => Response.json(body, { status }),
    });

  it("reads missingScope from a 403", async () => {
    await assert.rejects(
      failing(403, {
        error: "Missing scope EVENTS_READ",
        missingScope: "EVENTS_READ",
      }).events.list(),
      (error) => {
        assert.ok(error instanceof PlanewardApiError);
        assert.equal(error.status, 403);
        assert.equal(error.message, "Missing scope EVENTS_READ");
        assert.equal(error.missingScope, "EVENTS_READ");
        return true;
      }
    );
  });

  it("leaves it undefined for other 403s and other statuses", async () => {
    await assert.rejects(
      failing(403, {
        error: "Community is disabled",
      }).community.channels.list(),
      (error) => {
        assert.ok(error instanceof PlanewardApiError);
        assert.equal(error.missingScope, undefined);
        return true;
      }
    );
    await assert.rejects(
      failing(404, {
        error: "Event not shown in community.",
        missingScope: "EVENTS_READ",
      }).events.get("event_1"),
      (error) => {
        assert.ok(error instanceof PlanewardApiError);
        assert.equal(error.status, 404);
        assert.equal(error.missingScope, undefined);
        return true;
      }
    );
  });

  for (const [status, message] of [
    [400, "Invalid JSON body."],
    [409, "Member has no primary contact."],
    [429, "Too many API requests. Try again shortly."],
  ] as const) {
    it(`keeps status and message on a ${status}`, async () => {
      await assert.rejects(
        failing(status, { error: message }).events.registrations.create(
          "event_1",
          { memberId: "cm_1" }
        ),
        (error) => {
          assert.ok(error instanceof PlanewardApiError);
          assert.equal(error.status, status);
          assert.equal(error.message, message);
          assert.equal(error.missingScope, undefined);
          return true;
        }
      );
    });
  }

  it("falls back to a generic message without an error body", async () => {
    const client = createPlanewardClient({
      secret: "pwa_secret",
      installationId: "inst_1",
      fetch: async () => new Response("rate limited", { status: 429 }),
    });
    await assert.rejects(client.events.list(), (error) => {
      assert.ok(error instanceof PlanewardApiError);
      assert.equal(error.status, 429);
      assert.equal(
        error.message,
        "Planeward API request failed with status 429."
      );
      return true;
    });
  });
});

describe("path segments", () => {
  const unsafe = [
    "",
    ".",
    "..",
    "%2e",
    "%2E%2e",
    "a/b",
    "a\\b",
    "%2F",
    "a%2fb",
    "%5C",
    "../badge_1",
  ];

  const segmentCalls: {
    name: string;
    call: (pw: PlanewardClient, value: string) => Promise<unknown>;
  }[] = [
    {
      name: "community.messages.list",
      call: (pw, v) => pw.community.messages.list(v),
    },
    {
      name: "community.messages.create",
      call: (pw, v) => pw.community.messages.create(v, { body: "hi" }),
    },
    {
      name: "community.members.get",
      call: (pw, v) => pw.community.members.get(v),
    },
    {
      name: "community.members.progress.list",
      call: (pw, v) => pw.community.members.progress.list(v),
    },
    {
      name: "community.members.progress.complete (member)",
      call: (pw, v) => pw.community.members.progress.complete(v, "mod_1"),
    },
    {
      name: "community.members.progress.uncomplete (module)",
      call: (pw, v) => pw.community.members.progress.uncomplete("cm_1", v),
    },
    {
      name: "community.members.badges.award (badge)",
      call: (pw, v) => pw.community.members.badges.award("cm_1", v),
    },
    {
      name: "community.members.badges.revoke (member)",
      call: (pw, v) => pw.community.members.badges.revoke(v, "badge_1"),
    },
    {
      name: "community.courses.get",
      call: (pw, v) => pw.community.courses.get(v),
    },
    {
      name: "community.badges.update",
      call: (pw, v) => pw.community.badges.update(v, { name: "x" }),
    },
    {
      name: "community.badges.delete",
      call: (pw, v) => pw.community.badges.delete(v),
    },
    { name: "events.get", call: (pw, v) => pw.events.get(v) },
    {
      name: "events.registrations.create",
      call: (pw, v) => pw.events.registrations.create(v, { memberId: "cm_1" }),
    },
    {
      name: "events.registrations.cancel",
      call: (pw, v) => pw.events.registrations.cancel(v, { memberId: "cm_1" }),
    },
    {
      name: "events.attendance.set",
      call: (pw, v) =>
        pw.events.attendance.set(v, {
          memberId: "cm_1",
          attendance: "ATTENDED",
        }),
    },
    {
      name: "forms.submissions.create",
      call: (pw, v) =>
        pw.forms.submissions.create(v, { memberId: "cm_1", fields: {} }),
    },
  ];

  for (const { name, call } of segmentCalls) {
    it(`${name} rejects unsafe ids before fetch`, async () => {
      const { client, calls } = recordingClient();
      for (const value of unsafe) {
        await assert.rejects(
          call(client, value),
          TypeError,
          `${name}(${JSON.stringify(value)})`
        );
      }
      assert.equal(calls.length, 0);
    });
  }

  it('blocks the revoke("..", badgeId) traversal to DELETE /community/badges/{id}', async () => {
    const { client, calls } = recordingClient();
    await assert.rejects(
      client.community.members.badges.revoke("..", "badge_1"),
      TypeError
    );
    assert.equal(calls.length, 0);
  });

  it("still encodes ordinary ids", async () => {
    const { client, calls } = recordingClient();
    await client.community.members.badges.revoke("cm 1", "badge?1");
    await client.events.get("evt_..1");
    await client.forms.submissions.create("100%", {
      memberId: "cm_1",
      fields: {},
    });
    assert.deepEqual(
      calls.map((call) => call.url),
      [
        `${API}/community/members/cm%201/badges/badge%3F1`,
        `${API}/events/evt_..1`,
        `${API}/forms/100%25/submissions`,
      ]
    );
  });
});
