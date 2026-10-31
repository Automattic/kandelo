/**
 * Keep the dev server running the configuration that is on disk.
 *
 * Vite restarts the dev server when `vite.config.ts` or a module it imports
 * changes. A change that arrives while a restart is still loading the
 * configuration is folded into that restart: `server.restart()` returns the
 * restart already in flight, which read the files before the change. A
 * checkout or rebase rewrites many config dependencies in a burst, so the
 * server can come up with an intermediate configuration and stay there until
 * some later edit happens to restart it again. When that intermediate
 * configuration predates a plugin (for example the guest preview origin's
 * listener on port + 1, vite/preview-origin.ts), the feature is gone even
 * though the files on disk include it.
 *
 * This plugin closes that gap. The instance being torn down for a restart
 * waits for the restart to finish, then compares the configuration's files
 * with the moment the restart began. If any was written after that, the
 * running configuration may not be the one on disk, so it restarts once more.
 * The next instance does the same for its own restart, so the server converges
 * on the files on disk. The check lives in the outgoing instance on purpose:
 * the incoming configuration may be an intermediate one that does not include
 * this plugin at all.
 */
import fs from "node:fs";
import type { Plugin, ViteDevServer } from "vite";

/** The restart Vite has in flight. Read through the long-lived server object. */
interface RestartingServer extends ViteDevServer {
  _restartPromise?: Promise<void> | null;
}

function modifiedSince(files: Iterable<string>, since: number): string | null {
  for (const file of files) {
    let mtime: number;
    try {
      mtime = fs.statSync(file).mtimeMs;
    } catch {
      // A dependency that disappeared is a change too.
      return file;
    }
    if (mtime > since) return file;
  }
  return null;
}

export function restartConvergencePlugin(): Plugin {
  let live: RestartingServer | null = null;
  let dependencies: string[] = [];
  // When the first configuration change since this instance started arrived.
  // The restart it triggers reads the files at or after this time.
  let firstChangeAt: number | null = null;

  return {
    name: "kandelo-restart-convergence",
    apply: "serve",
    configureServer(server) {
      live = server as RestartingServer;
      dependencies = [
        ...new Set([
          ...(server.config.configFile ? [server.config.configFile] : []),
          ...server.config.configFileDependencies,
        ]),
      ];
      const watched = new Set(dependencies);
      const note = (file: string) => {
        if (firstChangeAt === null && watched.has(file)) firstChangeAt = Date.now();
      };
      server.watcher.on("change", note);
      server.watcher.on("add", note);
      server.watcher.on("unlink", note);
    },
    closeServer({ reason }) {
      if (reason !== "restart" || live === null) return;
      const server = live;
      // A restart without a file event (`r` in the terminal, server.restart())
      // read the files no earlier than now.
      const since = firstChangeAt ?? Date.now();
      const previous = dependencies;
      const restarting = server._restartPromise;
      // WHY the internal field: `server.restart()` hands back the restart in
      // flight, so asking for another before this one has fully settled would
      // be folded into it — the very loss this plugin exists to prevent. If a
      // future Vite drops the field, say so instead of silently not checking.
      if (!(restarting instanceof Promise)) {
        server.config.logger.warn(
          "kandelo-restart-convergence: this Vite exposes no restart promise; " +
            "a config change made during a restart may need a manual restart",
        );
        return;
      }
      void restarting.then(() => {
        const files = new Set([
          ...previous,
          ...(server.config.configFile ? [server.config.configFile] : []),
          ...server.config.configFileDependencies,
        ]);
        const changed = modifiedSince(files, since);
        if (changed === null) return;
        server.config.logger.info(
          `${changed} changed while the server was restarting; restarting again`,
          { timestamp: true },
        );
        void server.restart().catch((error: unknown) => {
          server.config.logger.error(
            `restart after a config change during a restart failed: ${String(error)}`,
          );
        });
      }, () => {});
    },
  };
}
