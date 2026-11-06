// Portable JWK material control. Engine getters, private codecs, GC edges and
// four-host behavior are separate evidence and are not exercised here.
#include "kandelo-node-key-operations.h"
#include <fstream>
#include <iostream>
#include <iterator>
#include <map>
using kandelo::crypto::Bytes;
using Material = kandelo::crypto::KeyMaterial;
static std::string Hex(const void* bytes, size_t length) {
  constexpr char digits[] = "0123456789abcdef";
  const auto* data = static_cast<const unsigned char*>(bytes); std::string out;
  for (size_t i = 0; i < length; i++) { out += digits[data[i] >> 4]; out += digits[data[i] & 15]; }
  return out;
}
int main(int argc, char** argv) {
  ncrypto::MarkPopErrorOnReturn mark;
  try {
    if (argc == 4 && std::string(argv[1]) == "pem-raw-jwk") {
      std::ifstream file(argv[2], std::ios::binary); Bytes bytes;
      bytes.value.assign(std::istreambuf_iterator<char>(file), {});
      auto material = Material::Parse(true, bytes, Material::Configuration(1, 1, nullptr));
      auto raw = material->ExportJwkRaw(std::string(argv[3]) == "2");
      std::cout << "public " << Hex(raw.public_key.get(), raw.public_key.size()) << '\n';
      if (raw.private_key) std::cout << "private " << Hex(raw.private_key.get(), raw.private_key.size()) << '\n';
      return 0;
    }
    if (argc != 3) throw std::runtime_error("Expected material file and role");
    std::ifstream input(argv[1]); std::string kind, name, field, hex;
    if (!std::getline(input, kind) || !std::getline(input, name)) throw std::runtime_error("Invalid fixture");
    std::map<std::string, Bytes> fields;
    while (input >> field >> hex) {
      Bytes bytes;
      if (hex != "-") for (size_t i = 0; i < hex.size(); i += 2)
        bytes.value.push_back(static_cast<unsigned char>(std::stoul(hex.substr(i, 2), nullptr, 16)));
      fields.emplace(field, std::move(bytes));
    }
    auto at = [&](const std::string& key) -> const Bytes& { return fields.at(key); };
    const bool isPrivate = fields.count(kind == "AKP" ? "priv" : "d");
    std::unique_ptr<Material> material;
    if (kind == "EC") {
      material = Material::JwkEc(Material::JwkCurve(name), at("x"), at("y"), isPrivate ? &at("d") : nullptr);
    } else if (kind == "OKP" || kind == "AKP") {
      const auto* algorithm = Material::JwkAlgorithm(name, kind == "AKP");
      material = Material::JwkRaw(*algorithm, at(kind == "AKP" ? "pub" : "x"),
          isPrivate ? &at(kind == "AKP" ? "priv" : "d") : nullptr);
    } else if (kind == "RSA") {
      ncrypto::Rsa rsa;
      if (!rsa.setPublicKey(Material::JwkBN(at("n")), Material::JwkBN(at("e")))) Material::InvalidJwk("RSA");
      if (isPrivate) {
        ncrypto::Rsa::OtherPrimeInfoPointers other;
        for (unsigned i = 0; fields.count("r" + std::to_string(i)); i++) {
          const auto suffix = std::to_string(i);
          other.emplace_back(Material::JwkBN(at("r" + suffix)), Material::JwkBN(at("d" + suffix)), Material::JwkBN(at("t" + suffix)));
        }
        if (!rsa.setPrivateKey(Material::JwkBN(at("d")), Material::JwkBN(at("q")), Material::JwkBN(at("p")),
            Material::JwkBN(at("dp")), Material::JwkBN(at("dq")), Material::JwkBN(at("qi")), std::move(other)) ||
            !rsa.checkPrimeProduct()) Material::InvalidJwk("RSA");
      }
      material = Material::JwkRsa(rsa);
    } else throw std::runtime_error("Unknown kind");
    const bool privateRole = std::string(argv[2]) == "2";
    if (privateRole && !isPrivate) throw kandelo::crypto::KeyError(
        "JWK does not contain private key material", "ERR_CRYPTO_INVALID_JWK");
    auto der = material->Export(Material::Configuration(0, privateRole ? 1 : 2, nullptr), privateRole);
    std::cout << "der " << Hex(der.get(), der.size()) << '\n';
    auto output = [&](const char* name, const ncrypto::DataPointer& bytes) {
      const auto value = Hex(bytes.get(), bytes.size());
      std::cout << name << ' ' << (value.empty() ? "-" : value) << '\n';
    };
    auto bn = [&](const char* name, const BIGNUM* value, size_t size = 0) { output(name, Material::JwkEncodeBN(value, size)); };
    const auto& key = material->asymmetric;
    if (kind == "EC") {
      ncrypto::BignumPointer x, y, d; int bits;
      if (!ncrypto::Ec::GetKeyComponents(key, &x, &y, privateRole ? &d : nullptr, &bits))
        throw std::runtime_error("EC export failed");
      bn("x", x.get(), (bits + 7) / CHAR_BIT); bn("y", y.get(), (bits + 7) / CHAR_BIT);
      if (privateRole) bn("d", d.get(), (bits + 7) / CHAR_BIT);
    } else if (kind == "RSA") {
      ncrypto::Rsa rsa(key.get()); const auto pub = rsa.getPublicKey(); bn("n", pub.n); bn("e", pub.e);
      if (privateRole) {
        const auto priv = rsa.getPrivateKey(); bn("d", pub.d); bn("p", priv.p); bn("q", priv.q);
        bn("dp", priv.dp); bn("dq", priv.dq); bn("qi", priv.qi);
        const auto other = rsa.getOtherPrimeInfos();
        for (unsigned i = 0; i < other.size(); i++) {
          const auto suffix = std::to_string(i);
          bn(("r" + suffix).c_str(), other[i].r); bn(("d" + suffix).c_str(), other[i].d); bn(("t" + suffix).c_str(), other[i].t);
        }
      }
    } else {
      auto raw = material->ExportJwkRaw(privateRole);
      output(kind == "AKP" ? "pub" : "x", raw.public_key);
      if (raw.private_key) output(kind == "AKP" ? "priv" : "d", raw.private_key);
    }
    return 0;
  } catch (const kandelo::crypto::Error& error) {
    std::cerr << error.code << ':' << error.what() << '\n'; return 2;
  } catch (const std::exception& error) { std::cerr << error.what() << '\n'; return 1; }
}
