/** Ahoy — name normalisation shared by discovery and the Metacritic matcher (the same rules ludarr's catalog uses). */
const ROMAN: Record<string, string> = { ii: "2", iii: "3", iv: "4", v: "5", vi: "6", vii: "7", viii: "8", ix: "9", xi: "11", xii: "12", xiii: "13", xiv: "14", xv: "15", xvi: "16" };

/** "The Legend of Zelda™: Majora’s Mask" → "legend of zelda majoras mask"; "Final Fantasy VII" → "final fantasy 7" */
export function normName(s: string): string {
  const words = s.replace(/[™®©]/g, "").normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`]/g, "")
    .replace(/[^a-z0-9]+/g, " ").trim().split(" ").filter(Boolean)
    .map(w => ROMAN[w] ?? w);
  if (words[0] === "the" && words.length > 1) words.shift();
  return words.join(" ");
}

/**
 * A catalog row made when the store had no details for an app (discover.ts enrichCatalog, "remember we looked") is named
 * "app <id>". That is a placeholder, never a name to show: callers fall back to the name the feed, the store search, Metacritic
 * or the library gave, or show none.
 */
const PLACEHOLDER_NAME = /^app \d+$/i;
export const knownName = (name: string | null | undefined): string | null => (name && name.trim() && !PLACEHOLDER_NAME.test(name.trim()) ? name : null);
