/* Actual CpDirJob allocation and owning-context completion. Included after
 * native-fs-promise.cpp and native-retained-memory.cpp. No worker enters JS.
 */
#include "kandelo-node-copy-directory-operations.h"
#include <initializer_list>
namespace {
using KandeloCpError = kandelo::nodefs::cp::CpError;
using KandeloCpOptions = kandelo::nodefs::cp::CpDirOptions;
enum KandeloCpSlot { KandeloCpStateSlot, KandeloCpFrameSlot, KandeloCpErrorFactorySlot, KandeloCpSlots };
static size_t KandeloCpStringBytes(const std::string& value) noexcept {
  const auto address = reinterpret_cast<uintptr_t>(value.data());
  const auto object = reinterpret_cast<uintptr_t>(&value);
  return address >= object && address < object + sizeof(value) ? 0 : value.capacity() + 1;
}
static size_t KandeloCpOwnedBytes(std::initializer_list<size_t> sizes) {
  size_t result=0;
  for(size_t bytes:sizes) {
    if(bytes>SIZE_MAX-result) throw std::bad_alloc();
    result+=bytes;
  }
  return result;
}
struct KandeloCpState {
  kandelo::memory::AccountHandle account;
  kandelo::memory::Allocation material{sizeof(KandeloCpState)};
  kandelo::memory::Claim claim;
  const std::filesystem::path source, destination;
  const std::string destinationDisplay;
  const KandeloCpOptions options;
  js::shell::KandeloNativeAsyncState* lifetime = nullptr;
  double id = -1, trigger = -1;
  bool scheduled = false, retired = false;
  KandeloCpState(kandelo::memory::AccountHandle account,
                 std::filesystem::path source, std::filesystem::path destination,
                 KandeloCpOptions options)
      : account(std::move(account)), claim(material.Handle(), this->account),
        source(std::move(source)), destination(std::move(destination)),
        destinationDisplay(this->destination.native()), options(options) {
    material.Resize(KandeloCpOwnedBytes({sizeof(*this),KandeloCpStringBytes(this->source.native()),
        KandeloCpStringBytes(this->destination.native()),KandeloCpStringBytes(destinationDisplay)}));
  }
  void Retire() {
    if (!retired) { retired = true; if (lifetime && id >= 0) lifetime->Finalized(id); }
  }
  ~KandeloCpState() { Retire(); if (lifetime) lifetime->Release(); }
};
static void KandeloCpFinalize(JS::GCContext*, JSObject* owner) {
  const auto slot = JS::GetReservedSlot(owner, KandeloCpStateSlot);
  if (!slot.isUndefined()) delete static_cast<KandeloCpState*>(slot.toPrivate());
}
static const JSClassOps KandeloCpClassOps = {
  nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloCpFinalize,
  nullptr, nullptr, nullptr};
static const JSClass KandeloCpClass = {"CpDirJob",
  JSCLASS_HAS_RESERVED_SLOTS(KandeloCpSlots) | JSCLASS_FOREGROUND_FINALIZE, &KandeloCpClassOps};
static KandeloCpState* KandeloCpOwner(JSContext* cx, HandleValue value, MutableHandleObject owner) {
  if (!value.isObject()) { JS_ReportErrorASCII(cx, "Invalid native copy-directory receiver"); return nullptr; }
  owner.set(js::CheckedUnwrapDynamic(&value.toObject(), cx));
  if (!owner || JS::GetClass(owner) != &KandeloCpClass ||
      JS::GetReservedSlot(owner, KandeloCpStateSlot).isUndefined()) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx, "Invalid native copy-directory receiver");
    return nullptr;
  }
  return static_cast<KandeloCpState*>(JS::GetReservedSlot(owner, KandeloCpStateSlot).toPrivate());
}
static bool KandeloCpResourceInfo(JSContext* cx, HandleObject owner, MutableHandleValue value) {
  RootedValue receiver(cx, ObjectValue(*owner)); RootedObject object(cx);
  auto* state = KandeloCpOwner(cx, receiver, &object); if (!state) return false;
  {
  JSAutoRealm realm(cx, object);
  JS::RootedValueArray<4> fields(cx);
  fields[0].setNumber(state->id); fields[1].setNumber(state->trigger);
  fields[2].set(JS::GetReservedSlot(object, KandeloCpFrameSlot));
  RootedString provider(cx, JS_NewStringCopyZ(cx, "FSREQCALLBACK")); if (!provider) return false;
  fields[3].setString(provider);
  RootedObject result(cx, JS::NewArrayObject(cx, fields)); if (!result) return false;
  value.setObject(*result);
  }
  return JS_WrapValue(cx,value);
}
static bool KandeloCpPacket(JSContext* cx, const KandeloCpError& error, MutableHandleValue value) {
  if (error.kind == KandeloCpError::kNone) { value.setUndefined(); return true; }
  JS::RootedValueArray<6> fields(cx);
  fields[0].setInt32(int(error.kind)); fields[1].setInt32(error.code);
  RootedString syscall(cx, JS_NewStringCopyZ(cx, error.syscall)); if (!syscall) return false;
  fields[2].setString(syscall);
  if (!KandeloFsPathString(cx,error.message.data(),error.message.size(),fields[3]) ||
      !KandeloFsPathString(cx,error.path.data(),error.path.size(),fields[4])) return false;
  if (error.dest && !KandeloFsPathString(cx,error.dest->data(),error.dest->size(),fields[5])) return false;
  RootedObject result(cx, JS::NewArrayObject(cx,fields)); if (!result) return false;
  value.setObject(*result); return true;
}
static bool KandeloCpPaths(JSContext* cx, const CallArgs& args, size_t offset,
                            std::filesystem::path* source, std::filesystem::path* destination) {
  JS::UniqueChars from, to; size_t fromLength, toLength;
  // Capture both complete byte paths before async init or native work owns
  // them. Never retain a JS pathname buffer address on the worker.
  if (!KandeloFsPath(cx,args.get(offset),&from,&fromLength) ||
      !KandeloFsPath(cx,args.get(offset+1),&to,&toLength)) return false;
  *source = std::string(from.get(),fromLength);
  *destination = std::string(to.get(),toLength); return true;
}
static bool KandeloCpBooleans(JSContext* cx, const CallArgs& args, size_t start, size_t count) {
  for (size_t i = 0; i < count; ++i) if (!args.get(start+i).isBoolean()) {
    JS_ReportErrorASCII(cx,"Native cp option must be boolean"); return false;
  }
  return true;
}
struct KandeloCpWork final : js::shell::KandeloNativeWork {
  JS::PersistentRootedObject owner;
  KandeloCpState* state;
  kandelo::memory::Allocation material{sizeof(KandeloCpWork)};
  kandelo::memory::Claim claim;
  KandeloCpError error;
  KandeloCpWork(JSContext* cx, JSObject* owner, KandeloCpState* state)
      : owner(cx,owner), state(state), claim(material.Handle(),state->account) {
    workClass = WorkClass::FastIo;
  }
  void Run() override {
    error = kandelo::nodefs::cp::CopyDirRecursive(state->source,state->destination,
        state->destinationDisplay,state->options);
    material.Resize(KandeloCpOwnedBytes({sizeof(*this),KandeloCpStringBytes(error.message),
        KandeloCpStringBytes(error.path),error.dest ? KandeloCpStringBytes(*error.dest) : 0}));
  }
  void Clear() {
    if (!state) return;
    state->Retire();
    JS::SetReservedSlot(owner,KandeloCpFrameSlot,UndefinedValue());
    JS::SetReservedSlot(owner,KandeloCpErrorFactorySlot,UndefinedValue());
    JS::SetReservedSlot(owner,KandeloCpStateSlot,UndefinedValue());
    delete state; state=nullptr;
  }
  void Cancel(JSContext*) override { Clear(); }
  bool Complete(JSContext* cx) override {
    RootedObject resource(cx,owner); JSAutoRealm realm(cx,resource);
    auto retire = mozilla::MakeScopeExit([&]{ Clear(); });
    // Shutdown cancellation suppresses JS delivery, including work that was
    // already running. It never purports to roll back actual filesystem I/O.
    if (failure == Failure::Cancelled) return true;
    if (failure != Failure::None) error = KandeloCpError::Uv(
        failure == Failure::OutOfMemory ? -ENOMEM : -EIO,"cp",state->destinationDisplay);
    JS::RootedValueArray<3> fields(cx); fields[0].setNull();
    const char* special = error.kind == KandeloCpError::kSocket ? "socket" :
        error.kind == KandeloCpError::kFifo ? "fifo" : error.kind == KandeloCpError::kUnknown ? "unknown" : nullptr;
    if (special) {
      RootedString kind(cx,JS_NewStringCopyZ(cx,special)); if (!kind) return false;
      fields[1].setString(kind);
      if (!KandeloFsPathString(cx,error.path.data(),error.path.size(),fields[2])) return false;
    } else if (error.kind != KandeloCpError::kNone) {
      JS::RootedValueArray<1> packet(cx); RootedValue factory(cx,JS::GetReservedSlot(resource,KandeloCpErrorFactorySlot));
      if (!KandeloCpPacket(cx,error,packet[0]) ||
          !JS_CallFunctionValue(cx,resource,factory,packet,fields[0])) return false;
    }
    // AsyncWrap::MakeCallback resolves this property before entering its
    // callback scope; getter throws and non-callable properties create none.
    RootedValue callback(cx), ignored(cx), frame(cx,JS::GetReservedSlot(resource,KandeloCpFrameSlot));
    if (!JS_GetProperty(cx,resource,"ondone",&callback)) return false;
    if (!callback.isObject() || !JS::IsCallable(&callback.toObject())) return true;
    KandeloNativeCallbackScope scope(cx,resource,frame);
    if (!scope.Enter()) return scope.Stopped();
    if (!JS_CallFunctionValue(cx,resource,callback,fields,&ignored)) return false;
    return scope.Close();
  }
};
static bool KandeloCreateCpDirJob(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp);
  if ((!args.get(0).isObject() && !args.get(0).isNull()) ||
      !args.get(9).isObject() || !JS::IsCallable(&args[9].toObject()) ||
      !KandeloCpBooleans(cx,args,3,5)) {
    if (!JS_IsExceptionPending(cx)) JS_ReportErrorASCII(cx,"Native cp requires prototype, options and error factory");
    return false;
  }
  int64_t flags;
  if (!KandeloFsInteger(cx,args.get(8),0,7,&flags)) return false;
  std::filesystem::path source,destination;
  if (!KandeloCpPaths(cx,args,1,&source,&destination)) return false;
  KandeloCpOptions options{args[3].toBoolean(),args[4].toBoolean(),args[5].toBoolean(),
      args[6].toBoolean(),args[7].toBoolean(),true,int(flags)};
  auto account=KandeloNativeMemoryOwner(cx);
  auto state=std::make_unique<KandeloCpState>(account,std::move(source),std::move(destination),options);
  RootedObject prototype(cx,args[0].toObjectOrNull()),owner(cx,JS_NewObjectWithGivenProto(cx,&KandeloCpClass,prototype));
  if (!owner) return false;
  auto* raw=state.release(); JS::SetReservedSlot(owner,KandeloCpStateSlot,PrivateValue(raw));
  RootedValue factory(cx,args[9]); if (!JS_WrapValue(cx,&factory)) return false;
  JS::SetReservedSlot(owner,KandeloCpErrorFactorySlot,factory);
  RootedValue frame(cx);
  if (!cx->kandeloAsyncProperty("frame",&frame) || !cx->getKandeloDefaultTriggerAsyncId(&raw->trigger)) return false;
  auto* lifetime=js::shell::KandeloGetNativeAsyncState(cx); if (!lifetime) return false;
  lifetime->Retain(); raw->lifetime=lifetime; raw->id=cx->allocateKandeloAsyncId();
  JS::SetReservedSlot(owner,KandeloCpFrameSlot,frame);
  if (!cx->notifyKandeloAsyncLifecycle("native:init",owner,frame)) {
    raw->Retire();
    if (!raw->scheduled) {
      JS::SetReservedSlot(owner,KandeloCpStateSlot,UndefinedValue());
      JS::SetReservedSlot(owner,KandeloCpFrameSlot,UndefinedValue());
      JS::SetReservedSlot(owner,KandeloCpErrorFactorySlot,UndefinedValue());
      delete raw;
    }
    return false;
  }
  args.rval().setObject(*owner); return true;
}
static bool KandeloRunCpDirJob(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp); RootedObject owner(cx);
  auto* state=KandeloCpOwner(cx,args.get(0),&owner); if (!state) return false;
  JSAutoRealm realm(cx,owner);
  if (state->scheduled || state->retired) { JS_ReportErrorASCII(cx,"Copy-directory job already dispatched or retired"); return false; }
  state->scheduled=true;
  auto retire=mozilla::MakeScopeExit([&]{
    state->Retire();
    JS::SetReservedSlot(owner,KandeloCpStateSlot,UndefinedValue());
    JS::SetReservedSlot(owner,KandeloCpFrameSlot,UndefinedValue());
    JS::SetReservedSlot(owner,KandeloCpErrorFactorySlot,UndefinedValue());
    delete state;
  });
  auto* queue=js::shell::KandeloGetNativeWorkQueue(cx); if (!queue) return false;
  void* storage=js_malloc(sizeof(KandeloCpWork));
  if (!storage) { JS_ReportOutOfMemory(cx); return false; }
  KandeloCpWork* raw;
  try { raw=new(storage) KandeloCpWork(cx,owner,state); }
  catch (...) { js_free(storage); throw; }
  std::unique_ptr<KandeloCpWork,void(*)(KandeloCpWork*)> work(raw,[](KandeloCpWork* owner){js_delete(owner);});
  if (!queue->Submit(work.get())) { JS_ReportErrorASCII(cx,"Native cp queue is closing"); return false; }
  work.release(); retire.release(); args.rval().setUndefined(); return true;
}
static bool KandeloCpSyncCheckPaths(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp); std::filesystem::path source,destination;
  if (!KandeloCpPaths(cx,args,0,&source,&destination) || !KandeloCpBooleans(cx,args,2,2)) return false;
  return KandeloCpPacket(cx,kandelo::nodefs::cp::CheckPaths(source,destination,args[2].toBoolean(),args[3].toBoolean()),args.rval());
}
static bool KandeloCpSyncOverrideFile(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp); std::filesystem::path source,destination; int64_t mode;
  if (!KandeloCpPaths(cx,args,0,&source,&destination) || !KandeloFsInteger(cx,args.get(2),0,7,&mode) || !KandeloCpBooleans(cx,args,3,1)) return false;
  return KandeloCpPacket(cx,kandelo::nodefs::cp::OverrideFile(source,destination,int(mode),args[3].toBoolean()),args.rval());
}
static bool KandeloCpSyncCopyDir(JSContext* cx,unsigned argc,Value* vp) {
  CallArgs args=CallArgsFromVp(argc,vp); std::filesystem::path source,destination;
  if (!KandeloCpPaths(cx,args,0,&source,&destination) || !KandeloCpBooleans(cx,args,2,5)) return false;
  const KandeloCpOptions options{args[2].toBoolean(),args[3].toBoolean(),args[4].toBoolean(),args[5].toBoolean(),args[6].toBoolean(),false,0};
  return KandeloCpPacket(cx,kandelo::nodefs::cp::CopyDirRecursive(source,destination,destination.native(),options),args.rval());
}
}  // namespace
