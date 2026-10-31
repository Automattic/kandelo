/* Actual GTK helper/adaptor definitions are extracted into a separate TU. */
#include <gtk/gtk.h>
#include <string.h>
extern GCallback gtk_contract_handler(gboolean object);
extern GCallback gtk_contract_class_handler(gboolean object);
typedef struct { GObject parent; } GtkContract;
typedef struct {
 GObjectClass parent;
 void (*object)(GtkWidget *, GtkWidget *);
 void (*realize)(GtkWidget *);
} GtkContractClass;
G_DEFINE_TYPE(GtkContract,gtk_contract,G_TYPE_OBJECT)
static guint object_id,realize_id,diagnostics;
static gboolean class_route;
static void gtk_contract_init(GtkContract *self) { (void)self; }
static void gtk_contract_class_init(GtkContractClass *klass) {
 if (class_route) {
  klass->object=(void (*)(GtkWidget *,GtkWidget *))gtk_contract_class_handler(TRUE);
  klass->realize=(void (*)(GtkWidget *))gtk_contract_class_handler(FALSE);
 }
 object_id=g_signal_new("object-signal",G_TYPE_FROM_CLASS(klass),G_SIGNAL_RUN_LAST,
  G_STRUCT_OFFSET(GtkContractClass,object),NULL,NULL,NULL,G_TYPE_NONE,1,G_TYPE_OBJECT);
 realize_id=g_signal_new("realize-signal",G_TYPE_FROM_CLASS(klass),G_SIGNAL_RUN_LAST,
  G_STRUCT_OFFSET(GtkContractClass,realize),NULL,NULL,NULL,G_TYPE_NONE,0);
}
static void expected_critical(const gchar *domain,GLogLevelFlags level,
                              const gchar *message,gpointer data) {
 (void)level;(void)data;
 g_assert_cmpstr(domain,==,"Gtk");
 g_assert_nonnull(strstr(message,"GTK_IS_WIDGET (widget)"));
 ++diagnostics;
 g_print("EXPECTED_GTK_PRECONDITION %s\n",message);
}
int main(int argc,char **argv) {
 g_assert_cmpint(argc,==,4);
 gboolean object=!strcmp(argv[1],"object"),va=!strcmp(argv[3],"va");
 class_route=!strcmp(argv[2],"class");
 GObject *instance=g_object_new(gtk_contract_get_type(),NULL);
 guint id=object?object_id:realize_id;
 if(!class_route)g_signal_connect_data(instance,object?"object-signal":"realize-signal",
  gtk_contract_handler(object),instance,NULL,
  !strcmp(argv[2],"swapped")?G_CONNECT_SWAPPED:G_CONNECT_DEFAULT);
 guint log=g_log_set_handler("Gtk",G_LOG_LEVEL_CRITICAL,expected_critical,NULL);
 if(va) {
  if(object)g_signal_emit(instance,id,0,NULL);
  else g_signal_emit(instance,id,0);
 } else {
  GValue values[2]={G_VALUE_INIT,G_VALUE_INIT};
  g_value_init(&values[0],G_TYPE_OBJECT);g_value_set_object(&values[0],instance);
  if(object)g_value_init(&values[1],G_TYPE_OBJECT);
  g_signal_emitv(values,id,0,NULL);
  if(object)g_value_unset(&values[1]);
  g_value_unset(&values[0]);
 }
 g_log_remove_handler("Gtk",log);
 g_assert_cmpuint(diagnostics,==,2);
 g_object_unref(instance);
 g_print("GTK_SIGNAL_CONTRACT_OK %s %s %s\n",argv[1],argv[2],argv[3]);return 0;
}
