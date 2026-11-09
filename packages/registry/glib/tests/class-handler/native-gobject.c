/* Real installed GObject semantic/ownership control on the declared target. */
#include <glib-object.h>
#include <stdint.h>
static unsigned base_calls,override_calls,ordinary_calls,finalized,weak_calls,marshal_calls;
static int cookie;
static const gint64 wide=G_GINT64_CONSTANT(0x1234567887654321);
static void check(GObject*self,gint arg){g_assert_true(G_IS_OBJECT(self));g_assert_cmpint(arg,==,7);}
static void class_enum(GObject*self,gint arg){check(self,arg);base_calls++;}
static gint64 class_wide(GObject*self,gint arg){check(self,arg);base_calls++;return wide;}
static gdouble class_double(GObject*self,gint arg){check(self,arg);base_calls++;return 9.75;}
static void override_enum(GObject*self,gint arg){check(self,arg);override_calls++;g_signal_chain_from_overridden_handler(self,arg);}
static gint64 override_wide(GObject*self,gint arg){gint64 value=0;check(self,arg);override_calls++;g_signal_chain_from_overridden_handler(self,arg,&value);return value+1;}
static gdouble override_double(GObject*self,gint arg){gdouble value=0;check(self,arg);override_calls++;g_signal_chain_from_overridden_handler(self,arg,&value);return value+1;}
static void ordinary_enum(GObject*self,gint arg,gpointer data){check(self,arg);g_assert_true(data==&cookie);ordinary_calls++;}
static gint64 ordinary_wide(GObject*self,gint arg,gpointer data){ordinary_enum(self,arg,data);return -1;}
static gdouble ordinary_double(GObject*self,gint arg,gpointer data){ordinary_enum(self,arg,data);return -1;}
static void cleanup(gpointer data,GClosure*c){g_assert_true(data==&cookie);g_assert_nonnull(c);finalized++;}
static void weak(gpointer data,GObject*object){g_assert_true(data==&cookie);g_assert_nonnull(object);weak_calls++;}
static void standard_enum_marshal(GClosure*c,GValue*r,guint n,const GValue*p,gpointer hint,gpointer data){marshal_calls++;g_cclosure_marshal_VOID__ENUM(c,r,n,p,hint,data);}
int main(void){
 static const GEnumValue enums[]={{7,"SEVEN","seven"},{0,NULL,NULL}};GType et=g_enum_register_static("HandlerNativeEnum",enums);
 GType base=g_type_register_static_simple(G_TYPE_OBJECT,"HandlerNativeBase",sizeof(GObjectClass),NULL,sizeof(GObject),NULL,0);
 guint ids[3];GType returns[3]={G_TYPE_NONE,G_TYPE_INT64,G_TYPE_DOUBLE};const char*names[3]={"direct-enum","direct-wide","direct-double"};
 GCallback callbacks[3]={G_CALLBACK(class_enum),G_CALLBACK(class_wide),G_CALLBACK(class_double)},overrides[3]={G_CALLBACK(override_enum),G_CALLBACK(override_wide),G_CALLBACK(override_double)},ordinary[3]={G_CALLBACK(ordinary_enum),G_CALLBACK(ordinary_wide),G_CALLBACK(ordinary_double)};
 for(guint i=0;i<3;i++)ids[i]=g_signal_new_class_handler(names[i],base,G_SIGNAL_RUN_LAST,callbacks[i],NULL,NULL,i==0?standard_enum_marshal:NULL,returns[i],1,et);
 GType child=g_type_register_static_simple(base,"HandlerNativeChild",sizeof(GObjectClass),NULL,sizeof(GObject),NULL,0);
 for(guint i=0;i<3;i++)g_signal_override_class_handler(names[i],child,overrides[i]);
 for(guint derived=0;derived<2;derived++){
  GObject*object=g_object_new(derived?child:base,NULL);g_object_weak_ref(object,weak,&cookie);
  for(guint i=0;i<3;i++)g_signal_connect_data(object,names[i],ordinary[i],&cookie,cleanup,0);
  for(guint route=0;route<2;route++)for(guint i=0;i<3;i++){
   GValue params[2]={G_VALUE_INIT,G_VALUE_INIT},result=G_VALUE_INIT;g_value_init(&params[0],G_TYPE_OBJECT);g_value_set_object(&params[0],object);g_value_init(&params[1],et);g_value_set_enum(&params[1],7);
   if(i)g_value_init(&result,returns[i]);
   if(route==0)g_signal_emitv(params,ids[i],0,i?&result:NULL);
   else if(i==0)g_signal_emit(object,ids[i],0,7);
   else if(i==1){gint64 value=0;g_signal_emit(object,ids[i],0,7,&value);g_value_set_int64(&result,value);}
   else{gdouble value=0;g_signal_emit(object,ids[i],0,7,&value);g_value_set_double(&result,value);}
   if(i==1)g_assert_cmpint(g_value_get_int64(&result),==,wide+derived);
   if(i==2)g_assert_cmpfloat(g_value_get_double(&result),==,9.75+derived);
   if(i)g_value_unset(&result);g_value_unset(&params[0]);g_value_unset(&params[1]);
  }
  g_object_unref(object);
 }
 g_assert_cmpuint(base_calls,==,12);g_assert_cmpuint(override_calls,==,6);g_assert_cmpuint(ordinary_calls,==,12);g_assert_cmpuint(finalized,==,6);g_assert_cmpuint(weak_calls,==,2);g_assert_cmpuint(marshal_calls,>,0);
 g_print("actual GObject %u.%u.%u: new/override enum+int64+double emit/emitv, chained defaults, ordinary userdata and six cleanup notifications pass; custom marshal calls=%u\n",glib_major_version,glib_minor_version,glib_micro_version,marshal_calls);return 0;
}
