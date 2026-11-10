#include <glib-object.h>
#undef G_IMPLEMENT_INTERFACE
#undef G_IMPLEMENT_INTERFACE_DYNAMIC
#include "control-macros.h"

typedef GTypeInterface ControlInterface;
static unsigned invoked;
static void unary(ControlInterface *iface) { g_assert_nonnull(iface); invoked++; }
static void binary(gpointer iface, gpointer data) {
  g_assert_nonnull(iface); g_assert_null(data); invoked++;
}
static void typed_binary(ControlInterface *iface, gpointer data) {
  g_assert_nonnull(iface); g_assert_null(data); invoked++;
}
void g_wasm_iface_init_thunk(gpointer iface, gpointer callback);

int main(void) {
  GType iface_type = g_type_register_static_simple(G_TYPE_INTERFACE,
    "ContractInterface", sizeof(ControlInterface), NULL, 0, NULL, 0);
  g_type_interface_add_prerequisite(iface_type, G_TYPE_OBJECT);
  const char *names[] = { "ContractUnary", "ContractBinary", "ContractTypedBinary", "ContractNull" };
  for (unsigned which = 0; which < G_N_ELEMENTS(names); which++) {
    GType g_define_type_id = g_type_register_static_simple(G_TYPE_OBJECT,
      names[which], sizeof(GObjectClass), NULL, sizeof(GObject), NULL, 0);
    invoked = 0;
    switch (which) {
    case 0: G_IMPLEMENT_INTERFACE_UNARY(iface_type, unary); break;
    case 1: G_IMPLEMENT_INTERFACE(iface_type, binary); break;
    case 2: G_IMPLEMENT_INTERFACE(iface_type, typed_binary); break;
    case 3: G_IMPLEMENT_INTERFACE(iface_type, NULL); break;
    }
    GObject *object = g_object_new(g_define_type_id, NULL);
    g_assert_nonnull(object);
    g_assert_cmpuint(invoked, ==, which == 3 ? 0 : 1);
    g_object_unref(object);
  }
  g_print("native GObject: unary, binary, typed binary and NULL construction passed\n");
  return 0;
}
