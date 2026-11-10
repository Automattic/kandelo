/* SPDX-License-Identifier: Apache-2.0 */
#include "binding-contract.h"
void binding_test_weak_notify(gpointer data, GObject *where_object_was) {
  BindingTestWeak *weak = data;
  g_assert_true(where_object_was == weak->expected);
  g_assert_cmpuint(++weak->calls, ==, 1);
}
static gboolean transform(GBinding *binding, const GValue *from, GValue *to,
                          BindingTestData *data, guint direction, gint delta) {
  g_assert_true(G_IS_BINDING(binding));
  g_assert_true(G_VALUE_HOLDS_INT(from));
  g_assert_true(G_VALUE_HOLDS_INT(to));
  ++data->stats->transformed[direction];
  g_value_set_int(to, g_value_get_int(from) + delta);
  return TRUE;
}
gboolean binding_test_transform_to(GBinding *binding, const GValue *from, GValue *to, gpointer data) {
  return transform(binding, from, to, data, 0, 10);
}
gboolean binding_test_transform_from(GBinding *binding, const GValue *from, GValue *to, gpointer data) {
  return transform(binding, from, to, data, 1, -10);
}
gboolean binding_test_closure_transform(GBinding *binding, const GValue *from, GValue *to, gpointer data) {
  BindingTestData *owned = data;
  return transform(binding, from, to, owned, owned->direction, owned->delta);
}
void binding_test_closure_cleanup(gpointer data, GClosure *closure) {
  BindingTestData *owned = data;
  g_assert_true(closure == owned->expected_closure);
  g_assert_cmpuint(++owned->stats->closure_cleanup[owned->direction], ==, 1);
  g_free(owned);
}
void binding_test_full_cleanup(gpointer data) {
  BindingTestData *owned = data;
  g_assert_cmpuint(++owned->stats->full_cleanup, ==, 1);
  g_free(owned);
}
_Static_assert(__builtin_types_compatible_p(__typeof__(&binding_test_weak_notify), GWeakNotify), "weak notify contract");
_Static_assert(__builtin_types_compatible_p(__typeof__(&binding_test_transform_to), GBindingTransformFunc), "transform-to contract");
_Static_assert(__builtin_types_compatible_p(__typeof__(&binding_test_transform_from), GBindingTransformFunc), "transform-from contract");
_Static_assert(__builtin_types_compatible_p(__typeof__(&binding_test_closure_transform), GBindingTransformFunc), "closure callback contract");
_Static_assert(__builtin_types_compatible_p(__typeof__(&binding_test_closure_cleanup), GClosureNotify), "closure cleanup contract");
_Static_assert(__builtin_types_compatible_p(__typeof__(&binding_test_full_cleanup), GDestroyNotify), "full cleanup contract");
