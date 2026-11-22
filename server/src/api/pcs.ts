/**
 * Ahoy API — your PCs, and what is to be installed on them (pcs.ts). All of it is whoever asks' own.
 *
 *   PUT    /api/v1/me/pc                 { device, version?, freeBytes? }   the launcher's page on a PC: "this PC is here"
 *                                        → { pc, orders }: the PC as kept, and its orders
 *   GET    /api/v1/me/pcs                → { items }: your PCs, the one seen last first
 *   PUT    /api/v1/me/pcs/:device        { auto }   does that PC install what you ask for when it arrives
 *   DELETE /api/v1/me/pcs/:device        a PC you no longer have
 *   GET    /api/v1/me/orders[?device=]   → { items }: open orders, and those that ended lately
 *   POST   /api/v1/me/orders             { device, gameId }   install that game on that PC (when it is on and the game is there)
 *   PUT    /api/v1/me/orders/:id         { state, progress?, error? }   the PC carrying it out says how it goes
 *   DELETE /api/v1/me/orders/:id         cancel it
 *
 * A page in a launcher names its PC on every request (the header x-ahoy-pc, its name percent-encoded): that is how asking
 * for a game knows where it was asked from, and how an order knows it is its own PC reporting.
 */
import { Hono, type Context } from "hono";
import * as ludarr from "../ludarr";
import { PcError, cancelOrder, deviceName, forgetPc, ordersOf, pcsOf, placeOrder, registerPc, reportOrder, setAuto } from "../pcs";
import type { UserRow } from "../auth";
import type { Env } from "../server";

export const pcsApi = new Hono<Env>();
const me = (c: Context<Env>): UserRow => c.get("user");
const fail = (c: Context<Env>, e: unknown) => c.json({ error: String((e as Error)?.message ?? e) }, (e instanceof PcError ? e.status : 500) as 400);

/** the PC a request was sent from, as its page says (null: a browser, or a launcher from before PCs had names here) */
export function pcOfRequest(c: Context): string | null {
  const raw = c.req.header("x-ahoy-pc");
  if (!raw) return null;
  try { return deviceName(decodeURIComponent(raw)); } catch { return null; }
}
const paramDevice = (c: Context<Env>) => deviceName(c.req.param("device"));

pcsApi.put("/api/v1/me/pc", async c => {
  const b = await c.req.json().catch(() => ({})) as { device?: unknown; version?: unknown; freeBytes?: unknown };
  const device = deviceName(b.device);
  if (!device) return c.json({ error: "the PC's name is needed" }, 400);
  const pc = registerPc(me(c), device, { version: typeof b.version === "string" ? b.version : null, freeBytes: typeof b.freeBytes === "number" ? b.freeBytes : null });
  return c.json({ pc, orders: ordersOf(me(c).id, device) });
});
pcsApi.get("/api/v1/me/pcs", c => c.json({ items: pcsOf(me(c).id) }));
pcsApi.put("/api/v1/me/pcs/:device", async c => {
  const device = paramDevice(c);
  const b = await c.req.json().catch(() => ({})) as { auto?: unknown };
  if (!device || typeof b.auto !== "boolean") return c.json({ error: "auto is needed" }, 400);
  try { return c.json({ pc: setAuto(me(c).id, device, b.auto) }); } catch (e) { return fail(c, e); }
});
pcsApi.delete("/api/v1/me/pcs/:device", c => {
  const device = paramDevice(c);
  if (device) forgetPc(me(c).id, device);
  return c.json({ ok: true });
});

pcsApi.get("/api/v1/me/orders", c => c.json({ items: ordersOf(me(c).id, deviceName(c.req.query("device"))) }));
pcsApi.post("/api/v1/me/orders", async c => {
  const b = await c.req.json().catch(() => ({})) as { device?: unknown; gameId?: unknown };
  const device = deviceName(b.device), game = ludarr.libraryById().get(Number(b.gameId));
  if (!device) return c.json({ error: "the PC's name is needed" }, 400);
  if (!game) return c.json({ error: "that game is not on the server" }, 404);
  try { return c.json({ item: placeOrder(me(c), device, { id: game.id, name: game.name }, { origin: "asked", from: pcOfRequest(c) }) }, 201); } catch (e) { return fail(c, e); }
});
pcsApi.put("/api/v1/me/orders/:id", async c => {
  const b = await c.req.json().catch(() => ({})) as { state?: unknown; progress?: unknown; error?: unknown };
  try { return c.json({ item: reportOrder(me(c).id, Number(c.req.param("id")), pcOfRequest(c), b) }); } catch (e) { return fail(c, e); }
});
pcsApi.delete("/api/v1/me/orders/:id", c => c.json({ ok: cancelOrder(me(c).id, Number(c.req.param("id"))) }));
