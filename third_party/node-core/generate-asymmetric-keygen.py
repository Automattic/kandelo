#!/usr/bin/env python3
"""Generate actual portable pair-generation setup from unchanged Node26 traits."""
from pathlib import Path
import argparse,hashlib,json

def generate(root):
    spec=json.loads((root/'asymmetric-keygen-sources.json').read_text())
    target=json.loads((root.parents[1]/'packages/registry/node-compat/target.json').read_text())
    if (spec['version'],spec['commit'])!=(target['version'],target['source']['commit']):
        raise ValueError('Asymmetric generation target/source mismatch')
    texts={}
    for name,item in spec['sources'].items():
        raw=(root/item['path']).read_bytes()
        if hashlib.sha256(raw).hexdigest()!=item['sha256']:
            raise ValueError('Asymmetric generation source mismatch: '+name)
        texts[name]=raw.decode()
    def section(name):
        item=spec['sections'][name];source=texts[item['source']]
        if source.count(item['start'])!=1:raise ValueError('Ambiguous keygen section '+name)
        start=source.index(item['start']);out=source[start:start+item['length']]
        if hashlib.sha256(out.encode()).hexdigest()!=item['sha256']:
            raise ValueError('Keygen section changed: '+name)
        return out
    header = r'''// Generated from exact pinned Node native traits; owning embedding declarations only.
#ifndef KANDELO_NODE_KEYPAIR_OPERATIONS_H
#define KANDELO_NODE_KEYPAIR_OPERATIONS_H
#include "kandelo-node-key-operations.h"
#include <openssl/objects.h>
#include <cstdlib>
#include <cstdint>
#include <optional>
#include <string>
#include <type_traits>
#include <variant>
namespace kandelo::crypto::keypair {
using ncrypto::BignumPointer;
using ncrypto::DHPointer;
using ncrypto::Digest;
using ncrypto::EVPKeyCtxPointer;
using ncrypto::EVPKeyPointer;
using ncrypto::KeyAlgorithm;
enum RSAKeyVariant {
  kKeyVariantRSA_SSA_PKCS1_v1_5,
  kKeyVariantRSA_PSS,
  kKeyVariantRSA_OAEP
};
struct RsaKeyPairParams {
  RSAKeyVariant variant;
  unsigned int modulus_bits, exponent;
  Digest md = nullptr, mgf1_md = nullptr;
  int saltlen = -1;
};
struct DsaKeyPairParams { unsigned int modulus_bits;int divisor_bits; };
struct EcKeyPairParams {
  const KeyAlgorithm* algorithm = nullptr;
  std::string curve_name;
  int param_encoding;
};
struct DhKeyPairParams { std::variant<BignumPointer,int> prime;unsigned int generator; };
struct NamedKeyPairParams { const KeyAlgorithm* algorithm = nullptr; };
template<class Params> struct KeyPairGenConfig { Params params{}; };
using RsaKeyPairGenConfig=KeyPairGenConfig<RsaKeyPairParams>;
using DsaKeyPairGenConfig=KeyPairGenConfig<DsaKeyPairParams>;
using EcKeyPairGenConfig=KeyPairGenConfig<EcKeyPairParams>;
using DhKeyPairGenConfig=KeyPairGenConfig<DhKeyPairParams>;
using NamedKeyPairGenConfig=KeyPairGenConfig<NamedKeyPairParams>;
struct RsaKeyGenTraits { static EVPKeyCtxPointer Setup(RsaKeyPairGenConfig*); };
struct DsaKeyGenTraits { static EVPKeyCtxPointer Setup(DsaKeyPairGenConfig*); };
struct EcKeyGenTraits { static EVPKeyCtxPointer Setup(EcKeyPairGenConfig*); };
struct DhKeyGenTraits { static EVPKeyCtxPointer Setup(DhKeyPairGenConfig*); };
struct NamedKeyPairGenTraits { static EVPKeyCtxPointer Setup(NamedKeyPairGenConfig*); };
// Preserve the shell fatal invariant policy; the portable component uses abort.
#ifndef UNREACHABLE
#define KANDELO_PAIR_LOCAL_UNREACHABLE
#define UNREACHABLE(...) std::abort()
#endif
'''
    header += '\n\n'.join(section(k) for k in ['rsaDigest','rsa','dsa','ec','dh','named'])
    header += r'''
#ifdef KANDELO_PAIR_LOCAL_UNREACHABLE
#undef UNREACHABLE
#undef KANDELO_PAIR_LOCAL_UNREACHABLE
#endif
using Parameters=std::variant<RsaKeyPairGenConfig,DsaKeyPairGenConfig,EcKeyPairGenConfig,
                              DhKeyPairGenConfig,NamedKeyPairGenConfig>;
enum class Kind { Rsa, Dsa, Ec, Dh, Named };
inline size_t StringStorage(const std::string& value) noexcept {
  const uintptr_t data=reinterpret_cast<uintptr_t>(value.data());
  const uintptr_t object=reinterpret_cast<uintptr_t>(&value);
  return data>=object && data-object<sizeof(value) ? 0 : value.capacity()+1;
}
struct Operation {
  Parameters parameters;
  EVPKeyPointer::PublicKeyEncodingConfig publicEncoding;
  EVPKeyPointer::PrivateKeyEncodingConfig privateEncoding;
  Kind kind;
  explicit Operation(Kind value):kind(value) {
    switch(value) {
      case Kind::Rsa: parameters.emplace<RsaKeyPairGenConfig>();break;
      case Kind::Dsa: parameters.emplace<DsaKeyPairGenConfig>();break;
      case Kind::Ec: parameters.emplace<EcKeyPairGenConfig>();break;
      case Kind::Dh: parameters.emplace<DhKeyPairGenConfig>();break;
      case Kind::Named: parameters.emplace<NamedKeyPairGenConfig>();break;
    }
  }
  size_t AccountedBytes() const {
    size_t bytes=sizeof(*this);
    if(const auto* ec=std::get_if<EcKeyPairGenConfig>(&parameters))
      bytes+=StringStorage(ec->params.curve_name);
    if(privateEncoding.passphrase)bytes+=privateEncoding.passphrase->size();
    // Opaque EVP/BIGNUM/provider allocations are real RAII owners, but their
    // internal heap size is not invented from logical modulus/prime lengths.
    return bytes;
  }
  void SetRsaDigest(const std::string& name, bool mgf1) {
    auto digest=Digest::FromName(name.c_str());
    if(!digest) {
      const auto message=std::string(mgf1?"Invalid MGF1 digest: ":"Invalid digest: ")+name.c_str();
      throw KeyError(message.c_str(),"ERR_CRYPTO_INVALID_DIGEST");
    }
    auto& config=std::get<RsaKeyPairGenConfig>(parameters).params;
    if(mgf1)config.mgf1_md=digest;else config.md=digest;
  }
  void SetCurve(const std::string& name, int encoding) {
    auto& config=std::get<EcKeyPairGenConfig>(parameters).params;
    config.algorithm=ncrypto::Ec::GetNamedKeyAlgorithm(name.c_str());
    if(!config.algorithm) {
      if(!ncrypto::Ec::CheckCurveName(name.c_str()))
        throw KeyError("Invalid EC curve name","ERR_CRYPTO_INVALID_CURVE");
      config.curve_name=name.c_str();
    }
    if(encoding!=OPENSSL_EC_NAMED_CURVE && encoding!=OPENSSL_EC_EXPLICIT_CURVE)
      throw KeyError("Invalid param_encoding specified","ERR_OUT_OF_RANGE");
    config.param_encoding=encoding;
  }
  void SetGroup(const std::string& name) {
    auto group=DHPointer::FindGroup(std::string_view(name.data(),name.size()));
    if(!group)throw KeyError("Unknown DH group","ERR_CRYPTO_UNKNOWN_DH_GROUP");
    auto& config=std::get<DhKeyPairGenConfig>(parameters).params;
    config.prime=std::move(group);config.generator=2;
  }
  void SetNamed(const std::string& name) {
    const auto* algorithm=KeyAlgorithm::FromName(name.c_str());
    if(!algorithm || (!algorithm->isOkp() && !algorithm->isPqc()) ||
       std::string_view(name.data(),name.size())!=algorithm->keyTypeName() ||
       !algorithm->isAvailable()) {
      const auto message=std::string("The argument 'type' must be a supported key type. Received '")+name.c_str()+"'";
      throw KeyError(message.c_str(),"ERR_INVALID_ARG_VALUE");
    }
    std::get<NamedKeyPairGenConfig>(parameters).params.algorithm=algorithm;
  }
  ncrypto::DataPointer Serialize(const KeyMaterial& material, bool privateKey) const {
    using Key=ncrypto::EVPKeyPointer;
    const Key::AsymmetricKeyEncodingConfig& encoding=privateKey?
      static_cast<const Key::AsymmetricKeyEncodingConfig&>(privateEncoding):publicEncoding;
    if(encoding.format==Key::PKFormatType::RAW_PUBLIC) {
      if(material.asymmetric.getAlgorithm()==&KeyAlgorithm::EC) {
        auto bytes=ncrypto::Ec::TryExportPublic(material.asymmetric,point_conversion_form_t(encoding.ec_point_form));
        if(bytes)return bytes;
        ncrypto::ECKeyPointer ec(material.asymmetric);
        if(!ec)throw KeyError("The selected key encoding is incompatible with the key type","ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
        if(!ec.getPublicKey())throw KeyError("Failed to export EC public key","ERR_CRYPTO_OPERATION_FAILED");
        const auto form=point_conversion_form_t(encoding.ec_point_form);
        const auto length=EC_POINT_point2oct(ec.getGroup(),ec.getPublicKey(),form,nullptr,0,nullptr);
        if(!length)throw KeyError("Failed to get public key length","ERR_CRYPTO_OPERATION_FAILED");
        bytes=ncrypto::DataPointer::Alloc(length);
        if(!bytes)throw std::bad_alloc();
        if(!EC_POINT_point2oct(ec.getGroup(),ec.getPublicKey(),form,bytes.get<unsigned char>(),length,nullptr))
          throw KeyError("Failed to get public key","ERR_CRYPTO_OPERATION_FAILED");
        return bytes;
      }
      if(!material.asymmetric.supportsRawPublic())
        throw KeyError("The selected key encoding is incompatible with the key type","ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
      auto bytes=material.asymmetric.rawPublicKey();
      if(!bytes)throw KeyError("Failed to get raw public key","ERR_CRYPTO_OPERATION_FAILED");
      return bytes;
    }
    if(encoding.format==Key::PKFormatType::RAW_PRIVATE) {
      if(!privateKey)std::abort();
      if(material.asymmetric.getAlgorithm()==&KeyAlgorithm::EC) {
        auto bytes=ncrypto::Ec::ExportPrivate(material.asymmetric);
        if(!bytes)throw KeyError("Failed to get raw private key","ERR_CRYPTO_OPERATION_FAILED");
        return bytes;
      }
      if(!material.asymmetric.supportsRawPrivate())
        throw KeyError("The selected key encoding is incompatible with the key type","ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS");
      auto bytes=material.asymmetric.rawPrivateKey();
      if(!bytes)throw KeyError("Failed to get raw private key","ERR_CRYPTO_OPERATION_FAILED");
      return bytes;
    }
    if(encoding.format==Key::PKFormatType::RAW_SEED) {
      if(!privateKey)std::abort();
      auto result=material.asymmetric.rawSeed();
      if(!result)throw KeyError(result.error==Key::RawExportError::UNSUPPORTED_KEY_TYPE?
        "The selected key encoding is incompatible with the key type":"Failed to get raw seed",
        result.error==Key::RawExportError::UNSUPPORTED_KEY_TYPE?
        "ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS":"ERR_CRYPTO_OPERATION_FAILED");
      return std::move(result.value);
    }
    Key::PrivateKeyEncodingConfig clone;
    static_cast<Key::AsymmetricKeyEncodingConfig&>(clone)=encoding;
    if(privateKey) {
      clone.cipher=privateEncoding.cipher;
      if(privateEncoding.passphrase) {
        const auto& source=*privateEncoding.passphrase;
        clone.passphrase=ncrypto::DataPointer::Copy({source.get(),source.size()});
        if(!*clone.passphrase && source.size())throw std::bad_alloc();
      }
    }
    return material.Export(std::move(clone),privateKey);
  }
  std::unique_ptr<KeyMaterial> Generate() {
    auto context=std::visit([](auto& config)->EVPKeyCtxPointer {
      using T=std::decay_t<decltype(config)>;
      if constexpr(std::is_same_v<T,RsaKeyPairGenConfig>)return RsaKeyGenTraits::Setup(&config);
      else if constexpr(std::is_same_v<T,DsaKeyPairGenConfig>)return DsaKeyGenTraits::Setup(&config);
      else if constexpr(std::is_same_v<T,EcKeyPairGenConfig>)return EcKeyGenTraits::Setup(&config);
      else if constexpr(std::is_same_v<T,DhKeyPairGenConfig>)return DhKeyGenTraits::Setup(&config);
      else return NamedKeyPairGenTraits::Setup(&config);
    },parameters);
    auto failed=[]() {
      auto errors=Error::Capture();
      if(errors.errors_.empty())errors.Insert("Key generation job failed");
      throw Error::FromCaptured(std::move(errors));
    };
    if(!context)failed();
    EVP_PKEY* raw=nullptr;
    const int status=EVP_PKEY_keygen(context.get(),&raw);
    EVPKeyPointer key(raw);
    if(status<=0 || !key)failed();
    auto material=std::make_unique<KeyMaterial>();
    material->asymmetric=std::move(key);
    return material;
  }
};
}  // namespace kandelo::crypto::keypair
#endif
'''
    return header,section('public')

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,required=True)
    parser.add_argument('--check',action='store_true')
    args=parser.parse_args();text,_=generate(Path(__file__).resolve().parent)
    if args.check:
        if args.output.read_text()!=text:raise ValueError('Stale keypair owner header')
    else:
        args.output.parent.mkdir(parents=True,exist_ok=True);args.output.write_text(text)
