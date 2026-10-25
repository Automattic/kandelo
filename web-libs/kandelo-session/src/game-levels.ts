import { MAX_DEPENDENCY_BYTES } from "./session-dependencies";

export type LevelFormat = "doom-wad" | "quake-pak";
export function validLevel(format: LevelFormat, name: unknown): name is string {
  return typeof name === "string" && (format === "doom-wad"
    ? /^(?:E[1-9]M[1-9]|MAP[0-9]{2})$/.test(name)
    : /^[a-z0-9_]{1,32}$/.test(name));
}
export function sortLevels(names: Iterable<string>): string[] {
  return [...new Set(names)].sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
}

/** Directory-only inspection: no decompression, scripts, textures or guest code.
 * The file cap and directory bounds apply before walking untrusted uploads. */
export function readGameLevels(bytes: Uint8Array, format: LevelFormat): string[] {
  const fail = (): never => { throw new Error(`Invalid ${format === "doom-wad" ? "WAD" : "PAK"} game data or no supported levels`); };
  if (bytes.length < 12 || bytes.length > MAX_DEPENDENCY_BYTES) fail();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const name = (offset: number, size: number) => {
    const end = offset + size;
    let text = "";
    for (let i = offset; i < end && bytes[i] !== 0; i++) text += String.fromCharCode(bytes[i]);
    return text;
  };
  const wad = format === "doom-wad";
  if (!(wad ? ["IWAD", "PWAD"] : ["PACK"]).includes(name(0, 4))) fail();
  const offset = view.getUint32(wad ? 8 : 4, true);
  const stride = wad ? 16 : 64;
  const length = wad ? view.getUint32(4, true) * stride : view.getUint32(8, true);
  if (offset < 12 || length === 0 || length % stride || length > bytes.length - offset || length / stride > 131072) fail();
  const entries: string[] = [];
  const playable = new Set<string>();
  let inspectedEntities = 0;
  let mapCandidates = 0;
  for (let i = offset; i < offset + length; i += stride) {
    const start = view.getUint32(wad ? i : i + 56, true);
    const size = view.getUint32(wad ? i + 4 : i + 60, true);
    if (start > bytes.length || size > bytes.length - start) fail();
    const entry = name(wad ? i + 8 : i, wad ? 8 : 56);
    entries.push(entry);
    if (!wad && /^maps\/[a-z0-9_]{1,32}\.bsp$/.test(entry) && size >= 12) {
      if (++mapCandidates > 512) fail();
      const entityStart = view.getUint32(start + 4, true);
      const entitySize = view.getUint32(start + 8, true);
      // Quake also stores brush models as BSPs. They are not playable maps.
      if (entityStart <= size && entitySize <= size - entityStart && entitySize <= 1048576) {
        inspectedEntities += entitySize;
        if (inspectedEntities > 8 * 1048576) fail();
        const entities = new TextDecoder().decode(bytes.subarray(start + entityStart, start + entityStart + entitySize));
        if (/"classname"\s*"worldspawn"/.test(entities) && /"classname"\s*"info_player_(?:start|deathmatch|coop)"/.test(entities)) playable.add(entry);
      }
    }
  }
  const levels = wad
    ? entries.filter((entry, i) => validLevel(format, entry) && entries[i + 1] === "THINGS" && entries[i + 2] === "LINEDEFS" && entries[i + 3] === "SIDEDEFS" && entries[i + 4] === "VERTEXES")
    : [...playable].map(entry => entry.slice(5, -4));
  if (!levels.length || levels.length > 256) fail();
  return sortLevels(levels);
}

/** Only the native game's bounded level syntax can become launch arguments. */
export function levelArguments(format: LevelFormat, level: string): string[] {
  if (!validLevel(format, level)) throw new Error("Invalid level name");
  if (format === "quake-pak") return [level];
  return level.startsWith("MAP") ? ["-warp", String(Number(level.slice(3)))] : ["-warp", level[1], level[3]];
}
