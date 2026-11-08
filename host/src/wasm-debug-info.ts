/** Worker-local diagnostic metadata; filenames never authorize file access. */
import { sha256 } from "@noble/hashes/sha2.js";
import { readWasmFunctionImports } from "./constants";

const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const encoder = new TextEncoder();
const METADATA_BYTES = 64 * 1024 * 1024;
const ROWS = 1_000_000;
const FILES = 4096;
const PATH_BYTES = 16 * 1024;
const BASE64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function require(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Wasm debug information: ${message}`);
}

class Reader {
  constructor(readonly bytes: Uint8Array, public position = 0, readonly end = bytes.length) {}
  byte(): number {
    require(this.position < this.end, "truncated metadata");
    return this.bytes[this.position++];
  }
  u32(): number {
    let value = 0;
    for (let shift = 0; shift <= 28; shift += 7) {
      const byte = this.byte();
      require(shift < 28 || byte < 16, "invalid u32 LEB");
      value += (byte & 127) * 2 ** shift;
      if (byte < 128) return value;
    }
    throw new Error("Wasm debug information: invalid u32 LEB");
  }
  text(maximum: number): string {
    const length = this.u32();
    require(length <= maximum && length <= this.end - this.position, "string exceeds budget or section");
    const text = decoder.decode(this.bytes.subarray(this.position, this.position + length));
    this.position += length;
    return text;
  }
}

interface SourceLocation { readonly file: string; readonly line: number; readonly column: number }
interface Section { id: number; start: number; end: number; name?: string; data?: number }
function sections(bytes: Uint8Array): Section[] {
  require(bytes.length >= 8 && bytes[0] === 0 && bytes[1] === 97 && bytes[2] === 115 && bytes[3] === 109 && bytes[4] === 1 && bytes[5] === 0 && bytes[6] === 0 && bytes[7] === 0, "expected a core module");
  const reader = new Reader(bytes, 8);
  const result: Section[] = [];
  while (reader.position < reader.end) {
    require(result.length < 4096, "too many sections");
    const id = reader.byte();
    const length = reader.u32();
    const start = reader.position;
    require(length <= reader.end - start, "section exceeds module");
    const end = start + length;
    const custom = new Reader(bytes, start, end);
    const name = id === 0 ? custom.text(PATH_BYTES) : undefined;
    result.push({ id, start, end, name, data: id === 0 ? custom.position : undefined });
    reader.position = end;
  }
  return result;
}

class SourceMap {
  private readonly offsets: Float64Array;
  private readonly locations: Uint32Array;
  private readonly files: string[];
  constructor(input: Uint8Array, private readonly code: Section, module: Uint8Array) {
    require(input.length >= 48 && input.length - 48 <= METADATA_BYTES, "invalid map size");
    require(input.subarray(0, 8).every((byte, index) => byte === [75, 68, 66, 71, 1, 0, 0, 0][index]), "unsupported map format");
    const view = new DataView(input.buffer, input.byteOffset, input.byteLength);
    require(view.getBigUint64(8, true) === BigInt(code.start), "stale map: Code section moved");
    const digest = sha256(module.subarray(code.start, code.end));
    require(digest.every((byte, index) => byte === input[16 + index]), "stale map: code changed");
    const json = JSON.parse(decoder.decode(input.subarray(48)));
    require(json && json.version === 3 && json.sections === undefined && (json.sourceRoot === undefined || json.sourceRoot === ""), "expected flat source-map v3");
    require(Array.isArray(json.sources) && json.sources.length <= FILES, "source file budget exceeded");
    let pathBytes = 0;
    this.files = json.sources.map((file: unknown) => {
      require(typeof file === "string" && file.length <= PATH_BYTES, "invalid source filename");
      const length = encoder.encode(file).length;
      pathBytes += length;
      require(length <= PATH_BYTES && pathBytes <= 4 * 1024 * 1024, "source path budget exceeded");
      return file;
    });
    require(typeof json.mappings === "string" && !json.mappings.includes(";"), "expected one generated Wasm line");
    const mappings: string = json.mappings;
    let count = mappings.length ? 1 : 0;
    for (let index = 0; index < mappings.length; index++) if (mappings[index] === ",") count++;
    require(count <= ROWS, "source row budget exceeded");
    this.offsets = new Float64Array(count);
    this.locations = new Uint32Array(count * 3).fill(0xffffffff);
    let position = 0;
    const values = [0, 0, 0, 0, 0];
    for (let row = 0; row < count; row++) {
      let fields = 0;
      while (position < mappings.length && mappings[position] !== ",") {
        require(fields < 5, "too many mapping fields");
        let value = 0;
        let shift = 0;
        for (;;) {
          require(position < mappings.length && shift <= 50, "truncated or overflowing mapping");
          const digit = BASE64.indexOf(mappings[position++]);
          require(digit >= 0, "invalid mapping base64");
          value += (digit & 31) * 2 ** shift;
          require(Number.isSafeInteger(value), "mapping delta exceeds exact range");
          if (digit < 32) break;
          shift += 5;
        }
        const delta = Math.floor(value / 2) * (value % 2 ? -1 : 1);
        require(fields !== 0 || delta >= 0, "unordered mapping");
        values[fields] += delta;
        require(Number.isSafeInteger(values[fields]), "mapping value exceeds exact range");
        fields++;
      }
      require(fields === 1 || fields === 4 || fields === 5, "invalid mapping fields");
      require(values[0] >= code.start && values[0] <= code.end, "mapping outside Code");
      this.offsets[row] = values[0];
      if (fields > 1) {
        require(values[0] < code.end && values[1] >= 0 && values[1] < this.files.length && values[2] >= 0 && values[2] <= 0xfffffffe && values[3] >= 0 && values[3] <= 0xfffffffe, "invalid mapping location");
        this.locations.set(values.slice(1, 4), row * 3);
      }
      if (position < mappings.length) position++;
    }
  }
  lookup(pc: number): SourceLocation | undefined {
    if (pc < this.code.start || pc >= this.code.end) return;
    let low = 0, high = this.offsets.length;
    while (low < high) {
      const middle = Math.floor((low + high) / 2);
      if (this.offsets[middle] <= pc) low = middle + 1; else high = middle;
    }
    if (low === 0) return;
    const index = (low - 1) * 3;
    if (this.locations[index] === 0xffffffff) return;
    return { file: this.files[this.locations[index]], line: this.locations[index + 1] + 1, column: this.locations[index + 2] + 1 };
  }
}

export class WasmDebugInfo {
  readonly sha256: Uint8Array;
  private readonly names = new Map<number, string>();
  private readonly bodies: Float64Array;
  private readonly imported: number;
  private readonly map?: SourceMap;
  constructor(bytes: ArrayBuffer) {
    const input = new Uint8Array(bytes);
    const all = sections(input);
    const code = all.filter(section => section.id === 10);
    require(code.length === 1, "expected one Code section");
    this.imported = readWasmFunctionImports(bytes).length;
    const bodies = new Reader(input, code[0].start, code[0].end);
    const count = bodies.u32();
    require(count <= ROWS, "function budget exceeded");
    this.bodies = new Float64Array(count * 2);
    for (let index = 0; index < count; index++) {
      const length = bodies.u32();
      require(length <= bodies.end - bodies.position, "function exceeds Code section");
      this.bodies[index * 2] = bodies.position;
      bodies.position += length;
      this.bodies[index * 2 + 1] = bodies.position;
    }
    require(bodies.position === bodies.end, "unexpected trailing code");
    const nameSections = all.filter(section => section.name === "name");
    require(nameSections.length <= 1, "duplicate name section");
    for (const section of nameSections) {
      require(section.end - section.data! <= METADATA_BYTES, "name section exceeds budget");
      const reader = new Reader(input, section.data, section.end);
      while (reader.position < reader.end) {
        const tag = reader.byte(), length = reader.u32();
        require(length <= reader.end - reader.position, "invalid name subsection");
        const end = reader.position + length;
        if (tag === 1) {
          const functions = new Reader(input, reader.position, end);
          const count = functions.u32();
          require(count <= ROWS, "function name budget exceeded");
          for (let index = 0; index < count; index++) {
            const key = functions.u32();
            require(!this.names.has(key) && key < this.imported + this.bodies.length / 2, "invalid function name index");
            this.names.set(key, functions.text(4096));
          }
          require(functions.position === end, "trailing function names");
        }
        reader.position = end;
      }
    }
    const maps = all.filter(section => section.name === "kandelo.debug.lines");
    require(maps.length <= 1, "duplicate source map");
    if (maps.length) this.map = new SourceMap(input.subarray(maps[0].data, maps[0].end), code[0], input);
    this.sha256 = sha256(input);
  }
  resolve(index: number, pc?: number): { name?: string; location?: SourceLocation } | undefined {
    const body = index - this.imported;
    if (!Number.isInteger(body) || body < 0 || body >= this.bodies.length / 2) return;
    if (pc !== undefined && (pc < this.bodies[body * 2] || pc >= this.bodies[body * 2 + 1])) return;
    return { name: this.names.get(index), location: pc === undefined ? undefined : this.map?.lookup(pc) };
  }
}
