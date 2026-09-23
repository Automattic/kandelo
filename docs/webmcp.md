# Kandelo WebMCP

Kandelo provides a browser-hosted computer where agents can run code, work with
files and use applications without executing commands on the host machine. Use
it as a sandbox for development, experimentation, testing or any task suited to
its available environments. The agent and user share the same computer,
terminals and previews.

Start with `kandelo_get_computer_status` to discover the current environment and
its available capabilities, or `kandelo_list_profiles` to discover environments
to launch. Capability support depends on the environment and backend; check
status before choosing execution, file or preview tools. These entry-point tool
descriptions also carry this context so agents can discover the purpose and
capabilities directly from the tool catalog.

Kandelo exposes 17 tools on its application document when the browser implements
`document.modelContext.registerTool`. The tools use the same computer, terminal
tabs and preview shown in the UI. Browsers without this API retain the normal UI.
No shell or filesystem capabilities are delegated to preview frames.

The live browser backend supports structured jobs, cancellation, directory listing,
file reads and writes, and atomic exclusive file creation. Status reports actual
runtime availability; tools remain registered while the computer is booting.

## Browser and invocation

The implementation targets Chrome's current [imperative API](https://developer.chrome.com/docs/ai/webmcp/imperative-api),
including registration cleanup using an AbortSignal. It was exercised with native
Chrome Canary 156 and `--enable-experimental-web-platform-features`. There is no
polyfill or test-only replacement for registration. Older versions exposing
`navigator.modelContext` alone are unsupported. Tools have read-only and untrusted
content annotations following Chrome's [tool security guidance](https://developer.chrome.com/docs/ai/webmcp/secure-tools).

```js
const tools = await document.modelContext.getTools();
const statusTool = tools.find(t => t.name === 'kandelo_get_computer_status');
const status = JSON.parse(await document.modelContext.executeTool(statusTool, {}));
```

Results are JSON strings: `{ok:true,...fields}` or
`{ok:false,error:{code,message,...details}}`. Browser-level schema validation and
aborted execution may reject the native call instead. Current Chrome accepts
argument objects; older experimental implementations accepted JSON strings.

Launch can navigate away. The tool acknowledges initiation and the destination
URL before invoking the existing gallery callback. Chrome can instead return
`null` when navigation interrupts execution. In either case, wait for the new
application document, rediscover tools, and poll status until `running` or
`error`. A launch of the exact current gallery URL reports `alreadyCurrent:true`
and `initiated:false`, matching the gallery's existing no-op behavior.

## Tool contract

Every name below has the `kandelo_` prefix. Inspect the registered JSON schemas for
parameter bounds and required fields. Unknown fields and invalid types are rejected.

| Tool | Inputs | Main result / effect |
| --- | --- | --- |
| `list_profiles` | `search?` | Dynamic `profiles` with `profileId`, name, description, availability. `resolved_on_launch` means asset resolution has not yet been attempted. |
| `launch_computer` | `profileId`, `requestId?` | Replaces the computer; `initiated`, `destinationUrl`, `rediscoverTools`. |
| `get_computer_status` | none | `generationId`, profile, status, bootError, capabilities, activeTerminalId, preview, previewProgress and shared document metadata. |
| `run_command` | `script`, `cwd?`, `env?`, `waitMs?`, `timeoutMs?`, `requestId?` | `jobId`, separate stdout/stderr, exitCode, status, terminationObserved, nextCursor. Runs Bash with independent cwd/env; timeout owns the entire descendant family. |
| `read_job` | `jobId`, `cursor?`, `byteLimit?` | Incremental stdout/stderr and observed lifecycle. Old generation → `STALE_SESSION`; current unknown ID → `UNKNOWN_JOB`. |
| `cancel_job` | `jobId` | Requests termination of the owned family. May return `cancelling`; poll until `terminationObserved:true`. Never signals unrelated processes. |
| `list_terminals` | none | `terminals`: terminalId, label, ready, active, error. |
| `create_terminal` | `activate?`, `requestId?` | Creates a real dock terminal; activates by default. Returns terminal metadata. |
| `switch_terminal` | `terminalId` | Selects and reveals the terminal without restarting its shell. |
| `send_terminal_input` | `terminalId`, exactly one of `text` / `key` | Writes to this PTY, serialized against other tool writes to it. `delivered` means input delivered, not command completed. |
| `read_terminal_output` | `terminalId`, `cursor?`, `byteLimit?` | `output`, bytesRead, nextCursor, truncated, hasMore. ANSI sequences and merged streams remain intact. |
| `list_files` | absolute `path`, `offset?`, `limit?` | Sorted directory entries (name, type, inode), nextOffset, hasMore. Each call is a fresh listing. |
| `read_file` | absolute `path`, `encoding?`, `offset?`, `byteLimit?` | UTF-8 or base64 `content`, bytesRead, nextOffset, eof, truncated. |
| `write_file` | absolute `path`, `content`, `encoding?`, explicit `overwrite` | `overwrite:true` creates or replaces; returns bytesWritten. `false` uses atomic O_EXCL creation and returns `FILE_EXISTS` without altering an existing path. Parent must exist. |
| `navigate_preview` | guest URL `path` | Reveals and requests navigation within the existing guest bridge; returns requestedPath, preview and previewProgress. Poll status for HTTP/load/render observations. |
| `read_logs` | `cursor?`, `limit?`, `level?` | Timestamped entries, nextCursor, truncated, hasMore. Levels: info, warn, err, ok, debug. |
| `create_launch_link` | `profileId?`, `startupScript?` | Encoded URL, sizeBytes, explanation of what it reproduces. Does not open, publish or execute it. |

