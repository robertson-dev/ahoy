/**
 * What's new: what changed in Ahoy, said to its players once after an update (whatsnew-state.tsx shows it), in a sentence
 * each. A note is one update's news, the newest first; add one at the top with each change players would notice.
 *
 * An item with `needs` arrives with that launcher version: it is news only in a launcher that has it (a browser, where
 * nothing is installed or played, never lists it), and it is what the launcher's own update says it brings ("Ahoy 0.13.0
 * is downloaded": what's new in it). An item is news to someone only when it came after they joined, and until they have
 * seen it on that device.
 */
export interface NewsItem { id: string; text: string; needs?: string }
export interface News { id: string; date: string; items: NewsItem[] }

export const NEWS: News[] = [
  { id: "2026-11-23-handheld", date: "2026-11-23", items: [
    { id: "handheld", needs: "0.12.0", text: "On a handheld PC, Ahoy opens in Big screen at a larger size, and its controller works from the sign-in page on. Settings, This PC has both." },
    { id: "pad-moves", text: "In Big screen the controller shows where it is from the start and moves row by row. X does the highlighted game's own action." },
  ] },
  { id: "2026-11-17-art", date: "2026-11-17", items: [
    { id: "stable-card-colours", text: "Game cards keep their artwork colours as you browse the carousel." },
    { id: "art-replacements", text: "Updated game artwork appears right away, including when it is replaced again." },
  ] },
  { id: "2026-11-11", date: "2026-11-11", items: [
    { id: "install-on", text: "Install a game on another of your PCs from its page, from your phone or from the couch. It installs when that PC is on." },
    { id: "auto-install", text: "A game you ask for installs by itself when it arrives. Settings, Your PCs says which of your PCs do that." },
    { id: "saves", needs: "0.13.0", text: "Your saves follow you between your PCs, and the versions before are kept on your server. A game's page has them under Saves." },
    { id: "notify", needs: "0.13.0", text: "Windows tells you when a game is ready to play." },
    { id: "background", needs: "0.13.0", text: "Closing the window leaves Ahoy running by the clock, so installs carry on. It can also start with Windows (Settings, This PC)." },
    { id: "version", text: "A game that came out on several platforms asks which version you want when you request it: the arcade one, or a console's." },
    { id: "whats-new", text: "Ahoy says what changed after it updates. This list stays under your account's menu." },
    { id: "big-screen", text: "Big screen is the app itself now, sized for a television and driven by a controller." },
    { id: "pad-home", needs: "0.12.0", text: "A controller's home button can show Ahoy or open Big screen (Settings, This PC)." },
    { id: "blocks", needs: "0.11.0", text: "Installs are faster, and an update downloads only what changed." },
  ] },
];

/** a version as numbers, or null when it cannot be read */
const parts = (v: string | null | undefined) => { const m = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(String(v ?? "").trim()); return m ? [Number(m[1]), Number(m[2]), Number(m[3] ?? 0)] : null; };
/** is version a at least b? (a version that cannot be read is not) */
export function atLeast(a: string | null | undefined, b: string | null | undefined): boolean {
  const x = parts(a), y = parts(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! > y[i]!;
  return true;
}

export interface Where {
  /** this launcher's version; null in a plain browser */
  launcher: string | null;
  /** when whoever looks joined (seconds); null: not known (then nothing is older than them) */
  joinedAt: number | null;
}
const noteTime = (n: News) => Math.floor(new Date(`${n.date}T23:59:59`).getTime() / 1000);
/** does this item exist here: always when it needs no launcher, else in a launcher that has it */
export const here = (i: NewsItem, w: Pick<Where, "launcher">) => !i.needs || (w.launcher != null && atLeast(w.launcher, i.needs));

/** the notes as they read here: every item this place has, a note without any left out */
export function notesHere(news: readonly News[], w: Pick<Where, "launcher">): News[] {
  return news.map(n => ({ ...n, items: n.items.filter(i => here(i, w)) })).filter(n => n.items.length > 0);
}
/** what is news to this person on this device: here, from after they joined, and not seen yet */
export function unseen(news: readonly News[], w: Where, seen: ReadonlySet<string>): NewsItem[] {
  return notesHere(news, w).filter(n => w.joinedAt == null || noteTime(n) >= w.joinedAt).flatMap(n => n.items).filter(i => !seen.has(i.id));
}
/** what an update of the launcher to `to` brings that the one running (`from`) has not */
export function comesWith(news: readonly News[], from: string | null, to: string | null | undefined): NewsItem[] {
  if (!to) return [];
  return news.flatMap(n => n.items).filter(i => !!i.needs && atLeast(to, i.needs) && !(from != null && atLeast(from, i.needs)));
}
