/* A plugin module. Its undefined symbols (host_callback, host_scale and
 * printf) resolve against the program that loads it. */
#include <stdio.h>

extern int host_scale;
int host_callback(int x);

int plugin_run(int x) {
    printf("plugin: host_scale=%d\n", host_scale);
    return host_callback(x) + 1;
}
