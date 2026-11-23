#define _GNU_SOURCE
#include "pthread_impl.h"

extern unsigned char __stack_low[], __stack_high[];

int pthread_getattr_np(pthread_t t, pthread_attr_t *a)
{
	*a = (pthread_attr_t){0};
	a->_a_detach = t->detach_state >= DT_DETACHED;
	a->_a_guardsize = t->guard_size;
	if (t->stack) {
		a->_a_stackaddr = (uintptr_t)t->stack;
		a->_a_stacksize = t->stack_size;
	} else {
		/* The linker reserves the main thread's downward-growing stack. */
		a->_a_stackaddr = (uintptr_t)__stack_high;
		a->_a_stacksize = (uintptr_t)__stack_high - (uintptr_t)__stack_low;
	}
	return 0;
}
