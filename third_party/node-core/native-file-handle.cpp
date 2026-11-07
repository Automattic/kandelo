#include <map>
/* Actual guest descriptor ownership for Node FileHandle. Included after the
 * native filesystem resource/work implementation. Uncompiled source candidate.
 */
namespace {
struct KandeloFileHandleEnvironment {
  JS::PersistentRootedObject makeError;
  explicit KandeloFileHandleEnvironment(JSContext* cx) : makeError(cx) {}
};
static thread_local std::map<JSContext*, std::unique_ptr<KandeloFileHandleEnvironment>> kandeloFileHandleEnvironments;
static void KandeloShutdownFileHandles(JSContext* cx) {
  // The shared teardown has already joined work and retired port packets.
  // Only this context's error converter root is retired here, without JS.
  kandeloFileHandleEnvironments.erase(cx);
}
static bool KandeloNativeConfigureFileHandles(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isObject() || !JS::IsCallable(&args[0].toObject()) ||
      kandeloFileHandleEnvironments.count(cx)) {
    JS_ReportErrorASCII(cx, "FileHandle receiver requires one local error factory"); return false;
  }
  try {
    auto environment = std::make_unique<KandeloFileHandleEnvironment>(cx);
    environment->makeError = &args[0].toObject();
    kandeloFileHandleEnvironments.emplace(cx, std::move(environment));
    args.rval().setUndefined(); return true;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
static KandeloFsRequestState* KandeloFileHandleTransferState(JSContext* cx,
    HandleObject value, MutableHandleObject actual) {
  actual.set(js::CheckedUnwrapDynamic(value, cx));
  if (!actual) { if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx); return nullptr; }
  if (JS::GetClass(actual) != &KandeloFsRequestClass) return nullptr;
  const Value slot = JS::GetReservedSlot(actual, FsRequestState);
  if (slot.isUndefined()) return nullptr;
  auto* state = static_cast<KandeloFsRequestState*>(slot.toPrivate());
  return state->kind == FsResourceKind::FileHandle ? state : nullptr;
}
static bool KandeloFileHandleIsTransferHost(JSContext* cx, HandleObject object, bool* found) {
  RootedObject actual(cx);
  *found = KandeloFileHandleTransferState(cx, object, &actual) != nullptr;
  return !JS_IsExceptionPending(cx);
}
static bool KandeloFileHandleMissingTransfer(JSContext* cx, HandleObject object, bool* found) {
  RootedObject actual(cx);
  auto* state = KandeloFileHandleTransferState(cx, object, &actual);
  if (JS_IsExceptionPending(cx)) return false;
  *found = state != nullptr;
  return !state || cx->reportKandeloCloneError(state->closing || state->descriptor.Fd() < 0
      ? "Cannot clone object of unsupported type."
      : "Object that needs transfer was found in message but not listed in transferList");
}
static bool KandeloFileHandleAdmitTransfer(JSContext* cx, HandleObject object,
    KandeloFsRequestState** result) {
  RootedObject actual(cx);
  auto* state = KandeloFileHandleTransferState(cx, object, &actual);
  if (!state) return JS_IsExceptionPending(cx) ? false :
      cx->reportKandeloCloneError("Invalid native FileHandle transfer");
  if (state->lifetime != GetShellContext(cx)->kandeloNativeAsync || state->id < 0 ||
      state->retired || state->closing || state->descriptor.Fd() < 0)
    return cx->reportKandeloCloneError("Cannot transfer object of unsupported type.");
  *result = state; return true;
}
static void KandeloAbortFileHandleAdmission(JSObject* object) noexcept {
  auto* state = static_cast<KandeloFsRequestState*>(JS::GetReservedSlot(object, FsRequestState).toPrivate());
  MOZ_RELEASE_ASSERT(state && state->kind == FsResourceKind::FileHandle);
  // A reentrant init hook may have queued close and handed the actual lease
  // to its rooted work item. Never close its observed numeric fd here.
  if (state->descriptor.Fd() >= 0) {
    MOZ_RELEASE_ASSERT(!state->closing);
    const int status = state->descriptor.Close(); state->fd = -1;
    MOZ_RELEASE_ASSERT(status == 0);
  }
}
static KandeloFsRequestState* KandeloFileHandleThis(JSContext* cx, const CallArgs& args) {
  if (!args.thisv().isObject()) { JS_ReportErrorASCII(cx, "Invalid FileHandle receiver"); return nullptr; }
  RootedObject owner(cx, &args.thisv().toObject());
  auto* state = KandeloFsRequestStateOf(cx, owner);
  if (state && state->kind != FsResourceKind::FileHandle) {
    JS_ReportErrorASCII(cx, "Invalid FileHandle resource kind"); return nullptr;
  }
  return state;
}
static bool KandeloFileHandleFd(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloFileHandleThis(cx, args);
  if (!state) return false;
  // Pinned StreamBase::GetFD checks IsAlive before invoking FileHandle::GetFD.
  // Queued close remains alive until completion; transfer consumes its lease.
  args.rval().setInt32(!state->closing && state->descriptor.Fd() < 0 ? -EINVAL : state->fd);
  return true;
}
static bool KandeloFileHandleAsyncId(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloFileHandleThis(cx, args);
  if (!state) return false;
  args.rval().setNumber(state->id); return true;
}
static bool KandeloFileHandleCloseSync(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloFileHandleThis(cx, args);
  if (!state) return false;
  args.rval().setUndefined();
  if (state->closing || state->descriptor.Fd() < 0) return true;
  MOZ_RELEASE_ASSERT(state->descriptor.Fd() == state->fd);
  const int status = state->descriptor.Close(); state->fd = -1;
  if (status == 0) return true;
  RootedObject owner(cx, &args.thisv().toObject());
  RootedValue callback(cx, JS::GetReservedSlot(owner, FsRequestCallback)), error(cx);
  JS::RootedValueArray<2> arguments(cx); arguments[0].setInt32(status);
  RootedString syscall(cx, JS_NewStringCopyZ(cx, "close")); if (!syscall) return false;
  arguments[1].setString(syscall);
  if (!JS_CallFunctionValue(cx, owner, callback, arguments, &error)) return false;
  JS_SetPendingException(cx, error); return false;
}
static bool KandeloFileHandleClose(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp); auto* state = KandeloFileHandleThis(cx, args);
  if (!state) return false;
  RootedObject parent(cx, &args.thisv().toObject());
  RootedValue existing(cx, JS::GetReservedSlot(parent, FsRequestPromise));
  if (existing.isObject()) { args.rval().set(existing); return true; }
  if (state->descriptor.Fd() < 0) {
    RootedObject promise(cx, JS::CallOriginalPromiseResolve(cx, UndefinedHandleValue));
    if (!promise) return false;
    args.rval().setObject(*promise); return true;
  }
  RootedObject promise(cx, JS::NewPromiseObject(cx, nullptr));
  RootedObject prototype(cx), request(cx);
  if (!promise || !KandeloCreateFsResource(cx, prototype, UndefinedHandleValue,
                                         FsResourceKind::FileHandleClose, &request)) return false;
  JS::SetReservedSlot(request, FsRequestParent, ObjectValue(*parent));
  JS::SetReservedSlot(request, FsRequestPromise, ObjectValue(*promise));
  state->closing = true;
  JS::SetReservedSlot(parent, FsRequestPromise, ObjectValue(*promise));
  auto failed = mozilla::MakeScopeExit([&] {
    state->closing = false; JS::SetReservedSlot(parent, FsRequestPromise, UndefinedValue());
    auto* requestState = static_cast<KandeloFsRequestState*>(JS::GetReservedSlot(request, FsRequestState).toPrivate());
    requestState->Retire();
    for (uint32_t slot : {FsRequestCallback, FsRequestFrame, FsRequestParent, FsRequestPromise})
      JS::SetReservedSlot(request, slot, UndefinedValue());
  });
  if (!KandeloInitializeFsResource(cx, request) ||
      !KandeloSubmitFsWork(cx, request, state->fd, 0, KandeloFsWork::Operation::CloseHandle)) return false;
  failed.release(); args.rval().setObject(*promise); return true;
}
static bool KandeloPrepareFileHandle(JSContext* cx, HandleValue makeError,
                                      MutableHandleObject result) {
  if (!makeError.isObject() || !JS::IsCallable(&makeError.toObject())) {
    JS_ReportErrorASCII(cx, "FileHandle requires its local error factory"); return false;
  }
  RootedObject prototype(cx), owner(cx);
  if (!KandeloCreateFsResource(cx, prototype, makeError, FsResourceKind::FileHandle, &owner)) return false;
  static const JSFunctionSpec methods[] = {
    JS_FN("getAsyncId", KandeloFileHandleAsyncId, 0, 0),
    JS_FN("close", KandeloFileHandleClose, 0, 0),
    JS_FN("closeSync", KandeloFileHandleCloseSync, 0, 0), JS_FS_END
  };
  static const JSPropertySpec properties[] = { JS_PSG("fd", KandeloFileHandleFd, 0), JS_PS_END };
  if (!JS_DefineFunctions(cx, owner, methods) || !JS_DefineProperties(cx, owner, properties)) return false;
  result.set(owner); return true;
}
static bool KandeloAdoptNamedFileHandle(JSContext* cx, int fd, JS::UniqueChars name,
                                         size_t length, HandleValue makeError,
                                         MutableHandleObject result) {
  // Adoption consumes the fd and the already-copied original pathname bytes.
  kandelo::nodefs::FileHandleLease incoming(fd);
  if (!makeError.isObject() || !JS::IsCallable(&makeError.toObject())) {
    JS_ReportErrorASCII(cx, "FileHandle requires original path and error factory"); return false;
  }
  RootedObject owner(cx);
  if (!KandeloPrepareFileHandle(cx, makeError, &owner)) return false;
  auto* state = KandeloFsRequestStateOf(cx, owner); if (!state) return false;
  state->name = std::move(name); state->nameLength = length; state->nameBytes = length + 1;
  JS::AddAssociatedMemory(owner, state->nameBytes, JS::MemoryUse::Embedding3);
  MOZ_RELEASE_ASSERT(state->descriptor.Adopt(incoming));
  state->fd = fd;
  if (!KandeloInitializeFsResource(cx, owner)) return false;
  result.set(owner); return true;
}
static bool KandeloAdoptFileHandle(JSContext* cx, int fd, HandleString path,
                                    HandleValue makeError, MutableHandleObject result) {
  kandelo::nodefs::FileHandleLease incoming(fd);
  JSLinearString* linear = JS_EnsureLinearString(cx, path); if (!linear) return false;
  const size_t length = JS::GetDeflatedUTF8StringLength(linear);
  if (length == SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
  JS::UniqueChars name(static_cast<char*>(js_malloc(length + 1)));
  if (!name) { JS_ReportOutOfMemory(cx); return false; }
  JS::DeflateStringToUTF8Buffer(linear, mozilla::Span<char>(name.get(), length));
  name.get()[length] = 0;
  incoming.Release();
  return KandeloAdoptNamedFileHandle(cx, fd, std::move(name), length, makeError, result);
}
static bool KandeloNativeAdoptFileHandle(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (!args.get(0).isInt32() || args[0].toInt32() < 0) {
    JS_ReportErrorASCII(cx, "FileHandle adoption requires a valid descriptor number"); return false;
  }
  const int fd = args[0].toInt32();
  if (!args.get(1).isString()) {
    KandeloFsDoClose(fd); JS_ReportErrorASCII(cx, "FileHandle requires an original path"); return false;
  }
  RootedString path(cx, args[1].toString()); RootedObject owner(cx);
  if (!KandeloAdoptFileHandle(cx, fd, path, args.get(2), &owner)) return false;
  args.rval().setObject(*owner); return true;
}
}  // namespace
