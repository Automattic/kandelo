/* Native function compilation for the shared Node VM frontend. Included after
 * the existing context/Stencils in shell/js.cpp; no kernel or host ABI change.
 * Compilation has identified targeted engine evidence; full VM/realm behavior
 * and four-host conformance remain incomplete.
 */
#include "js/GCAPI.h"
#include <new>
#include <string>
#include <vector>

static bool KandeloVmCompileFunction(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  if (argc != 5 || !args[0].isString() || !args[1].isObject() ||
      !args[2].isObject() || !args[3].isObject() || !args[4].isObject()) {
    JS_ReportErrorASCII(cx, "Invalid VM function compilation arguments");
    return false;
  }
  RootedString code(cx, args[0].toString());
  RootedObject params(cx, &args[1].toObject()), target(cx, &args[2].toObject());
  RootedObject options(cx, &args[3].toObject()), extensions(cx, &args[4].toObject());
  target = js::CheckedUnwrapDynamic(target, cx);
  if (!target || !JS_IsGlobalObject(target)) {
    JS_ReportErrorASCII(cx, "VM parsing context must own an accessible global");
    return false;
  }
  uint32_t count, extensionCount;
  if (!JS::GetArrayLength(cx, params, &count) ||
      !JS::GetArrayLength(cx, extensions, &extensionCount)) return false;
  RootedString filename(cx);
  int32_t lineOffset = 0, columnOffset = 0;
  RootedValue value(cx);
  if (!JS_GetProperty(cx, options, "filename", &value)) return false;
  if (value.isString()) filename = value.toString();
  if (!JS_GetProperty(cx, options, "lineOffset", &value)) return false;
  if (value.isInt32()) lineOffset = value.toInt32();
  if (!JS_GetProperty(cx, options, "columnOffset", &value)) return false;
  if (value.isInt32()) columnOffset = value.toInt32();
  if (lineOffset < 0 || columnOffset < 0) {
    JS_ReportErrorASCII(cx, "Negative VM source offsets require metadata support");
    return false;
  }
  UniqueChars filenameBytes;
  const char* file = "";
  if (filename) {
    filenameBytes = JS_EncodeStringToUTF8(cx, filename);
    if (!filenameBytes) return false;
    file = filenameBytes.get();
  }
  // CompileFunction's C strings become Latin-1 source. Encode non-ASCII UTF-16
  // as ECMAScript escapes, including scalar surrogate pairs. Embedded NUL must
  // reach the parser as invalid parameter text, never truncate a binding name.
  std::vector<std::string> names;
  std::vector<const char*> pointers;
  RootedObjectVector extensionObjects(cx);
  try {
    names.reserve(count);
    for (uint32_t i = 0; i < count; ++i) {
      if (!JS_GetElement(cx, params, i, &value)) return false;
      if (!value.isString()) { JS_ReportErrorASCII(cx, "VM parameter must be string"); return false; }
      RootedString name(cx, value.toString());
      std::string encoded;
      const size_t length = JS_GetStringLength(name);
      for (size_t j = 0; j < length; ++j) {
        char16_t unit;
        if (!JS_GetStringCharAt(cx, name, j, &unit)) return false;
        uint32_t point = unit;
        if (unit >= 0xd800 && unit <= 0xdbff && j + 1 < length) {
          char16_t trail;
          if (!JS_GetStringCharAt(cx, name, j + 1, &trail)) return false;
          if (trail >= 0xdc00 && trail <= 0xdfff) {
            point = 0x10000 + ((unit - 0xd800) << 10) + trail - 0xdc00;
            ++j;
          }
        }
        if (point > 0 && point < 128) encoded.push_back(static_cast<char>(point));
        else {
          char escape[16];
          snprintf(escape, sizeof(escape), "\\u{%x}", point);
          encoded.append(escape);
        }
      }
      names.push_back(std::move(encoded));
    }
    pointers.reserve(count);
    for (const auto& name : names) pointers.push_back(name.c_str());
  } catch (const std::bad_alloc&) { JS_ReportOutOfMemory(cx); return false; }
  catch (...) {
    JS_ReportErrorASCII(cx, "VM compilation argument allocation failed");
    return false;
  }
  for (uint32_t i = extensionCount; i > 0; --i) {
    if (!JS_GetElement(cx, extensions, i - 1, &value)) return false;
    if (!value.isObject()) { JS_ReportErrorASCII(cx, "VM context extension must be object"); return false; }
    if (!extensionObjects.append(&value.toObject())) { JS_ReportOutOfMemory(cx); return false; }
  }
  RootedValue result(cx), exception(cx);
  bool ok = false, threw = false;
  {
    JSAutoRealm realm(cx, target);
    ok = [&]() -> bool {
    JS::EnvironmentChain chain(cx, JS::SupportUnscopables::No);
    for (size_t i = 0; i < extensionObjects.length(); ++i) {
      RootedObject extension(cx, extensionObjects[i]);
      if (!JS_WrapObject(cx, &extension)) return false;
      if (!chain.append(extension)) { JS_ReportOutOfMemory(cx); return false; }
    }
    RootedValue source(cx, StringValue(code));
    if (!JS_WrapValue(cx, &source)) return false;
    RootedString realmCode(cx, source.toString());
    AutoStableStringChars stable(cx);
    if (!stable.initTwoByte(cx, realmCode)) return false;
    JS::SourceText<char16_t> body;
    if (!body.initMaybeBorrowed(cx, stable)) return false;
    JS::CompileOptions opts(cx);
    opts.setFileAndLine(file, uint32_t(lineOffset) + 1)
        .setColumn(JS::ColumnNumberOneOrigin::fromZeroOrigin(uint32_t(columnOffset)));
    RootedFunction function(cx, JS::CompileFunction(cx, chain, opts, nullptr,
        count, pointers.data(), body));
    if (function) {
      result.setObject(*JS_GetFunctionObject(function));
      return true;
    }
    return false;
    }();
    // All target-realm failures pass through this path. Return only after
    // restoring the caller realm and wrapping its exception, including errors
    // raised while wrapping an extension or allocating source/scope storage.
    if (!ok && JS_IsExceptionPending(cx)) {
      if (!JS_GetPendingException(cx, &exception)) return false;
      JS_ClearPendingException(cx);
      threw = true;
    }
  }
  if (ok) {
    if (!JS_WrapValue(cx, &result)) return false;
    args.rval().set(result);
    return true;
  }
  if (threw) {
    if (!JS_WrapValue(cx, &exception)) return false;
    JS_SetPendingException(cx, exception);
  }
  return false;
}

// Actual configured GC budget, not physical RSS or a complete V8 statistic.
// No limit is changed by reading it, and no outer-host accounting is used.
static bool KandeloNativeEngineGcHeapLimit(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  args.rval().setNumber(JS_GetGCParameter(cx, JSGC_MAX_BYTES));
  return true;
}
