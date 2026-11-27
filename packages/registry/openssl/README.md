# OpenSSL

OpenSSL's `libssl.a` and `libcrypto.a`, built for Kandelo through the SDK
(`build-openssl.sh`) for wasm32 and wasm64. Consumers include libcurl, curl,
git, wget, PHP, SpiderMonkey and cmake.

## No secure heap

The wasm32 and wasm64 libraries use ordinary heap allocations for secrets.
See [the secure-heap limitation](SECURITY.md) for the API behavior and how to
check whether an application can use this build.
