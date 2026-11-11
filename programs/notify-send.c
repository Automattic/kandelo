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
#include <string.h>

static const char help_text[] =
    "Usage: notify-send SUMMARY [BODY]...\n"
    "\n"
    "Show a desktop notification through the session bus.\n"
    "\n"
    "notify-send calls org.freedesktop.Notifications.Notify on the\n"
    "notification daemon that owns that name on the D-Bus session bus, whose\n"
    "address is taken from DBUS_SESSION_BUS_ADDRESS. The notification's\n"
    "summary is SUMMARY and its body is the remaining arguments joined with\n"
    "spaces; it has the application name notify-send, no icon and no\n"
    "actions, and the daemon's default timeout. notify-send waits up to ten\n"
    "seconds for the reply and prints the id the daemon assigned as\n"
    "\"NOTIFY_ID id=N\" on standard output.\n"
    "\n"
    "Unlike the libnotify notify-send, this one takes no other options: every\n"
    "argument other than --help and --version as the first is text.\n"
    "\n"
    "Exit status is 0 on success, 1 when the bus or the call fails, and 2\n"
    "when SUMMARY is missing.\n"
    "\n"
    "Options:\n"
    "      --help     display this help and exit\n"
    "      --version  output version information and exit\n";

int main(int argc, char **argv)
{
    GError *error = NULL;
    GDBusConnection *bus;
    GVariant *reply;
    GString *body;
    guint32 id = 0;

    if (argc > 1 && strcmp(argv[1], "--help") == 0) {
        fputs(help_text, stdout);
        return 0;
    }
    if (argc > 1 && strcmp(argv[1], "--version") == 0) {
        fputs("notify-send (Kandelo wayland-demo) 0.1.0\n", stdout);
        return 0;
    }

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
