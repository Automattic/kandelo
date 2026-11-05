// Streaming HTTP/1 response framing over the exact Node-vendored llhttp.
// This owner is independent of JS engines; it never retains borrowed input.
#ifndef KANDELO_NODE_HTTP_PARSER_H
#define KANDELO_NODE_HTTP_PARSER_H
#include <cstdint>
#include <exception>
#include <llhttp.h>
#include <new>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>
namespace kandelo::http {
struct Event {
  enum class Type { Headers, Body, Complete } type;
  std::vector<std::string> headers;
  std::string statusMessage;
  std::vector<uint8_t> body;
  unsigned major = 0, minor = 0, status = 0;
  bool keepAlive = false, upgrade = false, informational = false;
  explicit Event(Type type) : type(type) {}
};
struct Step {
  std::vector<Event> events;
  std::vector<uint8_t> remainder;
  size_t consumed = 0;
  bool complete = false, upgrade = false;
  std::string code, reason;
};
class ResponseParser final {
 public:
  explicit ResponseParser(std::string method = "GET", uint64_t limit = 0,
                          bool insecure = false, bool relaxed = false)
      : method_(std::move(method)), limit_(limit ? limit : 16 * 1024) {
    llhttp_settings_init(&settings_);
    settings_.on_message_begin = Begin;
    settings_.on_status = Status;
    settings_.on_header_field = Field;
    settings_.on_header_value = Value;
    settings_.on_header_value_complete = ValueComplete;
    settings_.on_headers_complete = Headers;
    settings_.on_body = Body;
    settings_.on_message_complete = Complete;
    settings_.on_chunk_extension_name = Extension;
    settings_.on_chunk_extension_value = Extension;
    settings_.on_chunk_header = Chunk;
    settings_.on_chunk_complete = ChunkComplete;
    llhttp_init(&parser_, HTTP_RESPONSE, &settings_);
    parser_.data = this;
    // Exactly Node's kLenientAll (bits 0..9). Header-value relaxation is a
    // separate option, not implicitly enabled by insecureHTTPParser.
    if (insecure) {
      llhttp_set_lenient_headers(&parser_, 1);
      llhttp_set_lenient_chunked_length(&parser_, 1);
      llhttp_set_lenient_keep_alive(&parser_, 1);
      llhttp_set_lenient_transfer_encoding(&parser_, 1);
      llhttp_set_lenient_version(&parser_, 1);
      llhttp_set_lenient_data_after_close(&parser_, 1);
      llhttp_set_lenient_optional_lf_after_cr(&parser_, 1);
      llhttp_set_lenient_optional_crlf_after_chunk(&parser_, 1);
      llhttp_set_lenient_optional_cr_before_lf(&parser_, 1);
      llhttp_set_lenient_spaces_after_chunk_size(&parser_, 1);
    }
    if (relaxed) llhttp_set_lenient_header_value_relaxed(&parser_, 1);
  }
  ResponseParser(const ResponseParser&) = delete;
  ResponseParser& operator=(const ResponseParser&) = delete;
  ResponseParser(ResponseParser&&) = delete;
  ResponseParser& operator=(ResponseParser&&) = delete;

