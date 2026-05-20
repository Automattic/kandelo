# Squeak Port Resume Notes

This is a WIP port of the OpenSmalltalk/Squeak VM to wasm-posix-kernel. It is
not finished: the current best path displays the Squeak 6.0 release splash, but
the image does not reach an interactive desktop yet.

## Current Shape

- Browser demo: `apps/browser-demos/pages/squeak/`
- Package build: `packages/registry/squeak/build-squeak.sh`
- VM source: OpenSmalltalk `cc2dd909045721f6cbf16cb62f5662fe68158021`
- Image bundle:
  - URL: `https://files.squeak.org/6.0/Squeak6.0-22148-32bit/Squeak6.0-22148-32bit.zip`
  - SHA-256: `63b195f00b29749aae3a0dab577af8563d9c5c8c311f6e209679b45afd3b6255`
- Browser launch args:
  - `squeak -maxoldspace 512m -vm-display-fbdev -vm-sound-OSS -plugins /usr/lib/squeak /home/Squeak6.0-22148-32bit.image`

The package build intentionally uses the `spur32.stack` interpreter now. The
earlier Sista/Cog experiment built, but it consistently hit eden/allocation
trouble and SmallInteger `doesNotUnderstand:` failures after showing the
framebuffer splash.

## What Was Added

- A Squeak browser page that downloads, SHA-checks, caches, and extracts the
official Squeak 6.0 32-bit image/changes/sources zip.
- Display wiring through `/dev/fb0` and the existing canvas framebuffer
renderer.
- Mouse wiring through `/dev/input/mice` using PS/2-style deltas.
- Keyboard wiring through process stdin for the fbdev keyboard shim.
- Audio drain scheduling through `/dev/dsp` and Web Audio.
- Minimal OSS header/ioctl support needed by OpenSmalltalk's OSS sound module.
- Larger wasm32 mmap address space and non-fixed mmap hint handling. Squeak
maps old-space segments at high hints and needs those hints respected.

## Verified Commands

Kernel memory test:

```sh
cargo test -p wasm-posix-kernel --target aarch64-apple-darwin \
  test_mmap_honors_non_fixed_hint_as_lower_bound -- --nocapture
```

Kernel rebuild used during browser debugging:

```sh
cargo build --release -p wasm-posix-kernel -Z build-std=core,alloc
cp target/wasm64-unknown-unknown/release/wasm_posix_kernel.wasm local-binaries/kernel.wasm
```

Focused browser server:

```sh
cd apps/browser-demos
VITE_ONLY_PAGE=squeak npx vite --host 127.0.0.1 --port 5177
```

## Debugging Results So Far

### Sista/Cog Build

The Sista build was made to compile by:

- ensuring `plugins.int` is truly empty,
- using `make -C vm ...` for VM support objects,
- compiling static fbdev/OSS modules,
- stubbing Cogit entry points so no machine-code zone is needed,
- raising wasm max memory with `WASM_POSIX_MAX_MEMORY=4294967296`.

It displayed the Squeak balloons, but stderr showed:

```text
sqAllocateMemorySegmentOfSizeAboveAllocatedSizeInto mmap: Out of memory
no room in eden for allocateSmallNewSpaceSlots:format:classIndex:
SmallInteger(Object)>doesNotUnderstand: message: 0xffffffdd=-18
```

After `-maxoldspace 512m` and the mmap fixes, the explicit mmap ENOMEM went
away, but the eden/DNU failure remained. `-eden 64m` made it worse with plain
`out of memory`.

### Stack VM Build

The stack VM gets further than Sista. It displays the splash and runs into the
release image startup/snapshot path:

```text
Cursor class>currentCursor:
CursorWithMask(Cursor)>show
SmalltalkImage>snapshot:andQuit:withExitCode:embedded:
SmalltalkImage>snapshot:andQuit:embedded:
SmalltalkImage>snapshot:andQuit:
[] in ReleaseBuilder class>saveAndQuit
WorldState>runStepMethodsIn:
```

A temporary local interpreter instrumentation showed the first impossible
receiver as a raw C null pointer while evaluating `=` inside
`SmalltalkImage>platformName`:

```text
[squeak debug] null receiver, selector=0x461c7a8: a(n) ByteSymbol nbytes 1
=
 argumentCount=1 localSP=0x181b28
0x181b24 SmalltalkImage>platformName 0x4798d68: a(n) SmalltalkImage
0x181b44 Cursor class>currentCursor: 0x4778018: a(n) Cursor
0x181b64 CursorWithMask(Cursor)>show 0x49f3638: a(n) CursorWithMask
0x181b88 SmalltalkImage>snapshot:andQuit:withExitCode:embedded:
```

Do not keep the local workaround that rewrites `null` receivers to `nil`; it
only masks the bug. With that workaround, the VM returns status 0 without ever
writing a snapshot, and the page restart just relaunches the unchanged image.

## Likely Next Investigation

Start around `SmalltalkImage>platformName` and primitive 149
(`primitiveGetAttribute`). The Unix VM currently reports:

- attribute `1001`: `OS_TYPE`, configured as `unix`
- attribute `1002`: `VM_TARGET_OS`, configured as `none`
- attribute `1003`: `VM_TARGET_CPU`, configured as `wasm32`

The null receiver appears while `platformName` is comparing one of these values.
Possible causes to verify:

- `VM_TARGET_OS="none"` is not accepted by the Squeak 6.0 release startup path;
  try forcing the configured target OS/name to something Linux/Unix-like for the
  wasm build.
- `methodReturnString()` / `stringForCString()` is returning a null OOP because
  allocation failed or because a primitive failure path leaves a null stack slot.
- The stack VM image load or special-object initialization is leaving a context
  temp uninitialized only after the startup finalization process runs.

Useful temporary instrumentation point:

```c
/* src/spur32.stack/interp.c, normalSend */
rcvr = longAtPointer(localSP + (GIV(argumentCount) * BytesPerOop));
if (rcvr == null) {
    FILE *savedTranscript = GIV(transcript);
    fprintf(stderr, "[squeak debug] null receiver, selector=");
    GIV(transcript) = stderr;
    printOop(GIV(messageSelector));
    GIV(transcript) = savedTranscript;
    fprintf(stderr, " argumentCount=%ld localSP=%p\n",
            (long)GIV(argumentCount), localSP);
    printCallStackOn(stderr);
    fflush(stderr);
}
```

## Playwright Smoke Harness

```sh
node <<'NODE'
const { chromium } = require('playwright');
const fs = require('fs');
const zip = fs.readFileSync('/tmp/Squeak6.0-22148-32bit.zip');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
  await page.route(/\/cors-proxy\?url=.*Squeak6\.0-22148-32bit\.zip/, route =>
    route.fulfill({ status: 200, contentType: 'application/zip', body: zip }));
  let count = 0;
  page.on('console', msg => {
    const text = msg.text();
    if (/squeak|SmallInteger|doesNotUnderstand|RuntimeError|failed|out of memory|Recursive/i.test(text)) {
      if (count++ < 200) console.log(`[${msg.type()}] ${text}`);
    }
  });
  await page.goto('http://127.0.0.1:5177/pages/squeak/', {
    waitUntil: 'domcontentloaded',
    timeout: 120000,
  });
  await page.click('#start');
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(10000);
    console.log('t' + ((i + 1) * 10) + '=' + await page.locator('#status').textContent());
  }
  await page.screenshot({ path: '/tmp/squeak-smoke.png', fullPage: true });
  await browser.close();
})();
NODE
```
