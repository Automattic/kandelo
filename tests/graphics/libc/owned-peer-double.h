#ifndef GRAPHICS_OWNED_PEER_DOUBLE_H
#define GRAPHICS_OWNED_PEER_DOUBLE_H
#include <sys/ioctl.h>
#include <stdlib.h>
void *control_calloc(size_t,size_t);
void control_free(void *);
#define calloc control_calloc
#define free control_free
int control_ioctl(int,unsigned long,...);
#define ioctl control_ioctl
#endif
