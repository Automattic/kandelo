#include "contract.h"
static GInterfaceInfo selected;
void g_type_add_interface_static(unsigned type, unsigned iface,
                                 const GInterfaceInfo *info) {
  (void)type; (void)iface;
  selected = *info;
}
void g_type_module_add_interface(gpointer module, unsigned type, unsigned iface,
                                 const GInterfaceInfo *info) {
  (void)module;
  g_type_add_interface_static(type, iface, info);
}
int run_case(int which) {
  Payload payload = { 0 };
  selected = (GInterfaceInfo){ NULL, NULL, NULL };
  callback_count = 0;
  register_case(which);
  if (selected.interface_init)
    selected.interface_init(&payload, selected.interface_data);
  return payload.value;
}
int calls(void) { return callback_count; }
