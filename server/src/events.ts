/**
 * Ahoy — in-process event bus feeding the SSE stream (/api/v1/events). The engine's events arrive re-emitted
 * as "engine" (and refresh the library snapshot, hence "library"); the rest are Ahoy's own.
 *
 * Most events are for everyone signed in. One that is a person's own business (their PCs, what is to be installed on
 * them, their saves) is emitted `to` that person, and only their streams carry it.
 */
export type EventName = "library" | "engine" | "user" | "activity" | "presence" | "friend" | "install" | "pc" | "order" | "save";
export interface AhoyEvent { event: EventName; data: unknown; at: number; to?: number }
type Listener = (e: AhoyEvent) => void;

const listeners = new Set<Listener>();
const recent: AhoyEvent[] = [];
const KEEP = 200;

export const events = {
  /** `to`: the one person (their user id) the event is for; without it, everyone */
  emit(event: EventName, data: unknown, to?: number) {
    const e: AhoyEvent = { event, data, at: Date.now(), ...(to != null ? { to } : {}) };
    recent.push(e);
    if (recent.length > KEEP) recent.splice(0, recent.length - KEEP);
    for (const l of listeners) { try { l(e); } catch { /* a dead subscriber must not break the others */ } }
  },
  subscribe(l: Listener): () => void { listeners.add(l); return () => { listeners.delete(l); }; },
  listeners: () => listeners.size,
  recent: () => [...recent],
};
