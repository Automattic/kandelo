#include <stdio.h>

int greeting_count(void) { return 3; }

int main(void) {
    for (int i = 0; i < greeting_count(); i++) puts("hello");
    return 0;
}
