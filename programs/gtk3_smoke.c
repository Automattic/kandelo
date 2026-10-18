#include <gtk/gtk.h>
#include <stdio.h>

static gboolean quit_idle(gpointer data)
{
    (void)data;
    gtk_main_quit();
    return G_SOURCE_REMOVE;
}

static gboolean drawn(GtkWidget *widget, cairo_t *cr, gpointer data)
{
    (void)widget;
    (void)cr;
    (void)data;
    static int reported;
    if (reported)
        return FALSE;
    reported = 1;
    printf("GTK3-SMOKE: draw\n");
    fflush(stdout);
    g_idle_add(quit_idle, NULL);
    return FALSE;
}

int main(int argc, char **argv)
{
    gtk_init(&argc, &argv);
    printf("GTK3-SMOKE: init backend=%s\n",
           G_OBJECT_TYPE_NAME(gdk_display_get_default()));
    fflush(stdout);

    GtkWidget *window = gtk_window_new(GTK_WINDOW_TOPLEVEL);
    gtk_window_set_title(GTK_WINDOW(window), "gtk3-smoke");
    gtk_window_set_default_size(GTK_WINDOW(window), 400, 200);
    GtkWidget *label = gtk_label_new("kandelo");
    gtk_container_add(GTK_CONTAINER(window), label);
    g_signal_connect(window, "draw", G_CALLBACK(drawn), NULL);
    gtk_widget_show_all(window);

    gtk_main();
    printf("GTK3-SMOKE: exit\n");
    return 0;
}