  Step Feed(const uint8_t* bytes, size_t length) {
    if (oom_) throw std::bad_alloc();
    if (unexpected_) throw std::runtime_error("HTTP parser callback failed");
    Step step;
    if (!errorCode_.empty()) { Error(step); return step; }
    if (complete_) {
      step.complete = true; step.upgrade = upgrade_;
      if (length) step.remainder.assign(bytes, bytes + length);
      return step;
    }
    step_ = &step;
    // A non-null empty buffer also avoids undefined pointer subtraction.
    const char* input = length ? reinterpret_cast<const char*>(bytes) : "";
    const auto error = llhttp_execute(&parser_, input, length);
    step_ = nullptr;
    CheckCallback();
    if (error == HPE_OK) step.consumed = length;
    else {
      const char* position = llhttp_get_error_pos(&parser_);
      // error_pos is read only for this call, while its input is alive.
      if (position) {
        const auto base = reinterpret_cast<uintptr_t>(input);
        const auto at = reinterpret_cast<uintptr_t>(position);
        if (at >= base && at - base <= length) step.consumed = at - base;
      }
      if (error != HPE_PAUSED && error != HPE_PAUSED_UPGRADE) SaveError(error);
    }
    if (error == HPE_PAUSED_UPGRADE) { complete_ = true; upgrade_ = true; }
    step.complete = complete_; step.upgrade = upgrade_;
    if (complete_ && step.consumed < length)
      step.remainder.assign(bytes + step.consumed, bytes + length);
    Error(step);
    return step;
  }
  Step Finish() {
    if (oom_) throw std::bad_alloc();
    if (unexpected_) throw std::runtime_error("HTTP parser callback failed");
    Step step;
    if (!errorCode_.empty()) { Error(step); return step; }
    if (!complete_) {
      step_ = &step;
      const auto error = llhttp_finish(&parser_);
      step_ = nullptr;
      CheckCallback();
      if (error != HPE_OK && error != HPE_PAUSED) SaveError(error);
    }
    step.complete = complete_; step.upgrade = upgrade_;
    Error(step); return step;
  }
  size_t AllocationBytes() const {
    size_t bytes = sizeof(*this) + HeapString(method_) + HeapString(status_) +
        HeapString(field_) + HeapString(value_) + HeapString(errorCode_) + HeapString(errorReason_);
    bytes += headers_.capacity() * sizeof(std::string);
    for (const auto& item : headers_) bytes += HeapString(item);
    return bytes;
  }
 private:
  llhttp_t parser_{};
  llhttp_settings_t settings_{};
  std::string method_, status_, field_, value_, errorCode_, errorReason_;
  std::vector<std::string> headers_;
  uint64_t limit_, headerBytes_ = 0, extensionBytes_ = 0;
  bool complete_ = false, upgrade_ = false, informational_ = false;
  bool oom_ = false, unexpected_ = false;
  Step* step_ = nullptr;
  static size_t HeapString(const std::string& value) {
    const auto data = reinterpret_cast<uintptr_t>(value.data());
    const auto owner = reinterpret_cast<uintptr_t>(&value);
    return data >= owner && data - owner < sizeof(value) ? 0 : value.capacity() + 1;
  }
  void Error(Step& step) const { step.code = errorCode_; step.reason = errorReason_; }
  void SaveError(llhttp_errno_t error) {
    errorCode_ = llhttp_errno_name(error);
    const char* reason = llhttp_get_error_reason(&parser_);
    errorReason_ = reason ? reason : "";
    if (error == HPE_USER) {
      const auto colon = errorReason_.find(':');
      if (colon != std::string::npos) {
        errorCode_ = errorReason_.substr(0, colon);
        errorReason_.erase(0, colon + 1);
      }
    }
  }
  void CheckCallback() const {
    if (oom_) throw std::bad_alloc();
    if (unexpected_) throw std::runtime_error("HTTP parser callback failed");
  }
  // No C++ exception may unwind through unchanged C parser frames.
  template <typename Callback> static int Guard(llhttp_t* parser, Callback callback) noexcept {
    auto& self = *static_cast<ResponseParser*>(parser->data);
    try { return callback(self); }
    catch (const std::bad_alloc&) { self.oom_ = true; }
    catch (const std::length_error&) { self.oom_ = true; }
    catch (...) { self.unexpected_ = true; }
    llhttp_set_error_reason(parser, "HTTP parser callback failed");
    return HPE_USER;
  }
  int Track(size_t length) {
    if (headerBytes_ >= limit_ || uint64_t(length) >= limit_ - headerBytes_) {
      llhttp_set_error_reason(&parser_, "HPE_HEADER_OVERFLOW:Header overflow");
      return HPE_USER;
    }
    headerBytes_ += length; return 0;
  }
  static int Begin(llhttp_t* parser) noexcept {
    return Guard(parser, [](ResponseParser& s) {
      s.status_.clear(); s.field_.clear(); s.value_.clear(); s.headers_.clear();
      s.informational_ = false; s.upgrade_ = false; return 0;
    });
  }
  static int Status(llhttp_t* p, const char* at, size_t size) noexcept {
    return Guard(p, [&](ResponseParser& s) {
      if (int error = s.Track(size)) return error;
      s.status_.append(at, size); return 0;
    });
  }
  static int Field(llhttp_t* p, const char* at, size_t size) noexcept {
    return Guard(p, [&](ResponseParser& s) {
      if (int error = s.Track(size)) return error;
      s.field_.append(at, size); return 0;
    });
  }
  static int Value(llhttp_t* p, const char* at, size_t size) noexcept {
    return Guard(p, [&](ResponseParser& s) {
      if (int error = s.Track(size)) return error;
      s.value_.append(at, size); return 0;
    });
  }
  static int ValueComplete(llhttp_t* p) noexcept {
    return Guard(p, [](ResponseParser& s) {
      while (!s.value_.empty() && (s.value_.back() == ' ' || s.value_.back() == '\t')) s.value_.pop_back();
      s.headers_.push_back(std::move(s.field_)); s.headers_.push_back(std::move(s.value_));
      s.field_.clear(); s.value_.clear(); return 0;
    });
  }
  static int Headers(llhttp_t* p) noexcept {
    return Guard(p, [](ResponseParser& s) {
      s.headerBytes_ = 0;
      s.informational_ = s.parser_.status_code >= 100 && s.parser_.status_code < 200 && s.parser_.status_code != 101;
      s.upgrade_ = s.parser_.upgrade || s.method_ == "CONNECT";
      Event event(Event::Type::Headers);
      event.headers = std::move(s.headers_); event.statusMessage = std::move(s.status_);
      event.major = s.parser_.http_major; event.minor = s.parser_.http_minor;
      event.status = s.parser_.status_code; event.keepAlive = llhttp_should_keep_alive(&s.parser_);
      event.upgrade = s.upgrade_; event.informational = s.informational_;
      s.step_->events.push_back(std::move(event));
      if (s.upgrade_) return 2;
      if (s.informational_ || s.method_ == "HEAD") return 1;
      return 0;
    });
  }
  static int Body(llhttp_t* p, const char* at, size_t size) noexcept {
    return Guard(p, [&](ResponseParser& s) {
      if (size) {
        Event event(Event::Type::Body);
        event.body.assign(reinterpret_cast<const uint8_t*>(at), reinterpret_cast<const uint8_t*>(at) + size);
        s.step_->events.push_back(std::move(event));
      }
      return 0;
    });
  }
  static int Complete(llhttp_t* p) noexcept {
    return Guard(p, [](ResponseParser& s) {
      Event event(Event::Type::Complete);
      event.headers = std::move(s.headers_); event.informational = s.informational_;
      event.upgrade = s.upgrade_; s.step_->events.push_back(std::move(event));
      if (s.informational_) return 0;
      s.complete_ = true;
      return s.upgrade_ ? 0 : int(HPE_PAUSED);
    });
  }
  static int Extension(llhttp_t* p, const char*, size_t size) noexcept {
    return Guard(p, [&](ResponseParser& s) {
      if (size > 16384 - s.extensionBytes_) {
        llhttp_set_error_reason(&s.parser_, "HPE_CHUNK_EXTENSIONS_OVERFLOW:Chunk extensions overflow");
        return int(HPE_USER);
      }
      s.extensionBytes_ += size; return 0;
    });
  }
  static int Chunk(llhttp_t* p) noexcept {
    return Guard(p, [](ResponseParser& s) { s.headerBytes_ = 0; s.extensionBytes_ = 0; return 0; });
  }
  static int ChunkComplete(llhttp_t* p) noexcept {
    return Guard(p, [](ResponseParser& s) { s.headerBytes_ = 0; return 0; });
  }
};
}  // namespace kandelo::http
#endif
