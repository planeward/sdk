import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createPlanewardAppForWindow, type PlanewardAppWindow } from "./client";
import { APP_MESSAGE, type AppContext } from "./protocol";

const HOST = "https://acme.planeward.site";
const context: AppContext = {
  view: "experience",
  channelId: "chan_1",
  theme: "light",
};

type Posted = { message: Record<string, unknown>; targetOrigin: string };

function createFakeWindow() {
  const posted: Posted[] = [];
  const listeners = new Set<(event: MessageEvent) => void>();
  const parent = {
    postMessage(message: unknown, targetOrigin: string) {
      posted.push({
        message: message as Record<string, unknown>,
        targetOrigin,
      });
    },
  };
  const win: PlanewardAppWindow = {
    parent,
    addEventListener: (_type, listener) => listeners.add(listener),
    removeEventListener: (_type, listener) => listeners.delete(listener),
  };
  const dispatch = (data: unknown, origin = HOST, source: unknown = parent) => {
    const event = { data, origin, source } as unknown as MessageEvent;
    for (const listener of listeners) listener(event);
  };
  const tokenMessage = (
    token: string,
    requestId: string | null = null,
    expiresAt = Date.now() + 300_000,
    ctx: AppContext = context
  ) => ({
    type: APP_MESSAGE.token,
    requestId,
    token,
    expiresAt,
    context: ctx,
  });
  return { win, posted, listeners, dispatch, tokenMessage };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("createPlanewardApp handshake", () => {
  it("posts ready to * and resolves with the first token's context", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win);
    assert.deepEqual(fake.posted[0], {
      message: { type: APP_MESSAGE.ready, version: 1 },
      targetOrigin: "*",
    });
    assert.equal(app.context, null);
    fake.dispatch(fake.tokenMessage("t1"));
    assert.deepEqual(await app.ready, context);
    assert.equal(await app.getToken(), "t1");
    app.destroy();
  });

  it("posts ready to the first allowed origin", () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win, {
      allowedHostOrigins: [HOST, "https://other.example"],
    });
    assert.equal(fake.posted[0]?.targetOrigin, HOST);
    app.destroy();
  });

  it("ignores messages from other sources and disallowed origins", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win, {
      allowedHostOrigins: [HOST],
      timeoutMs: 50,
    });
    fake.dispatch(fake.tokenMessage("evil"), HOST, {});
    fake.dispatch(fake.tokenMessage("evil"), "https://evil.example");
    await assert.rejects(app.ready, /Not running inside a Planeward community/);
    app.destroy();
  });

  it("pins to the first token origin and ignores others afterwards", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win);
    // Theme before any token does not pin.
    fake.dispatch({ type: APP_MESSAGE.theme, theme: "dark" }, "https://x.io");
    fake.dispatch(fake.tokenMessage("t1"));
    await app.ready;

    const themes: string[] = [];
    app.onThemeChange((theme) => themes.push(theme));
    fake.dispatch({ type: APP_MESSAGE.theme, theme: "dark" }, "https://x.io");
    assert.equal(app.context?.theme, "light");
    fake.dispatch({ type: APP_MESSAGE.theme, theme: "dark" });
    assert.equal(app.context?.theme, "dark");
    assert.deepEqual(themes, ["dark"]);
    app.destroy();
  });

  it("ignores malformed payloads", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win, { timeoutMs: 50 });
    fake.dispatch({ type: APP_MESSAGE.token, token: "t" });
    fake.dispatch("planeward:app:token");
    fake.dispatch(null);
    await assert.rejects(app.ready);
    app.destroy();
  });

  it("rejects ready after the timeout", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win, { timeoutMs: 20 });
    await assert.rejects(app.ready, /Not running inside a Planeward community/);
    app.destroy();
  });
});

describe("getToken", () => {
  it("dedupes concurrent refreshes and posts to the pinned origin", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win);
    fake.dispatch(fake.tokenMessage("old", null, Date.now() + 10_000));
    await app.ready;

    const first = app.getToken();
    const second = app.getToken();
    await flush();
    const requests = fake.posted.filter(
      (p) => p.message.type === APP_MESSAGE.tokenRequest
    );
    assert.equal(requests.length, 1);
    assert.equal(requests[0]?.targetOrigin, HOST);
    const requestId = requests[0]?.message.requestId as string;
    assert.equal(typeof requestId, "string");

    // A reply with another requestId does not settle the request.
    fake.dispatch(fake.tokenMessage("other", "nope"));
    fake.dispatch(fake.tokenMessage("fresh", requestId));
    assert.equal(await first, "fresh");
    assert.equal(await second, "fresh");
    assert.equal(await app.getToken(), "fresh");
    app.destroy();
  });

  it("rejects on a matching host error", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win);
    fake.dispatch(fake.tokenMessage("old", null, Date.now()));
    await app.ready;

    const pending = app.getToken();
    await flush();
    const request = fake.posted.find(
      (p) => p.message.type === APP_MESSAGE.tokenRequest
    );
    fake.dispatch({
      type: APP_MESSAGE.error,
      requestId: request?.message.requestId,
      message: "Session expired",
    });
    await assert.rejects(pending, /Session expired/);
    app.destroy();
  });

  it("rejects when the host does not answer in time", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win, { timeoutMs: 30 });
    fake.dispatch(fake.tokenMessage("old", null, Date.now()));
    await app.ready;
    await assert.rejects(app.getToken(), /did not return a token/);
    app.destroy();
  });

  it("destroy removes the listener and rejects pending requests", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win);
    fake.dispatch(fake.tokenMessage("old", null, Date.now()));
    await app.ready;
    const pending = app.getToken();
    await flush();
    app.destroy();
    await assert.rejects(pending, /destroyed/);
    assert.equal(fake.listeners.size, 0);
    await assert.rejects(app.getToken(), /destroyed/);
  });
});
