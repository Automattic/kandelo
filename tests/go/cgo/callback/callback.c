#include <pthread.h>
#include <stdlib.h>
#include <string.h>

#include "callback.h"

extern int go_double(int value);
extern char *go_message(int value);

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
