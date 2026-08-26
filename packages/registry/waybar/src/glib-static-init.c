/*
 * glib initializes itself from a plain __attribute__((constructor)) with
 * no priority (glib/glib-init.c, G_DEFINE_CONSTRUCTOR(glib_init_ctor)),
 * and so does gobject (gobject/gtype.c, gobject_init_ctor). Upstream that
 * ordering is guaranteed by the dynamic loader: libgobject-2.0.so depends
 * on libglib-2.0.so, so glib's constructor runs first. A fully static link
 * has no such guarantee — the constructors run in link order, and with
 * gobject's ahead of glib's, gobject_init() reaches g_quark_from_static_string
 * before glib_init() has allocated the quark table: NULL-table criticals,
 * then g_quark_init's `quark_seq_id == 0` assertion aborts the process.
 *
 * Priority 101 sorts this constructor ahead of every default-priority one.
 * glib_init() is idempotent (its own `glib_inited` guard), so glib's
 * constructor still runs and simply returns.
 */
extern void glib_init(void);

__attribute__((constructor(101))) static void glib_init_first(void) {
    glib_init();
}
