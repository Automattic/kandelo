/* SPDX-License-Identifier: Apache-2.0 */
/* Real installed GLib/GObject and libffi API control, no host adapters or stubs. */
#include "contract.h"
#include <stdarg.h>
#include <string.h>

typedef struct { GObject parent; } ContractObject;
typedef struct {
 GObjectClass parent;
#define SLOT(name,ctype,gtype,result) ctype (*name)(gpointer instance,gint argument);
 CASES(SLOT)
#undef SLOT
 void (*object_signal)(GObject *instance, GObject *argument);
 void (*realize_signal)(GObject *instance);
} ContractObjectClass;
G_DEFINE_TYPE(ContractObject,contract_object,G_TYPE_OBJECT)
static guint signal_ids[7], object_signal_id, realize_signal_id;
static void contract_object_init(ContractObject *self) { (void)self; }
static void contract_object_class_init(ContractObjectClass *klass) {
 guint i=0;
#define INSTALL(name,ctype,gtype,result) \
 klass->name=virtual_##name; \
 signal_ids[i++]=g_signal_new(#name, G_TYPE_FROM_CLASS(klass), G_SIGNAL_RUN_LAST, \
 G_STRUCT_OFFSET(ContractObjectClass,name),NULL,NULL,NULL,gtype,1,G_TYPE_INT);
 CASES(INSTALL)
#undef INSTALL
 klass->object_signal = virtual_object;
 klass->realize_signal = virtual_realize;
 object_signal_id = g_signal_new("object-signal", G_TYPE_FROM_CLASS(klass),
  G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(ContractObjectClass, object_signal),
  NULL, NULL, NULL, G_TYPE_NONE, 1, G_TYPE_OBJECT);
 realize_signal_id = g_signal_new("realize-signal", G_TYPE_FROM_CLASS(klass),
  G_SIGNAL_RUN_LAST, G_STRUCT_OFFSET(ContractObjectClass, realize_signal),
  NULL, NULL, NULL, G_TYPE_NONE, 0);
}
static void check_value(guint which,const GValue *value) {
 switch(which) {
 case 0:g_assert_cmpint(g_value_get_int64(value),==,G_GINT64_CONSTANT(0x1234567887654321));break;
 case 1:g_assert_cmpint(g_value_get_int64(value),==,-G_GINT64_CONSTANT(0x1234567887654321));break;
 case 2:g_assert_cmpuint(g_value_get_uint64(value),==,G_GUINT64_CONSTANT(0xfedcba9876543210));break;
 case 3:g_assert_cmpfloat(g_value_get_double(value),==,12345.125);break;
 case 4:g_assert_true(g_value_get_pointer(value)==&contract_cookie);break;
 case 5:g_assert_cmpint(g_value_get_enum(value),==,-30);break;
 case 6:g_assert_cmpuint(g_value_get_flags(value),==,0xa5a50002u);break;
 default:g_assert_not_reached();
 }
}
static GType result_types[7];
static void invoke_generic_va(GClosure *closure,GValue *result,...) {
 va_list args;GType types[]={G_TYPE_INT};va_start(args,result);
 g_cclosure_marshal_generic_va(closure,result,contract_instance,args,NULL,1,types);
 va_end(args);
}
static void generic_case(guint which,gboolean swap,gboolean valist) {
 GCallback callbacks[]={
#define ENTRY(name,ctype,gtype,result) G_CALLBACK(normal_##name),
 CASES(ENTRY)
#undef ENTRY
 };
 GCallback swapped[]={
#define ENTRY(name,ctype,gtype,result) G_CALLBACK(swapped_##name),
 CASES(ENTRY)
#undef ENTRY
 };
 GClosure *closure=(swap?g_cclosure_new_swap:g_cclosure_new)(swap?swapped[which]:callbacks[which],&contract_cookie,NULL);
 GValue result=G_VALUE_INIT,params[2]={G_VALUE_INIT,G_VALUE_INIT};
 g_value_init(&result,result_types[which]);
 g_value_init(&params[0],G_TYPE_OBJECT);g_value_set_object(&params[0],contract_instance);
 g_value_init(&params[1],G_TYPE_INT);g_value_set_int(&params[1],-153);
 if(valist)invoke_generic_va(closure,&result,-153);
 else g_cclosure_marshal_generic(closure,&result,2,params,NULL,NULL);
 check_value(which,&result);g_value_unset(&result);
 g_value_unset(&params[0]);g_value_unset(&params[1]);g_closure_unref(closure);
}
static void virtual_case(guint which,gboolean valist) {
 if(valist) {
  guint i=0;
#define EMIT(name,ctype,gtype,result) \
  if(which==i++){ctype value;g_signal_emit(contract_instance,signal_ids[which],0,-153,&value);g_assert_true(value==(result));}
 CASES(EMIT)
#undef EMIT
 } else {
  GValue result=G_VALUE_INIT,params[2]={G_VALUE_INIT,G_VALUE_INIT};
  g_value_init(&result,result_types[which]);
  g_value_init(&params[0],G_TYPE_OBJECT);g_value_set_object(&params[0],contract_instance);
  g_value_init(&params[1],G_TYPE_INT);g_value_set_int(&params[1],-153);
  g_signal_emitv(params,signal_ids[which],0,&result);check_value(which,&result);
  g_value_unset(&result);g_value_unset(&params[0]);g_value_unset(&params[1]);
 }
}
/* Exercise generated VOID__OBJECT / VOID__VOID marshallers and the separate
 * class meta path through real signal emission. Route0 is class-only; routes
 * 1/2 add normal/swapped handlers and verify disconnect-by-function identity. */
