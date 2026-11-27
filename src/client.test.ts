import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it, mock } from "node:test";

import {
  applyAppearance,
  createPlanewardAppForWindow,
  type PlanewardAppWindow,
} from "./client";
import { APP_MESSAGE, type AppAppearance, type AppContext } from "./protocol";

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
    await assert.rejects(app.ready, /Not running inside Planeward/);
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

  it("resends the hello until the first token arrives", async () => {
    mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
    try {
      const fake = createFakeWindow();
      const app = createPlanewardAppForWindow(fake.win);
      const hellos = () =>
        fake.posted.filter((p) => p.message.type === APP_MESSAGE.ready).length;
      mock.timers.tick(2_000);
      assert.equal(hellos(), 3);
      fake.dispatch(fake.tokenMessage("t1"));
      await app.ready;
      mock.timers.tick(5_000);
      assert.equal(hellos(), 3);
      app.destroy();
    } finally {
      mock.timers.reset();
    }
  });

  it("rejects ready after the timeout", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win, { timeoutMs: 20 });
    await assert.rejects(app.ready, /Not running inside Planeward/);
    app.destroy();
  });
});

/** An unsigned JWT with these claims; the client only decodes it. */
const jwtWith = (claims: Record<string, unknown>) =>
  [{ alg: "RS256", typ: "JWT" }, claims]
    .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
    .concat("sig")
    .join(".");

