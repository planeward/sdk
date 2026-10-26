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
  createPlanewardClient,
  parsePlanewardWebhook,
  PlanewardApiError,
  PlanewardTokenAudienceError,
  verifyPlanewardWebhook,
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
