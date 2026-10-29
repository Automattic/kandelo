#ifndef KANDELO_GBM_MAP_DOUBLE_H
#define KANDELO_GBM_MAP_DOUBLE_H
/* Redirect native descriptor operations in the GBM object and test process.
 * Only the GBM object receives the injected munmap failure. */
#include <sys/mman.h>
#include <fcntl.h>
#include <unistd.h>
#ifndef F_DUPFD_QUERY
#define F_DUPFD_QUERY 1027
#endif
int graphics_gbm_fcntl(int, int, ...);
int graphics_gbm_dup(int);
int graphics_gbm_close(int);
extern int graphics_gbm_fail_file_query;
#define fcntl graphics_gbm_fcntl
#define dup graphics_gbm_dup
#define close graphics_gbm_close
int graphics_gbm_munmap(void *, size_t);
#ifndef KANDELO_GBM_TEST_PROCESS
#define munmap graphics_gbm_munmap
#endif
#endif
