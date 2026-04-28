/**
 * Erlang browser demo — Erlang/OTP 28 BEAM VM running inside the POSIX kernel.
 * Batch mode only: enter Erlang expressions, click Run, see output.
 * BEAM uses -noshell -eval, so no interactive REPL.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import { decompressVfsImage } from "../../../../host/src/vfs/load-image";
import kernelWasmUrl from "@kernel-wasm?url";
import beamWasmUrl from "../../../../binaries/programs/wasm32/erlang.wasm?url";
import VFS_IMAGE_URL from "@binaries/programs/wasm32/erlang-vfs.vfs?url";

// --- DOM elements ---
const codeEl = document.getElementById("code") as HTMLTextAreaElement;
const outputEl = document.getElementById("output") as HTMLPreElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const examplesEl = document.getElementById("examples") as HTMLSelectElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;

const decoder = new TextDecoder();

// --- Status helpers ---
function setStatus(text: string, type: "loading" | "running" | "error") {
  statusDiv.style.display = "block";
  statusDiv.textContent = text;
  statusDiv.className = `status ${type}`;
}

function hideStatus() {
  statusDiv.style.display = "none";
}

// --- Binary loading ---
let kernelBytes: ArrayBuffer | null = null;
let beamBytes: ArrayBuffer | null = null;
let vfsImageBuf: ArrayBuffer | null = null;

async function loadBinaries(): Promise<string> {
  if (kernelBytes && beamBytes && vfsImageBuf) return "";

  setStatus("Loading kernel + BEAM VM + OTP (~4.5MB)...", "loading");
  const results = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(beamWasmUrl).then((r) => r.arrayBuffer()),
    fetch(VFS_IMAGE_URL).then((r) => r.arrayBuffer()),
  ]);
  kernelBytes = results[0];
  beamBytes = results[1];
  vfsImageBuf = results[2];

  return [
    `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB`,
    `BEAM: ${(beamBytes.byteLength / (1024 * 1024)).toFixed(1)}MB`,
    `OTP VFS: ${(vfsImageBuf.byteLength / (1024 * 1024)).toFixed(1)}MB`,
  ].join(", ") + "\n";
}

// --- OTP directory structure ---
const OTP_ROOT = "/usr/local/lib/erlang";
const OTP_DIRS = [
  "/usr", "/usr/local", "/usr/local/lib", "/usr/local/lib/erlang",
  "/usr/local/lib/erlang/lib", "/usr/local/lib/erlang/releases",
  "/usr/local/lib/erlang/releases/28",
  "/usr/local/lib/erlang/erts-16.1.2",
  "/usr/local/lib/erlang/erts-16.1.2/bin",
  "/tmp", "/home",
];

// --- BEAM environment variables ---
const BEAM_ENV = [
  "HOME=/tmp",
  "TMPDIR=/tmp",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin",
  `ROOTDIR=${OTP_ROOT}`,
  `BINDIR=${OTP_ROOT}/erts-16.1.2/bin`,
  "EMU=beam",
  "PROGNAME=erl",
];

// --- BEAM arguments ---
function makeBeamArgs(evalCode: string): string[] {
  return [
    "beam.smp",
    "-S", "1:1",
    "-A", "0",
    "-SDio", "1",
    "-SDcpu", "1:1",
    "-P", "262144",
    "--",
    "-root", OTP_ROOT,
    "-bindir", `${OTP_ROOT}/erts-16.1.2/bin`,
    "-progname", "erl",
    "-home", "/tmp",
    "-start_epmd", "false",
    "-boot", `${OTP_ROOT}/releases/28/start_clean`,
    "-noshell",
    "-pa", ".",
    `${OTP_ROOT}/lib/kernel-10.4.2/ebin`,
    `${OTP_ROOT}/lib/stdlib-7.1/ebin`,
    "-eval", evalCode,
  ];
}

// --- Examples ---
const EXAMPLES: Record<string, string> = {
  hello: `io:format("Hello from Erlang/OTP 28 on WebAssembly!~n"),
io:format("System: ~s~n", [erlang:system_info(system_version)]),
io:format("Word size: ~p bytes~n", [erlang:system_info(wordsize)]),
io:format("Schedulers: ~p~n", [erlang:system_info(schedulers)]),
io:format("Process limit: ~p~n", [erlang:system_info(process_limit)]),
io:format("Processes: ~p~n", [length(erlang:processes())]).`,

  ring: `%% Ring benchmark: 1000 processes, 100 rounds
Ring = fun Ring(0, _N) -> ok;
           Ring(Rounds, N) ->
    Pids = lists:foldl(
        fun(_, [Prev|_] = Acc) ->
            Pid = spawn(fun Loop() ->
                receive {token, From, Val} ->
                    Prev ! {token, self(), Val + 1},
                    Loop()
                end
            end),
            [Pid | Acc]
        end,
        [self()],
        lists:seq(1, N - 1)
    ),
    Last = hd(Pids),
    Last ! {token, self(), 0},
    receive {token, _, Val} ->
        io:format("Round ~p: token value = ~p~n", [Rounds, Val])
    end,
    Ring(Rounds - 1, N)
end,
T1 = erlang:monotonic_time(millisecond),
Ring(100, 1000),
T2 = erlang:monotonic_time(millisecond),
io:format("~nDone: 100 rounds x 1000 processes in ~pms~n", [T2 - T1]).`,

  fib: `%% Fibonacci with pattern matching and recursion
Fib = fun Fib(0) -> 0;
          Fib(1) -> 1;
          Fib(N) -> Fib(N-1) + Fib(N-2)
      end,
lists:foreach(
    fun(N) ->
        io:format("fib(~2w) = ~w~n", [N, Fib(N)])
    end,
    lists:seq(0, 20)
).`,

  processes: `%% Spawn processes and pass messages
Parent = self(),

%% Spawn 5 worker processes
Workers = lists:map(
    fun(Id) ->
        spawn(fun() ->
            %% Each worker does some "work" then reports back
            Result = Id * Id,
            Parent ! {result, Id, Result}
        end)
    end,
    lists:seq(1, 5)
),

io:format("Spawned ~p workers: ~p~n", [length(Workers), Workers]),

%% Collect results
lists:foreach(
    fun(_) ->
        receive
            {result, Id, Value} ->
                io:format("Worker ~p: ~p^2 = ~p~n", [Id, Id, Value])
        after 5000 ->
            io:format("Timeout waiting for result~n")
        end
    end,
    lists:seq(1, 5)
),
io:format("~nAll workers done.~n").`,

  lists: `%% List comprehensions and higher-order functions
Nums = lists:seq(1, 20),

%% List comprehension: squares of even numbers
Squares = [X*X || X <- Nums, X rem 2 =:= 0],
io:format("Even squares: ~p~n", [Squares]),

%% Map and filter
Doubled = lists:map(fun(X) -> X * 2 end, lists:seq(1, 10)),
io:format("Doubled: ~p~n", [Doubled]),

Big = lists:filter(fun(X) -> X > 10 end, Doubled),
io:format("Greater than 10: ~p~n", [Big]),

%% Fold (sum and product)
Sum = lists:foldl(fun(X, Acc) -> X + Acc end, 0, lists:seq(1, 100)),
io:format("Sum 1..100: ~p~n", [Sum]),

Factorial = lists:foldl(fun(X, Acc) -> X * Acc end, 1, lists:seq(1, 20)),
io:format("20! = ~p~n", [Factorial]),

%% Zip and unzip
Keys = [a, b, c, d],
Vals = [1, 2, 3, 4],
Pairs = lists:zip(Keys, Vals),
io:format("Zipped: ~p~n", [Pairs]),

%% Sort with custom comparator
Words = ["banana", "apple", "cherry", "date"],
Sorted = lists:sort(fun(A, B) -> length(A) =< length(B) end, Words),
io:format("Sorted by length: ~p~n", [Sorted]).`,

  patterns: `%% Pattern matching showcase
%% Tuple matching
{ok, Value} = {ok, 42},
io:format("Extracted value: ~p~n", [Value]),

%% List pattern matching
[Head | Tail] = [1, 2, 3, 4, 5],
io:format("Head: ~p, Tail: ~p~n", [Head, Tail]),

%% Function with guards using anonymous funs
Classify = fun(X) when X > 0 -> positive;
              (X) when X < 0 -> negative;
              (0) -> zero
           end,
lists:foreach(
    fun(N) ->
        io:format("~3w -> ~p~n", [N, Classify(N)])
    end,
    [-5, -1, 0, 1, 42]
),

%% Map (dictionary) operations
Map = #{name => "BEAM", version => 28, platform => "wasm32"},
#{name := Name, version := Ver} = Map,
io:format("~nRunning ~s version ~p~n", [Name, Ver]),

%% Binary pattern matching
Bin = <<72, 101, 108, 108, 111>>,
io:format("Binary: ~p = ~s~n", [Bin, Bin]),

%% Bit syntax
<<A:4, B:4>> = <<16#AB>>,
io:format("Nibbles: ~.16B, ~.16B~n", [A, B]).`,
};

// --- Active kernel tracking ---
let activeKernel: BrowserKernel | null = null;
let running = false;

function appendOutput(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  outputEl.appendChild(span);
  outputEl.scrollTop = outputEl.scrollHeight;
}

async function runBatch() {
  if (running) return;
  running = true;
  runBtn.disabled = true;
  stopBtn.disabled = false;
  outputEl.textContent = "";

  try {
    const info = await loadBinaries();
    if (info) appendOutput(info, "info");

    let code = codeEl.value.trim();

    // Auto-append halt if user code doesn't call halt().
    // Erlang -eval expects a single expression sequence: "expr1, expr2, expr3."
    // Strip trailing period, append halt as the last expression.
    if (!/halt\s*\(/.test(code)) {
      code = code.replace(/\.\s*$/, "");
      code += ",\nhalt(0, [{flush, false}]).";
    }

    // Halt detection: BEAM's halt() hangs on pthread_join because
    // dirty scheduler threads are blocked on futex. Track output timing
    // and force exit after 3s of idle.
    let lastOutputTime = 0;
    let outputSeen = false;

    const memfs = MemoryFileSystem.fromImage(decompressVfsImage(new Uint8Array(vfsImageBuf!)),
      { maxByteLength: 256 * 1024 * 1024 },
    );

    const kernel = new BrowserKernel({
      memfs,
      onStdout: (data) => {
        appendOutput(decoder.decode(data));
        lastOutputTime = Date.now();
        outputSeen = true;
      },
      onStderr: (data) => appendOutput(decoder.decode(data), "stderr"),
    });
    activeKernel = kernel;
    await kernel.init(kernelBytes!);

    setStatus("Starting BEAM...", "loading");

    const args = makeBeamArgs(code);
    setStatus("Running BEAM...", "running");

    const exitPromise = kernel.spawn(beamBytes!, args, {
      env: BEAM_ENV,
    });

    const haltPromise = new Promise<number>((resolve) => {
      const interval = setInterval(() => {
        if (outputSeen && Date.now() - lastOutputTime > 3000) {
          clearInterval(interval);
          resolve(0);
        }
      }, 500);

      // Also resolve if exitPromise resolves naturally
      exitPromise.then((code) => {
        clearInterval(interval);
        resolve(code);
      });
    });

    const exitCode = await haltPromise;

    appendOutput(`\nExited with code ${exitCode}\n`, "info");
    hideStatus();

    // Force cleanup — BEAM threads may still be alive
    try { await kernel.destroy(); } catch { /* already destroyed */ }
    activeKernel = null;
  } catch (e) {
    appendOutput(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
    console.error(e);
    if (activeKernel) {
      try { await activeKernel.destroy(); } catch {}
      activeKernel = null;
    }
  } finally {
    running = false;
    runBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

async function stopBeam() {
  if (activeKernel) {
    appendOutput("\n[BEAM stopped]\n", "info");
    try { await activeKernel.destroy(); } catch {}
    activeKernel = null;
  }
  running = false;
  runBtn.disabled = false;
  stopBtn.disabled = true;
  hideStatus();
}

// --- Event listeners ---
runBtn.addEventListener("click", runBatch);
stopBtn.addEventListener("click", stopBeam);

examplesEl.addEventListener("change", () => {
  const key = examplesEl.value;
  if (key && EXAMPLES[key]) {
    codeEl.value = EXAMPLES[key];
  }
  examplesEl.value = "";
});

codeEl.addEventListener("keydown", (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
    e.preventDefault();
    runBatch();
  }
});
