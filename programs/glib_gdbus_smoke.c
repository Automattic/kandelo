/*
 * glib_gdbus_smoke.c — PR22 gate for the gdbus client core against the
 * dbus-daemon port: two-process gdbus ping (server owns a name and
 * exports a method, client calls it) plus a notify-send-shaped
 * org.freedesktop.Notifications.Notify round trip.
 *
 * Modes:
 *   --server   own org.kandelo.Smoke + org.freedesktop.Notifications,
 *              touch /tmp/gdbus-server-ready once both names are up,
 *              exit 0 after handling one Ping and one Notify.
 *   --client   call Ping("marco") expecting "polo" (prints PING_OK),
 *              then Notify(...) expecting a notification id
 *              (prints NOTIFY_OK).
 *
 * The session bus address comes from DBUS_SESSION_BUS_ADDRESS.
 */
#include <gio/gio.h>

#include <fcntl.h>
#include <stdio.h>
#include <string.h>
#include <unistd.h>

#define READY_FILE "/tmp/gdbus-server-ready"

typedef struct {
    GMainLoop *loop;
    int names_acquired;
    int ping_handled;
    int notify_handled;
} ServerState;

static const gchar smoke_xml[] =
    "<node>"
    "  <interface name='org.kandelo.Smoke'>"
    "    <method name='Ping'>"
    "      <arg type='s' name='msg' direction='in'/>"
    "      <arg type='s' name='reply' direction='out'/>"
    "    </method>"
    "  </interface>"
    "</node>";

static const gchar notifications_xml[] =
    "<node>"
    "  <interface name='org.freedesktop.Notifications'>"
    "    <method name='Notify'>"
    "      <arg type='s' name='app_name' direction='in'/>"
    "      <arg type='u' name='replaces_id' direction='in'/>"
    "      <arg type='s' name='app_icon' direction='in'/>"
    "      <arg type='s' name='summary' direction='in'/>"
    "      <arg type='s' name='body' direction='in'/>"
    "      <arg type='as' name='actions' direction='in'/>"
    "      <arg type='a{sv}' name='hints' direction='in'/>"
    "      <arg type='i' name='expire_timeout' direction='in'/>"
    "      <arg type='u' name='id' direction='out'/>"
    "    </method>"
    "  </interface>"
    "</node>";

static void maybe_finish(ServerState *st)
{
    if (st->ping_handled && st->notify_handled)
        g_main_loop_quit(st->loop);
}

static void handle_smoke_call(GDBusConnection *connection,
                              const gchar *sender, const gchar *object_path,
                              const gchar *interface_name, const gchar *method_name,
                              GVariant *parameters,
                              GDBusMethodInvocation *invocation,
                              gpointer user_data)
{
    ServerState *st = user_data;
    const gchar *msg = NULL;

    g_variant_get(parameters, "(&s)", &msg);
    if (g_strcmp0(msg, "marco") == 0) {
        g_dbus_method_invocation_return_value(invocation, g_variant_new("(s)", "polo"));
        st->ping_handled++;
    } else {
        g_dbus_method_invocation_return_error(invocation, G_IO_ERROR,
                                              G_IO_ERROR_INVALID_ARGUMENT,
                                              "expected marco, got %s", msg);
    }
    maybe_finish(st);
}

static void handle_notify_call(GDBusConnection *connection,
                               const gchar *sender, const gchar *object_path,
                               const gchar *interface_name, const gchar *method_name,
                               GVariant *parameters,
                               GDBusMethodInvocation *invocation,
                               gpointer user_data)
{
    ServerState *st = user_data;

    g_dbus_method_invocation_return_value(invocation, g_variant_new("(u)", 42u));
    st->notify_handled++;
    maybe_finish(st);
}

static const GDBusInterfaceVTable smoke_vtable = {
    handle_smoke_call, NULL, NULL, { 0 }
};

static const GDBusInterfaceVTable notify_vtable = {
    handle_notify_call, NULL, NULL, { 0 }
};

static void on_name_acquired(GDBusConnection *connection, const gchar *name,
                             gpointer user_data)
{
    ServerState *st = user_data;

    st->names_acquired++;
    if (st->names_acquired == 2) {
        int fd = creat(READY_FILE, 0644);
        if (fd >= 0)
            close(fd);
    }
}

