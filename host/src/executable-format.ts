export const ENOEXEC = 8;
export const MAX_SHEBANG_DEPTH = 4;

export interface Shebang {
  interpreter: string;
  arg?: string;
}

export interface ExecutableFormatFailure {
  errno: typeof ENOEXEC;
  error: string;
}

export function parseShebang(bytes: ArrayBuffer): Shebang | null {
  const view = new Uint8Array(bytes);
  if (view.length < 2 || view[0] !== 0x23 || view[1] !== 0x21) return null;
  let end = 2;
  while (end < view.length && view[end] !== 0x0a && end < 4096) end++;
  const line = new TextDecoder().decode(view.subarray(2, end)).replace(/\r$/, "").trim();
  if (!line) return null;
  const match = line.match(/^(\S+)(?:\s+(.*))?$/);
  if (!match) return null;
  return { interpreter: match[1], arg: match[2] };
}

export function isWasmBinary(bytes: ArrayBuffer): boolean {
  const view = new Uint8Array(bytes);
  return view.length >= 4 &&
    view[0] === 0x00 &&
    view[1] === 0x61 &&
    view[2] === 0x73 &&
    view[3] === 0x6d;
}

export function executableFormatFailure(path: string, bytes: ArrayBuffer): ExecutableFormatFailure {
  const view = new Uint8Array(bytes);
  const magic = Array.from(view.subarray(0, Math.min(4, view.length)))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(" ");
  return {
    errno: ENOEXEC,
    error: `${path}: unsupported executable format (not WebAssembly and no shebang; magic ${magic || "empty"})`,
  };
}
