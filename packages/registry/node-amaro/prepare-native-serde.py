"""Adapt only the pinned converter's JS-import boundary, retaining de/ser owners.

Input must be the checksum-verified serde-wasm-bindgen 0.6.5 source. The native
value operations are part of the same private guest backend, not a new library.
"""
from pathlib import Path
import hashlib
import shutil
import sys

source, output, operations = map(Path, sys.argv[1:])
output.mkdir(exist_ok=False)
(output / 'src').mkdir()
for name in ['README.md', 'LICENSE']:
    if (source / name).is_file():
        shutil.copy2(source / name, output / name)
proof = {}
for name in ['lib.rs', 'de.rs', 'ser.rs', 'error.rs']:
    raw = (source / 'src' / name).read_bytes()
    proof[name] = {'upstreamSha256': hashlib.sha256(raw).hexdigest()}
    text = raw.decode().replace('\r\n', '\n')
    text = text.replace('use js_sys::', 'use crate::native_values::')
    text = text.replace('use wasm_bindgen::', 'use crate::native_values::')
    text = text.replace('js_sys::', 'crate::native_values::')
    text = text.replace('wasm_bindgen::', 'crate::native_values::')
    if name == 'lib.rs':
        # The cache stored handles in Wasm glue's process-wide JS heap. Native
        # handles are scoped to one synchronous call, so do not retain them in
        # that cache. String creation is an engine primitive, without user JS.
        start = text.index('fn static_str_to_js(')
        block = text.index('{', start)
        depth = 1
        end = block + 1
        while depth:
            depth += (text[end] == '{') - (text[end] == '}')
            end += 1
        text = text[:start] + "fn static_str_to_js(s: &'static str) -> JsString { s.into() }" + text[end:]
        start = text.index('#[wasm_bindgen]\nextern "C" {')
        end = text.index('\n}\n', start) + 3
        text = text[:start] + 'pub mod native_values;\nuse native_values::ObjectExt;\n' + text[end:]
    elif name == 'error.rs':
        start = text.index('        #[wasm_bindgen]\n')
        end = text.index('        to_string(&self.0).fmt(f)', start)
        text = text[:start] + '        crate::native_values::display(&self.0).fmt(f)' + text[end + len('        to_string(&self.0).fmt(f)'):]
    proof[name]['nativeSha256'] = hashlib.sha256(text.encode()).hexdigest()
    (output / 'src' / name).write_text(text)
shutil.copy2(operations, output / 'src' / 'native_values.rs')
(output / 'Cargo.toml').write_text('''[package]
name = "serde-wasm-bindgen"
version = "0.6.5"
edition = "2021"
license = "MIT"
[dependencies]
serde = "1.0"
''')
import json
(output / 'NATIVE-SOURCE-BOUNDARY.json').write_text(json.dumps(proof, indent=2)+'\n')