Supported terminal keys: `enter`, `ctrl_c`, `ctrl_d`, `ctrl_z`, `tab`, `escape`,
`backspace`, `up`, `down`, `left`, `right`. Text is literal; include `\n` to submit
it. `ready:true` means a PTY is attached, not that login is complete or a shell
prompt is visible. Read output to determine the current interactive state.

## Limits and lifecycle

- Terminal output retains at most 256 KiB per observed terminal, at most 32
  terminals per computer. Read size defaults to 4096 bytes, maximum 65536.
  Output observers attach with the application lifecycle and detach without
  terminating the host-owned PTY. Removing a terminal in the UI releases its
  observer and makes its ID invalid.
- Cursors encode a generation, stream and absolute offset. Continue with the
  returned `nextCursor`; never construct or reuse one for another stream. An
  expired cursor returns `OUTPUT_EXPIRED` with `oldestCursor` and
  `truncated:true`. Omitting a cursor starts at oldest retained output and
  reports whether earlier captured output was dropped. An invalid or foreign
  cursor returns `INVALID_CURSOR`.
- Logs retain 1000 entries, each message limited to 4096 characters and facility
  to 256. Oversized messages carry `messageTruncated:true`. Reads default to 50
  entries, maximum 200. Filtering still advances the cursor through inspected
  entries, so a filtered read may return no entries and a newer cursor.
  Timestamps are monotonic milliseconds since boot, not wall-clock dates.
- File reads use byte offsets, default 4096 bytes and maximum 65536 per response.
  The existing runtime transfers the full source file internally; this is not
  a streaming/range-read API. Writes and terminal input allow 65536 decoded bytes.
  Standard padded base64 preserves exact bytes. UTF-8 chunks can split a
  multibyte character; use base64 when exact reconstruction matters.
- Guest paths must be absolute and contain no dot segments, control characters
  or backslashes. Preview paths additionally reject authority URLs, encoded
  traversal and double encoding; `/file.html?x=1#section` is valid.
- Startup scripts obey existing boot-input codec limits: at most 2 MiB inflated,
  32 KiB carried inline input, and 64 KiB compressed descriptor. A script below
  the inflated cap may still exceed a compressed cap. Links preserve the app
  URL and selected image configuration. Selecting a different profile does not
  inherit the current profile's startup inputs. Links are launch recipes, not
  snapshots of modified files, processes or terminal state.
- `requestId` deduplicates launch, terminal creation and command requests within
  one document, including concurrent repeats and application remounts. Reusing a key with changed
  arguments returns `REQUEST_CONFLICT`. At most 256 retry records are retained;
  further keys fail with `LIMIT_EXCEEDED`, without evicting old keys and risking a
  duplicate mutation. Navigation starts a new retry lifetime. A result cached before remount may carry an old terminal ID; rediscover terminals instead of creating another one.
- Computer reboot/replacement invalidates generation-qualified terminal IDs and
  cursors and disposes adapter buffers/subscriptions. It never reruns input.
  Tool cancellation is checked before mutations and after asynchronous setup;
  input or writes already delivered cannot be rolled back. Accepted jobs remain
  owned by the worker and can be cancelled explicitly or by their timeout.

