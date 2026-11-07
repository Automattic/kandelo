// Exact pinned Node image-fuse source; see sea-image-profile.md.
#ifndef KANDELO_NODE_SEA_IMAGE_PROFILE_H
#define KANDELO_NODE_SEA_IMAGE_PROFILE_H
#define SEA_SENTINEL_PREFIX "NODE_SEA_FUSE"
#define SEA_SENTINEL_TAIL "fce680ab2cc467b6e072b8b5df1996b2"

// The POSTJECT_SENTINEL_FUSE macro is a string of random characters selected by
// the Node.js project that is present only once in the entire binary. It is
// used by the postject_has_resource() function to efficiently detect if a
// resource has been injected. See
// https://github.com/nodejs/postject/blob/35343439cac8c488f2596d7c4c1dddfec1fddcae/postject-api.h#L42-L45.
#define POSTJECT_SENTINEL_FUSE SEA_SENTINEL_PREFIX "_" SEA_SENTINEL_TAIL
#include <kandelo-node/postject/postject-api.h>
#undef POSTJECT_SENTINEL_FUSE
namespace kandelo::sea {
bool IsSingleExecutable() {
  return postject_has_resource();
}

}  // namespace kandelo::sea
#endif
