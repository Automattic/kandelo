/* A plugin module that calls a libc function its host program never links
 * (strverscmp). A Kandelo plugin takes libc from the program, so the
 * program must link and export that function too, for example with
 * -Wl,--export=strverscmp; --export-dynamic exports only what the program
 * links. */
#define _GNU_SOURCE
#include <string.h>

int plugin_run(int x) {
    return strverscmp("a2", "a10") < 0 ? x + 1 : -1;
}
