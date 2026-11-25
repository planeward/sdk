import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  can,
  definePermissions,
  PLANEWARD_PERMISSIONS_PATH,
  validatePermissionsResponse,
  type PlanewardPermissionEntry,
  type PlanewardPermissionKey,
} from "./permissions";

const entry = (
  overrides: Partial<Record<keyof PlanewardPermissionEntry, unknown>> = {}
) => ({
  key: "posts.moderate",
  name: "Moderate posts",
  default: "off",
  ...overrides,
});

describe("definePermissions", () => {
  it("returns its input and keeps literal keys", () => {
    const declared = {
      dashboard: [{ key: "reports.view", name: "View reports", default: "on" }],
      community: [{ key: "posts.create", name: "Create posts", default: "on" }],
    } as const;
    const permissions = definePermissions(declared);
    assert.equal(permissions, declared);
    const key: PlanewardPermissionKey<typeof permissions> = "posts.create";
    assert.equal(key, "posts.create");
    assert.equal(
      PLANEWARD_PERMISSIONS_PATH,
      "/.well-known/planeward-permissions"
    );
  });
});

describe("validatePermissionsResponse", () => {
  it("normalizes a valid response: missing lists become [], unknown fields drop", () => {
    assert.deepEqual(
      validatePermissionsResponse({
        community: [
          { ...entry(), description: "Hide and pin posts", extra: true },
          entry({ key: "billing.view_invoices_2", default: "on" }),
        ],
        version: 2,
      }),
      {
        ok: true,
        value: {
          dashboard: [],
          community: [
            {
              key: "posts.moderate",
              name: "Moderate posts",
              description: "Hide and pin posts",
              default: "off",
            },
            {
              key: "billing.view_invoices_2",
              name: "Moderate posts",
              default: "on",
            },
          ],
        },
      }
    );
    assert.deepEqual(validatePermissionsResponse({}), {
      ok: true,
      value: { dashboard: [], community: [] },
    });
  });

  const invalid: Array<[string, unknown, string]> = [
    ["a non-object root", [], "(root): must be a JSON object"],
    [
      "a list that isn't an array",
      { dashboard: {} },
      "dashboard: must be an array.",
    ],
    [
      "an entry that isn't an object",
      { community: ["x"] },
      "community[0]: must be an object.",
    ],
    [
      "a key without a dot",
      { community: [entry({ key: "moderate" })] },
      'community[0].key: "moderate" must be dotted',
    ],
    [
      "an uppercase key",
      { community: [entry({ key: "Posts.read" })] },
      "community[0].key:",
    ],
    [
      "a trailing dot",
      { community: [entry({ key: "posts." })] },
      "community[0].key:",
    ],
    [
      "a 65-character key",
      { community: [entry({ key: `a.${"b".repeat(63)}` })] },
      "community[0].key: must be at most 64 characters.",
    ],
    [
      "a missing key",
      { community: [entry({ key: undefined })] },
      "community[0].key: must be a string.",
    ],
    [
      "an empty name",
      { dashboard: [entry({ name: "  " })] },
      "dashboard[0].name: can't be empty.",
    ],
    [
      "a 61-character name",
      { dashboard: [entry({ name: "n".repeat(61) })] },
      "dashboard[0].name: must be at most 60 characters.",
    ],
    [
      "a 201-character description",
      { dashboard: [entry({ description: "d".repeat(201) })] },
      "dashboard[0].description: must be at most 200 characters.",
    ],
    [
      "a null description",
      { dashboard: [entry({ description: null })] },
      "dashboard[0].description: must be a string.",
    ],
    [
      "a bad default",
      { dashboard: [entry({ default: true })] },
      'dashboard[0].default: must be "on" or "off".',
    ],
    [
      "a duplicate key",
      { community: [entry(), entry()] },
      'community[1].key: "posts.moderate" is listed twice.',
    ],
    [
      "26 entries",
      {
        dashboard: Array.from({ length: 26 }, (_, i) =>
          entry({ key: `a.k${i}` })
        ),
      },
      "dashboard: at most 25 permissions (got 26).",
    ],
  ];
  for (const [name, json, message] of invalid) {
    it(`rejects ${name}`, () => {
      const result = validatePermissionsResponse(json);
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.ok(
        result.errors.some((error) => error.startsWith(message)),
        `expected "${message}" in ${JSON.stringify(result.errors)}`
      );
    });
  }

  it("accepts limits exactly", () => {
    const result = validatePermissionsResponse({
      dashboard: Array.from({ length: 25 }, (_, i) =>
        entry({
          key: `a.${String(i).padStart(62, "k")}`,
          name: "n".repeat(60),
          description: "d".repeat(200),
        })
      ),
      community: [entry()],
    });
    assert.equal(result.ok, true);
  });

  it("allows the same key in both lists and reports every problem", () => {
    assert.equal(
      validatePermissionsResponse({
        dashboard: [entry()],
        community: [entry()],
      }).ok,
      true
    );
    const result = validatePermissionsResponse({
      dashboard: [entry({ key: "x", name: "" })],
      community: "nope",
    });
    assert.deepEqual(result.ok ? [] : result.errors, [
      'dashboard[0].key: "x" must be dotted lowercase segments, like "posts.moderate".',
      "dashboard[0].name: can't be empty.",
      "community: must be an array.",
    ]);
  });
});

describe("can", () => {
  it("is true only for listed keys, and false without the claim", () => {
    const claims = { permissions: ["posts.moderate"] };
    assert.equal(can(claims, "posts.moderate"), true);
    assert.equal(can(claims, "posts.delete"), false);
    assert.equal(can({}, "posts.moderate"), false);
    assert.equal(can(null, "posts.moderate"), false);
  });
});
