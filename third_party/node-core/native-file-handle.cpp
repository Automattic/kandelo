/* Actual guest descriptor ownership for Node FileHandle. Included after the
 * native filesystem resource/work implementation. Uncompiled source candidate.
 */
namespace {
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
  args.rval().setInt32(state->fd); return true;
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
  if (state->closing || state->fd < 0) return true;
  const int status = KandeloFsDoClose(state->fd); state->fd = -1;
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
  if (state->fd < 0) {
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
static bool KandeloAdoptNamedFileHandle(JSContext* cx, int fd, JS::UniqueChars name,
                                         size_t length, HandleValue makeError,
                                         MutableHandleObject result) {
  // Adoption consumes the fd and the already-copied original pathname bytes.
  auto releaseFd = mozilla::MakeScopeExit([&] { KandeloFsDoClose(fd); });
  if (!makeError.isObject() || !JS::IsCallable(&makeError.toObject())) {
    JS_ReportErrorASCII(cx, "FileHandle requires original path and error factory"); return false;
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
  auto* state = KandeloFsRequestStateOf(cx, owner); if (!state) return false;
  state->name = std::move(name); state->nameLength = length; state->nameBytes = length + 1;
  JS::AddAssociatedMemory(owner, state->nameBytes, JS::MemoryUse::Embedding3);
  state->fd = fd; releaseFd.release();
  if (!KandeloInitializeFsResource(cx, owner)) return false;
  result.set(owner); return true;
}
static bool KandeloAdoptFileHandle(JSContext* cx, int fd, HandleString path,
                                    HandleValue makeError, MutableHandleObject result) {
  auto releaseFd = mozilla::MakeScopeExit([&] { KandeloFsDoClose(fd); });
  JSLinearString* linear = JS_EnsureLinearString(cx, path); if (!linear) return false;
  const size_t length = JS::GetDeflatedUTF8StringLength(linear);
  if (length == SIZE_MAX) { JS_ReportOutOfMemory(cx); return false; }
  JS::UniqueChars name(static_cast<char*>(js_malloc(length + 1)));
  if (!name) { JS_ReportOutOfMemory(cx); return false; }
  JS::DeflateStringToUTF8Buffer(linear, mozilla::Span<char>(name.get(), length));
  name.get()[length] = 0;
  releaseFd.release();
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
