// Owned OpenSSL queues and exact Node decoration order. No JS values, contexts
// or provider-owned text pointers survive this capture/worker handoff boundary.
#ifndef KANDELO_NODE_CRYPTO_ERRORS_H
#define KANDELO_NODE_CRYPTO_ERRORS_H
#include <algorithm>
#include <cstdint>
#include <locale>
#include <optional>
#include <openssl/err.h>
#include <openssl/opensslv.h>
#include <stdexcept>
#include <string>
#include <string_view>
#include <utility>
#include <vector>
namespace kandelo::crypto {
// NODE_CRYPTO_UPPER
// NODE_CRYPTO_DECORATE
struct Decoration {
  std::vector<std::pair<std::string,std::string>> fields;
  static Decoration Capture(unsigned long number) {
    Decoration result;
    DescribeError(number,[&](const char* name,const char* value){
      result.fields.emplace_back(name,value);return true;
    });
    return result;
  }
};
class CryptoErrorStore {
 public:
  std::vector<std::string> errors_;
  unsigned long primary_openssl_error_=0;
  std::optional<std::string> node_error_code_;
  void Insert(std::string value){errors_.push_back(std::move(value));}
  void SetNodeErrorCode(const char* value){node_error_code_=value;}
  // NODE_CRYPTO_CAPTURE
};
enum class ErrorKind { Error, TypeError, RangeError, SyntaxError, URIError };
// NODE_CRYPTO_NODE_KINDS
// NODE_CRYPTO_EMPTY_MESSAGE
struct Error : std::runtime_error {
  std::string message;
  unsigned long number=0;
  std::string library,function,reason,code;
  std::vector<std::string> stack;
  std::vector<Decoration> decorations;
  bool checkedNodeCode=false;
 private:
  struct Captured {};
  Error(const std::string& text,CryptoErrorStore&& store,unsigned long explicitNumber,Captured)
      : std::runtime_error(text),message(text) {
    stack=std::move(store.errors_);
    if(store.primary_openssl_error_) decorations.push_back(Decoration::Capture(store.primary_openssl_error_));
    if(explicitNumber) decorations.push_back(Decoration::Capture(explicitNumber));
    number=explicitNumber?explicitNumber:store.primary_openssl_error_;
    if(!decorations.empty()) {
      for(const auto& field:decorations.back().fields) {
        if(field.first=="library")library=field.second;
        else if(field.first=="function")function=field.second;
        else if(field.first=="reason")reason=field.second;
        else if(field.first=="code")code=field.second;
      }
    }
  }
 public:
  static CryptoErrorStore Capture() { CryptoErrorStore store;store.Capture();return store; }
  explicit Error(const std::string& text,unsigned long explicitNumber=0)
      : Error(text,Capture(),explicitNumber,Captured{}) {}
  static Error FromCaptured(CryptoErrorStore&& store,std::optional<std::string> text=std::nullopt) {
    if(!text) {
      if(store.errors_.empty())text=EmptyStoreMessage();
      else {text=std::move(store.errors_.back());store.errors_.pop_back();}
    }
    auto nodeCode=std::move(store.node_error_code_);
    Error result(*text,std::move(store),0,Captured{});
    if(result.decorations.empty()&&nodeCode)result.code=std::move(*nodeCode);
    return result;
  }
  void SetNodeCode(const char* value) {
    // Explicit Node argument/state errors own their code, not a provider queue.
    number=0;library.clear();function.clear();reason.clear();stack.clear();decorations.clear();
    code=value;checkedNodeCode=IsNativeNodeCode(value);
  }
};
// Node's ordinary [[Set]] may return false without throwing. The adapter's
// setter returns false only for an actual exception/allocation failure.
// Native Node-code macros additionally Check() that exception result.
template<class SetStack,class SetString>
bool ApplyErrorProperties(const Error& error,SetStack&& setStack,SetString&& setString) {
  if(!error.stack.empty()&&!setStack(error.stack))return false;
  for(const auto& decoration:error.decorations)
    for(const auto& field:decoration.fields)
      if(!setString(field.first,field.second))return false;
  if(error.decorations.empty()&&!error.code.empty()&&!setString("code",error.code))return false;
  return true;
}
} // namespace kandelo::crypto
#endif
