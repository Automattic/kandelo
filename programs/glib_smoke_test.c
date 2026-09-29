/*
 * glib_smoke_test.c — PR21 gate for the glib port: GMainLoop dispatch
 * (idle, timeout, unix fd source), GObject signals through the
 * libffi-backed generic marshaller, GObject properties, and GSpawn
 * (sync + async with child watch on the main loop).
 *
 * Spawn legs re-exec this binary at /bin/glib_smoke_test with --child
 * (the vitest gate stages it there via execPrograms). Prints
 * GLIB_SMOKE_OK and exits 0 when every check passes.
 */
#include <glib.h>
#include <glib-object.h>
#include <glib-unix.h>

#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define CHILD_PATH "/bin/glib_smoke_test"

static int failures;

#define CHECK(cond)                                                     \
    do {                                                                \
        if (!(cond)) {                                                  \
            failures++;                                                 \
            fprintf(stderr, "FAIL %s:%d: %s\n", __FILE__, __LINE__, #cond); \
        }                                                               \
    } while (0)

/* --- GMainLoop: idle + timeout + unix fd source ----------------------- */

typedef struct {
    GMainLoop *loop;
    int idle_fired;
    int timeout_fired;
    int fd_fired;
    int write_fd;
    char fd_byte;
} LoopState;

static gboolean on_idle(gpointer data)
{
    LoopState *st = data;
    st->idle_fired++;
    CHECK(write(st->write_fd, "x", 1) == 1);
    return G_SOURCE_REMOVE;
}

static gboolean on_fd_ready(gint fd, GIOCondition cond, gpointer data)
{
    LoopState *st = data;
    st->fd_fired++;
    CHECK((cond & G_IO_IN) != 0);
    CHECK(read(fd, &st->fd_byte, 1) == 1);
    return G_SOURCE_REMOVE;
}

static gboolean on_timeout(gpointer data)
{
    LoopState *st = data;
    st->timeout_fired++;
    g_main_loop_quit(st->loop);
    return G_SOURCE_REMOVE;
}

static void test_mainloop(void)
{
    LoopState st = { 0 };
    int fds[2];

    CHECK(g_unix_open_pipe(fds, O_CLOEXEC, NULL));
    st.write_fd = fds[1];
    st.loop = g_main_loop_new(NULL, FALSE);

    g_idle_add(on_idle, &st);
    g_unix_fd_add(fds[0], G_IO_IN, on_fd_ready, &st);
    g_timeout_add(50, on_timeout, &st);
    g_main_loop_run(st.loop);

    CHECK(st.idle_fired == 1);
    CHECK(st.fd_fired == 1);
    CHECK(st.fd_byte == 'x');
    CHECK(st.timeout_fired == 1);

    g_main_loop_unref(st.loop);
    close(fds[0]);
    close(fds[1]);
}

/* --- GObject: type, property, signal via generic marshaller ----------- */

#define SMOKE_TYPE_OBJECT (smoke_object_get_type())
G_DECLARE_FINAL_TYPE(SmokeObject, smoke_object, SMOKE, OBJECT, GObject)

struct _SmokeObject {
    GObject parent_instance;
    int count;
};

G_DEFINE_TYPE(SmokeObject, smoke_object, G_TYPE_OBJECT)

enum { PROP_COUNT = 1 };
static guint ping_signal;

static void smoke_object_set_property(GObject *object, guint prop_id,
                                      const GValue *value, GParamSpec *pspec)
{
    SmokeObject *self = SMOKE_OBJECT(object);
    if (prop_id == PROP_COUNT)
        self->count = g_value_get_int(value);
    else
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
}

static void smoke_object_get_property(GObject *object, guint prop_id,
                                      GValue *value, GParamSpec *pspec)
{
    SmokeObject *self = SMOKE_OBJECT(object);
    if (prop_id == PROP_COUNT)
        g_value_set_int(value, self->count);
    else
        G_OBJECT_WARN_INVALID_PROPERTY_ID(object, prop_id, pspec);
}

static void smoke_object_class_init(SmokeObjectClass *klass)
{
    GObjectClass *object_class = G_OBJECT_CLASS(klass);

    object_class->set_property = smoke_object_set_property;
    object_class->get_property = smoke_object_get_property;

    g_object_class_install_property(object_class, PROP_COUNT,
        g_param_spec_int("count", NULL, NULL, G_MININT, G_MAXINT, 0,
                         G_PARAM_READWRITE));

    /* NULL marshaller: dispatch goes through
     * g_cclosure_marshal_generic, i.e. libffi ffi_call (PR20). */
    ping_signal = g_signal_new("ping", SMOKE_TYPE_OBJECT,
                               G_SIGNAL_RUN_LAST, 0, NULL, NULL, NULL,
                               G_TYPE_INT, 3,
                               G_TYPE_INT, G_TYPE_DOUBLE, G_TYPE_STRING);
}

static void smoke_object_init(SmokeObject *self)
{
    (void)self;
}

static gint on_ping(SmokeObject *obj, gint i, gdouble d, const gchar *s,
                    gpointer user_data)
{
    int *seen = user_data;
    (*seen)++;
    CHECK(i == 41);
    CHECK(d == 2.5);
    CHECK(g_strcmp0(s, "quux") == 0);
    obj->count += i;
    return i + (gint)d;
}

static void test_gobject(void)
{
    SmokeObject *obj = g_object_new(SMOKE_TYPE_OBJECT, "count", 7, NULL);
    int seen = 0;
    gint prop = 0;
    gint ret = 0;

    g_object_get(obj, "count", &prop, NULL);
    CHECK(prop == 7);

    g_signal_connect(obj, "ping", G_CALLBACK(on_ping), &seen);
    g_signal_emit(obj, ping_signal, 0, 41, 2.5, "quux", &ret);

    CHECK(seen == 1);
    CHECK(ret == 43);
    CHECK(obj->count == 48);

    g_object_set(obj, "count", 3, NULL);
    g_object_get(obj, "count", &prop, NULL);
    CHECK(prop == 3);

    g_object_unref(obj);
}

/* --- GSpawn: sync and async with child watch --------------------------- */

static void test_spawn_sync(void)
{
    gchar *argv[] = { CHILD_PATH, "--child", NULL };
    gchar *out = NULL;
    gchar *err = NULL;
    gint status = 0;
    GError *error = NULL;

    CHECK(g_spawn_sync(NULL, argv, NULL, G_SPAWN_DEFAULT, NULL, NULL,
                       &out, &err, &status, &error));
    CHECK(error == NULL);
    if (error != NULL)
        fprintf(stderr, "g_spawn_sync: %s\n", error->message);
    CHECK(g_spawn_check_wait_status(status, NULL));
    CHECK(out != NULL && strstr(out, "GLIB_CHILD_OK") != NULL);

    g_free(out);
    g_free(err);
    g_clear_error(&error);
}

typedef struct {
    GMainLoop *loop;
    int watch_fired;
    int child_ok;
} WatchState;

static void on_child_exit(GPid pid, gint status, gpointer data)
{
    WatchState *st = data;
    st->watch_fired++;
    st->child_ok = g_spawn_check_wait_status(status, NULL);
    g_spawn_close_pid(pid);
    g_main_loop_quit(st->loop);
}

static void test_spawn_async(void)
{
    gchar *argv[] = { CHILD_PATH, "--child", NULL };
    WatchState st = { 0 };
    GPid pid = 0;
    GError *error = NULL;

    CHECK(g_spawn_async(NULL, argv, NULL,
                        G_SPAWN_DO_NOT_REAP_CHILD | G_SPAWN_STDOUT_TO_DEV_NULL,
                        NULL, NULL, &pid, &error));
    CHECK(error == NULL);
    if (error != NULL) {
        fprintf(stderr, "g_spawn_async: %s\n", error->message);
        g_clear_error(&error);
        return;
    }

    st.loop = g_main_loop_new(NULL, FALSE);
    g_child_watch_add(pid, on_child_exit, &st);
    g_main_loop_run(st.loop);

    CHECK(st.watch_fired == 1);
    CHECK(st.child_ok);

    g_main_loop_unref(st.loop);
}

int main(int argc, char **argv)
{
    if (argc > 1 && strcmp(argv[1], "--child") == 0) {
        printf("GLIB_CHILD_OK\n");
        return 0;
    }

    test_mainloop();
    test_gobject();
    test_spawn_sync();
    test_spawn_async();

    if (failures) {
        fprintf(stderr, "GLIB_SMOKE_FAILED: %d checks\n", failures);
        return 1;
    }
    printf("GLIB_SMOKE_OK\n");
    return 0;
}
