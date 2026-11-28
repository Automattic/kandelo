# Toywasm core

The resolver builds the pinned Toywasm interpreter core for the wasm32 Kandelo SDK. It installs a static archive, the matching headers, and relocatable pkg-config metadata.

The build enables Wasm threads through the guest pthread implementation. Export order follows the module's declarations so an embedding can expose the same metadata as the WebAssembly JavaScript API. Consumers must compile with the published flags because the library and its C headers share an enum layout.

This is an embeddable library. The Node engine bridge, JavaScript API, WASI bindings, and installed helper migrations have independent integration work.
