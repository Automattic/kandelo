#include <stdint.h>
#include <stdlib.h>
struct s { int x; };
struct ops { void (*run)(struct s *); int (*cmp)(const void *, const void *); };
struct other { void (*go)(void); };
static void exact(struct s *p) { p->x++; }
static void cast_me(struct s *p) { p->x--; }
static void via_void(struct s *p) { p->x = 0; }
static void in_struct(struct s *p) { p->x = 1; }
static int bycmp(const struct s *a, const struct s *b) { return a->x - b->x; }
static void assigned(struct s *p) { (void)p; }
void (*gp)(struct s *) = exact;            /* Q only */
void (*gv)(void *) = (void (*)(void *))cast_me;   /* W cast_me -> void(void*) */
void *gvoid = (void *)via_void;            /* W via_void -> * */
struct ops gops = { .run = in_struct };    /* G in_struct ops */
void use(struct s *arr, size_t n, struct ops *o, void (*fp)(struct s *)) {
  qsort(arr, n, sizeof *arr, (int (*)(const void *, const void *))bycmp);  /* W bycmp */
  o->run = assigned;                       /* G assigned ops */
  ((void (*)(void *))fp)(arr);             /* Z void(s*) -> void(void*) */
  ((void (*)(struct s *))gvoid)(arr);      /* Z * -> void(s*) */
  ((struct other *)o)->go();               /* H ops */
}