Other stable errors include `NOT_READY`, `UNKNOWN_PROFILE`, `UNKNOWN_TERMINAL`,
`STALE_SESSION`, `UNSUPPORTED_CAPABILITY`, `FILE_NOT_FOUND`, `INVALID_ARGUMENT`,
`ABORTED`, and `OPERATION_FAILED`. A missing or nonregular file is reported as
`FILE_NOT_FOUND` because the existing regular-file read API returns null for both.

## Example agent workflows

1. Discover profiles, launch one, rediscover after navigation, and check status.
2. List terminals and read TTY1 output. Create TTY2, read its login/prompt state,
   send `VALUE=second\n`, switch to TTY1 and send `VALUE=first\n`. Switching back
   preserves each shell's variables and working directory. Read output rather
   than interpreting input delivery as command completion.
3. Write `/tmp/example.bin` with `encoding:"base64"`, `content:"AAEC/w=="`,
   `overwrite:true`; read with base64 and compare. On a service profile, write
   a served file and navigate its guest path with `navigate_preview`.
4. Generate a link with `startupScript:"echo hello"`. Generation has no execution
   effect. Opening the link boots the encoded configuration and executes the
   startup input through the existing launch behavior.

## Validation

Run the native WebMCP browser E2E suite:

```sh
cd apps/browser-demos
npx playwright test --config webmcp.playwright.config.ts
```

The dedicated config defaults to installed `chrome-canary`; override
`KANDELO_WEBMCP_CHANNEL` only with a browser implementing the current native API.
The ordinary Vite/kernel assets must be available as for the existing browser app.
Tests invoke registered native tools against real kernels and include a separate
normal-browser UI check without WebMCP enabled. Focused host tests cover owned-job
output, cancellation, process reaping and preview observations.


## Structured jobs

Jobs use an owned process family tracked inside the kernel worker before children
launch. Forks and posix_spawn inherit ownership; exec, reparenting and changes to
POSIX process groups do not remove it. Cancellation sends SIGKILL only to that
family, retrying across process launch/exec gaps. `terminationObserved` becomes true
only after every member has exited, its worker has detached, and remaining family
process records have been reaped. Guest parents retain normal wait/waitpid semantics
while the family is running. `exitCode` is the root shell's
observed status, and can be available while background children are still running.
The terminal shells are independent and share the guest filesystem with jobs.

`waitMs` bounds the initial result wait, after spawning; it does not terminate the
job. The worker enforces `timeoutMs` even when the agent stops polling. Status is
`running`, `cancelling`, `completed`, `cancelled` or `timed_out`. A cancelled call
is not cancellation of an accepted job; use `kandelo_cancel_job` or its timeout.
Jobs retain 256 KiB of combined stdout/stderr and at most 64 job records per
computer. Read cursors advance across both streams and report overflow explicitly.
Output is UTF-8 text; byte limits can split multibyte sequences as with terminals.

## Preview observations

`navigate_preview` returns `UNSUPPORTED_CAPABILITY` when the running computer has
no web preview, and `NOT_READY` when an existing preview is not ready to navigate.

`previewProgress` separates navigation acceptance, the HTTP response status,
`documentLoaded`, and `rendered`. Rendered means the iframe completed its load and
had a browser paint opportunity, not that an application finished hydration or all
background requests stopped. An HTTP error page can still load and render; inspect
`http.status` separately. Fragment-only navigation reports HTTP `not_requested`
because it reuses the loaded document. Late responses from an earlier navigation cannot update
a newer navigation's state. Background requests no longer keep the dock's Loading
label active. The bridge's `pendingRequests` count is still available separately.

## Compact discovery

The browser may attach the full launch URL to each RegisteredTool. Kandelo's
registered descriptions do not contain it, and the page cannot change the browser's
native discovery envelope. Client integrations can use `compactToolCatalog` from
`apps/browser-demos/pages/kandelo/webmcp/discovery.ts` to serialize shared document
metadata once. Keep native RegisteredTool objects separately for execution:

```js
const registered = await document.modelContext.getTools();
const statusTool = registered.find(t => t.name === 'kandelo_get_computer_status');
const status = JSON.parse(await document.modelContext.executeTool(statusTool, {}));
const catalog = compactToolCatalog({
  generationId: status.generationId,
  ...status.document,
}, registered);
// catalog.documents holds URL/title once; catalog.tools refers to documentId.
```

This leaves the launch URL intact for reloading and sharing. The launch-link tool
continues to warn that modified files, processes and terminal state are not saved.
