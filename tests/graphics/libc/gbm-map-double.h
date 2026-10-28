#ifndef KANDELO_GBM_MAP_DOUBLE_H
#define KANDELO_GBM_MAP_DOUBLE_H
/* Redirect only the GBM object, after loading the native declarations. */
#include <sys/mman.h>
int graphics_gbm_munmap(void *, size_t);
#define munmap graphics_gbm_munmap
#endif
