#include <dlfcn.h>
#include <pthread.h>
#include <stdio.h>

int host_scale = 3;

int host_callback(int value)
{
    return value * host_scale;
}

struct plugin_call {
    int (*run)(int);
    int result;
};

static void *call_plugin(void *argument)
{
    struct plugin_call *call = argument;
    call->result = call->run(7);
    return NULL;
}

int main(int argc, char **argv)
{
    if (argc != 2) return 1;
    void *plugin = dlopen(argv[1], RTLD_NOW);
    if (!plugin) {
        fprintf(stderr, "%s\n", dlerror());
        return 2;
    }

    struct plugin_call call = { .run = dlsym(plugin, "plugin_run") };
    pthread_t thread;
    if (!call.run || pthread_create(&thread, NULL, call_plugin, &call))
        return 3;
    if (pthread_join(thread, NULL) || dlclose(plugin) || call.result != 22)
        return 4;

    printf("plugin_run(7) = %d\n", call.result);
    return 0;
}
