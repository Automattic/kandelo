import { readFileSync } from "node:fs";
import { zipSync } from "fflate";
import { resolveBinary } from "../../../../host/src/binary-resolver";
import { KandeloImageFs } from "../../../../images/vfs/lib/kandelo-image-fs";

// A real 16-bit COM program: set VGA mode 13h, paint red with REP STOSB,
// create READY.TXT with DOS INT 21h, optionally wait for a BIOS key, then
// write that character to RESULT.TXT. Label fixups avoid a host assembler.
export function dosSmokeCom(waitForKey = true): Uint8Array {
  const code: number[] = [];
  const fixups: Array<{ offset: number; label: string }> = [];
  const data = new Map<string, number[]>();
  const emit = (...bytes: number[]) => code.push(...bytes);
  const address = (opcode: number, label: string) => {
    emit(opcode);
    fixups.push({ offset: code.length, label });
    emit(0, 0);
  };
  const writeFile = (name: string, label: string, length: number) => {
    data.set(name, [...new TextEncoder().encode(name), 0]);
    address(0xba, name); // mov dx, filename
    emit(0x31, 0xc9, 0xb4, 0x3c, 0xcd, 0x21, 0x89, 0xc3); // create; bx=handle
    address(0xba, label);
    emit(0xb9, length & 255, length >> 8, 0xb4, 0x40, 0xcd, 0x21);
    emit(0xb4, 0x3e, 0xcd, 0x21); // close
  };
  emit(0xb8, 0x13, 0, 0xcd, 0x10, 0xb8, 0, 0xa0, 0x8e, 0xc0);
  emit(0x31, 0xff, 0xb9, 0, 0xfa, 0xb0, 4, 0xf3, 0xaa);
  data.set("ready", [1]);
  data.set("key", [0x61]);
  writeFile("READY.TXT", "ready", 1);
  if (waitForKey) {
    emit(0x31, 0xc0, 0xcd, 0x16); // BIOS read key
    address(0xa2, "key"); // mov [key], al
  }
  writeFile("RESULT.TXT", "key", 1);
  emit(0xb8, 0, 0x4c, 0xcd, 0x21);
  const labels = new Map<string, number>();
  for (const [label, bytes] of data) {
    labels.set(label, 0x100 + code.length);
    emit(...bytes);
  }
  for (const { offset, label } of fixups) {
    const value = labels.get(label)!;
    code[offset] = value & 255;
    code[offset + 1] = value >> 8;
  }
  return Uint8Array.from(code);
}

export async function dosSmokeImage(zip = false): Promise<Uint8Array> {
  const image = KandeloImageFs.create();
  image.setImageCapacity(32 * 1024 * 1024);
  for (const path of ["/usr", "/usr/bin", "/games", "/games2", "/home", "/home/player"]) {
    image.mkdir(path, 0o755);
  }
  image.chown("/games", 1000, 1000);
  image.chown("/games2", 1000, 1000);
  image.chown("/home/player", 1000, 1000);
  image.writeFile("/usr/bin/dosbox-pure", readFileSync(resolveBinary("programs/dosbox-pure/dosbox-pure.wasm")), 0o755);
  if (zip) {
    image.writeFile("/games/game.zip", zipSync({ "SMOKE.COM": dosSmokeCom(false) }), 0o644);
  } else {
    for (const directory of ["/games", "/games2"]) {
      image.writeFile(`${directory}/SMOKE.COM`, dosSmokeCom(), 0o644);
      image.writeFile(`${directory}/dosbox.conf`, new TextEncoder().encode(
        `[cpu]\ncore=normal\ncycles=fixed 3000\n[autoexec]\n@echo off\nmount c ${directory}\nc:\nsmoke.com\n`), 0o644);
    }
  }
  return image.saveImage();
}
