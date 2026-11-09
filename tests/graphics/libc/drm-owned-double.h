#ifndef WPK_OWNED_TRANSPORT_DOUBLE_H
#define WPK_OWNED_TRANSPORT_DOUBLE_H
#include <sys/ioctl.h>
#include <stdlib.h>
int owned_ioctl(int,unsigned long,...);
void *owned_calloc(size_t,size_t);
void owned_free(void *);
#define ioctl owned_ioctl
#define calloc owned_calloc
#define free owned_free
#endif
