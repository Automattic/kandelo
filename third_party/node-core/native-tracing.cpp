/* Actual process-wide classic trace category/file owner; no synthetic metrics. */
#include "kandelo-node-tracing-owner.h"
#include "js/Array.h"
#include "js/Conversions.h"
#include <memory>
namespace {
static void KandeloTraceFinalize(JS::GCContext*, JSObject* object) {
  delete JS::GetMaybePtrFromReservedSlot<kandelo::tracing::CategorySet>(object, 0);
}
static const JSClassOps KandeloTraceClassOps = {
    nullptr, nullptr, nullptr, nullptr, nullptr, nullptr, KandeloTraceFinalize,
    nullptr, nullptr, nullptr};
static const JSClass KandeloTraceClass = {
    "KandeloTraceCategories", JSCLASS_HAS_RESERVED_SLOTS(1), &KandeloTraceClassOps};
static bool KandeloTraceText(JSContext* cx, HandleValue input, std::string* output) {
  RootedString string(cx, JS::ToString(cx, input));
  if (!string) return false;
  JS::UniqueChars bytes = JS_EncodeStringToUTF8(cx, string);
  if (!bytes) return false;
  // Pinned CategorySet/TraceObject consume NUL-terminated UTF-8 strings.
  output->assign(bytes.get()); return true;
}
static bool KandeloTraceDispatch(JSContext* cx, const CallArgs& args,
    const char* operation, MutableHandleValue output, int* error) {
  try {
    if (strcmp(operation, "trace-has-agent") == 0) {
      (void)kandelo::tracing::Process(); output.setBoolean(true); return true;
    }
    if (strcmp(operation, "trace-create") == 0) {
      RootedObject array(cx, args.get(1).isObject() ? &args[1].toObject() : nullptr);
      bool isArray = false;
      if (!array) { JS_ReportErrorASCII(cx, "Trace categories require an Array"); return false; }
      if (!JS::IsArrayObject(cx, array, &isArray)) return false;
      if (!isArray) { JS_ReportErrorASCII(cx, "Trace categories require an Array"); return false; }
      kandelo::tracing::Owner<>::Categories names;
      for (uint32_t index = 0;; ++index) {
        uint32_t length;
        if (!JS::GetArrayLength(cx, array, &length)) return false;
        if (index >= length) break;
        RootedValue value(cx); std::string text;
        if (!JS_GetElement(cx, array, index, &value) || !KandeloTraceText(cx, value, &text)) return false;
        names.emplace(std::move(text));
      }
      RootedObject object(cx, JS_NewObjectWithGivenProto(cx, &KandeloTraceClass, nullptr));
      if (!object) return false;
      auto owner = std::make_unique<kandelo::tracing::CategorySet>(std::move(names));
      JS::SetReservedSlot(object, 0, JS::PrivateValue(owner.release()));
      output.setObject(*object); return true;
    }
    if (strcmp(operation, "trace-enable") == 0 || strcmp(operation, "trace-disable") == 0) {
      if (!args.get(1).isObject() || JS::GetClass(&args[1].toObject()) != &KandeloTraceClass) {
        JS_ReportErrorASCII(cx, "Invalid trace category owner"); return false;
      }
      auto* owner = JS::GetMaybePtrFromReservedSlot<kandelo::tracing::CategorySet>(&args[1].toObject(), 0);
      if (!owner) { JS_ReportErrorASCII(cx, "Trace category owner was retired"); return false; }
      if (strcmp(operation, "trace-enable") == 0) *error = -owner->Enable();
      else owner->Disable();
      return true;
    }
    if (strcmp(operation, "trace-categories") == 0) {
      const auto names = kandelo::tracing::Process().Enabled();
      if (names.empty()) { output.setUndefined(); return true; }
      RootedString string(cx, JS_NewStringCopyUTF8N(cx, JS::UTF8Chars(names.data(), names.size())));
      if (!string) return false;
      output.setString(string); return true;
    }
    if (strcmp(operation, "trace-enabled") == 0 || strcmp(operation, "trace-event") == 0) {
      std::string group;
      if (!KandeloTraceText(cx, args.get(1), &group)) return false;
      if (strcmp(operation, "trace-enabled") == 0) {
        output.setBoolean(kandelo::tracing::Process().Enabled(group)); return true;
      }
      std::string fields;
      if (!KandeloTraceText(cx, args.get(2), &fields)) return false;
      *error = -kandelo::tracing::Process().Append(group, fields); return true;
    }
    JS_ReportErrorASCII(cx, "Unknown trace operation"); return false;
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
}
}  // namespace
