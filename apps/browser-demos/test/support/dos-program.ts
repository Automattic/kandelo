/** Authored DOS MZ executable: VGA red screen, then BIOS keyboard wait.
 * No downloaded game or host assembler is required for drop/lifecycle tests.
 */
export function dosVgaExecutable(): Uint8Array {
  const code = Uint8Array.of(
    0xb8, 0x13, 0x00, 0xcd, 0x10, // VGA mode 13h
    0xb8, 0x00, 0xa0, 0x8e, 0xc0, // ES = VGA segment
    0x31, 0xff, 0xb9, 0x00, 0xfa, 0xb0, 0x04, 0xfc, 0xf3, 0xaa,
    0x31, 0xc0, 0xcd, 0x16, 0xeb, 0xfa,
  );
  const file = new Uint8Array(32 + code.length);
  const header = new DataView(file.buffer);
  file.set([0x4d, 0x5a]);
  header.setUint16(2, file.length % 512, true);
  header.setUint16(4, Math.ceil(file.length / 512), true);
  header.setUint16(8, 2, true); // 32-byte header
  header.setUint16(10, 0x1000, true); // stack allocation
  header.setUint16(12, 0xffff, true);
  header.setUint16(16, 0xfffe, true);
  header.setUint16(24, 28, true);
  file.set(code, 32);
  return file;
}

/** VGA plus a continuous 440 Hz PIT/PC-speaker tone, independent of game data. */
export function dosPcSpeakerExecutable(): Uint8Array {
  const source = dosVgaExecutable();
  const tone = Uint8Array.of(
    0xb0, 0xb6, 0xe6, 0x43, // PIT channel 2, square-wave mode
    0xb8, 0x98, 0x0a, 0xe6, 0x42, 0x88, 0xe0, 0xe6, 0x42, // divisor 2712
    0xe4, 0x61, 0x0c, 0x03, 0xe6, 0x61, // enable speaker
    0xeb, 0xfe, // keep running until the frontend's ordinary quit/signal path
  );
  const file = new Uint8Array(source.length - 6 + tone.length);
  file.set(source.subarray(0, -6)); // replace the BIOS keyboard-wait loop
  file.set(tone, source.length - 6);
  new DataView(file.buffer).setUint16(2, file.length, true);
  return file;
}
