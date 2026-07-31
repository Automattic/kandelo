import rubyWasmUrl from "@binaries/programs/wasm32/ruby/ruby.wasm?url";

// WHY: Ruby can resolve to a canonical generation outside the checkout.
// Importing it through @binaries makes Vite grant access only after the
// package resolver verifies the generation and approves this exact file.
export default rubyWasmUrl;
