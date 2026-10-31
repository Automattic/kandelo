/* Exercise the actual upstream window.c with real native GObject ownership.
 * Only the Gtk widget surface is supplied locally; this is not rendered-GUI
 * evidence. The live-object boundary rejects invalid callback data before
 * forwarding valid calls to native g_object_get_data. */
#include <gtk/gtk.h>
#include <string.h>
#include "window.h"
#undef g_object_get_data
static GHashTable *live;
gpointer lifecycle_checked_get_data(GObject *object, const gchar *key) {
  g_assert_true(g_hash_table_contains(live,object));
  return g_object_get_data(object,key);
}
static void finalized(GObject *object) {
  g_hash_table_remove(live,object);
  G_OBJECT_CLASS(g_type_class_peek_parent(G_OBJECT_GET_CLASS(object)))->finalize(object);
}


G_DEFINE_TYPE(GtkWidget, gtk_widget, G_TYPE_OBJECT)
static guint unmap_signal, destroy_signal;
static unsigned notified;
static void gtk_widget_dispose(GObject *object) {
  GtkWidget *self=(GtkWidget *)object;
  if(!self->disposed) {
    self->disposed=TRUE;
    if(self->visible) gtk_widget_hide(self);
    g_signal_emit(self,destroy_signal,0);
  }
  G_OBJECT_CLASS(gtk_widget_parent_class)->dispose(object);
}
static void gtk_widget_class_init(GtkWidgetClass *klass) {
  G_OBJECT_CLASS(klass)->dispose=gtk_widget_dispose;
  G_OBJECT_CLASS(klass)->finalize=finalized;
  unmap_signal=g_signal_new("unmap",G_TYPE_FROM_CLASS(klass),G_SIGNAL_RUN_FIRST,
    0,NULL,NULL,g_cclosure_marshal_VOID__VOID,G_TYPE_NONE,0);
  destroy_signal=g_signal_new("destroy",G_TYPE_FROM_CLASS(klass),G_SIGNAL_RUN_FIRST,
    0,NULL,NULL,g_cclosure_marshal_VOID__VOID,G_TYPE_NONE,0);
}
static void gtk_widget_init(GtkWidget *self) { if(!live)live=g_hash_table_new(g_direct_hash,g_direct_equal);g_hash_table_add(live,self);self->window=TRUE; }
int gtk_window_get_window_type(GtkWidget *self) { (void)self;return GTK_WINDOW_POPUP; }
void gtk_widget_hide(GtkWidget *self) {
  if(self->visible) { self->visible=FALSE;g_signal_emit(self,unmap_signal,0); }
}
void gtk_menu_popdown(GtkWidget *self) { gtk_widget_hide(self); }
static GtkWidget *widget(gboolean visible) {
  GtkWidget *w=g_object_new(gtk_widget_get_type(),NULL);w->visible=visible;return w;
}
static void drop_sibling(GtkWidget *self, gpointer data) { (void)self;g_clear_object((GtkWidget **)data); }
static void empty(gpointer self) { g_assert_nonnull(self);notified++; }
int main(int argc,char **argv) {
  g_assert_cmpint(argc,==,2);
  g_print("ENTER %s\n",argv[1]);
  g_log_set_always_fatal(G_LOG_FATAL_MASK|G_LOG_LEVEL_CRITICAL|G_LOG_LEVEL_WARNING);
  GtkWidget *owner=widget(FALSE),*popup=widget(TRUE);
  window_set_unref_func(owner,empty);
  if(!strcmp(argv[1],"owner-finalize")) {
    window_ref(owner,popup);g_object_unref(owner);g_object_unref(popup);
  } else if(!strcmp(argv[1],"owner-before-unmap")) {
    window_ref(owner,popup);g_object_unref(owner);gtk_widget_hide(popup);
    g_assert_cmpuint(notified,==,0);g_object_unref(popup);
  } else if(!strcmp(argv[1],"duplicate-reference")) {
    window_ref(owner,popup);window_ref(owner,popup);gtk_widget_hide(popup);
    g_assert_cmpuint(notified,==,1);g_assert_false(window_ref_check(owner));
    g_object_unref(popup);g_object_unref(owner);
  } else if(!strcmp(argv[1],"reopen-unmap")) {
    window_ref(owner,popup);gtk_widget_hide(popup);popup->visible=TRUE;
    window_ref(owner,popup);gtk_widget_hide(popup);
    g_assert_cmpuint(notified,==,2);g_object_unref(popup);g_object_unref(owner);
  } else if(!strcmp(argv[1],"destroy-unmapped")) {
    popup->visible=FALSE;window_ref(owner,popup);g_object_unref(popup);
    g_assert_false(window_ref_check(owner));g_assert_cmpuint(notified,==,1);
    g_object_unref(owner);
  } else if(!strcmp(argv[1],"collapse-unmap")) {
    GtkWidget *other=widget(TRUE);window_ref(owner,popup);window_ref(owner,other);
    window_collapse_popups(owner);g_assert_false(window_ref_check(owner));
    g_assert_false(popup->visible);g_assert_false(other->visible);
    g_assert_cmpuint(notified,==,1);g_object_unref(other);
    g_object_unref(popup);g_object_unref(owner);
  } else if(!strcmp(argv[1],"explicit-release")) {
    window_ref(owner,popup);window_unref(popup,owner);window_unref(popup,owner);
    gtk_widget_hide(popup);g_object_unref(popup);
    g_assert_cmpuint(notified,==,1);g_object_unref(owner);
  } else if(!strcmp(argv[1],"self-association")) {
    window_ref(owner,owner);window_unref(owner,owner);window_unref(owner,owner);
    g_assert_cmpuint(notified,==,1);g_assert_false(window_ref_check(owner));
    g_object_unref(popup);g_object_unref(owner);
  } else if(!strcmp(argv[1],"legacy-normalization")) {
    g_signal_connect(popup,"unmap",G_CALLBACK(window_unref),owner);
    window_ref(owner,popup);gtk_widget_hide(popup);
    g_assert_cmpuint(notified,==,1);g_object_unref(popup);g_object_unref(owner);
  } else if(!strcmp(argv[1],"collapse-reentrant")) {
    GtkWidget *other=widget(TRUE);window_ref(owner,popup);window_ref(owner,other);
    g_signal_connect(other,"unmap",G_CALLBACK(drop_sibling),&popup);
    window_collapse_popups(owner);g_assert_false(window_ref_check(owner));
    g_assert_null(popup);g_assert_false(other->visible);
    g_assert_cmpuint(notified,==,1);g_object_unref(other);g_object_unref(owner);
  } else g_assert_not_reached();
  g_assert_cmpuint(g_hash_table_size(live),==,0);
  g_hash_table_unref(live);
  g_print("PASS %s\n",argv[1]);return 0;
}
