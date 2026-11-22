/**
 * Ahoy — a small per-address limiter for the doors that face the internet (sign-in, sign-up). In memory: a restart
 * forgets it, which is fine for what it guards against (guessing passwords, invite codes and the setup code).
 *
 * The address is the socket's. X-Forwarded-For is read only when the socket's other end is the reverse proxy (TRUSTED_PROXY;
 * left empty, any private or loopback address), and then it is the last entry, the one the proxy itself wrote: everything
 * before it is whatever the caller sent. An IPv6 visitor is known by its /64: that is what one connection is given, so
 * its 2^64 addresses are one visitor.
 *
 * A count that is running is never dropped to make room. The per-address counts are bounded: once that many are running,
 * an address that has none yet is told to wait until one runs out. The counts that are not one visitor's (an account's
 * wrong passwords, all guests' error reports together) are kept apart, as many as there are accounts.
 */
import type { Context, Next } from "hono";
import { getConnInfo } from "hono/bun";
import { cfg } from "./config";

type Bucket = { n: number; until: number };
/** the counts per visitor address */
const buckets = new Map<string, Bucket>();
/** the counts that are not per address (`held`): no flood of other tries starts one of these over */
const kept = new Map<string, Bucket>();
/** the most addresses remembered at once; past it an address not yet among them waits for one of their counts to run out */
export const bucketLimit = { max: 20_000 };
/** when the per-address counts were last found full: the moment the first of them runs out (nothing is looked through again before) */
let roomAt = 0;
/** tests run the app without a socket and sign up a lot; they switch this on only to test it */
export const limits = { enabled: process.env.NODE_ENV !== "test" };

const plain = (a: string) => a.trim().replace(/^\[|\]$/g, "").replace(/^::ffff:(?=\d+\.\d+\.\d+\.\d+$)/i, "").toLowerCase();
const looksLikeAddress = (a: string) => /^[0-9a-f:.]{2,45}$/i.test(a) && /[.:]/.test(a);
const v4 = (a: string): number | null => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(a);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.some(x => x > 255) ? null : ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
};
const inBlock = (a: string, block: string): boolean => {
  const [net, bits] = block.split("/");
  if (bits === undefined) return plain(net) === a;
  const x = v4(a), n = v4(plain(net)), b = Number(bits);
  if (x == null || n == null || !Number.isInteger(b) || b < 0 || b > 32) return false;
  const mask = b === 0 ? 0 : (0xffff_ffff << (32 - b)) >>> 0;
  return ((x & mask) >>> 0) === ((n & mask) >>> 0);
};
const PRIVATE = ["127.0.0.0/8", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "169.254.0.0/16", "100.64.0.0/10"];
const isPrivate = (a: string) => a === "::1" || /^f[cd][0-9a-f]{2}:/.test(a) || /^fe[89ab][0-9a-f]:/.test(a) || PRIVATE.some(b => inBlock(a, b));
/** the proxies the admin named (TRUSTED_PROXY: addresses or IPv4 blocks, comma separated) */
const named = () => cfg("TRUSTED_PROXY").split(/[\s,]+/).filter(Boolean);
/** is the other end of the socket the reverse proxy? */
function isProxy(a: string): boolean {
  const list = named();
  return list.length ? list.some(b => inBlock(a, b)) : isPrivate(a);
}

/**
 * The visitor an address counts as: an IPv4 address is itself, an IPv6 one is its /64 ("2001:db8:1:2::/64"). Addresses whose
 * first half is all zeros (::1, an IPv4 address written as IPv6) and anything that does not read as IPv6 stay as they are.
 */
