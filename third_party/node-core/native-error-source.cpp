// Private assertion source capture from the actual live caller script. This
// does not implement public Error.captureStackTrace or mapped stack formatting.
#include "vm/FrameIter.h"
#include "vm/JSScript.h"
#include "vm/Realm.h"
#include "js/CharacterEncoding.h"
#include "js/Wrapper.h"

namespace {
static bool KandeloSourceLineTerminator(char16_t value) {
  return value == '\n' || value == '\r' || value == 0x2028 || value == 0x2029;
}
static bool KandeloCaptureAssertionSource(JSContext* cx, unsigned argc, Value* vp) {
  CallArgs args = CallArgsFromVp(argc, vp);
  args.rval().setUndefined();
  if (!args.get(0).isObject()) return true;
  RootedObject boundary(cx, js::CheckedUnwrapDynamic(&args[0].toObject(), cx));
  if (!boundary) {
    if (!JS_IsExceptionPending(cx)) js::ReportAccessDenied(cx);
    return false;
  }
  if (!boundary->is<JSFunction>()) return true;
  RootedFunction function(cx, &boundary->as<JSFunction>());
  RootedScript caller(cx);
  unsigned line = 0;
  JS::LimitedColumnNumberOneOrigin column;
  // Principals filter is the engine's real frame-visibility owner. Match the
  // actual cutoff function (including JIT clone handling), never its name or
  // an assumed number of adapter/assertion frames.
  for (NonBuiltinFrameIter iter(cx, cx->realm()->principals()); !iter.done(); ++iter) {
    if (!iter.hasScript() || !iter.isFunctionFrame()) continue;
    const bool matches = iter.matchCallee(cx, function);
    if (JS_IsExceptionPending(cx)) return false;
    if (!matches) continue;
    ++iter;
    if (iter.done() || !iter.hasScript() || !iter.pc()) return true;
    caller = iter.script();
    line = PCToLineNumber(caller, iter.pc(), &column);
    break;
  }
  if (!caller || caller->mutedErrors() || !column.valid() ||
      column.oneOriginValue() == JS::LimitedColumnNumberOneOrigin::Limit ||
      !caller->column().valid() ||
      caller->column().oneOriginValue() == JS::LimitedColumnNumberOneOrigin::Limit)
    return true;
  auto* source = caller->scriptSource();
  // Kandelo CJS/VM compilation supplies actual UTF-16 SourceText. UTF-8 source
  // extents use other code units; no byte-to-UTF16 guess is substituted here.
  if (!source->hasSourceText() || !source->hasSourceType<char16_t>() ||
      line < caller->lineno()) return true;
  const uint32_t sourceStart = caller->sourceStart();
  const uint32_t sourceLine = caller->lineno();
  const uint32_t sourceColumn = caller->column().oneOriginValue();
  const uint32_t actualColumn = column.oneOriginValue();
  RootedValue result(cx);
  {
    JSAutoRealm realm(cx, caller);
    RootedString text(cx, source->substring(cx, 0, source->length()));
    if (!text) return false;
    RootedString selected(cx);
    size_t startColumn;
    {
      AutoStableStringChars chars(cx);
      if (!chars.initTwoByte(cx, text)) return false;
      const char16_t* units = chars.twoByteChars();
      const size_t length = text->length();
      if (sourceStart > length) return true;
      size_t begin = sourceStart;
      while (begin && !KandeloSourceLineTerminator(units[begin - 1])) --begin;
      size_t cursor = sourceStart;
      unsigned currentLine = sourceLine;
      while (currentLine < line) {
        while (cursor < length && !KandeloSourceLineTerminator(units[cursor])) ++cursor;
        if (cursor == length) return true;
        if (units[cursor++] == '\r' && cursor < length && units[cursor] == '\n') ++cursor;
        begin = cursor;
        ++currentLine;
      }
      size_t end = cursor;
      while (end < length && !KandeloSourceLineTerminator(units[end])) ++end;
      if (line == sourceLine) {
        if (actualColumn < sourceColumn) return true;
        startColumn = size_t(sourceStart - begin) + (actualColumn - sourceColumn);
      } else {
        startColumn = actualColumn - 1;
      }
      if (startColumn > end - begin) return true;
      // AutoStableStringChars pins this actual owned source through the
      // allocating copy. No borrowed pointer escapes into publication/JS.
      selected = JS_NewUCStringCopyN(cx, units + begin, end - begin);
      if (!selected) return false;
    }
    RootedObject info(cx, JS_NewObjectWithGivenProto(cx, nullptr, nullptr));
    RootedValue sourceValue(cx, StringValue(selected));
    RootedValue columnValue(cx, DoubleValue(double(startColumn)));
    if (!info || !JS_DefineProperty(cx, info, "sourceLine", sourceValue, JSPROP_ENUMERATE) ||
        !JS_DefineProperty(cx, info, "startColumn", columnValue, JSPROP_ENUMERATE)) return false;
    result.setObject(*info);
  }
  if (!JS_WrapValue(cx, &result)) return false;
  args.rval().set(result);
  return true;
}
}  // namespace
