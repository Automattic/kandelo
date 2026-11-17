/* A plugin module. Its undefined symbols resolve against the program that
 * loads it: here the program's own API, which the program exports. */
extern int host_scale;
int host_callback(int x);
void host_log(const char *label, int value);

int plugin_run(int x) {
    host_log("plugin: host_scale=", host_scale);
    return host_callback(x) + 1;
}
