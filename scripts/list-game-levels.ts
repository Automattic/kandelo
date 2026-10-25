// Maintainer helper: inspect extracted, original WAD/PAK files. For pinned
// archives, verify their sessions.json size/hash before native extraction.
// scripts/dev-shell.sh node --import ./apps/browser-demos/node_modules/tsx/dist/esm/index.mjs scripts/list-game-levels.ts doom-wad game.wad
import { readFileSync } from "node:fs";
import { readGameLevels, sortLevels, type LevelFormat } from "../web-libs/kandelo-session/src/game-levels.ts";
const [format, ...files] = process.argv.slice(2);
if (!["doom-wad", "quake-pak"].includes(format) || !files.length) throw new Error("Usage: list-game-levels.ts <doom-wad|quake-pak> <file>…");
console.log(JSON.stringify(sortLevels(files.flatMap(file => readGameLevels(new Uint8Array(readFileSync(file)), format as LevelFormat))), null, 2));
