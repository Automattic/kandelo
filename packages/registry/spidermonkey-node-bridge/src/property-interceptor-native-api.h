#ifndef KANDELO_NODE_PROPERTY_INTERCEPTOR_NATIVE_API_H
#define KANDELO_NODE_PROPERTY_INTERCEPTOR_NATIVE_API_H

// C++ source interfaces from pinned Node's V8 embedding API. These records
// contain borrowed API handles only while being passed to SetHandler. The
// bridge moves JavaScript payloads into traced template slots before returning.
// This header defines neither property lookup policy nor callback dispatch.
namespace v8 {
enum class Intercepted { kNo, kYes };
enum class PropertyHandlerFlags {
  kNone = 0,
  kNonMasking = 1,
  kOnlyInterceptStrings = 1 << 1,
  kHasNoSideEffect = 1 << 2,
  kHasDontDeleteProperty = 1 << 3,
  kInternalNewCallbacksSignatures = 1 << 10,
};
using NamedPropertyGetterCallback = Intercepted (*)(Local<Name>, const PropertyCallbackInfo<Value>&);
using NamedPropertySetterCallback = Intercepted (*)(Local<Name>, Local<Value>, const PropertyCallbackInfo<void>&);
using NamedPropertyQueryCallback = Intercepted (*)(Local<Name>, const PropertyCallbackInfo<Integer>&);
using NamedPropertyDeleterCallback = Intercepted (*)(Local<Name>, const PropertyCallbackInfo<Boolean>&);
using NamedPropertyEnumeratorCallback = void (*)(const PropertyCallbackInfo<Array>&);
using NamedPropertyDefinerCallback = Intercepted (*)(Local<Name>, const PropertyDescriptor&, const PropertyCallbackInfo<void>&);
using NamedPropertyDescriptorCallback = Intercepted (*)(Local<Name>, const PropertyCallbackInfo<Value>&);
using IndexedPropertyGetterCallbackV2 = Intercepted (*)(uint32_t, const PropertyCallbackInfo<Value>&);
using IndexedPropertySetterCallbackV2 = Intercepted (*)(uint32_t, Local<Value>, const PropertyCallbackInfo<void>&);
using IndexedPropertyQueryCallbackV2 = Intercepted (*)(uint32_t, const PropertyCallbackInfo<Integer>&);
using IndexedPropertyDeleterCallbackV2 = Intercepted (*)(uint32_t, const PropertyCallbackInfo<Boolean>&);
using IndexedPropertyEnumeratorCallback = void (*)(const PropertyCallbackInfo<Array>&);
using IndexedPropertyDefinerCallbackV2 = Intercepted (*)(uint32_t, const PropertyDescriptor&, const PropertyCallbackInfo<void>&);
using IndexedPropertyDescriptorCallbackV2 = Intercepted (*)(uint32_t, const PropertyCallbackInfo<Value>&);

struct NamedPropertyHandlerConfiguration {
  NamedPropertyHandlerConfiguration(
      NamedPropertyGetterCallback getter,
      NamedPropertySetterCallback setter,
      NamedPropertyQueryCallback query,
      NamedPropertyDeleterCallback deleter,
      NamedPropertyEnumeratorCallback enumerator,
      NamedPropertyDefinerCallback definer,
      NamedPropertyDescriptorCallback descriptor,
      Local<Value> data = {},
      PropertyHandlerFlags flags = PropertyHandlerFlags::kNone)
      : getter(getter), setter(setter), query(query), deleter(deleter), enumerator(enumerator), definer(definer), descriptor(descriptor),
        data(data), flags(flags) {}
  explicit NamedPropertyHandlerConfiguration(
      NamedPropertyGetterCallback getter,
      NamedPropertySetterCallback setter = nullptr,
      NamedPropertyQueryCallback query = nullptr,
      NamedPropertyDeleterCallback deleter = nullptr,
      NamedPropertyEnumeratorCallback enumerator = nullptr,
      Local<Value> data = {},
      PropertyHandlerFlags flags = PropertyHandlerFlags::kNone)
      : getter(getter), setter(setter), query(query), deleter(deleter), enumerator(enumerator), definer(nullptr), descriptor(nullptr),
        data(data), flags(flags) {}
  NamedPropertyHandlerConfiguration(
      NamedPropertyGetterCallback getter,
      NamedPropertySetterCallback setter,
      NamedPropertyDescriptorCallback descriptor,
      NamedPropertyDeleterCallback deleter,
      NamedPropertyEnumeratorCallback enumerator,
      NamedPropertyDefinerCallback definer,
      Local<Value> data = {},
      PropertyHandlerFlags flags = PropertyHandlerFlags::kNone)
      : getter(getter), setter(setter), query(nullptr), deleter(deleter), enumerator(enumerator), definer(definer), descriptor(descriptor),
        data(data), flags(flags) {}
  NamedPropertyGetterCallback getter;
  NamedPropertySetterCallback setter;
  NamedPropertyQueryCallback query;
  NamedPropertyDeleterCallback deleter;
  NamedPropertyEnumeratorCallback enumerator;
  NamedPropertyDefinerCallback definer;
  NamedPropertyDescriptorCallback descriptor;
  Local<Value> data;
  PropertyHandlerFlags flags;
};

struct IndexedPropertyHandlerConfiguration {
  IndexedPropertyHandlerConfiguration(
      IndexedPropertyGetterCallbackV2 getter,
      IndexedPropertySetterCallbackV2 setter,
      IndexedPropertyQueryCallbackV2 query,
      IndexedPropertyDeleterCallbackV2 deleter,
      IndexedPropertyEnumeratorCallback enumerator,
      IndexedPropertyDefinerCallbackV2 definer,
      IndexedPropertyDescriptorCallbackV2 descriptor,
      Local<Value> data = {},
      PropertyHandlerFlags flags = PropertyHandlerFlags::kNone)
      : getter(getter), setter(setter), query(query), deleter(deleter), enumerator(enumerator), definer(definer), descriptor(descriptor),
        data(data), flags(flags) {}
  explicit IndexedPropertyHandlerConfiguration(
      IndexedPropertyGetterCallbackV2 getter = nullptr,
      IndexedPropertySetterCallbackV2 setter = nullptr,
      IndexedPropertyQueryCallbackV2 query = nullptr,
      IndexedPropertyDeleterCallbackV2 deleter = nullptr,
      IndexedPropertyEnumeratorCallback enumerator = nullptr,
      Local<Value> data = {},
      PropertyHandlerFlags flags = PropertyHandlerFlags::kNone)
      : getter(getter), setter(setter), query(query), deleter(deleter), enumerator(enumerator), definer(nullptr), descriptor(nullptr),
        data(data), flags(flags) {}
  IndexedPropertyHandlerConfiguration(
      IndexedPropertyGetterCallbackV2 getter,
      IndexedPropertySetterCallbackV2 setter,
      IndexedPropertyDescriptorCallbackV2 descriptor,
      IndexedPropertyDeleterCallbackV2 deleter,
      IndexedPropertyEnumeratorCallback enumerator,
      IndexedPropertyDefinerCallbackV2 definer,
      Local<Value> data = {},
      PropertyHandlerFlags flags = PropertyHandlerFlags::kNone)
      : getter(getter), setter(setter), query(nullptr), deleter(deleter), enumerator(enumerator), definer(definer), descriptor(descriptor),
        data(data), flags(flags) {}
  IndexedPropertyGetterCallbackV2 getter;
  IndexedPropertySetterCallbackV2 setter;
  IndexedPropertyQueryCallbackV2 query;
  IndexedPropertyDeleterCallbackV2 deleter;
  IndexedPropertyEnumeratorCallback enumerator;
  IndexedPropertyDefinerCallbackV2 definer;
  IndexedPropertyDescriptorCallbackV2 descriptor;
  Local<Value> data;
  PropertyHandlerFlags flags;
};
}  // namespace v8
#endif
