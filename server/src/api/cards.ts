/**
 * Ahoy API — the generated Home cards (contracts/cards.md). The pictures are served without a session like a game's other
 * art; the JSON names the game, so it is for members, and for anyone only for the front page's five games (who.ts):
 *
 *   GET /api/v1/art/game/:id/card               the card as JSON: colours, text ink, the art and its placement on
 *                                               the free card and in each fan slot, the labels, status ready|pending,
 *                                               the game's box art; ?text=1 (a client that draws box art) adds the
 *                                               poster's lettering to it; ?style=cover|fade asks for the card with the
 *                                               poster where the cut-out stood, whatever the server's CARD_STYLE
 *   GET /api/v1/art/game/:id/card/cutout.png    the cut-out subject (PNG with alpha) of a "cut" card; a client that takes WebP
 *                                               (every browser and the launcher say so in Accept) gets the same picture as WebP,
 *                                               a fifth to a tenth of the bytes, its alpha exact
 *   GET /api/v1/art/game/:id/card/art           the source art of a "dissolve" card (the exact file it was made from)
 *
 * The JSON is revalidated (ETag, no-cache); the images are immutable under their ?v=<key>.
 */
import { Hono } from "hono";
import { cardImage, getCard } from "../cards";
import { webpCopy } from "../art";
import { ensureModel } from "../cards/model";
import { sha1 } from "../cards/store";
import { plainId } from "../ids";
import { maySeeGame } from "../who";

export const cardsApi = new Hono();

const notModified = (inm: string | undefined, etag: string) => !!inm && inm.split(",").some(t => t.trim().replace(/^W\//, "") === etag);

cardsApi.get("/api/v1/art/game/:id/card", async c => {
  const id = plainId(c.req.param("id"));
  if (!id) return c.json({ error: "no such game" }, 404);
  // the card carries the game's title: for members, and for anyone when it is one of the front page's five (the doors draw those)
  if (!maySeeGame(c, id)) return c.json({ error: "sign in first" }, 401);
  const style = c.req.query("style");
  const card = await getCard(id, { text: c.req.query("text") === "1", style: style === "cover" || style === "fade" ? style : null });
  if (!card) return c.json({ error: "no such game" }, 404);
  const body = JSON.stringify(card), etag = `"${sha1(body).slice(0, 27)}"`;
  const headers: Record<string, string> = { "content-type": "application/json; charset=utf-8", "cache-control": "no-cache", etag };
  if (card.status === "pending" && card.retryAfter) headers["retry-after"] = String(card.retryAfter);
  if (notModified(c.req.header("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(body, { headers });
});

const image = (kind: "cutout" | "art") => async (c: any) => {
  const id = plainId(c.req.param("id"));
  const img = id ? await cardImage(id, kind) : null;
  if (!img || !(await Bun.file(img.path).exists())) return c.json({ error: "no such image" }, 404);
  const webp = kind === "cutout" && /image\/webp/i.test(c.req.header("accept") ?? "");
  const out = webp ? await webpCopy(img) : img;
  const etag = `"${img.key}${out.type === "image/webp" && img.type !== "image/webp" ? "-webp" : ""}"`, current = c.req.query("v") === img.key;
  const headers: Record<string, string> = { "content-type": out.type, etag, "cache-control": current ? "public, max-age=31536000, immutable" : "public, max-age=60" };
  if (kind === "cutout") headers.vary = "Accept";
  if (notModified(c.req.header("if-none-match"), etag)) return new Response(null, { status: 304, headers });
  return new Response(Bun.file(out.path), { headers });
};
cardsApi.get("/api/v1/art/game/:id/card/cutout.png", image("cutout"));
cardsApi.get("/api/v1/art/game/:id/card/art", image("art"));

// the model is fetched in the background once the server is up (not under AHOY_WORKERS=0: tests and tools)
if (process.env.AHOY_WORKERS !== "0") { const t = setTimeout(() => ensureModel(), 15_000); (t as { unref?: () => void }).unref?.(); }
