#define main device_fixture_main
#include "image-ownership.c"
#undef main
void review_device_set_format_error(int error){check_format_errno=error;}
/* Exact descriptor reuse is a device-peer input action, never a production
 * phase hook. The old ACQUIRE remains pinned independently of this alias. */
uint64_t review_device_replace_fd100(void){
 struct graphics_peer_file *old=peer_aliases[100];assert(old&&old->refs>1);
 assert(!image_peer_close_alias(old,100));
 struct graphics_peer_file *fresh=peer_new(100,3);peer_aliases[100]=fresh;return fresh->identity;
}
void review_device_check_replacement(uint64_t identity,int close_it){
 struct graphics_peer_file *fresh=peer_aliases[100];assert(fresh&&fresh->identity==identity&&fresh->refs==1);
 if(close_it)assert(!image_peer_close_alias(fresh,100));
}
