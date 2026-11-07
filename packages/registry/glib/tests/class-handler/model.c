/* The extracted API and meta-marshal bodies are production source. Registry,
 * GValue and exact-arity call engines below are deliberately tiny test doubles.
 * This proves source admission + C/Wasm arity routing, not real GObject/libffi. */
#include "contract.h"
static GClosure cell,*selected;static unsigned allocations,meta_sets,va_sets;
GClosure *g_cclosure_new(GCallback callback,gpointer data,gpointer notify){(void)notify;allocations++;cell.callback=callback;cell.data=data;cell.meta=0;cell.meta_va=0;return &cell;}
void g_closure_set_meta_marshal(GClosure*c,gpointer data,GClosureMarshal f){(void)data;c->meta=f;meta_sets++;}
void g_closure_set_meta_va_marshal(GClosure*c,GVaClosureMarshal f){c->meta_va=f;va_sets++;}
guint g_signal_new_valist(const gchar*n,GType type,GSignalFlags flags,GClosure*c,GSignalAccumulator a,gpointer data,GSignalCMarshaller m,GType result,guint count,va_list args){(void)n;(void)type;(void)flags;(void)a;(void)data;(void)m;(void)result;(void)count;(void)args;selected=c;return 42;}
guint g_signal_lookup(const gchar*n,GType type){(void)n;(void)type;return 42;}
void g_signal_override_class_closure(guint id,GType type,GClosure*c){(void)id;(void)type;selected=c;}
void g_critical(const char*message,...){(void)message;}
void g_wasm_vtable_meta_marshal(GValue*r,guint n,const GValue*p,gpointer callback){if(n!=2){callback_bad++;return;}if(r->type==0)((void(*)(gpointer,int))callback)(p[0].value.p,p[1].value.i);if(r->type==1)r->value.i64=((int64_t(*)(gpointer,int))callback)(p[0].value.p,p[1].value.i);if(r->type==2)r->value.d=((double(*)(gpointer,int))callback)(p[0].value.p,p[1].value.i);}
void g_wasm_vtable_meta_marshal_va(GValue*r,gpointer self,va_list args,gpointer cb,int n,GType*types){(void)types;GValue p[2];p[0].value.p=self;p[1].value.i=va_arg(args,int);g_wasm_vtable_meta_marshal(r,(guint)n+1,p,cb);}
static void invoke(GClosure*c,GValue*r,const GValue*p){if(c->meta)c->meta(c,r,2,p,0,0);else if(r->type==0)g_cclosure_marshal_VOID__ENUM(c,r,2,p,0,0);else if(r->type==1)r->value.i64=((int64_t(*)(gpointer,int,gpointer))c->callback)(p[0].value.p,p[1].value.i,c->data);else r->value.d=((double(*)(gpointer,int,gpointer))c->callback)(p[0].value.p,p[1].value.i,c->data);}
static void invoke_va(GClosure*c,GValue*r,gpointer self,...){va_list a;va_start(a,self);GType types[1]={1};c->meta_va(c,r,self,a,0,1,types);va_end(a);}
int run_case(unsigned which){callback_calls=callback_bad=allocations=meta_sets=va_sets=0;selected=0;
 if(which==15){g_signal_new_class_handler("empty",1,0,0,0,0,0,0,1,1);return selected==0&&allocations==0;}
 if(which==16){g_signal_override_class_handler("empty",1,0);return selected==0&&allocations==0;}
 if(which>16)return 0;
 unsigned shape=which%3,ordinary=which>=6&&which<9,override=(which>=3&&which<6)||(which>=12&&which<15);
 GCallback class_callbacks[3]={(GCallback)class_enum,(GCallback)class_i64,(GCallback)class_double};GCallback connected[3]={(GCallback)connected_enum,(GCallback)connected_i64,(GCallback)connected_double};
 if(ordinary)selected=g_cclosure_new(connected[shape],(gpointer)0x5678,0);else if(override)g_signal_override_class_handler("x",1,class_callbacks[shape]);else g_signal_new_class_handler("x",1,0,class_callbacks[shape],0,0,g_cclosure_marshal_VOID__ENUM,shape,1,1);
 GValue result,p[2];result.type=shape;result.value.i64=0;p[0].value.p=(gpointer)0x1234;p[1].value.i=7;
 if(which>=9&&selected->meta_va)invoke_va(selected,&result,(gpointer)0x1234,7);else invoke(selected,&result,p);
 return callback_calls==1&&callback_bad==0&&allocations==1&&(ordinary?meta_sets==0&&va_sets==0:meta_sets==1&&va_sets==1)&&(shape!=1||result.value.i64==INT64_C(0x1234567887654321))&&(shape!=2||result.value.d==9.75);
}
