#include <dlfcn.h>
#include <stdio.h>

__attribute__((visibility("default")))
int kandelo_main_data = 35;

__attribute__((visibility("default")))
int kandelo_main_function(int value) {
    return value + 7;
}

int main(void) {
    void *self = dlopen(NULL, RTLD_NOW | RTLD_GLOBAL);
    if (!self) {
        printf("dlopen(NULL) failed: %s\n", dlerror());
        return 1;
    }

    int (*function)(int) = (int (*)(int))dlsym(self, "kandelo_main_function");
    int *data = (int *)dlsym(self, "kandelo_main_data");
    int (*default_function)(int) =
        (int (*)(int))dlsym(RTLD_DEFAULT, "kandelo_main_function");
    if (!function || !data || !default_function) {
        printf("main dlsym failed: %s\n", dlerror());
        return 2;
    }

    printf("self=%d default=%d data=%d\n",
           function(35), default_function(1), *data);
    if (dlclose(self) != 0) {
        printf("dlclose(self) failed: %s\n", dlerror());
        return 3;
    }
    return 0;
}
