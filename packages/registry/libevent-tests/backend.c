#include <event2/event.h>
#include <stdio.h>
#include <string.h>

int main(void) {
    struct event_config *config = event_config_new();
    if (!config) return 1;
    if (event_config_require_features(config, EV_FEATURE_ET | EV_FEATURE_EARLY_CLOSE) != 0) return 2;
    struct event_base *base = event_base_new_with_config(config);
    event_config_free(config);
    if (!base) return 3;
    const char *method = event_base_get_method(base);
    int valid = strcmp(method, "epoll") == 0 || strcmp(method, "epoll (with changelist)") == 0;
    printf("LIBEVENT_BACKEND=%s features=%d version=%s\n", method,
           event_base_get_features(base), event_get_version());
    event_base_free(base);
    return valid ? 0 : 4;
}
