#include "contract.h"
unsigned callback_calls,callback_bad;
static void check(gpointer self,int arg){callback_calls++;if(self!=(gpointer)0x1234||arg!=7)callback_bad++;}
void class_enum(gpointer self,int arg){check(self,arg);}
int64_t class_i64(gpointer self,int arg){check(self,arg);return INT64_C(0x1234567887654321);}
double class_double(gpointer self,int arg){check(self,arg);return 9.75;}
void connected_enum(gpointer self,int arg,gpointer data){check(self,arg);if(data!=(gpointer)0x5678)callback_bad++;}
int64_t connected_i64(gpointer self,int arg,gpointer data){connected_enum(self,arg,data);return INT64_C(0x1234567887654321);}
double connected_double(gpointer self,int arg,gpointer data){connected_enum(self,arg,data);return 9.75;}
