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

/* Class virtuals omit closure data; connected handlers retain it, including
 * swapped handlers. All pointers are non-NULL and distinguishable. */
GObject *contract_argument;
guint signal_class_count, signal_handler_count;
void virtual_object(GObject *instance, GObject *argument) {
 g_assert_true(instance == contract_instance);
 g_assert_true(argument == contract_argument);
 ++signal_class_count; ++callback_count;
}
void normal_object(GObject *instance, GObject *argument, gpointer data) {
 g_assert_true(instance == contract_instance);
 g_assert_true(argument == contract_argument);
 g_assert_true(data == &contract_cookie);
 ++signal_handler_count; ++callback_count;
}
void swapped_object(gpointer data, GObject *argument, GObject *instance) {
 normal_object(instance, argument, data);
}
void virtual_realize(GObject *instance) {
 g_assert_true(instance == contract_instance);
 ++signal_class_count; ++callback_count;
}
void normal_realize(GObject *instance, gpointer data) {
 g_assert_true(instance == contract_instance);
 g_assert_true(data == &contract_cookie);
 ++signal_handler_count; ++callback_count;
}
void swapped_realize(gpointer data, GObject *instance) {
 normal_realize(instance, data);
}
