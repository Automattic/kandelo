// Real dynamic-library ownership over the guest libc loader. This owner has
// no JS values or callbacks; finalization only requests later owner-thread close.
#ifndef KANDELO_NODE_FFI_LIBRARY_OWNER_H_
#define KANDELO_NODE_FFI_LIBRARY_OWNER_H_
#include <dlfcn.h>
#include <algorithm>
#include <cstdint>
#include <exception>
#include <memory>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <utility>
#include <vector>

namespace kandelo::ffi {
struct Error : std::runtime_error {
  const char* code;
  Error(const char* code, const std::string& message)
      : std::runtime_error(message), code(code) {}
};
inline std::string LoaderError(const char* operation) {
  const char* error = dlerror();
  return std::string(operation) + " failed: " + (error ? error : "unknown loader error");
}
class Environment;
class Library {
  friend class Environment;
  void* handle_ = nullptr;
  bool closed_ = false;
  bool finalized_ = false;
  std::string path_;
  std::unordered_map<std::string, uintptr_t> symbols_;
 public:
  explicit Library(std::string path) : path_(std::move(path)) {}
  Library(const Library&) = delete;
  Library& operator=(const Library&) = delete;
  // Never call into the loader from a JS finalizer or a native destructor.
  // Environment owns every open handle until explicit close/drain/shutdown.
  ~Library() = default;
  const std::string& Path() const noexcept { return path_; }
  void Finalized() noexcept { finalized_ = true; }
  void RequireOpen() const {
    if (closed_ || !handle_) throw Error("ERR_FFI_LIBRARY_CLOSED", "Library is closed");
  }
  uintptr_t Symbol(const std::string& name) {
    RequireOpen();
    auto found = symbols_.find(name);
    if (found != symbols_.end()) return found->second;
    // A null symbol value is permitted by dlsym. Only dlerror indicates failure.
    dlerror();
    void* pointer = dlsym(handle_, name.c_str());
    const char* error = dlerror();
    if (error) throw Error("ERR_FFI_CALL_FAILED", std::string("dlsym failed: ") + error);
    auto address = reinterpret_cast<uintptr_t>(pointer);
    symbols_.emplace(name, address);
    return address;
  }
  const std::unordered_map<std::string, uintptr_t>& Symbols() const {
    RequireOpen();
    return symbols_;
  }
  void Close() {
    if (closed_) return;
    // The guest loader may retire its public handle before reporting an unload
    // error. Consume this exact ownership once; never retry a numeric handle.
    closed_ = true;
    void* handle = std::exchange(handle_, nullptr);
    symbols_.clear();
    if (handle && dlclose(handle) != 0)
      throw Error("ERR_FFI_CALL_FAILED", LoaderError("dlclose"));
  }
};
class Environment {
  std::vector<std::shared_ptr<Library>> libraries_;
  bool retired_ = false;
  void CollectClosed() noexcept {
    libraries_.erase(std::remove_if(libraries_.begin(), libraries_.end(),
        [](const auto& library) { return library->closed_; }), libraries_.end());
  }
 public:
  std::shared_ptr<Library> Open(const char* path) {
    if (retired_) throw Error("ERR_FFI_CALL_FAILED", "FFI environment is closed");
    CollectClosed();
    auto library = std::make_shared<Library>(path ? path : "");
    // Publish native ownership before dlopen: allocation failure cannot orphan
    // a loaded image. No JS object or context is retained by this registry.
    libraries_.push_back(library);
    dlerror();
    library->handle_ = dlopen(path, RTLD_LAZY);
    if (!library->handle_) {
      library->closed_ = true;
      CollectClosed();
      throw Error("ERR_FFI_CALL_FAILED", LoaderError("dlopen"));
    }
    return library;
  }
  // Continue retiring every owner after an error, then report the first real
  // failure. No user code executes here. Closed states may survive via wrappers.
  void Drain(bool shutdown = false) {
    if (shutdown) retired_ = true;
    std::exception_ptr failure;
    for (const auto& library : libraries_) {
      if (shutdown || library->finalized_) {
        try { library->Close(); }
        catch (...) { if (!failure) failure = std::current_exception(); }
      }
    }
    CollectClosed();
    if (failure) std::rethrow_exception(failure);
  }
  size_t Pending() const noexcept { return libraries_.size(); }
};
}  // namespace kandelo::ffi
#endif
