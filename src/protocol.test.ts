import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { APP_MESSAGE, parseAppAppearance, parseHostMessage } from "./protocol";

const FONT_CSS = "https://fonts.googleapis.com/css2?family=Inter&display=swap";

describe("parseAppAppearance", () => {
  const cases: {
    name: string;
    input: unknown;
    expected: ReturnType<typeof parseAppAppearance>;
  }[] = [
    {
      name: "keeps good colours, radius and font",
      input: {
        colors: { primary: "oklch(0.6 0.2 250)", background: "#fff" },
        radius: "0.75rem",
        font: { family: '"Inter", sans-serif', stylesheets: [FONT_CSS] },
      },
      expected: {
        colors: { background: "#fff", primary: "oklch(0.6 0.2 250)" },
        radius: "0.75rem",
        font: { family: '"Inter", sans-serif', stylesheets: [FONT_CSS] },
      },
    },
    {
      name: "drops unknown keys and non-string values",
      input: {
        colors: { primary: "red", "--evil": "red", position: "fixed", ring: 3 },
      },
      expected: { colors: { primary: "red" } },
    },
    {
      name: "drops injection attempts",
      input: {
        colors: {
          primary: "red; background: blue",
          secondary: "red}body{display:none",
          accent: "url(https://evil.example/x.png)",
          muted: "URL(https://evil.example/x.png)",
          border: "expression(alert(1))",
          input: "</style><script>",
          ring: "u\\72l(https://evil.example)",
          card: "x".repeat(65),
          popover: "  ",
          foreground: "hsl(0 0% 9%)",
        },
        radius: "1rem;",
      },
      expected: { colors: { foreground: "hsl(0 0% 9%)" } },
    },
    {
      name: "keeps only Google Fonts stylesheets, at most four",
      input: {
        colors: {},
        font: {
          family: "Inter",
          stylesheets: [
            "https://evil.example/font.css",
            "http://fonts.googleapis.com/css2?family=Inter",
            "https://fonts.googleapis.com.evil.example/css",
            `${FONT_CSS}&${"a".repeat(500)}`,
            `${FONT_CSS}&1`,
            `${FONT_CSS}&2`,
            `${FONT_CSS}&3`,
            `${FONT_CSS}&4`,
            `${FONT_CSS}&5`,
          ],
        },
      },
      expected: {
        colors: {},
        font: {
          family: "Inter",
          stylesheets: [
            `${FONT_CSS}&1`,
            `${FONT_CSS}&2`,
            `${FONT_CSS}&3`,
            `${FONT_CSS}&4`,
          ],
        },
      },
    },
    {
      name: "drops a font with an unsafe family",
      input: {
        colors: { primary: "red" },
        font: { family: "Inter;}", stylesheets: [FONT_CSS] },
      },
      expected: { colors: { primary: "red" } },
    },
    { name: "absent", input: undefined, expected: undefined },
    { name: "not an object", input: "dark", expected: undefined },
    {
      name: "nothing usable left",
      input: { colors: { primary: "url(x)" }, radius: 4 },
      expected: undefined,
    },
  ];

  for (const { name, input, expected } of cases) {
    it(name, () => {
      assert.deepEqual(parseAppAppearance(input), expected);
    });
  }
});

describe("parseHostMessage appearance", () => {
  const context = { view: "experience", channelId: null, theme: "dark" };

  it("sanitises appearance on token and theme messages", () => {
    const appearance = { colors: { primary: "red", ring: "url(x)" } };
    const token = parseHostMessage({
      type: APP_MESSAGE.token,
      requestId: null,
      token: "t",
      expiresAt: 1,
      context: { ...context, appearance },
    });
    assert.deepEqual(token, {
      type: APP_MESSAGE.token,
      requestId: null,
      token: "t",
      expiresAt: 1,
      context: { ...context, appearance: { colors: { primary: "red" } } },
    });
    assert.deepEqual(
      parseHostMessage({ type: APP_MESSAGE.theme, theme: "light", appearance }),
      {
        type: APP_MESSAGE.theme,
        theme: "light",
        appearance: { colors: { primary: "red" } },
      }
    );
  });

  it("drops an invalid appearance without rejecting the message", () => {
    assert.deepEqual(
      parseHostMessage({
        type: APP_MESSAGE.theme,
        theme: "dark",
        appearance: "nope",
      }),
      { type: APP_MESSAGE.theme, theme: "dark" }
    );
    const token = parseHostMessage({
      type: APP_MESSAGE.token,
      requestId: null,
      token: "t",
      expiresAt: 1,
      context: { ...context, appearance: { colors: [] } },
    });
    assert.deepEqual(
      token?.type === APP_MESSAGE.token && token.context,
      context
    );
  });
});
