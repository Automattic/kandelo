// Host-only native libuv control, running the real portable producer on the
// exact reference Node loop. Not an emulation of the Kandelo loop or JSAPI.
#include "histogram-addon-control.inc"
#include "event-loop-delay.h"
#include <uv.h>
namespace {
using kandelo::histogram::EventLoopDelayLoop;
using kandelo::histogram::EventLoopDelayProducer;
static uint64_t UvClock() { return uv_hrtime(); }
static const napi_type_tag eldTag = {UINT64_C(0x47dfaa5749320b98), UINT64_C(0xb993b7bb5f28451a)};
struct EldOwner {
  std::shared_ptr<EventLoopDelayLoop> timeline;
  std::shared_ptr<EventLoopDelayProducer> producer;
  uv_loop_t* loop = nullptr;
  uv_timer_t timer{};
  uv_prepare_t prepare{};
  uv_check_t check{};
  napi_ref material = nullptr;
  size_t handles = 0;
  uint64_t resolution = 0;
  bool iteration = false;
  bool timerInitialized = false, prepareInitialized = false, checkInitialized = false;
  static void Closed(uv_handle_t* handle) {
    auto* self = static_cast<EldOwner*>(handle->data);
    if (--self->handles == 0) delete self;
  }
  void Close() {
    if (producer) producer->Close();
    if (timeline) timeline->Shutdown();
    if (prepareInitialized) {
      uv_prepare_stop(&prepare);
      uv_close(reinterpret_cast<uv_handle_t*>(&prepare), Closed);
    }
    if (checkInitialized) {
      uv_check_stop(&check);
      uv_close(reinterpret_cast<uv_handle_t*>(&check), Closed);
    }
    if (timerInitialized) {
      uv_timer_stop(&timer); uv_close(reinterpret_cast<uv_handle_t*>(&timer), Closed);
    }
  }
};
struct EldBuildDelete {
  napi_env env;
  void operator()(EldOwner* owner) const {
    if (owner->material) napi_delete_reference(env, owner->material);
    if (owner->handles) owner->Close(); else delete owner;
  }
};
static void EldFinalize(napi_env env, void* data, void*) {
  auto* owner = static_cast<EldOwner*>(data);
  napi_delete_reference(env, owner->material); owner->material = nullptr;
  owner->Close();
}
static EldOwner* Eld(napi_env env, napi_value value) {
  bool matches; Check(napi_check_object_type_tag(env, value, &eldTag, &matches));
  if (!matches) throw std::runtime_error("Invalid native ELD receiver");
  void* data; Check(napi_unwrap(env, value, &data)); return static_cast<EldOwner*>(data);
}
static napi_value EldDispatch(napi_env env, napi_callback_info info) {
  napi_value args[8]; size_t argc = 8; void* data;
  Check(napi_get_cb_info(env, info, &argc, args, nullptr, &data)); auto* state = static_cast<Env*>(data);
  for (size_t i = argc; i < 8; ++i) args[i] = Undefined(env);
  try {
    std::string name = Text(env, args[0]);
    if (name == "create") {
      std::unique_ptr<EldOwner, EldBuildDelete> owner(new EldOwner(), EldBuildDelete{env});
      Check(napi_get_uv_event_loop(env, &owner->loop));
      owner->iteration = Bool(env, args[3]);
      Histogram::Options options{Integer(env, args[4], "options.lowest is out of range"),
        Integer(env, args[5], "options.highest is out of range"), int(Integer(env, args[6], "options.figures is out of range"))};
      int64_t resolution = Integer(env, args[2], "resolution is out of range");
      owner->resolution = uint64_t(resolution);
      owner->timeline = std::make_shared<EventLoopDelayLoop>(uv_now(owner->loop), UvClock);
      owner->producer = owner->timeline->Create(options, owner->iteration ? EventLoopDelayProducer::Mode::Iteration : EventLoopDelayProducer::Mode::Interval, resolution);
      if (!owner->producer) throw HistogramBindingError("ERR_INVALID_ARG_VALUE", "TypeError", "Invalid histogram options");
      auto materialOwner = std::make_unique<HistogramBindingState>(); materialOwner->histogram = owner->producer->histogram();
      napi_value material = Own(env, state, std::move(materialOwner)); Check(napi_create_reference(env, material, 1, &owner->material));
      napi_value result = Object(env); Prototype(env, state, result, args[1]); Check(napi_type_tag_object(env, result, &eldTag));
      // Native handle initialization and closure are real; handles never root
      // the JavaScript wrapper or acquire a loop reference for sampling.
      if (owner->iteration) {
        if (uv_prepare_init(owner->loop, &owner->prepare)) throw std::runtime_error("UV prepare init failed");
        owner->prepareInitialized = true; owner->prepare.data = owner.get(); ++owner->handles;
        if (uv_check_init(owner->loop, &owner->check)) throw std::runtime_error("UV check init failed");
        owner->checkInitialized = true; owner->check.data = owner.get(); ++owner->handles;
        uv_unref(reinterpret_cast<uv_handle_t*>(&owner->prepare)); uv_unref(reinterpret_cast<uv_handle_t*>(&owner->check));
      } else {
        if (uv_timer_init(owner->loop, &owner->timer)) throw std::runtime_error("UV timer init failed");
        owner->timerInitialized = true; owner->timer.data = owner.get(); owner->handles = 1;
      }
      Check(napi_wrap(env, result, owner.get(), EldFinalize, nullptr, nullptr)); owner.release();
      return Packet(env, result);
    }
    auto* owner = Eld(env, args[1]);
    if (name == "material") return Packet(env, Get(env, owner->material));
    if (name == "references") return Packet(env, Number(env, owner->iteration ?
      uv_has_ref(reinterpret_cast<uv_handle_t*>(&owner->prepare)) + uv_has_ref(reinterpret_cast<uv_handle_t*>(&owner->check)) :
      uv_has_ref(reinterpret_cast<uv_handle_t*>(&owner->timer))));
    if (name == "start") {
      owner->timeline->UpdateTime(uv_now(owner->loop));
      if (owner->producer->Start(Bool(env, args[2]))) {
        if (owner->iteration) {
          uv_check_start(&owner->check, [](uv_check_t* handle) { static_cast<EldOwner*>(handle->data)->producer->Check(); });
          uv_prepare_start(&owner->prepare, [](uv_prepare_t* handle) { static_cast<EldOwner*>(handle->data)->producer->Prepare(uv_backend_timeout(handle->loop)); });
          uv_unref(reinterpret_cast<uv_handle_t*>(&owner->check)); uv_unref(reinterpret_cast<uv_handle_t*>(&owner->prepare));
        } else {
          uv_timer_start(&owner->timer, [](uv_timer_t* handle) { static_cast<EldOwner*>(handle->data)->producer->TimerFired(); }, owner->resolution, owner->resolution);
          uv_unref(reinterpret_cast<uv_handle_t*>(&owner->timer));
        }
      }
    } else if (name == "stop") {
      if (owner->producer->Stop()) {
        if (owner->iteration) { uv_check_stop(&owner->check); uv_prepare_stop(&owner->prepare); }
        else uv_timer_stop(&owner->timer);
      }
    } else throw std::runtime_error("Unknown ELD operation");
    return Packet(env, Undefined(env));
  } catch (const HistogramBindingError& error) { return Error(env, error); }
  catch (const std::exception& error) { napi_throw_error(env, nullptr, error.what()); return nullptr; }
}
static napi_value InitELD(napi_env env, napi_value exports) {
  Init(env, exports); void* state; Check(napi_get_instance_data(env, &state)); napi_value function;
  Check(napi_create_function(env, "eventLoopDelayOperation", NAPI_AUTO_LENGTH, EldDispatch, state, &function));
  Set(env, exports, "eventLoopDelayOperation", function); return exports;
}
}  // namespace
NAPI_MODULE(NODE_GYP_MODULE_NAME, InitELD)
