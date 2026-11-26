#include <json_object.h>
#include <stdlib.h>
#include <stdio.h>
#include <stdint.h>
static void *objects[4096];
static size_t live;
void *repro_malloc(size_t n) {
 void *p=malloc(n);if(!p)return p;
 for(size_t i=0;i<4096;i++)if(!objects[i]){objects[i]=p;live++;return p;}
 abort();
}
void repro_free(void *p) {
 for(size_t i=0;i<4096;i++)if(objects[i]==p && p){objects[i]=NULL;live--;break;}
 free(p);
}
int main(void) {
 for(int i=0;i<100;i++) {
  struct json_object *root=json_object_new_object(),*child=json_object_new_array();
  if(!root||!child)return 2;
  if(json_object_array_add(child,json_object_new_int(i)) || json_object_object_add(root,"child",child))return 3;
  int released=json_object_put(root);
  if(released!=1)return 4;
 }
 printf("json_object allocations still live after 100 puts: %zu\n",live);
 return live ? 1 : 0;
}
