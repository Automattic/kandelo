/* SPDX-License-Identifier: Apache-2.0 */
/* Actual installed GObject APIs only. No copied binding implementation. */
#include "binding-contract.h"
#include <stdio.h>
#include <string.h>
typedef struct { GObject parent; gint value; BindingTestStats *stats; guint endpoint; } BindingTestObject;
typedef struct { GObjectClass parent; } BindingTestObjectClass;
G_DEFINE_TYPE(BindingTestObject, binding_test_object, G_TYPE_OBJECT)
static GParamSpec *value_pspec;
static void binding_test_object_set_property(GObject *object, guint id, const GValue *value, GParamSpec *pspec) {
  BindingTestObject *self = (BindingTestObject *)object;
  if (id != 1) { G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, pspec); return; }
  if (self->value != g_value_get_int(value)) {
    self->value = g_value_get_int(value);
    g_object_notify_by_pspec(object, value_pspec);
  }
}
static void binding_test_object_get_property(GObject *object, guint id, GValue *value, GParamSpec *pspec) {
  if (id == 1) g_value_set_int(value, ((BindingTestObject *)object)->value);
  else G_OBJECT_WARN_INVALID_PROPERTY_ID(object, id, pspec);
}
static void binding_test_object_finalize(GObject *object) {
  BindingTestObject *self = (BindingTestObject *)object;
  g_assert_nonnull(self->stats);
  g_assert_cmpuint(++self->stats->finalized[self->endpoint], ==, 1);
  G_OBJECT_CLASS(binding_test_object_parent_class)->finalize(object);
}
static void binding_test_object_class_init(BindingTestObjectClass *klass) {
  GObjectClass *object = G_OBJECT_CLASS(klass);
  object->set_property = binding_test_object_set_property;
  object->get_property = binding_test_object_get_property;
  object->finalize = binding_test_object_finalize;
  value_pspec = g_param_spec_int("value", "value", "Observable binding value", -100000, 100000, 0,
                                G_PARAM_READWRITE | G_PARAM_EXPLICIT_NOTIFY | G_PARAM_STATIC_STRINGS);
  g_object_class_install_property(object, 1, value_pspec);
}
static void binding_test_object_init(BindingTestObject *self) { (void)self; }
static BindingTestObject *new_endpoint(BindingTestStats *stats, guint endpoint, BindingTestWeak *weak) {
  BindingTestObject *object = g_object_new(binding_test_object_get_type(), NULL);
  object->stats = stats; object->endpoint = endpoint;
  weak->expected = G_OBJECT(object);
  g_object_weak_ref(G_OBJECT(object), binding_test_weak_notify, weak);
  return object;
}
static gint get_value(BindingTestObject *object) {
  gint value; g_object_get(object, "value", &value, NULL); return value;
}
static GClosure *new_transform(BindingTestStats *stats, guint direction) {
  BindingTestData *data = g_new0(BindingTestData, 1);
  data->stats = stats; data->direction = direction; data->delta = direction ? -100 : 100;
  GClosure *closure = g_cclosure_new(G_CALLBACK(binding_test_closure_transform), data,
                                    binding_test_closure_cleanup);
  data->expected_closure = closure;
  /* Own one nonfloating caller reference, independently of the binding. */
  g_closure_ref(closure); g_closure_sink(closure);
  return closure;
}
static void check_bound(GBinding *binding, BindingTestObject *source, BindingTestObject *target) {
  GObject *s = g_binding_dup_source(binding), *t = g_binding_dup_target(binding);
  g_assert_true(s == G_OBJECT(source)); g_assert_true(t == G_OBJECT(target));
  g_object_unref(s); g_object_unref(t);
  g_assert_cmpstr(g_binding_get_source_property(binding), ==, "value");
  g_assert_cmpstr(g_binding_get_target_property(binding), ==, "value");
}
int main(int argc, char **argv) {
  if (argc != 3) { fprintf(stderr, "usage: binding-lifecycle oneway|bidi|full|closures unbind|source|target\n"); return 2; }
  const gboolean oneway = strcmp(argv[1], "oneway") == 0;
  const gboolean bidi = strcmp(argv[1], "bidi") == 0;
  const gboolean full = strcmp(argv[1], "full") == 0;
  const gboolean closures = strcmp(argv[1], "closures") == 0;
  const gboolean unbind = strcmp(argv[2], "unbind") == 0;
  const gboolean destroy_source = strcmp(argv[2], "source") == 0;
  const gboolean destroy_target = strcmp(argv[2], "target") == 0;
  if (!(oneway || bidi || full || closures) || !(unbind || destroy_source || destroy_target)) return 2;
  g_log_set_always_fatal(G_LOG_FATAL_MASK | G_LOG_LEVEL_WARNING | G_LOG_LEVEL_CRITICAL);
  BindingTestStats stats = {0}; BindingTestWeak weak[3] = {{0}};
  BindingTestObject *source = new_endpoint(&stats, 0, &weak[0]);
  BindingTestObject *target = new_endpoint(&stats, 1, &weak[1]);
  g_object_set(source, "value", 11, NULL); g_object_set(target, "value", 3, NULL);
  GBinding *binding; GClosure *to = NULL, *from = NULL;
  const GBindingFlags flags = G_BINDING_BIDIRECTIONAL | G_BINDING_SYNC_CREATE;
  const gint delta = full ? 10 : closures ? 100 : 0;
  if (full) {
    BindingTestData *data = g_new0(BindingTestData, 1); data->stats = &stats;
    binding = g_object_bind_property_full(source, "value", target, "value", flags,
      binding_test_transform_to, binding_test_transform_from, data, binding_test_full_cleanup);
  } else if (closures) {
    to = new_transform(&stats, 0); from = new_transform(&stats, 1);
    binding = g_object_bind_property_with_closures(source, "value", target, "value", flags, to, from);
  } else binding = g_object_bind_property(source, "value", target, "value", oneway ? G_BINDING_DEFAULT : flags);
  g_assert_nonnull(binding); g_object_ref(binding);
  weak[2].expected = G_OBJECT(binding);
  g_object_weak_ref(G_OBJECT(binding), binding_test_weak_notify, &weak[2]);
  check_bound(binding, source, target);
  g_assert_cmpint(get_value(target), ==, oneway ? 3 : 11 + delta);
  g_object_set(source, "value", 42, NULL);
  g_assert_cmpint(get_value(target), ==, 42 + delta);
  g_object_set(target, "value", 90 + delta, NULL);
  g_assert_cmpint(get_value(source), ==, oneway ? 42 : 90);
  if (full || closures) {
    g_assert_cmpuint(stats.transformed[0], ==, 2);
    g_assert_cmpuint(stats.transformed[1], ==, 1);
  }
  g_assert_cmpuint(stats.full_cleanup, ==, 0);
  g_assert_cmpuint(stats.closure_cleanup[0] + stats.closure_cleanup[1], ==, 0);
  /* For automatic teardown the binding is the sole closure owner. For
   * explicit unbind retain caller closure refs to prove delayed cleanup. */
  if (closures && !unbind) { g_closure_unref(to); g_closure_unref(from); to = from = NULL; }
  printf("BINDING_PROPAGATION_OK %s %s\nBINDING_TEARDOWN_BEGIN %s %s\n", argv[1], argv[2], argv[1], argv[2]); fflush(stdout);
  if (unbind) g_binding_unbind(binding);
  else if (destroy_source) { g_object_unref(source); source = NULL; }
  else { g_object_unref(target); target = NULL; }
  g_assert_null(g_binding_dup_source(binding)); g_assert_null(g_binding_dup_target(binding));
  g_assert_cmpuint(weak[2].calls, ==, 0); /* caller reference still owns binding */
  g_assert_cmpuint(stats.full_cleanup, ==, full ? 1 : 0);
  for (guint i = 0; i < 2; ++i) g_assert_cmpuint(stats.closure_cleanup[i], ==, closures && !unbind ? 1 : 0);
  const guint transforms_before = stats.transformed[0] + stats.transformed[1];
  if (source) { g_object_set(source, "value", 123, NULL); g_assert_cmpint(get_value(source), ==, 123); }
  if (target) { g_object_set(target, "value", 321, NULL); g_assert_cmpint(get_value(target), ==, 321); }
  if (source && target) g_assert_cmpint(get_value(source), ==, 123);
  g_assert_cmpuint(stats.transformed[0] + stats.transformed[1], ==, transforms_before);
  /* Safe because caller owns binding: duplicate unbind must be effect-free. */
  g_binding_unbind(binding);
  if (to) { g_closure_unref(to); g_closure_unref(from); }
  for (guint i = 0; i < 2; ++i) g_assert_cmpuint(stats.closure_cleanup[i], ==, closures ? 1 : 0);
  g_object_unref(binding); g_assert_cmpuint(weak[2].calls, ==, 1);
  if (source) g_object_unref(source);
  if (target) g_object_unref(target);
  for (guint i = 0; i < 2; ++i) {
    g_assert_cmpuint(stats.finalized[i], ==, 1); g_assert_cmpuint(weak[i].calls, ==, 1);
  }
  g_assert_cmpuint(stats.full_cleanup, ==, full ? 1 : 0);
  printf("BINDING_LIFECYCLE_OK %s %s\n", argv[1], argv[2]);
  return 0;
}
