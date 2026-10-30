/* SPDX-License-Identifier: Apache-2.0 */
#ifndef GOBJECT_CALLBACK_CONTRACT_H
#define GOBJECT_CALLBACK_CONTRACT_H
#include <glib-object.h>
#include <ffi.h>
#define CASES(X) \
 X(i64_positive, gint64, G_TYPE_INT64, G_GINT64_CONSTANT(0x1234567887654321)) \
 X(i64_negative, gint64, G_TYPE_INT64, -G_GINT64_CONSTANT(0x1234567887654321)) \
 X(u64, guint64, G_TYPE_UINT64, G_GUINT64_CONSTANT(0xfedcba9876543210)) \
 X(real, gdouble, G_TYPE_DOUBLE, 12345.125) \
 X(pointer, gpointer, G_TYPE_POINTER, (gpointer)&contract_cookie) \
 X(enumeration, gint, contract_enum_type(), -30) \
 X(flags, guint, contract_flags_type(), 0xa5a50002u)
extern guint contract_cookie;
extern guint callback_count;
extern gpointer contract_instance;
GType contract_enum_type(void);
GType contract_flags_type(void);
#define DECLARE(name, ctype, gtype, result) \
 ctype normal_##name(gpointer instance, gint argument, gpointer data); \
 ctype swapped_##name(gpointer data, gint argument, gpointer instance); \
 ctype virtual_##name(gpointer instance, gint argument);
CASES(DECLARE)
#undef DECLARE
#endif
