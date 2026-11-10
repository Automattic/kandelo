/* Source-isolated ABI admission model, not a replacement GObject runtime. */
#include <stdarg.h>
#include <stdint.h>
#include <stddef.h>
typedef uintptr_t guintptr;typedef void *gpointer;typedef char gchar;typedef unsigned guint;typedef int gint;typedef unsigned GType;typedef unsigned GSignalFlags;typedef int GSignalAccumulator;typedef void (*GCallback)(void);
typedef struct {unsigned type;union{int i;int64_t i64;double d;void *p;} value;} GValue;
typedef struct Closure GClosure;
typedef void (*GClosureMarshal)(GClosure*,GValue*,guint,const GValue*,gpointer,gpointer);
typedef void (*GVaClosureMarshal)(GClosure*,GValue*,gpointer,va_list,gpointer,int,GType*);
typedef GClosureMarshal GSignalCMarshaller;
struct Closure{gpointer data;gpointer callback;GClosureMarshal meta;GVaClosureMarshal meta_va;};typedef GClosure GCClosure;
#define G_TYPE_NONE 0
#define G_CCLOSURE_SWAP_DATA(c) 0
#define g_return_if_fail(x) do{if(!(x))return;}while(0)
#define g_return_val_if_fail(x,v) do{if(!(x))return(v);}while(0)
#define g_value_peek_pointer(x) ((x)->value.p)
#define g_marshal_value_peek_enum(x) ((x)->value.i)
#define G_STRLOC "source-isolated control"
#define G_GUINTPTR_FORMAT "u"
#define G_GNUC_UNUSED
#define TRUE 1
GClosure *g_cclosure_new(GCallback,gpointer,gpointer);
GClosure *_g_cclosure_new_class_handler(GCallback);
void g_closure_set_meta_marshal(GClosure*,gpointer,GClosureMarshal);
void g_closure_set_meta_va_marshal(GClosure*,GVaClosureMarshal);
void g_wasm_vtable_meta_marshal(GValue*,guint,const GValue*,gpointer);
void g_wasm_vtable_meta_marshal_va(GValue*,gpointer,va_list,gpointer,int,GType*);
guint g_signal_new_valist(const gchar*,GType,GSignalFlags,GClosure*,GSignalAccumulator,gpointer,GSignalCMarshaller,GType,guint,va_list);
guint g_signal_lookup(const gchar*,GType);
void g_signal_override_class_closure(guint,GType,GClosure*);
void g_critical(const char*,...);
guint g_signal_new_class_handler(const gchar*,GType,GSignalFlags,GCallback,GSignalAccumulator,gpointer,GSignalCMarshaller,GType,guint,...);
void g_signal_override_class_handler(const gchar*,GType,GCallback);
void g_cclosure_marshal_VOID__ENUM(GClosure*,GValue*,guint,const GValue*,gpointer,gpointer);
void class_enum(gpointer,int);int64_t class_i64(gpointer,int);double class_double(gpointer,int);
void connected_enum(gpointer,int,gpointer);int64_t connected_i64(gpointer,int,gpointer);double connected_double(gpointer,int,gpointer);
extern unsigned callback_calls,callback_bad;
