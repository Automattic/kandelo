/*
 * notify-send — the desktop's notification sender, Omarchy's notify-send
 * slot routed over the session bus.
 *
 * `notify-send <summary> [body…]` calls
 * org.freedesktop.Notifications.Notify on whoever owns the name (mako)
 * and prints the assigned id for the demo gates:
 *   NOTIFY_ID id=N
 *
 * The session bus address comes from DBUS_SESSION_BUS_ADDRESS. The
 * compositor's `notify =` config hook spawns it on a theme switch;
 * anything else can spawn it too.
 */
#include <gio/gio.h>

#include <stdio.h>

int main(int argc, char **argv)
{
    GError *error = NULL;
    GDBusConnection *bus;
    GVariant *reply;
    GString *body;
    guint32 id = 0;

    if (argc < 2) {
        fprintf(stderr, "usage: %s <summary> [body...]\n", argv[0]);
        return 2;
    }

    body = g_string_new(NULL);
    for (int i = 2; i < argc; i++) {
        if (i > 2)
            g_string_append_c(body, ' ');
        g_string_append(body, argv[i]);
    }

    bus = g_bus_get_sync(G_BUS_TYPE_SESSION, NULL, &error);
    if (bus == NULL) {
        fprintf(stderr, "notify-send: bus connection failed: %s\n",
                error->message);
        return 1;
    }

    reply = g_dbus_connection_call_sync(bus, "org.freedesktop.Notifications",
                                        "/org/freedesktop/Notifications",
                                        "org.freedesktop.Notifications",
                                        "Notify",
                                        g_variant_new("(susssasa{sv}i)",
                                                      "notify-send", 0u, "",
                                                      argv[1], body->str,
                                                      NULL, NULL, -1),
                                        G_VARIANT_TYPE("(u)"),
                                        G_DBUS_CALL_FLAGS_NONE, 10000, NULL,
                                        &error);
    if (reply == NULL) {
        fprintf(stderr, "notify-send: Notify failed: %s\n", error->message);
        return 1;
    }
    g_variant_get(reply, "(u)", &id);
    printf("NOTIFY_ID id=%u\n", id);
    g_variant_unref(reply);

    return 0;
}