describe("can", () => {
  it("reads the current token's permissions claim", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win);
    assert.equal(app.can("posts.moderate"), false);
    fake.dispatch(
      fake.tokenMessage(jwtWith({ permissions: ["posts.moderate"] }))
    );
    await app.ready;
    assert.equal(app.can("posts.moderate"), true);
    assert.equal(app.can("posts.delete"), false);

    // A re-minted token replaces the grants; an opaque token grants nothing.
    fake.dispatch(fake.tokenMessage(jwtWith({ permissions: [] })));
    assert.equal(app.can("posts.moderate"), false);
    fake.dispatch(fake.tokenMessage("opaque"));
    assert.equal(app.can("posts.moderate"), false);
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

  describe("retries", () => {
    beforeEach(() => mock.timers.enable({ apis: ["setTimeout"] }));
    afterEach(() => mock.timers.reset());

    async function setup(timeoutMs?: number) {
      const fake = createFakeWindow();
      const app = createPlanewardAppForWindow(fake.win, { timeoutMs });
      fake.dispatch(fake.tokenMessage("old", null, Date.now()));
      await app.ready;
      const pending = app.getToken();
      await flush();
      const lastRequestId = () =>
        fake.posted.findLast((p) => p.message.type === APP_MESSAGE.tokenRequest)
          ?.message.requestId;
      const hostError = () =>
        fake.dispatch({
          type: APP_MESSAGE.error,
          requestId: lastRequestId(),
          message: "Session expired",
        });
      return { fake, app, pending, lastRequestId, hostError };
    }

    it("retries a host error and resolves with the next answer", async () => {
      const { fake, app, pending, lastRequestId, hostError } = await setup();
      const firstId = lastRequestId();
      hostError();
      mock.timers.tick(1_000);
      assert.notEqual(lastRequestId(), firstId);
      fake.dispatch(fake.tokenMessage("fresh", lastRequestId() as string));
      assert.equal(await pending, "fresh");
      app.destroy();
    });

    it("rejects after three host errors", async () => {
      const { app, pending, hostError } = await setup();
      hostError();
      mock.timers.tick(1_000);
      hostError();
      mock.timers.tick(1_000);
      hostError();
      await assert.rejects(pending, /Session expired/);
      app.destroy();
    });

    it("rejects after three attempts time out", async () => {
      const { fake, app, pending } = await setup(30);
      for (const ms of [30, 1_000, 30, 1_000, 30]) mock.timers.tick(ms);
      await assert.rejects(pending, /did not return a token/);
      const requests = fake.posted.filter(
        (p) => p.message.type === APP_MESSAGE.tokenRequest
      );
      assert.equal(requests.length, 3);
      app.destroy();
    });
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

describe("onThemeChange appearance", () => {
  const A: AppAppearance = { colors: { primary: "red" }, radius: "0.5rem" };
  const B: AppAppearance = { colors: { primary: "blue" } };

  it("emits when the theme or the appearance changes", async () => {
    const fake = createFakeWindow();
    const app = createPlanewardAppForWindow(fake.win);
    fake.dispatch(
      fake.tokenMessage("t1", null, undefined, { ...context, appearance: A })
    );
    assert.deepEqual((await app.ready).appearance, A);

    const emitted: unknown[] = [];
    app.onThemeChange((theme, appearance) => emitted.push([theme, appearance]));
    const dark = { ...context, theme: "dark" as const };
    const steps: { message: unknown; emits: unknown[] }[] = [
      {
        message: { type: APP_MESSAGE.theme, theme: "dark", appearance: A },
        emits: [["dark", A]],
      },
      // Same theme and appearance: nothing to emit.
      {
        message: { type: APP_MESSAGE.theme, theme: "dark", appearance: A },
        emits: [],
      },
      // Appearance change alone emits.
      {
        message: { type: APP_MESSAGE.theme, theme: "dark", appearance: B },
        emits: [["dark", B]],
      },
      {
        message: fake.tokenMessage("t2", null, undefined, {
          ...dark,
          appearance: B,
        }),
        emits: [],
      },
      // A host that stops sending an appearance clears it.
      {
        message: fake.tokenMessage("t3", null, undefined, dark),
        emits: [["dark", undefined]],
      },
      { message: { type: APP_MESSAGE.theme, theme: "dark" }, emits: [] },
    ];
    for (const { message, emits } of steps) {
      emitted.length = 0;
      fake.dispatch(message);
      assert.deepEqual(emitted, emits);
    }
    assert.deepEqual(app.context, dark);
    app.destroy();
  });
});

type FakeLink = {
  attributes: Map<string, string>;
  setAttribute: (name: string, value: string) => void;
  remove: () => void;
};

function createFakeRoot() {
  const properties = new Map<string, string>();
  const head: FakeLink[] = [];
  const ownerDocument = {
    head: { appendChild: (link: FakeLink) => head.push(link) },
    createElement(tag: string): FakeLink {
      assert.equal(tag, "link");
      const link: FakeLink = {
        attributes: new Map(),
        setAttribute: (name, value) => link.attributes.set(name, value),
        remove: () => {
          const index = head.indexOf(link);
          if (index >= 0) head.splice(index, 1);
        },
      };
      return link;
    },
  };
  const root = {
    style: {
      setProperty: (name: string, value: string) => properties.set(name, value),
      removeProperty: (name: string) => properties.delete(name),
    },
    ownerDocument,
  } as unknown as HTMLElement;
  const hrefs = () => head.map((link) => link.attributes.get("href"));
  return { root, properties, head, hrefs };
}

const FONT_A = "https://fonts.googleapis.com/css2?family=Inter";
const FONT_B = "https://fonts.googleapis.com/css2?family=Geist";

describe("applyAppearance", () => {
  it("sets variables and font links, and cleans up", () => {
    const fake = createFakeRoot();
    const cleanup = applyAppearance(
      {
        colors: { primary: "red", background: "#fff" },
        radius: "0.5rem",
        font: { family: "Inter", stylesheets: [FONT_A, FONT_A, FONT_B] },
      },
      fake.root
    );
    assert.deepEqual(Object.fromEntries(fake.properties), {
      "--background": "#fff",
      "--primary": "red",
      "--radius": "0.5rem",
      "--font-sans": "Inter",
    });
    assert.deepEqual(fake.hrefs(), [FONT_A, FONT_B]);
    assert.deepEqual(Object.fromEntries(fake.head[0]!.attributes), {
      rel: "stylesheet",
      href: FONT_A,
      "data-planeward-font": "",
    });

    cleanup();
    assert.equal(fake.properties.size, 0);
    assert.equal(fake.head.length, 0);
  });

  it("replaces the previous appearance and keeps shared links", () => {
    const fake = createFakeRoot();
    const first = applyAppearance(
      {
        colors: { primary: "red" },
        radius: "0.5rem",
        font: { family: "Inter", stylesheets: [FONT_A, FONT_B] },
      },
      fake.root
    );
    const linkA = fake.head[0];
    const second = applyAppearance(
      {
        colors: { background: "#000" },
        font: { family: "Geist", stylesheets: [FONT_A] },
      },
      fake.root
    );
    assert.deepEqual(Object.fromEntries(fake.properties), {
      "--background": "#000",
      "--font-sans": "Geist",
    });
    assert.deepEqual(fake.hrefs(), [FONT_A]);
    assert.equal(fake.head[0], linkA);

    // A replaced call's cleanup is a no-op.
    first();
    assert.equal(fake.properties.size, 2);
    applyAppearance(null, fake.root);
    assert.equal(fake.properties.size, 0);
    assert.equal(fake.head.length, 0);
    second();
  });

  it("sanitises a caller-supplied appearance", () => {
    const fake = createFakeRoot();
    applyAppearance(
      {
        colors: { primary: "red;color:blue", "--x": "y" } as never,
        font: { family: "Inter", stylesheets: ["https://evil.example/a.css"] },
      },
      fake.root
    );
    assert.deepEqual(Object.fromEntries(fake.properties), {
      "--font-sans": "Inter",
    });
    assert.equal(fake.head.length, 0);
  });
});
