#pragma once
#include <glib-object.h>
typedef struct _GtkWidget GtkWidget;
typedef struct _GtkWidgetClass GtkWidgetClass;
struct _GtkWidget { GObject parent; gboolean window, menu, visible, disposed; };
struct _GtkWidgetClass { GObjectClass parent; };
GType gtk_widget_get_type(void);
#define GTK_IS_WINDOW(w) (((GtkWidget *)(w))->window)
#define GTK_WINDOW(w) ((GtkWidget *)(w))
#define GTK_IS_MENU(w) (((GtkWidget *)(w))->menu)
#define GTK_WINDOW_POPUP 1
int gtk_window_get_window_type(GtkWidget *self);
void gtk_widget_hide(GtkWidget *self);
void gtk_menu_popdown(GtkWidget *self);

#ifdef LIFECYCLE_BOUNDARY_CHECK
gpointer lifecycle_checked_get_data(GObject *object, const gchar *key);
#define g_object_get_data lifecycle_checked_get_data
#endif
