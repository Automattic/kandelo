/* Read-only observation of the exact independently-accounted native peer.
 * Entry behavior is unchanged; no phase hooks or cleanup authority added. */
#include "owned-resource-peer.c"
void review_peer_snapshot(unsigned *files,unsigned *buffers,uint32_t *handle,uint64_t *storage){
 *files=*buffers=0;*handle=0;*storage=0;
 for(unsigned i=1;i<=last_cap;i++)if(caps[i].live){
  if(caps[i].bo){++*buffers;*handle=caps[i].bo->handle;*storage=caps[i].bo->storage;}
  else ++*files;
 }
}
