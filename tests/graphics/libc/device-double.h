#ifndef KANDELO_GRAPHICS_DEVICE_DOUBLE_H
#define KANDELO_GRAPHICS_DEVICE_DOUBLE_H
/* Load system declarations before remapping calls. Darwin's asm symbol
 * aliases must not turn these test functions into global libc overrides. */
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/mman.h>
#include <sys/ioctl.h>
int graphics_open(const char *, int, ...);
int graphics_close(int);
int graphics_fstat(int, struct stat *);
void *graphics_mmap(void *, size_t, int, int, int, off_t);
int graphics_munmap(void *, size_t);
int graphics_ioctl(int, unsigned long, ...);
#define open graphics_open
#define close graphics_close
#define fstat graphics_fstat
#define mmap graphics_mmap
#define munmap graphics_munmap
#define ioctl graphics_ioctl
#endif
