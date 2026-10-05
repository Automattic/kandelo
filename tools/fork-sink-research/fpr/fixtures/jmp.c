#include <setjmp.h>
static sigjmp_buf env_a;
struct ctx { jmp_buf jb; };
void handler(int s) { (void)s; siglongjmp(env_a, 1); }
int resolve(void) { if (sigsetjmp(env_a, 1)) return -1; return 0; }
int other(struct ctx *c) { if (setjmp(c->jb)) return 1; longjmp(c->jb, 2); }
