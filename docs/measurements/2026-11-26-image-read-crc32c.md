# CRC32C during verified image reads

A Firefox profile of starting Foot on the grouped Sway desktop had 53 samples in the kernel's persistent-image checksum update, representing 35.6 ms of sampled CPU. The profiled kernel retained symbols. Its shortcut-to-two-fitted-prompts time was 3481 ms at 2634 × 1806. Deflate, executable SHA-256, Worker startup and graphics also appeared on this path.

The CRC32C update now takes four bytes at a time. Four precomputed tables allow the lookups within each word to run independently. The table occupies 4096 bytes, up from 1024. Incremental calls keep the same four-byte state, digest encoding and image format.

The following medians are for checksumming the same 8 MiB minus seven bytes with 64 KiB updates, in milliseconds. The browser harness compiled the unchanged and modified production checksum sources to Wasm with the kernel's size optimization. Each engine ran four samples per arm in interleaved order, warming each arm before timing. A second pass used 1009-byte updates. All outputs agreed. The native verified-image suite also checks an independent bitwise reference, block corruption, short reads and both integrity policies.

| Browser | Previous CRC32C, 64 KiB | Four-byte update, 64 KiB | Previous CRC32C, 1009 B | Four-byte update, 1009 B |
| --- | ---: | ---: | ---: | ---: |
| Firefox | 33.92 | 8.88 | 19.97 | 6.92 |
| WebKit | 24.78 | 8.37 | 24.80 | 8.64 |
| Chromium | 20.30 | 7.23 | 19.56 | 6.82 |

The integrated kernel with this change booted the normal partial desktop in installed Firefox 161. One trusted shortcut reached two fitted prompt-bearing terminals in 1679 ms. That single observation on a shared machine cannot establish an end-to-end improvement. The timing table measures the checksum itself.
