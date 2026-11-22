/**
 * Big screen — hovering without a mouse. The app says a lot with :hover (a card's action appears, a row lights up, a
 * button brightens); a pad has no pointer, so what the pad's focus rests on is marked the way a pointer would hover it:
 * `data-hv` on the element and on everything it sits in. Every style rule that names :hover gets a twin that names
 * [data-hv] instead, put right behind it in its own sheet, so the two look the same and cascade the same.
 */

/** the twin of a selector that names :hover (null when it names none, or is a twin already) */
export function hoverTwin(selector: string): string | null {
  if (!selector.includes(":hover") || selector.includes("[data-hv]")) return null;
  return selector.replace(/:hover/g, "[data-hv]");
}
/** a media condition without its "has a pointer that hovers" part: the pad hovers whatever the device says */
export const withoutHoverQuery = (media: string): string => media.replace(/\(\s*(any-)?hover\s*:\s*hover\s*\)/g, "all");

const done = new WeakSet<CSSStyleSheet>();

function twinRules(list: CSSRuleList, owner: { insertRule(rule: string, index?: number): number }) {
  // from the end, so a twin put in behind its rule does not move what is still to be read
  for (let i = list.length - 1; i >= 0; i--) {
    const rule = list[i]!;
    if (rule instanceof CSSStyleRule) {
      const twin = hoverTwin(rule.selectorText);
      if (twin) { try { owner.insertRule(`${twin} { ${rule.style.cssText} }`, i + 1); } catch { /* a selector this browser cannot read back */ } }
    } else if ("cssRules" in rule && (rule as CSSGroupingRule).cssRules) {
      const group = rule as CSSGroupingRule;
      twinRules(group.cssRules, group);
      // rules that only apply where a pointer hovers apply to the pad too
      if (rule instanceof CSSMediaRule && /hover/.test(rule.media.mediaText)) { try { rule.media.mediaText = withoutHoverQuery(rule.media.mediaText); } catch { /* left as it is */ } }
    }
  }
}

/** give every sheet on the page its twins (once each; a sheet that arrives later gets them at the next call) */
export function twinHoverRules() {
  for (const sheet of Array.from(document.styleSheets)) {
    if (done.has(sheet)) continue;
    done.add(sheet);
    try { twinRules(sheet.cssRules, sheet); } catch { /* another origin's sheet: its rules cannot be read */ }
  }
}

let chain: HTMLElement[] = [];
/** mark `el` and what it sits in as hovered; whatever was marked before is not any more (null: nothing is) */
export function hoverOn(el: HTMLElement | null) {
  const next: HTMLElement[] = [];
  for (let p: HTMLElement | null = el; p && p !== document.documentElement; p = p.parentElement) next.push(p);
  for (const p of chain) if (!next.includes(p)) p.removeAttribute("data-hv");
  for (const p of next) if (!p.hasAttribute("data-hv")) p.setAttribute("data-hv", "");
  chain = next;
}
