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

Failed requests throw `PlanewardApiError` with `status` and the API's `error` message. Calls are limited to the scopes the installer granted.

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

  const { event, data, installationId, workspaceId } =
    parsePlanewardWebhook(rawBody);
  // Dedupe retries on the x-planeward-delivery header.
  return new Response(null, { status: 204 });
}
```

`verifyPlanewardWebhook` is async because it uses Web Crypto, so it runs on Node 18+, edge runtimes and Workers. Verify against the raw body string before parsing it.

## Releasing

1. On `main`, run `pnpm release` (or `pnpm release patch|minor|major`). bumpp updates `package.json`, commits `chore(release): vX.Y.Z` and creates the tag `vX.Y.Z`.
2. Push the commit and tag: `git push --follow-tags`.

The `Release` workflow (`.github/workflows/release.yml`) runs on that tag in the `Release` environment. It checks that the tag matches `package.json`, builds, typechecks, tests, lints, publishes to npm with trusted publishing (OIDC, with provenance), creates a GitHub release and moves the `latest` tag to the released commit. No npm token is stored in the repo. To retry a failed release, re-run the workflow run.

To check a release locally: `pnpm build && pnpm test && pnpm pack --dry-run`.

## License

MIT
