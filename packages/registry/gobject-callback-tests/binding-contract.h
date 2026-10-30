/* SPDX-License-Identifier: Apache-2.0 */
#ifndef BINDING_LIFECYCLE_CONTRACT_H
#define BINDING_LIFECYCLE_CONTRACT_H
#include <glib-object.h>
typedef struct {
  guint finalized[2], transformed[2], closure_cleanup[2], full_cleanup;
} BindingTestStats;
typedef struct { GObject *expected; guint calls; } BindingTestWeak;
typedef struct {
  BindingTestStats *stats;
  guint direction;
  gint delta;
  GClosure *expected_closure;
} BindingTestData;
void binding_test_weak_notify(gpointer data, GObject *where_object_was);
gboolean binding_test_transform_to(GBinding *binding, const GValue *from, GValue *to, gpointer data);
gboolean binding_test_transform_from(GBinding *binding, const GValue *from, GValue *to, gpointer data);
gboolean binding_test_closure_transform(GBinding *binding, const GValue *from, GValue *to, gpointer data);
void binding_test_closure_cleanup(gpointer data, GClosure *closure);
void binding_test_full_cleanup(gpointer data);
#endif
