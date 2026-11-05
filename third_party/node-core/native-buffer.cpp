#include <cstring>
/* Native backing stores used by the pinned unpooled Buffer allocator.
 * Ordinary malloc-backed ArrayBuffers retain engine ownership/accounting and
 * can enter the same canonical pin path as other filesystem/codec buffers.
 */
namespace {
static bool KandeloNativeUnsafeArrayBuffer(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isNumber() || !std::isfinite(args[0].toNumber()) ||
      args[0].toNumber() < 0 ||
      args[0].toNumber() > double(js::TypedArrayObject::ByteLengthLimit)) {
    JS_ReportErrorASCII(cx, "Invalid native Buffer backing-store length"); return false;
  }
  const size_t length = size_t(args[0].toNumber());
  mozilla::UniquePtr<void, JS::FreePolicy> data(length ? js_malloc(length) : nullptr);
  if (length && !data) { JS_ReportOutOfMemory(cx); return false; }
  if (length && gKandeloZeroFillBuffers) std::memset(data.get(), 0, length);
  RootedObject buffer(cx, JS::NewArrayBufferWithContents(cx, length, std::move(data)));
  if (!buffer) return false;
  args.rval().setObject(*buffer); return true;
}
static bool KandeloNativeMarkBufferUntransferable(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject()) {
    JS_ReportErrorASCII(cx, "Pool owner requires an ArrayBuffer"); return false;
  }
  RootedObject buffer(cx, JS::UnwrapArrayBuffer(&args[0].toObject()));
  if (!buffer) { JS_ReportErrorASCII(cx, "Pool owner requires an accessible ArrayBuffer"); return false; }
  uint32_t marks;
  if (!cx->getKandeloObjectMarks(buffer, &marks) ||
      !cx->setKandeloObjectMarks(buffer, marks | JSContext::KandeloUntransferable)) return false;
  buffer->as<js::ArrayBufferObject>().markNonDetachable();
  args.rval().setUndefined(); return true;
}
static bool KandeloNativeArrayBufferAlignedOffset(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !JS::IsArrayBufferObject(&args[0].toObject()) ||
      !args.get(1).isNumber()) {
    JS_ReportErrorASCII(cx, "Alignment requires an ArrayBuffer and a power of two"); return false;
  }
  const double value = args[1].toNumber();
  if (!std::isfinite(value) || std::floor(value) != value || value < 1 || value > double(1u << 30)) {
    JS_ReportErrorASCII(cx, "Invalid Buffer alignment"); return false;
  }
  const size_t alignment = size_t(value);
  if (alignment & (alignment - 1)) { JS_ReportErrorASCII(cx, "Buffer alignment must be a power of two"); return false; }
  RootedObject buffer(cx, JS::UnwrapArrayBuffer(&args[0].toObject()));
  if (!buffer) { JS_ReportErrorASCII(cx, "Cannot unwrap Buffer backing storage"); return false; }
  auto& backing = buffer->as<js::ArrayBufferObject>();
  // Inline/resizable/detached stores cannot promise this address after GC or
  // resize. Our nonempty allocator above creates fixed malloc-backed storage.
  if (backing.isDetached() || backing.isResizable()) {
    JS_ReportErrorASCII(cx, "Buffer alignment requires stable backing storage"); return false;
  }
  if (!JS::EnsureNonInlineArrayBufferOrView(cx, buffer)) return false;
  // EnsureNonInline may collect; reacquire the backing object from its root.
  const uintptr_t address = reinterpret_cast<uintptr_t>(buffer->as<js::ArrayBufferObject>().dataPointer());
  args.rval().setNumber(double((0 - address) & (alignment - 1))); return true;
}
}  // namespace
