/**
 * Addresses from outside, as links (bun test, in web/). A catalog's link to a way to play comes from other people's lists; in
 * the launcher a click on a link is handed to Windows. Only a web page's address is ever drawn as one (ui/words webLink), on a
 * game's page (WaysSection) as anywhere.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import "./harness";
import { createElement } from "react";
import type { Route } from "../src/api";

let words: typeof import("../src/ui/words");
let parts: typeof import("../src/screens/game-parts");
let renderToStaticMarkup: typeof import("react-dom/server").renderToStaticMarkup;
beforeAll(async () => {
  words = await import("../src/ui/words");
  parts = await import("../src/screens/game-parts");
  ({ renderToStaticMarkup } = await import("react-dom/server"));
});

/** what must never become something to click: files, shares, other programs' addresses, scripts, and what is no address at all */
const NOT_WEB = [
  "file:///C:/Windows/System32/calc.exe", "FILE://server/share/run.exe", "\\\\server\\share\\run.exe", "C:\\Windows\\notepad.exe",
  "ms-settings:privacy", "search-ms:query=x&crumb=location:%5C%5Cserver%5Cshare", "steam://run/1", "vbscript:msgbox(1)",
  "javascript:alert(1)", " JaVaScRiPt:alert(1)", "java\tscript:alert(1)", "data:text/html,<script>alert(1)</script>",
  "//evil.example/x", "evil.example/x", "/library", "", "   ",
];

describe("an address as a link", () => {
  test("a web page's is one, written as the browser reads it", () => {
    expect(words.webLink("https://github.com/xenia-canary/game-compatibility/issues/1")).toBe("https://github.com/xenia-canary/game-compatibility/issues/1");
    expect(words.webLink("http://192.168.1.2:7979")).toBe("http://192.168.1.2:7979/");
    expect(words.webLink("HTTPS://Example.org/a b")).toBe("https://example.org/a%20b");
  });
  test("nothing else is", () => {
    for (const u of NOT_WEB) expect(words.webLink(u)).toBeNull();
    expect(words.webLink(null)).toBeNull();
    expect(words.webLink(undefined)).toBeNull();
  });
});

describe("other ways to play", () => {
  const route = (id: number, link: string | null): Route => ({
    id, kind: "emulated", platform: "x360", provenance: "retail", label: `Way ${id}`, status: "playable", statusNote: null, statusAt: null,
    runtime: null, content: null, needs: [], features: [], launch: null, link, source: "compat", updatedAt: 1,
  });
  const draw = (routes: Route[]) => renderToStaticMarkup(createElement(parts.WaysSection, { routes }));
  const hrefs = (html: string) => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map(m => m[1]);

  test("Open is offered for a web page, and goes there", () => {
    const html = draw([route(1, "https://github.com/xenia-canary/game-compatibility/issues/1"), route(2, null)]);
    expect(hrefs(html)).toEqual(["https://github.com/xenia-canary/game-compatibility/issues/1"]);
    expect(html).toContain("Way 1"); expect(html).toContain("Way 2");
  });
  test("a way whose link is anything else is listed without one: nothing to click hands Windows a file, a share or a program", () => {
    const html = draw(NOT_WEB.map((u, i) => route(i + 1, u)));
    expect(hrefs(html)).toEqual([]);
    expect(html).not.toContain("<a ");
    for (let i = 1; i <= NOT_WEB.length; i++) expect(html).toContain(`Way ${i}<`);          // every way is still there
  });
});
