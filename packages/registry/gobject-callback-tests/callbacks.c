/* SPDX-License-Identifier: Apache-2.0 */
/* Separate TU: the caller cannot optimize away the actual ABI boundary. */
#include "contract.h"
guint contract_cookie = 0x69a5;
guint callback_count;
gpointer contract_instance;
#define DEFINE(name, ctype, gtype, result) \
 ctype normal_##name(gpointer instance, gint argument, gpointer data) { \
  g_assert_true(instance == contract_instance); g_assert_cmpint(argument, ==, -153); \
  g_assert_true(data == &contract_cookie); ++callback_count; return result; } \
 ctype swapped_##name(gpointer data, gint argument, gpointer instance) { \
  return normal_##name(instance, argument, data); } \
 ctype virtual_##name(gpointer instance, gint argument) { \
  return normal_##name(instance, argument, &contract_cookie); }
CASES(DEFINE)
#undef DEFINE
GType contract_enum_type(void) {
 static GType type;
 if (!type) { static const GEnumValue values[]={{-30,"negative","negative"},{0,NULL,NULL}};
  type=g_enum_register_static("ContractEnum",values); }
 return type;
}
GType contract_flags_type(void) {
 static GType type;
 if (!type) { static const GFlagsValue values[]={{0xa5a50002u,"bits","bits"},{0,NULL,NULL}};
  type=g_flags_register_static("ContractFlags",values); }
 return type;
}
