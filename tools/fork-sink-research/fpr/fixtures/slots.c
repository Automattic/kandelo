struct ops_a { void (*run)(int); };
struct ops_b { void (*go)(long); };
struct holder { void *data; void (*cb)(void *); };
static void ra(int x) { (void)x; }
static struct ops_a A = { .run = ra };
void put(struct holder *h) { h->data = &A; }
void same(struct holder *h) { struct ops_a *a = h->data; a->run(1); }
void other(struct holder *h) { struct ops_b *b = h->data; b->go(1); }
static void cb(void *data) { struct ops_b *b = data; b->go(2); }
void reg(struct holder *h, void (*f)(void *), void *d) { h->cb = f; h->data = d; }
void fire(struct holder *h) { h->cb(h->data); }
void setup(struct holder *h) { reg(h, cb, &A); }
