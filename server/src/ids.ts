/**
 * Ahoy — ids from paths. Number() reads "1e3", "0x10", "+5", "12.0" and "1e20" as numbers, so an id is accepted only as the
 * plain decimal digits of a positive whole number ("31", never "031"), within `max`; anything else is no id at all, and nothing is
 * asked of Steam or ludarr for it.
 */

/** Steam app ids are unsigned 32-bit numbers */
export const STEAM_APP_MAX = 0xffff_ffff;

/** the positive whole number a path segment spells in plain digits, else null */
export function plainId(s: string | null | undefined, max = Number.MAX_SAFE_INTEGER): number | null {
  if (typeof s !== "string" || !/^[1-9]\d{0,15}$/.test(s)) return null;
  const n = Number(s);
  return Number.isSafeInteger(n) && n <= max ? n : null;
}
