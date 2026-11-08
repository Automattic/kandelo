# Process supplementary-group owner

process.getBuiltinModule already consumes the pinned validator/normalizer through its private builtin internal-loader/cache owner. Do not duplicate it or count that existing source as new support. Full builtin namespace/ESM/runtime gaps remain.

This bounded slice instead implements process.getgroups (PROC-005 partial). Current uid/euid/gid/egid getters lack supplementary groups; existing libc SYS_GETGROUPS and kernel Process credentials already own them. No new kernel/ABI/syscall/host delegation. The process-state helper ports pinned node_credentials.cc GetGroups: query count, allocate vector, fetch actual groups, resize to returned count, append actual getegid only when absent. Preserve order/duplicates, no public getter, cache, sorting or extra retry. It is the target two-snapshot algorithm, not an atomic concurrent-credential guarantee.

Existing native OS dispatch consumes actual native storage before rooted JS publication. The resulting Number array uses native own elements, like Node Array::New from converted handles, without public index setters. Public getgroups has arity0/namegetgroups and is nonconstructible as the pinned native kThrow method; it ignores arguments and receiver. Main and Worker use their real process-object birth route, without fake AsyncWrap/provider state.

Failure creates actual native Error/stack and ErrnoException schema: original positive errno, conditional packaged errno name (empty for unknown as target errno_string), real libc strerror text, then checked ordinary errno/code/syscall Set in target order. Rooted values protect allocations/setters. Throwing setters reach native checked-failure fatal policy; nonthrowing false is ignored. Actual allocation failures use JS OOM. Stack/fatal/locale/realm/OOM details are source-only and unexecuted.

Five raw leaves/four runtime: process-state.h, native-os.cpp, process-state-adapter.js, one bootstrap property and this doc. Existing declared header/fragments/dispatcher consume it; no engine registration/patch/new runtime input/core/recipe is supplied. Parent owns later shared generation/check/build. Initial assigned273 pins are historical: copies were taken after parent274 integration and match actual state5372/bootstrap7f3a.

Zero tests/probes/compilers/generation/Git/index/root edits. Credential setters/initgroups/active Node permission policy/full process or loader and four-host compatibility remain incomplete. New C++/JSAPI, concurrent mutation, GC/OOM/realm/Worker/fatal/teardown remain uncompiled/unvalidated.
