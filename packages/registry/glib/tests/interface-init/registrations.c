#include "contract.h"
#include "control-macros.h"

void register_case(int which) {
  unsigned g_define_type_id = 1;
  gpointer type_module = (gpointer)1;
  switch (which) {
  case 0: G_IMPLEMENT_INTERFACE_UNARY(17, callback_one); break;
  case 1: G_IMPLEMENT_INTERFACE(17, callback_two); break;
  case 2: G_IMPLEMENT_INTERFACE(17, callback_typed_two); break;
  case 3: G_IMPLEMENT_INTERFACE(17, NULL); break;
  case 4: G_IMPLEMENT_INTERFACE_DYNAMIC_UNARY(17, callback_one); break;
  case 5: G_IMPLEMENT_INTERFACE_DYNAMIC(17, callback_two); break;
  case 6: G_IMPLEMENT_INTERFACE_DYNAMIC(17, callback_typed_two); break;
  case 7: G_IMPLEMENT_INTERFACE_DYNAMIC(17, NULL); break;
  case 8: OLD_G_IMPLEMENT_INTERFACE(17, callback_two); break;
  case 9: OLD_G_IMPLEMENT_INTERFACE_DYNAMIC(17, callback_two); break;
  case 10: G_IMPLEMENT_INTERFACE_UNARY(17, NULL); break;
  case 11: G_IMPLEMENT_INTERFACE_DYNAMIC_UNARY(17, NULL); break;
  }
}