static void signal_emit_once(gboolean object, gboolean valist) {
 guint id = object ? object_signal_id : realize_signal_id;
 if (valist) {
  if (object) g_signal_emit(contract_instance, id, 0, contract_argument);
  else g_signal_emit(contract_instance, id, 0);
 } else {
  GValue values[2] = {G_VALUE_INIT, G_VALUE_INIT};
  g_value_init(&values[0], G_TYPE_OBJECT);
  g_value_set_object(&values[0], contract_instance);
  if (object) {
   g_value_init(&values[1], G_TYPE_OBJECT);
   g_value_set_object(&values[1], contract_argument);
  }
  g_signal_emitv(values, id, 0, NULL);
  if (object) g_value_unset(&values[1]);
  g_value_unset(&values[0]);
 }
}
static void signal_case(gboolean object, gboolean valist, guint route) {
 GCallback handler = NULL;
 const gchar *name = object ? "object-signal" : "realize-signal";
 g_assert_cmpuint(route, <, 3);
 contract_argument = g_object_new(G_TYPE_OBJECT, NULL);
 g_assert_true(contract_argument != contract_instance);
 if (route) {
  handler = object ? (route == 2 ? G_CALLBACK(swapped_object) : G_CALLBACK(normal_object))
                   : (route == 2 ? G_CALLBACK(swapped_realize) : G_CALLBACK(normal_realize));
  g_signal_connect_data(contract_instance, name, handler, &contract_cookie,
                        NULL, route == 2 ? G_CONNECT_SWAPPED : G_CONNECT_DEFAULT);
 }
 signal_emit_once(object, valist);
 g_assert_cmpuint(signal_class_count, ==, 1);
 g_assert_cmpuint(signal_handler_count, ==, route ? 1 : 0);
 if (route)
  g_assert_cmpuint(g_signal_handlers_disconnect_by_func(contract_instance, handler,
                                                       &contract_cookie), ==, 1);
 signal_emit_once(object, valist);
 g_assert_cmpuint(signal_class_count, ==, 2);
 g_assert_cmpuint(signal_handler_count, ==, route ? 1 : 0);
 g_assert_cmpuint(callback_count, ==, route ? 3 : 2);
 g_object_unref(contract_argument);
 contract_argument = NULL;
}
static gboolean quit_source(gpointer data) { ++*(guint*)data;return G_SOURCE_REMOVE; }
static void source_case(void) {
 guint called=0;GSource *source=g_idle_source_new();GMainContext *context=g_main_context_new();
 GClosure *closure=g_cclosure_new(G_CALLBACK(quit_source),&called,NULL);
 g_source_set_closure(source,closure);g_source_attach(source,context);
 g_assert_true(g_main_context_iteration(context,FALSE));g_assert_cmpuint(called,==,1);
 g_source_destroy(source);g_source_unref(source);g_main_context_unref(context);
}
/* Check the actual ffi return buffer contract independently of GLib's
 * GValue conversion. Integer values wider than ffi_arg retain their width. */
