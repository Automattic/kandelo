/* SPDX-License-Identifier: Apache-2.0 */
#include <glib-object.h>
#include <errno.h>
#include <string.h>
#include <sys/wait.h>

typedef struct {
  GMainLoop *loop;
  GPid pid;
  guint calls;
  guint finalized;
} Watch;

static void observed(Watch *watch, GPid pid, gint status)
{
  g_assert_cmpint(pid, ==, watch->pid);
  g_assert_true(WIFEXITED(status));
  g_assert_cmpint(WEXITSTATUS(status), ==, 7);
  g_assert_cmpuint(++watch->calls, ==, 1);
  g_main_loop_quit(watch->loop);
}

static void public_callback(GPid pid, gint status, gpointer data)
{
  observed(data, pid, status);
}

/* The inner GClosure uses ULONG on Unix. This is distinct from the
 * public native GChildWatchFunc's GPid and void return contract. */
static gboolean closure_callback(gulong pid, gint status, gpointer data)
{
  observed(data, (GPid) pid, status);
  return TRUE;
}

static void finalized(gpointer data, GClosure *closure)
{
  Watch *watch = data;
  g_assert_nonnull(closure);
  g_assert_cmpuint(++watch->finalized, ==, 1);
}

static gboolean timed_out(gpointer data)
{
  (void) data;
  g_error("child watch did not complete");
  return G_SOURCE_REMOVE;
}

int main(int argc, char **argv)
{
  if (argc == 2 && strcmp(argv[1], "--child") == 0)
    return 7;
  g_assert_cmpint(argc, ==, 2);
  gboolean use_closure = strcmp(argv[1], "closure") == 0;
  g_assert_true(use_closure || strcmp(argv[1], "public") == 0);
  Watch watch = { .loop = g_main_loop_new(NULL, FALSE) };
  gchar *child_argv[] = { argv[0], "--child", NULL };
  GError *error = NULL;
  g_assert_true(g_spawn_async(NULL, child_argv, NULL,
    G_SPAWN_DO_NOT_REAP_CHILD, NULL, NULL, &watch.pid, &error));
  g_assert_no_error(error);
  g_assert_cmpint(watch.pid, >, 0);
  if (use_closure) {
    GSource *source = g_child_watch_source_new(watch.pid);
    GClosure *closure = g_cclosure_new(G_CALLBACK(closure_callback), &watch, finalized);
    g_source_set_closure(source, closure);
    g_assert_cmpuint(g_source_attach(source, NULL), >, 0);
    g_source_unref(source);
  } else {
    g_assert_cmpuint(g_child_watch_add(watch.pid, public_callback, &watch), >, 0);
  }
  guint timeout = g_timeout_add_seconds(10, timed_out, NULL);
  g_main_loop_run(watch.loop);
  g_assert_true(g_source_remove(timeout));
  g_assert_cmpuint(watch.calls, ==, 1);
  g_assert_cmpuint(watch.finalized, ==, use_closure ? 1 : 0);
  int status = 0;
  errno = 0;
  g_assert_cmpint(waitpid(watch.pid, &status, WNOHANG), ==, -1);
  g_assert_cmpint(errno, ==, ECHILD);
  g_spawn_close_pid(watch.pid);
  g_main_loop_unref(watch.loop);
  g_print("CHILD_WATCH_OK %s: exact callback, exit7, one notification, cleanup and reap\n", argv[1]);
  return 0;
}
