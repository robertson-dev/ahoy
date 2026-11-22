/**
 * Big screen — the focus engine. One focused element at a time, moved spatially: the nearest focusable in the
 * direction pressed, the way a console does it. Anything with `data-f` can take focus; the topmost `[data-layer]`
 * decides which ones are in play; a `[data-row]` remembers the last thing focused inside it, so going up and back
 * down lands where you were.
 */
export type Dir = "up" | "down" | "left" | "right";
export type Cmd = Dir | "ok" | "back" | "prevTab" | "nextTab" | "search" | "downloads" | "friends" | "menu" | "leave";

const SEL = "[data-f]:not([disabled]):not([aria-hidden='true'])";

const visible = (el: HTMLElement) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };

export class Nav {
  current: HTMLElement | null = null;
  private lastRect: DOMRect | null = null;
  private stack: (HTMLElement | null)[] = [];
  onFocus: (el: HTMLElement | null) => void = () => {};

  /** the layer in play: the last [data-layer] in the document, or the whole document */
  layer(): HTMLElement | Document {
    const layers = document.querySelectorAll<HTMLElement>("[data-layer]");
    return layers.length ? layers[layers.length - 1] : document;
  }
  candidates(): HTMLElement[] {
    return [...this.layer().querySelectorAll<HTMLElement>(SEL)].filter(visible);
  }

  focus(el: HTMLElement | null, scroll: boolean | "x" | "y" = true) {
    if (this.current === el) return;
    this.current?.classList.remove("f");
    this.current = el;
    if (el) {
      el.classList.add("f");
      this.lastRect = el.getBoundingClientRect();
      const row = el.closest<HTMLElement>("[data-row]");
      if (row && el.dataset.f) row.dataset.last = el.dataset.f;
      if (scroll) el.scrollIntoView({ block: scroll === "x" ? "nearest" : el.closest("[data-scroll-nearest]") ? "nearest" : "center", inline: scroll === "y" ? "nearest" : "center", behavior: "smooth" });
    }
    this.onFocus(el);
  }

  /** a layer opened: remember what was focused underneath and start on the layer's own first thing */
  push() {
    this.stack.push(this.current);
    this.current?.classList.remove("f");
    this.current = null;
    this.first();
  }
  /** a layer closed: back to what was focused before it opened */
  pop() {
    const prev = this.stack.pop() ?? null;
    this.current?.classList.remove("f");
    this.current = null;
    if (prev && prev.isConnected && visible(prev)) this.focus(prev, false);
    else this.first();
  }
  /** start somewhere sensible: what asks for it, else the first thing inside `within` (the content, not the chrome), else anything */
  first(within?: string) {
    const c = this.candidates();
    const scope = within ? document.querySelector(within) : null;
    this.focus(c.find(e => e.dataset.autofocus != null) ?? (scope ? c.find(e => scope.contains(e)) : undefined) ?? c[0] ?? null, false);
  }
  /** the focused thing vanished (a list re-rendered): land on whatever is nearest to where it was */
  private recover() {
    const c = this.candidates();
    if (!c.length) { this.focus(null); return; }
    if (!this.lastRect) { this.focus(c[0]); return; }
    const cx = this.lastRect.left + this.lastRect.width / 2, cy = this.lastRect.top + this.lastRect.height / 2;
    let best = c[0], bd = Infinity;
    for (const e of c) { const r = e.getBoundingClientRect(); const d = Math.hypot(r.left + r.width / 2 - cx, r.top + r.height / 2 - cy); if (d < bd) { bd = d; best = e; } }
    this.focus(best);
  }