static void on_name_lost(GDBusConnection *connection, const gchar *name,
                         gpointer user_data)
{
    fprintf(stderr, "server: lost name %s\n", name);
    g_main_loop_quit(((ServerState *)user_data)->loop);
}

static int run_server(void)
{
    GError *error = NULL;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    ServerState st = { 0 };
    GDBusNodeInfo *smoke_info, *notify_info;

    if (bus == NULL) {
        fprintf(stderr, "server: bus connection failed: %s\n", error->message);
        return 1;
    }

    smoke_info = g_dbus_node_info_new_for_xml(smoke_xml, NULL);
    notify_info = g_dbus_node_info_new_for_xml(notifications_xml, NULL);
    g_dbus_connection_register_object(bus, "/org/kandelo/Smoke",
                                      smoke_info->interfaces[0],
                                      &smoke_vtable, &st, NULL, NULL);
    g_dbus_connection_register_object(bus, "/org/freedesktop/Notifications",
                                      notify_info->interfaces[0],
                                      &notify_vtable, &st, NULL, NULL);

    st.loop = g_main_loop_new(NULL, FALSE);
    g_bus_own_name_on_connection(bus, "org.kandelo.Smoke",
                                 G_BUS_NAME_OWNER_FLAGS_NONE,
                                 on_name_acquired, on_name_lost, &st, NULL);
    g_bus_own_name_on_connection(bus, "org.freedesktop.Notifications",
                                 G_BUS_NAME_OWNER_FLAGS_NONE,
                                 on_name_acquired, on_name_lost, &st, NULL);
    g_main_loop_run(st.loop);

    if (st.ping_handled != 1 || st.notify_handled != 1) {
        fprintf(stderr, "server: ping=%d notify=%d\n",
                st.ping_handled, st.notify_handled);
        return 1;
    }
    printf("SERVER_DONE\n");
    return 0;
}

static int run_client(void)
{
    GError *error = NULL;
    GDBusConnection *bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    GVariant *reply;
    const gchar *pong = NULL;
    guint32 id = 0;

    if (bus == NULL) {
        fprintf(stderr, "client: bus connection failed: %s\n", error->message);
        return 1;
    }

    reply = g_dbus_connection_call_sync(bus, "org.kandelo.Smoke",
                                        "/org/kandelo/Smoke",
                                        "org.kandelo.Smoke", "Ping",
                                        g_variant_new("(s)", "marco"),
                                        G_VARIANT_TYPE("(s)"),
                                        G_DBUS_CALL_FLAGS_NONE, 10000, NULL,
                                        &error);
    if (reply == NULL) {
        fprintf(stderr, "client: Ping failed: %s\n", error->message);
        return 1;
    }
    g_variant_get(reply, "(&s)", &pong);
    if (g_strcmp0(pong, "polo") != 0) {
        fprintf(stderr, "client: unexpected Ping reply %s\n", pong);
        return 1;
    }
    printf("PING_OK\n");
    g_variant_unref(reply);

    reply = g_dbus_connection_call_sync(bus, "org.freedesktop.Notifications",
                                        "/org/freedesktop/Notifications",
                                        "org.freedesktop.Notifications",
                                        "Notify",
                                        g_variant_new("(susssasa{sv}i)",
                                                      "glib_gdbus_smoke", 0u,
                                                      "", "quux summary",
                                                      "corge body", NULL, NULL,
                                                      -1),
                                        G_VARIANT_TYPE("(u)"),
                                        G_DBUS_CALL_FLAGS_NONE, 10000, NULL,
                                        &error);
    if (reply == NULL) {
        fprintf(stderr, "client: Notify failed: %s\n", error->message);
        return 1;
    }
    g_variant_get(reply, "(u)", &id);
    if (id != 42u) {
        fprintf(stderr, "client: unexpected notification id %u\n", id);
        return 1;
    }
    printf("NOTIFY_OK\n");
    g_variant_unref(reply);

    return 0;
}

int main(int argc, char **argv)
{
    if (argc > 1 && strcmp(argv[1], "--server") == 0)
        return run_server();
    if (argc > 1 && strcmp(argv[1], "--client") == 0)
        return run_client();
    fprintf(stderr, "usage: %s --server | --client\n", argv[0]);
    return 2;
}