export function visitor(a: string): string {
  if (!a.includes(":")) return a;
  const halves = a.split("%")[0]!.split("::");
  if (halves.length > 2) return a;
  const groups = (s: string) => (s ? s.split(":") : []);
  const head = groups(halves[0]!), tail = halves.length === 2 ? groups(halves[1]!) : null;
  // an IPv4 address in the last place takes two groups
  const width = (g: string[]) => g.length + (g.length && g[g.length - 1]!.includes(".") ? 1 : 0);
  const gap = 8 - width(head) - (tail ? width(tail) : 0);
  if (tail ? gap < 1 : gap !== 0) return a;
  const all = [...head, ...Array<string>(tail ? gap : 0).fill("0"), ...(tail ?? [])];
  const net = all.slice(0, 4);
  if (net.some(g => !/^[0-9a-f]{1,4}$/i.test(g))) return a;
  const tidy = net.map(g => parseInt(g, 16).toString(16));
  return tidy.every(g => g === "0") ? a : `${tidy.join(":")}::/64`;
}

/** who a request comes from, as the limits count them: the visitor (see `visitor`) behind the socket, or behind the proxy */
export function clientAddress(c: Context): string {
  let peer = "";
  try { peer = plain(getConnInfo(c).remote.address ?? ""); } catch { /* no socket: a test calling the app directly */ }
  if (!peer) return "local";
  if (!isProxy(peer)) return visitor(peer);
  // the proxy appends the address it saw; with more than one named proxy in a row, the last entry that is not one of them
  const list = named();
  const hops = (c.req.header("x-forwarded-for") ?? "").split(",").map(plain).filter(Boolean);
  for (let i = hops.length - 1; i >= 0; i--) {
    if (!looksLikeAddress(hops[i]!)) break;
    if (list.length && list.some(b => inBlock(hops[i]!, b))) continue;
    return visitor(hops[i]!);
  }
  return visitor(peer);
}

/** the running count under `key`, started when there is none; null when it is a per-address one and there is no room for another */
function bucket(key: string, windowMs: number, now: number, held: boolean): Bucket | null {
  const map = held ? kept : buckets;
  const b = map.get(key);
  if (b && b.until >= now) return b;
  if (!held && !b && buckets.size >= bucketLimit.max) {
    if (now < roomAt) return null;
    let first = Infinity;
    for (const [k, v] of buckets) { if (v.until < now) buckets.delete(k); else if (v.until < first) first = v.until; }
    if (buckets.size >= bucketLimit.max) { roomAt = first; return null; }
  }
  const fresh = { n: 0, until: now + windowMs };
  map.set(key, fresh);
  return fresh;
}
/**
 * One try against a budget of `max` per `windowMs` under `key`. It is counted now, before the work it guards (a hundred tries
 * sent at once are a hundred tries, not none); `refund` gives it back when it turns out not to count. `held`: the key is not
 * a visitor's address but one of a few the server itself names (an account, "all guests"): kept apart and never refused room.
 */
export function attempt(key: string, max: number, windowMs: number, held = false): { ok: boolean; retryAfter: number; refund: () => void } {
  const now = Date.now();
  const b = bucket(key, windowMs, now, held);
  if (!b) return { ok: false, retryAfter: Math.max(1, Math.ceil((roomAt - now) / 1000)), refund: () => {} };
  const retryAfter = Math.max(1, Math.ceil((b.until - now) / 1000));
  if (b.n >= max) return { ok: false, retryAfter, refund: () => {} };
  b.n++;
  let back = false;
  return { ok: true, retryAfter, refund: () => { if (!back) { back = true; b.n = Math.max(0, b.n - 1); } } };
}
export const tooMany = (c: Context, retryAfter: number) => {
  c.header("retry-after", String(retryAfter));
  return c.json({ error: `too many tries, wait ${Math.ceil(retryAfter / 60)} min` }, 429);
};

/** at most `max` counted events per `windowMs` per address; `count` decides after the response whether this one counts */
export function limiter(name: string, max: number, windowMs: number, count: (c: Context) => boolean = () => true) {
  return async (c: Context, next: Next) => {
    if (!limits.enabled) return next();
    const a = attempt(`${name}:${clientAddress(c)}`, max, windowMs);
    if (!a.ok) return tooMany(c, a.retryAfter);
    await next();
    if (!count(c)) a.refund();
  };
}
export const _test = { reset: () => { buckets.clear(); kept.clear(); roomAt = 0; }, size: () => buckets.size, held: () => kept.size };
