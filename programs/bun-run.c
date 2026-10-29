/*
 * bun-run: thin entrypoint that hands a Bun standalone executable to the
 * Kandelo `bun-run.js` bootstrap running on spidermonkey-node.
 *
 * `bun-run.js` (runtime/bun-run/bun-run.js, installed at
 * /usr/lib/kandelo/bun-run.js) spawns `bun-extract --prepare` to extract the
 * plaintext ESM module graph from the target Bun executable, installs a thin
 * `Bun` global shim, and natively `import()`s the cached entry point. This
 * program is just argv passthrough: it execs spidermonkey-node with the
 * bootstrap script and the caller's arguments, so `bun-run <binary> [args]`
 * behaves like running <binary> directly (e.g. as a future binfmt target).
 *
 * usage: bun-run <bun-executable> [args...]
 */
#include <unistd.h>
#include <stdio.h>
#include <stdlib.h>
#include <errno.h>
#include <sys/stat.h>

int main(int argc, char **argv) {
    if (argc < 2) {
        fprintf(stderr, "usage: bun-run <bun-executable> [args...]\n");
        return 2;
    }
    /* Scratch files are per-user and ephemeral. Do not share an executable
     * module cache between users, or write it into the root-owned image. */
    char cache[96];
    snprintf(cache, sizeof(cache), "/tmp/kandelo-bun-run-%lu", (unsigned long)geteuid());
    if (mkdir(cache, 0700) != 0 && errno != EEXIST) {
        perror("bun-run: create cache");
        return 1;
    }
    struct stat st;
    if (lstat(cache, &st) != 0 || !S_ISDIR(st.st_mode) ||
        st.st_uid != geteuid() || (st.st_mode & 0077) != 0) {
        fprintf(stderr, "bun-run: cache must be a private directory owned by the current user: %s\n", cache);
        return 1;
    }
    if (setenv("KANDELO_BUN_CACHE", cache, 1) != 0) {
        perror("bun-run: set cache environment");
        return 1;
    }
    /* bun-run <binary> [args...] -> spidermonkey-node /usr/lib/kandelo/bun-run.js <binary> [args...] */
    char *nargv[argc + 3];
    nargv[0] = "node";
    nargv[1] = "/usr/lib/kandelo/bun-run.js";
    for (int i = 1; i < argc; i++) nargv[i + 1] = argv[i];
    nargv[argc + 1] = 0;
    execv("/usr/bin/node", nargv);
    int error = errno;
    perror("bun-run: exec /usr/bin/node");
    return error == ENOENT ? 127 : 126;
}
