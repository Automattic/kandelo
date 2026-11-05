/* Synchronous private parser/cache owner, confined to its owning JS context. */
#include "kandelo-node-package-config.h"
namespace {
struct KandeloPackageCache
{
  kandelo::packages::Cache cache;
  size_t accounted = 0;
};
static void
KandeloPackageFinalize(JS::GCContext*, JSObject* object)
{
  const auto slot = JS::GetReservedSlot(object, 0);
  if (!slot.isUndefined()) {
    auto* cache = static_cast<KandeloPackageCache*>(slot.toPrivate());
    JS::RemoveAssociatedMemory(
      object, cache->accounted, JS::MemoryUse::Embedding3);
    delete cache;
  }
}
static const JSClassOps KandeloPackageClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloPackageFinalize,
  nullptr, nullptr, nullptr
};
static const JSClass KandeloPackageClass = { "KandeloPackageCache",
                                             JSCLASS_HAS_RESERVED_SLOTS(1) |
                                               JSCLASS_FOREGROUND_FINALIZE,
                                             &KandeloPackageClassOps };
static bool
KandeloPackageText(JSContext* cx,
                   const std::string& text,
                   MutableHandleValue value)
{
  return KandeloFsPathString(cx, text.data(), text.size(), value);
}
static bool
KandeloPackageOperation(JSContext* cx, unsigned argc, Value* vp)
{
  CallArgs args = CallArgsFromVp(argc, vp);
  try {
    if (args.get(0).isUndefined()) {
      auto cache = std::make_unique<KandeloPackageCache>();
      RootedObject object(cx, JS_NewObject(cx, &KandeloPackageClass));
      if (!object)
        return false;
      cache->accounted = sizeof(KandeloPackageCache) -
                         sizeof(kandelo::packages::Cache) +
                         cache->cache.AccountedBytes();
      JS::AddAssociatedMemory(
        object, cache->accounted, JS::MemoryUse::Embedding3);
      JS::SetReservedSlot(object, 0, PrivateValue(cache.release()));
      args.rval().setObject(*object);
      return true;
    }
    if (!args.get(0).isObject()) {
      JS_ReportErrorASCII(cx, "Invalid package cache owner");
      return false;
    }
    RootedObject owner(cx, js::CheckedUnwrapDynamic(&args[0].toObject(), cx));
    if (!owner || JS::GetClass(owner) != &KandeloPackageClass ||
        JS::GetReservedSlot(owner, 0).isUndefined()) {
      JS_ReportErrorASCII(cx, "Invalid package cache owner");
      return false;
    }
    auto* cache = static_cast<KandeloPackageCache*>(
      JS::GetReservedSlot(owner, 0).toPrivate());
    JS::UniqueChars path;
    size_t length;
    if (!KandeloFsPath(cx, args.get(1), &path, &length))
      return false;
    if (!args.get(2).isBoolean()) {
      JS_ReportErrorASCII(cx, "Package traversal flag must be boolean");
      return false;
    }
    const std::string filename(path.get(), length);
    const auto result = args[2].toBoolean() ? cache->cache.Nearest(filename)
                                            : cache->cache.Get(filename);
    const auto size = sizeof(KandeloPackageCache) -
                      sizeof(kandelo::packages::Cache) +
                      cache->cache.AccountedBytes();
    if (size > cache->accounted) {
      JS::AddAssociatedMemory(
        owner, size - cache->accounted, JS::MemoryUse::Embedding3);
      cache->accounted = size;
    }
    JS::RootedValueArray<4> packet(cx);
    packet[0].setInt32(result.invalid  ? 2
                       : result.error  ? 3
                       : result.config ? 0
                                       : 1);
    packet[2].setInt32(result.error);
    if ((result.invalid || result.error) &&
        !KandeloPackageText(cx, result.errorPath, packet[3]))
      return false;
    if (result.config) {
      const auto& c = *result.config;
      JS::RootedValueArray<6> fields(cx);
      const std::optional<std::string>* optional[] = { &c.name,    &c.main,
                                                       nullptr,    &c.imports,
                                                       &c.exports, nullptr };
      for (size_t i = 0; i < 6; ++i) {
        if (i == 2) {
          if (!KandeloPackageText(cx, c.type, fields[i]))
            return false;
        } else if (i == 5) {
          if (!KandeloPackageText(cx, c.file_path, fields[i]))
            return false;
        } else if (*optional[i] &&
                   !KandeloPackageText(cx, **optional[i], fields[i]))
          return false;
      }
      RootedObject array(cx, JS::NewArrayObject(cx, fields));
      if (!array)
        return false;
      packet[1].setObject(*array);
    }
    RootedObject array(cx, JS::NewArrayObject(cx, packet));
    if (!array)
      return false;
    args.rval().setObject(*array);
    return true;
  } catch (const std::bad_alloc&) {
    JS_ReportOutOfMemory(cx);
    return false;
  }
}
} // namespace
