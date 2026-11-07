# Ordinary Node SEA image profile

The isSea owner uses the exact pinned Node sentinel definition and unchanged
postject_has_resource detector. It reads the executing program's actual compiled
image byte. It does not infer image kind from argv0, execPath, environment, outer
host Node or a synthetic JavaScript flag. Normal guest executable bytes are held
by the kernel's executable owner; the detector reads the loaded image's own data,
which remains independent of a renamed/replaced executable path. Each image/
worker/fork keeps its real loaded storage; no asset catalog or resource success
is fabricated.

The full pinned lib/sea.js public algorithms are consumed unchanged, including
function/property shapes, encoding-before-key validation and exact ordinary
ERR_NOT_IN_SINGLE_EXECUTABLE_APPLICATION behavior. The only native binding is the
real image detector; there are no fake asset callbacks. Marked images fail explicit
missing resource/startup-profile admission before module activation. Unsupported
native-format resource lookup is never called and never mapped to missing assets.
This is ordinary-image behavior only, not positive SEA compatibility.

The imported postject header stays byte-identical at the real third_party include
boundary. Its non-native-format resource finder returns null; that function is
not a valid Wasm SEA backend and is not used here. Reusing the actual Node image
fuse does not define or promise a Wasm injection/resource format. Current build/
injection/parser/main/assets/borrowed raw lifetime/copies/Blob/TextDecoder/VFS/
ZIP/CJS/ESM/module-resolution/snapshot/cache/argument-extension/worker startup
owners remain implementation dependencies. Native Mach-O/ELF/PE injector branches
and V8-specific payload formats are concrete source facts, not blanket accepted
Wasm API exclusions. An explicit Wasm packaging/identity decision is still needed.

Native controls compile the actual portable detector into an identified component
image and inspect its single ordinary sentinel. Node's native reference detector
and that component image are distinct artifacts. Public algorithms use genuine
native error/validator dependencies in the component controls. Guest JSAPI
binding/loader/realm/lifetime, full positive SEA and four-host identified-artifact
conformance remain unexecuted. No successful unsupported cases are manufactured.
The separate Bun/Claude loader and all previous seals remain untouched.
