# Physical backing size checks during desktop mapping

Base develop dffcfca5325666d5e02cacdef03d4f14893a4584. Implementation commit 2ad4fe0932. A trace of a second Foot terminal showed that preparing mappings and reclaiming removed pages repeatedly called the host to read the same physical WebAssembly memory size.

## Authority and concurrency

Rust owns both the mapping transaction and the set of frames eligible for release. While holding the root growth lock it checks the complete table against one backing extent. When it visits an unlocked peer, a frame below a previously observed extent remains valid. A frame outside that prefix needs a fresh size check because a live peer may have grown. Both bounds are local to the synchronous scan.

The atomic scanner still inspects peer page tables. Every entry, alias, pin, custody record and native-wait fence follows the same validation and retirement path. The change adds no persistent state, protocol messages or ABI fields.

## Browser comparison

Each arm used the same partial Sway and Foot packages and the same host, including the mapped font loader. Only the published kernel changed. Each fresh browser session verified the kernel SHA-256 before boot. A single trusted Alt+Return started a second Foot on a 2634 × 1806 display. Completion required terminal-colored pixels across both backgrounds and prompt ink in both tiles.

The test counted calls to host_group_memory_pages within each mmap and munmap syscall dispatch, from the first trusted key through the filled frame. These totals also include other size checks made by those handlers. Dispatch duration is synchronous kernel-Worker time. Desktop time includes shell launch, Wayland negotiation, rendering and polling. Other builds were running on the machine.

| Browser | Run | Kernel | mmap calls / size queries | munmap calls / size queries | Both handlers, ms | Filled frame, s |
| --- | --- | --- | ---: | ---: | ---: | ---: |
| firefox | A | develop | 84 / 71,186 | 55 / 242,213 | 1143.5 | 18.573 |
| webkit | A | develop | 61 / 55,107 | 37 / 159,209 | 108.1 | 2.251 |
| firefox | B | candidate | 71 / 4,418 | 45 / 3,489 | 435.6 | 7.150 |
| webkit | B | candidate | 61 / 3,830 | 37 / 2,860 | 115.2 | 2.292 |
| webkit | C | candidate | 61 / 3,806 | 37 / 2,945 | 110.6 | 2.494 |
| firefox | D | develop | 76 / 66,076 | 51 / 225,575 | 515.4 | 7.355 |
| webkit | D | develop | 60 / 52,313 | 36 / 152,701 | 114.4 | 2.143 |
| firefox | E | candidate | 75 / 4,674 | 50 / 3,836 | 709.0 | 9.698 |

| Kernel | Published SHA-256 |
| --- | --- |
| develop | 62caee617cf7fd3aff5b17927ba6cb96fb5f796457757160118775475fe10d1a |
| candidate | a1cee55dfac89df81343ad4c7f26f33ff84417e1e736d507b0194d0002531993 |

Pooling completed runs, Firefox went from 2,275 to 68 backing-size queries per mapping syscall (97.0% fewer). WebKit went from 2,161 to 69 (96.8% fewer). This directly measures fewer Wasm-to-host calls. Firefox handler and end-to-end times varied widely. Both WebKit candidate launches were slower than both controls, while handler times overlapped. The trial establishes no consistent improvement in time to a fully painted desktop.

The order was develop, candidate, candidate, develop. In Firefox run C one shortcut produced three fitted terminals and the check for two tiles timed out after 75 seconds. Its timing is excluded. Run E repeated the candidate unchanged. The extra launch remains unexplained.

## Validation and limitations

- The normal kernel build, program ABI check and all 4,101 native kernel tests passed. New tests cover the first frame outside physical memory, allocation retention on rejection, and concurrent growth past a live peer scan’s earlier extent.
- The candidate Wasm passed the Rust group ownership test, 18 Worker boundary tests, the SDK shared-file probe and the native-wait-exit probe, including 40 retire/reuse cohorts. The stock anonymous-shared probe failed before execution because the pinned SDK no longer links `mprotect` by default. In a supplemental run, the same guest and assertions passed both tests, including 40 cohorts, after linking a test-only wrapper that calls `syscall(SYS_mprotect, address, length, protection)`. The stock fixture failure remains open.
- An integrated desktop with the candidate and the other desktop changes completed three cycles from one terminal to five and back in each engine. Each return had seven images, nine Worker replicas, one backing, zero quarantined replicas, zero pending native-wait drains and zero retained mapping references. Firefox returned with 1,840, 1,840 and 1,841 allocated pages (high-water 3,973 throughout). WebKit returned with 1,840, 1,841 and 1,839 pages (high-water 3,864, 3,930, 3,930). The live desktop could still have 128 KiB staged for a mapping transaction at sampling time.
- On the combined build at the recording resolution, one additional fully fitted terminal took 4.864 seconds in Firefox and 1.613 seconds in WebKit. Five took 24.694 and 5.264 seconds respectively. After the five launches, event-to-first-observed cursor-plane pixels at eight destinations ranged from 51 to 419 ms in Firefox and 62 to 182 ms in WebKit. Chromium reached five fitted prompts from one in 2.525 seconds. These single integrated runs verify visible behavior under load. The separate kernel comparison above isolates the changed binary.

The comparison measures a general engine path. Two separate traces with Sway debug logging showed why a large terminal can display wallpaper during launch. Sway applied a resize after its normal timeout with both clients outstanding. Both prompts already contained ink in a frame with 2,923 wallpaper-colored sample points out of 14,062. The more intrusive Wayland logs placed resized 1308 × 1686 and 1310 × 1686 buffers after the timeout in both browsers. Those diagnostic timings include guest logging and used a different combined desktop. They do not isolate a change to the compositor deadline.

The first counter was attached to only one retry dispatch and returned an empty WebKit trace. The comparison above covers all four dispatch sites. Fresh-worktree native tests initially lacked the ignored frozen echo and raw-fork inputs. Both inputs were verified against the committed ABI-56 manifest before rerunning. Playwright WebKit supplies the WebKit observations. Native Safari and physical monitor latency were outside this run.
