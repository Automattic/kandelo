/* Compile with each unmodified pinned library's actual Xcursor file loader.
 * The filesystem supplies the packaged default theme and upstream aliases. */
#include <assert.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#ifdef CONTROL_WLROOTS
#include "xcursor/xcursor.h"
#else
#include "xcursor.h"
#endif
static unsigned count;
static void loaded(struct xcursor_images *images, void *data) {
    const unsigned expected = *(unsigned *)data;
    assert(images->nimage > 0 && images->nimage <= 64);
    uint64_t hash = UINT64_C(14695981039346656037);
    for (int i = 0; i < images->nimage; i++) {
        struct xcursor_image *image = images->images[i];
        assert(image->size == expected);
        assert(image->width && image->height && image->width <= 96 && image->height <= 96);
        assert(image->xhot < image->width && image->yhot < image->height);
        for (size_t p = 0; p < (size_t)image->width * image->height; ++p) {
            hash ^= image->pixels[p]; hash *= UINT64_C(1099511628211);
        }
        hash ^= image->delay; hash *= UINT64_C(1099511628211);
    }
    const struct xcursor_image *first = images->images[0];
    printf("%s %d %u %u %u %u %u %" PRIu64 "\n", images->name, images->nimage,
        first->size, first->width, first->height, first->xhot, first->yhot, hash);
    ++count;
    xcursor_images_destroy(images);
}
int main(int argc, char **argv) {
    if (argc != 3) return 2;
    unsigned expected = (unsigned)strtoul(argv[2], NULL, 10);
    xcursor_load_theme("default", atoi(argv[1]), loaded, &expected);
    if (count != 145) {
        fprintf(stderr,"theme parser: expected 56 cursors + 89 aliases, loaded %u\n",count);
        return 1;
    }
    return 0;
}
