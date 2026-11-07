#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#include "callback.h"

extern int go_double(int value);
extern char *go_message(int value);
extern int go_deep(int value);

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

static void *message_thread_main(void *argument) {
    int *result = argument;
    char *message = go_message(7);
    *result = message != NULL && strcmp(message, "callback-7") == 0;
    free(message);
    return NULL;
}

int call_go_message_on_pthread(void) {
    pthread_t thread;
    int result = 0;
    if (pthread_create(&thread, NULL, message_thread_main, &result) != 0) {
        return 0;
    }
    if (pthread_join(thread, NULL) != 0) {
        return 0;
    }
    return result;
}

static void *deep_thread_main(void *argument) {
    int *result = argument;
    for (int callback = 0; callback < 3; ++callback) {
        *result = go_deep(128);
    }
    return NULL;
}

int call_go_deep_on_pthread(void) {
    pthread_t thread;
    int result = 0;
    if (pthread_create(&thread, NULL, deep_thread_main, &result) != 0) {
        return -1;
    }
    if (pthread_join(thread, NULL) != 0) {
        return -1;
    }
    return result;
}

struct stress_argument {
    int input;
    int result;
};

static void *stress_thread_main(void *argument) {
    struct stress_argument *entry = argument;
    void *allocation = malloc(65536);
    if (allocation == NULL) {
        entry->result = -1;
        return NULL;
    }
    entry->result = go_double(entry->input);
    free(allocation);
    return NULL;
}

int call_go_on_pthreads(void) {
    pthread_t threads[3];
    struct stress_argument entries[3];
    int started = 0;
    for (int index = 0; index < 3; ++index) {
        entries[index].input = 17 + index;
        entries[index].result = -1;
        if (pthread_create(&threads[index], NULL, stress_thread_main, &entries[index]) != 0) {
            break;
        }
        ++started;
    }
    int result = 0;
    for (int index = 0; index < started; ++index) {
        if (pthread_join(threads[index], NULL) != 0) result = -1;
        result += entries[index].result;
    }
    return started == 3 ? result : -1;
}
