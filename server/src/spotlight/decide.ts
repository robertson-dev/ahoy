/**
 * Spotlight — one game's stage, decided (the generator's spotlight(), M/spot/gen/main.js, without its browser): place the art,
 * pan it so its subject stands beside the text, find the weakest scrim at which every text reads, and choose the identity (the
 * logo as it is, the logo recoloured, or the title). The order of decisions is the generator's:
 *   1. a cut-out logo is laid out provisionally (its 6%-opaque box, first 50%-opaque column on the content edge); that layout
 *      sets the pan and the text's strength;
 *   2. the logo's crop is measured against that backdrop, and the strength is raised from the text's up to 1 until its ink and
 *      faces read; a one-colour logo that never reads is recoloured #f2f2f2 and tried again;
 *   3. otherwise (no logo, an opaque picture, or a logo that never reads) the title is laid out, and the pan and the strength are
 *      found again for it.
 *
 * The strength the text needs is found run by run (rule.ts runThreshold): the strength several runs need together is the largest
 * of theirs. Two modes:
 *   board  the generator's flow, with the board's own facts line (stage.factsWidth) and primary action;
 *   page   what the endpoint serves. The facts line is the viewer's (play time, progress), so its need is measured column by column
 *          and the answer comes back per width (steps): for each facts width, the strength the generator's flow would end on —
 *          what the text needs, then raised until the logo reads (a logo's readable strengths need not be one range: dark ink can
 *          read over bright art at a weak scrim, fail in between and read again over a dark one). The logo itself, its crop and the
 *          pan are decided once, for a facts line of stage.factsWidth. The presence chips always count, so the answer holds on
 *          every page.
 * Pure: pixels in, numbers out. The worker decodes the files and caches the subject map.
 */
import * as P from "./pixels";
import type { Rgba } from "./pixels";
import { RULE, anchor, artLayer, artLayerP3, fitCrop, geometryFor, logoCrop, logoEdge, logoFaces, logoFacts, logoPixels, logoShare, makeBackdrop, placement, round2, runContrast,
  runThreshold, strengthOf, subjectMap, type Anchor, type ArtLayer, type Backdrop, type Fit, type Geometry, type Placement, type Run, type Subject, type SubjectMap, type TextArea } from "./rule";
import { NOMINAL_STAGE, boardRuns, fitTitle, stageRuns, titleLayout, type StageText, type TitleFit } from "./layout";

export interface DecideInput {
  hero: Rgba;
  /** the art is a Steam library hero (used whole); anything else is used above its bottom 10% */
  fromSteam: boolean;
  logo: Rgba | null;
  name: string;
  geo: Geometry;
  stage?: StageText;
  mode?: "board" | "page";
  /** the subject map of this art, when it is already known (it depends on the art only) */
  map?: SubjectMap;
}
export type Identity = { kind: "logo"; fit: Fit; recolour: boolean } | { kind: "title"; title: TitleFit };
export interface Check { who: string; text: string; need: number; cr: number; reportOnly: boolean }
export interface Decision {
  placement: Placement; ox: number; oy: number; anchor: Anchor; text: TextArea;
  /** the strength (board mode: the generator's; page mode: with a facts line of stage.factsWidth) and the top scrim's */
  k: number; topK: number;
  /** what each group of text needs on its own (strengths; facts: board mode only) and where the logo first read */
  parts: { bar: number; chips: number; stage: number; facts: number | null; logo: number | null };
  /** page mode: [w, k] rising; the strength for a facts line w px wide is the k of the last step whose w is below it (the first
   *  step, [0, k], also holds for no facts line at all) */
  steps: [number, number][];
  identity: Identity;
  why: string[]; checks: Check[];
  logo: { share: number; p50: number; faces: number; weakest: number | null } | null;
  map: SubjectMap; ms: number;
}

interface Pos { an: Anchor; text: TextArea; layer: ArtLayer; layerP3: ArtLayer }
const group = (r: Run) => (r.who.startsWith("presence:") ? "chips" : r.who === "stage:facts" ? "facts" : r.who.startsWith("stage:") ? "stage" : "bar");
const NEVER = Math.round(1 / RULE.strengthStep) + 1;

