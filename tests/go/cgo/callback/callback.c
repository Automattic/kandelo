#include <pthread.h>

#include "callback.h"

extern int go_double(int value);

int call_go(int value) {
    return go_double(value);
}

static void *thread_main(void *argument) {
    int *value = argument;
    int first = go_double(*value);
    *value = go_double(first / 2);
    return NULL;
}

int call_go_on_pthread(int value) {
    pthread_t thread;
    if (pthread_create(&thread, NULL, thread_main, &value) != 0) {
        return -1;
    }
    if (pthread_join(thread, NULL) != 0) {
        return -1;
    }
    return value;
}