static void ffi_case(guint which) {
 GCallback callbacks[]={
#define ENTRY(name,ctype,gtype,result) G_CALLBACK(normal_##name),
 CASES(ENTRY)
#undef ENTRY
 };
 ffi_type *returns[]={&ffi_type_sint64,&ffi_type_sint64,&ffi_type_uint64,
  &ffi_type_double,&ffi_type_pointer,&ffi_type_sint,&ffi_type_uint};
 ffi_type *types[]={&ffi_type_pointer,&ffi_type_sint,&ffi_type_pointer};
 gpointer instance=contract_instance,data=&contract_cookie;gint argument=-153;
 void *args[]={&instance,&argument,&data};ffi_cif cif;
 union { ffi_arg word;gint64 signed64;guint64 unsigned64;gdouble real;gpointer pointer; } value;
 memset(&value,0x69,sizeof value);
 g_assert_cmpint(ffi_prep_cif(&cif,FFI_DEFAULT_ABI,3,returns[which],types),==,FFI_OK);
 ffi_call(&cif,(void (*)(void))callbacks[which],&value,args);
 switch(which) {
 case 0:g_assert_cmpint(value.signed64,==,G_GINT64_CONSTANT(0x1234567887654321));break;
 case 1:g_assert_cmpint(value.signed64,==,-G_GINT64_CONSTANT(0x1234567887654321));break;
 case 2:g_assert_cmpuint(value.unsigned64,==,G_GUINT64_CONSTANT(0xfedcba9876543210));break;
 case 3:g_assert_cmpfloat(value.real,==,12345.125);break;
 case 4:g_assert_true(value.pointer==&contract_cookie);break;
 case 5:g_assert_cmpint((gint)value.word,==,-30);break;
 case 6:g_assert_cmpuint((guint)value.word,==,0xa5a50002u);break;
 default:g_assert_not_reached();
 }
}
/* Isolate each case in an ordinary guest process: a Wasm signature trap must
 * remain a failure, and must not hide later matrix cases behind the same exit. */
int main(int argc,char **argv) {
 g_assert_cmpint(argc,>=,2);
 if(!strcmp(argv[1],"source-closure")){source_case();g_print("GOBJECT_CALLBACK_OK source-closure\n");return 0;}
 contract_instance=g_object_new(contract_object_get_type(),NULL);
 guint i=0;
#define TYPE(name,ctype,gtype,result) result_types[i++]=gtype;
 CASES(TYPE)
#undef TYPE
 g_assert_cmpint(argc,==,3);guint which=(guint)g_ascii_strtoull(argv[2],NULL,10);g_assert_cmpuint(which,<,7);
 if(!strcmp(argv[1],"signal-object-value") || !strcmp(argv[1],"signal-object-va") ||
    !strcmp(argv[1],"signal-realize-value") || !strcmp(argv[1],"signal-realize-va")) {
  signal_case(g_str_has_prefix(argv[1], "signal-object-"), g_str_has_suffix(argv[1], "-va"), which);
  g_object_unref(contract_instance);
  g_print("GOBJECT_CALLBACK_OK %s %u\n",argv[1],which);return 0;
 }
 if(!strcmp(argv[1],"ffi-raw"))ffi_case(which);
 else if(!strcmp(argv[1],"generic-value"))generic_case(which,FALSE,FALSE);
 else if(!strcmp(argv[1],"generic-va"))generic_case(which,FALSE,TRUE);
 else if(!strcmp(argv[1],"swapped-value"))generic_case(which,TRUE,FALSE);
 else if(!strcmp(argv[1],"swapped-va"))generic_case(which,TRUE,TRUE);
 else if(!strcmp(argv[1],"vtable-value"))virtual_case(which,FALSE);
 else if(!strcmp(argv[1],"vtable-va"))virtual_case(which,TRUE);
 else g_assert_not_reached();
 g_assert_cmpuint(callback_count,==,1);g_object_unref(contract_instance);
 g_print("GOBJECT_CALLBACK_OK %s %u\n",argv[1],which);return 0;
}