  move(dir: Dir) {
    const cur = this.current;
    if (!cur || !cur.isConnected || !visible(cur) || !this.layer().contains(cur)) { this.recover(); return; }
    const a = cur.getBoundingClientRect();
    const ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    // Left and Right keep to the line you are on: at its end they stop, instead of jumping to another row (or out of the top
    // strip into the content). A [data-nav-free] block (the search keyboard, beside its results) may still jump across.
    const free = !!cur.closest("[data-nav-free]");
    let best: HTMLElement | null = null, bs = Infinity;
    for (const el of this.candidates()) {
      if (el === cur) continue;
      const b = el.getBoundingClientRect();
      const bx = b.left + b.width / 2, by = b.top + b.height / 2;
      let primary: number, secondary: number, overlap: boolean;
      if (dir === "left" || dir === "right") {
        if (dir === "right" ? bx <= ax + a.width * 0.2 : bx >= ax - a.width * 0.2) continue;
        primary = dir === "right" ? Math.max(0, b.left - a.right) : Math.max(0, a.left - b.right);
        secondary = Math.abs(by - ay);
        overlap = b.top < a.bottom && b.bottom > a.top;
        if (!overlap && !free) continue;
      } else {
        if (dir === "down" ? by <= ay + a.height * 0.2 : by >= ay - a.height * 0.2) continue;
        primary = dir === "down" ? Math.max(0, b.top - a.bottom) : Math.max(0, a.top - b.bottom);
        secondary = Math.abs(bx - ax);
        overlap = b.left < a.right && b.right > a.left;
      }
      // things that line up with us win; among those, the closest. Things off to the side cost extra.
      const score = primary + (overlap ? secondary * 0.3 : secondary * 2.5 + 400);
      if (score < bs) { bs = score; best = el; }
    }
    if (!best) return;
    // moving between rows: a row remembers where you were in it
    if (dir === "up" || dir === "down") {
      const row = best.closest<HTMLElement>("[data-row]");
      if (row && row !== cur.closest("[data-row]") && row.dataset.last) {
        const remembered = [...row.querySelectorAll<HTMLElement>(SEL)].find(e => e.dataset.f === row.dataset.last && visible(e));
        if (remembered) best = remembered;
      }
    }
    this.focus(best, dir === "left" || dir === "right" ? "x" : "y");
  }
}

/* ─────────── input: keys and the pad, as one stream of commands ─────────── */

const KEYS: Record<string, Cmd> = {
  ArrowUp: "up", ArrowDown: "down", ArrowLeft: "left", ArrowRight: "right",
  Enter: "ok", Escape: "back", Backspace: "back", PageUp: "prevTab", PageDown: "nextTab", "/": "search", F11: "leave",
};
const PAD: Record<number, Cmd> = { 0: "ok", 1: "back", 2: "downloads", 3: "search", 4: "prevTab", 5: "nextTab", 8: "friends", 9: "menu", 12: "up", 13: "down", 14: "left", 15: "right" };

/**
 * Keys go through `onKey` first (a search box wants the letters); what it does not take becomes a command.
 * The pad is polled; directions repeat while held.
 */
export function listenInput(onCmd: (c: Cmd) => void, onKey: (e: KeyboardEvent) => boolean, onPadSeen: () => void) {
  const key = (e: KeyboardEvent) => {
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (onKey(e)) { e.preventDefault(); return; }
    const c = KEYS[e.key];
    if (!c) return;
    e.preventDefault(); onCmd(c);
  };
  addEventListener("keydown", key);
  let raf = 0;
  const held: Partial<Record<Cmd, number>> = {};
  // the pad is ours only while the window is: a visible window behind a game is still told its buttons. What is already down
  // when listening starts, or when the window comes back, was pressed for something else: it counts once let go and pressed again
  let ours = false;
  const tick = () => {
    const mine = !document.hidden && document.hasFocus();
    const pads = mine && navigator.getGamepads ? navigator.getGamepads() : [];
    const now = performance.now();
    const down = new Set<Cmd>();
    for (const p of pads) {
      if (!p) continue;
      onPadSeen();
      p.buttons.forEach((b, i) => { if (b.pressed && PAD[i]) down.add(PAD[i]); });
      const [x, y] = p.axes;
      if (x < -0.55) down.add("left"); else if (x > 0.55) down.add("right");
      if (y < -0.55) down.add("up"); else if (y > 0.55) down.add("down");
    }
    for (const c of Object.keys(held) as Cmd[]) if (!down.has(c)) delete held[c];
    for (const c of down) {
      const dir = c === "up" || c === "down" || c === "left" || c === "right";
      if (held[c] == null) { held[c] = ours ? now + 360 : Infinity; if (ours) onCmd(c); }
      else if (dir && now >= held[c]!) { held[c] = now + 100; onCmd(c); }
    }
    ours = mine;
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  return () => { removeEventListener("keydown", key); cancelAnimationFrame(raf); };
}