export function decide(input: DecideInput): Decision {
  const t0 = performance.now();
  const { hero, fromSteam, logo, name, geo } = input;
  const mode = input.mode ?? "page", stage = input.stage ?? NOMINAL_STAGE;
  const pl = placement(hero, fromSteam, geo);
  const map = input.map ?? subjectMap(pl.winH === hero.h ? hero : P.cropRows(hero, 0, pl.winH));
  const st0 = stageRuns(geo, stage);
  const fixed = boardRuns(geo), stageBase = st0.runs.filter(r => mode === "board" || r.who !== "stage:facts");
  const why: string[] = [];

  // the board's stage (1440 wide on the 148 bar, margin 48) chooses the subject; every other stage keeps it where the board has it
  // (rule.ts anchor): the same text block laid out on the board's stage gives the subject the board shows and its place in the room
  const B = RULE.board, board = geo.W === B.w && geo.bar === B.bar && geo.left === B.left ? null : geometryFor(B.w, B.bar, B.left);
  const boardPl = board ? placement(hero, fromSteam, board) : null;
  const keepOf = (text: TextArea): Subject | null =>
    board && boardPl ? anchor(map, boardPl, { right: text.right - geo.left + board.left, top: text.top - geo.dy + board.dy }, board).subject : null;
  // the pan follows the stage's real text: its right edge (+24) and the identity's top (-24)
  const place = (identityTop: number, identityRight: number): Pos => {
    const text = { right: Math.max(st0.right, identityRight) + RULE.anchor.textGap, top: identityTop - RULE.anchor.textGap };
    const an = anchor(map, pl, text, geo, keepOf(text));
    const layer = artLayer(hero, pl, an.ox, an.oy);
    return { an, text, layer, layerP3: artLayerP3(layer) };
  };
  // the facts line at its widest (page mode measures it column by column)
  const factsWide = stageRuns(geo, { ...stage, factsWidth: RULE.id.width }).runs.find(x => x.who === "stage:facts")!;
  // the strength every group needs at the first top-scrim strength where everything can read; page mode also gives the facts
  // line's need per width, and counts the nominal facts line
  const strengths = (runs: Run[], pos: Pos) => {
    for (const topK of RULE.topStrengths) {
      const cx = { layer: pos.layer, layerP3: pos.layerP3, pl, topK };
      const need = { bar: 0, chips: 0, stage: 0, facts: 0 };
      let ok = true;
      for (const r of runs) {
        if (r.reportOnly) continue;
        const g = group(r), n = runThreshold(r, cx);
        if (n >= NEVER) { ok = false; break; }
        need[g] = Math.max(need[g], n);
      }
      if (!ok) continue;
      const fixedNeed = Math.max(need.bar, need.chips, need.stage);
      // page mode: [w, index]: a facts line wider than w needs at least index (the running maximum over its columns)
      const facts: [number, number][] = [];
      if (mode === "page") {
        const cols = new Map<number, number>();
        runThreshold(factsWide, cx, cols);
        let run = -1;
        for (const i of [...cols.keys()].sort((a, b) => a - b)) {
          const n = Math.min(cols.get(i)!, NEVER - 1);
          if (n > run) { run = n; facts.push([round2(i / RULE.dpr - geo.left), n]); }
        }
      }
      const factsAt = (w: number) => facts.reduce((m, [x, n]) => (w > x ? Math.max(m, n) : m), 0);
      const counted = mode === "board" ? Math.max(fixedNeed, need.facts) : Math.max(fixedNeed, factsAt(stage.factsWidth));
      return { k: strengthOf(counted), topK, need, fixedNeed, facts };
    }
    throw new Error(`${name}: no scrim strength reaches the targets`);
  };

  const lf = logo ? logoFacts(logo) : null;
  let runs: Run[] = [...fixed, ...stageBase];
  let pos: Pos | null = null, st: ReturnType<typeof strengths> | null = null, identity: Identity | null = null, logoReport: Decision["logo"] = null, logoK: number | null = null;
  let logoFrom: ((k0: number) => { k: number } | null) | null = null;
  if (!lf) why.push(logo ? "logo has no ink" : "no logo file");
  else if (lf.opaque) why.push(`logo is ${(lf.coverage * 100).toFixed(1)}% opaque inside its visible box (>= ${RULE.logo.opaque * 100}%): a picture, not a cut-out`);
  else {
    // provisional layout: the 6%-opaque box with its first 50%-opaque column on the content edge (sets the pan and the text's strength)
    const f0 = fitCrop(lf.visibleBox, lf.inkBox.x, geo);
    pos = place(f0.top, geo.left + f0.inkW);
    st = strengths(runs, pos);
    const p = pos, s = st;
    const ends: Backdrop[] = [makeBackdrop(p.layer, pl, s.k, s.topK), makeBackdrop(p.layer, pl, 1, s.topK)];
    // the smallest strength (from the text's own, up to 1) at which the logo's faces and ink share hold; at that strength the ink
    // edge is the first column where the logo stands out from the backdrop (24 levels or 1.5:1), so nothing that stands out hangs
    const tryLogo = (rc: boolean) => {
      const c0 = logoCrop(logo!, ends, rc, geo);
      const check = (k: number) => {
        const bd = makeBackdrop(p.layer, pl, k, s.topK, p.layerP3), edge = logoEdge(logo!, c0, bd, rc);
        const f = edge.loud < c0.inkX ? fitCrop(c0.box, edge.loud, geo) : c0;
        const lp = logoPixels(logo!, f, bd, rc), sh = logoShare(lp), fc = logoFaces(logo!, f, lp, rc);
        return { fit: f, k, sh, fc, pass: sh.share >= RULE.logo.share && fc.pass };
      };
      const memo = new Map<number, ReturnType<typeof check>>();
      const at = (k: number) => { let c = memo.get(k); if (!c) { c = check(k); memo.set(k, c); } return c; };
      // the generator's search: from a strength up to 1, the first where the logo reads
      const from = (k0: number) => {
        for (let i = 0; ; i++) {
          const k = Math.round((k0 + i * RULE.strengthStep) * 1000) / 1000; if (k > 1 + 1e-9) return null;
          const c = at(k);
          if (c.pass) return c;
        }
      };
      const got = from(s.k);
      if (!got || got.k > s.k) { const c = at(s.k); why.push(`${rc ? "recoloured logo" : "logo"} at the text's strength ${s.k}: ink share at 3:1 ${(c.sh.share * 100).toFixed(1)}%, weakest face ${c.fc.worst ? c.fc.worst.q.toFixed(2) + ":1 (" + c.fc.faces.length + " faces)" : "none"}`); }
      return got ? { ...got, from } : null;
    };
    let got = tryLogo(false), recolour = false;
    if (!got && lf.mono) { why.push(`one colour (ink luminance spread ${lf.spread.toFixed(3)}): recoloured #f2f2f2`); got = tryLogo(true); if (got) recolour = true; }
    if (got) {
      logoFrom = got.from;
      if (got.k > s.k) why.push(`logo needed scrim strength ${got.k} (the text alone needed ${s.k})`);
      logoK = got.k;
      st = { ...s, k: got.k };
      identity = { kind: "logo", fit: got.fit, recolour };
      logoReport = { share: round2(got.sh.share), p50: round2(got.sh.p50), faces: got.fc.faces.length, weakest: got.fc.worst ? round2(got.fc.worst.q) : null };
    } else why.push(lf.mono ? "recoloured logo still below: title" : "several colours: title");
  }
  if (!identity) {
    const title = fitTitle(name), tl = titleLayout(title, geo);
    identity = { kind: "title", title };
    runs = [...fixed, ...stageBase, tl.run];
    pos = place(tl.top, tl.right);
    st = strengths(runs, pos);
  }
  const ps = pos!, S = st!;
  // page mode: for each facts width, the strength the generator's flow ends on (what the text needs, then up until the logo reads)
  const steps: [number, number][] = [];
  if (mode === "page") {
    const final = (n: number) => { const k = strengthOf(n); if (!logoFrom) return k; return logoFrom(k)?.k ?? Math.max(k, S.k); };
    const push = (w: number, k: number) => { if (!steps.length || k > steps[steps.length - 1][1]) steps.push([w, k]); };
    push(0, final(S.fixedNeed));
    for (const [x, n] of S.facts) if (n > S.fixedNeed) push(x, final(n));
  }
  const kFor = (w: number) => steps.reduce((k, [x, v], i) => (i === 0 || w > x ? v : k), 0);
  // final numbers at the chosen strength (page mode: with the nominal facts line)
  const kFinal = mode === "board" ? S.k : kFor(stage.factsWidth);
  const check = mode === "board" ? runs : [...runs, ...st0.runs.filter(r => r.who === "stage:facts")];
  const bd = makeBackdrop(ps.layer, pl, kFinal, S.topK, ps.layerP3), memo = new Map<string, number>();
  const checks = check.map(r => ({ who: r.who, text: r.text ?? "", need: r.need, reportOnly: !!r.reportOnly, cr: round2(runContrast(bd, r, memo)) }));
  return {
    placement: pl, ox: ps.an.ox, oy: ps.an.oy, anchor: ps.an, text: ps.text, k: kFinal, topK: S.topK,
    parts: { bar: strengthOf(S.need.bar), chips: strengthOf(S.need.chips), stage: strengthOf(S.need.stage), facts: mode === "board" ? strengthOf(S.need.facts) : null, logo: logoK },
    steps, identity, why, checks, logo: logoReport, map, ms: Math.round(performance.now() - t0),
  };
}
