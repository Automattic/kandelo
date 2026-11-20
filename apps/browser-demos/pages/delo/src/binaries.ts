// The URL of each registry file this build serves. A file's or an
// archive's `from` is a path under the binaries root; Vite serves a binary only when the source
// names its exact path, so every local source in registry.json has one line
// here per mirror. A lazy file has none: the kernel fetches it from the
// image's own lazy-asset address. A `from` of `<image>:<path>` has none either: the
// builder reads the Kandelo image from the same store. `import.meta.glob` tolerates a file that is not built: a
// package whose file is missing fails when a computer installs it, not when
// the page loads.

const MIRRORS = ["../../../../../local-binaries/", "../../../../../binaries/"];

const LOADERS = {
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/bash.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/bash.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/dash.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/dash.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/dinit/dinit.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/dinit/dinit.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/dinit/dinitctl.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/dinit/dinitctl.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/dinit/dinitcheck.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/dinit/dinitcheck.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/coreutils.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/coreutils.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/login.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/login.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/clear.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/clear.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/reset.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/reset.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/tset.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/tset.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/tput.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/tput.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/tabs.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/tabs.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/tic.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/tic.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/infocmp.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/infocmp.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/toe.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/toe.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/captoinfo.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/captoinfo.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/infotocap.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/infotocap.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/ncurses/terminfo.zip", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/ncurses/terminfo.zip", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/less.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/less.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/nano.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/nano.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/grep.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/grep.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/sed.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/sed.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/unzip.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/unzip.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/lha.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/lha.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/findutils/find.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/findutils/find.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/findutils/xargs.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/findutils/xargs.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/fbdoom/fbdoom.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/fbdoom/fbdoom.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/tyrquake/quake.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/tyrquake/quake.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/modeset.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/modeset.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/sdl2.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/sdl2.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/node.zip", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/node.zip", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/nginx.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/nginx.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/redis/redis-server.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/redis/redis-server.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/redis/redis-cli.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/redis/redis-cli.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/kandelo-exchange/kxchgd.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/kandelo-exchange/kxchgd.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/kandelo-exchange/exchange-save.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/kandelo-exchange/exchange-save.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/kandelo-exchange/kandelo-exchange.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/kandelo-exchange/kandelo-exchange.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../local-binaries/programs/wasm32/kandelo-exchange/kandelo-publish.wasm", { query: "?url", import: "default" }),
  ...import.meta.glob("../../../../../binaries/programs/wasm32/kandelo-exchange/kandelo-publish.wasm", { query: "?url", import: "default" }),
} as Record<string, () => Promise<string>>;

/** The URL to fetch a file's source: its own URL for https, the build's URL otherwise. */
export async function deloSourceUrl(from: string): Promise<string> {
  if (from.startsWith("https://")) return from;
  for (const mirror of MIRRORS) {
    const loader = LOADERS[`${mirror}${from}`];
    if (loader !== undefined) return loader();
  }
  throw new Error(`${from} is not in this build. Build it with ./run.sh local-build.`);
}
