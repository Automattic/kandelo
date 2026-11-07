/* Explicit native-only peer for the legacy owned-leaf/log fixtures. Their
 * narrow client TU intentionally has no raw-entry continuation provider.
 * Link this file ONLY into those controls, never SDK/product or full raw
 * fixtures: inactive raw work cannot supply a scope, entry or pending drain.
 * Strong definitions also avoid Darwin's unresolved weak-import linkage. */
#include <assert.h>
#include <stddef.h>
struct wpk_wl_log_scope;
struct wpk_wl_log_scope *_wpk_wl_raw_log_scope(void){return NULL;}
int _wpk_wl_raw_drain_deferred(void){return 0;}
void *_wpk_wl_raw_entry_suspend(void){return NULL;}
void _wpk_wl_raw_entry_resume(void *entry){assert(!entry);}
