/**
 * Ruby browser demo — Ruby 3.3.6 running inside the POSIX kernel.
 * Two modes:
 *   - REPL: xterm.js terminal with PTY-backed I/O (simple eval loop)
 *   - Script: textarea for entering a full script, click Run
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { PtyTerminal } from "../../lib/pty-terminal";
import { MemoryFileSystem } from "../../../../host/src/vfs/memory-fs";
import {
  ensureDir,
  ensureDirRecursive,
  writeVfsFile,
  writeVfsBinary,
} from "../../../../host/src/vfs/image-helpers";
import kernelWasmUrl from "@kernel-wasm?url";
import rubyWasmUrl from "../../../../binaries/programs/wasm32/ruby.wasm?url";
import "@xterm/xterm/css/xterm.css";

// --- DOM elements ---
const terminalContainer = document.getElementById("terminal") as HTMLDivElement;
const startBtn = document.getElementById("start") as HTMLButtonElement;
const stopBtn = document.getElementById("stop") as HTMLButtonElement;
const snippetsEl = document.getElementById("snippets") as HTMLSelectElement;
const codeEl = document.getElementById("code") as HTMLTextAreaElement;
const batchOutput = document.getElementById("batch-output") as HTMLPreElement;
const runBtn = document.getElementById("run") as HTMLButtonElement;
const examplesEl = document.getElementById("examples") as HTMLSelectElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const modeInteractiveBtn = document.getElementById("mode-interactive") as HTMLButtonElement;
const modeBatchBtn = document.getElementById("mode-batch") as HTMLButtonElement;
const interactiveView = document.getElementById("interactive-view") as HTMLDivElement;
const batchView = document.getElementById("batch-view") as HTMLDivElement;

const decoder = new TextDecoder();

// --- Mode switching ---
let currentMode: "interactive" | "batch" = "interactive";

modeInteractiveBtn.addEventListener("click", () => {
  currentMode = "interactive";
  modeInteractiveBtn.classList.add("active");
  modeBatchBtn.classList.remove("active");
  interactiveView.classList.remove("hidden");
  batchView.classList.add("hidden");
});

modeBatchBtn.addEventListener("click", () => {
  currentMode = "batch";
  modeBatchBtn.classList.add("active");
  modeInteractiveBtn.classList.remove("active");
  batchView.classList.remove("hidden");
  interactiveView.classList.add("hidden");
});

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
let rubyBytes: ArrayBuffer | null = null;

async function loadBinaries(): Promise<string> {
  if (kernelBytes && rubyBytes) return "";

  setStatus("Loading kernel + Ruby (~4MB)...", "loading");
  const results = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(rubyWasmUrl).then((r) => r.arrayBuffer()),
  ]);
  kernelBytes = results[0];
  rubyBytes = results[1];

  return [
    `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB`,
    `Ruby: ${(rubyBytes.byteLength / (1024 * 1024)).toFixed(1)}MB`,
  ].join(", ") + "\n";
}

const RUBY_ENV = [
  "HOME=/home",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin",
];

const REPL_SCRIPT_PATH = "/usr/local/share/ruby-demo/repl.rb";
const BATCH_SCRIPT_PATH = "/usr/local/share/ruby-demo/script.rb";

// A simple REPL script written to the VFS. Ruby's irb needs the stdlib,
// so we provide a minimal eval loop instead.
const REPL_SCRIPT = `
$stdout.sync = true
$stderr.sync = true
puts "Ruby #{RUBY_VERSION} REPL (eval loop)"
puts "Type 'exit' to quit."
puts
binding_ctx = binding
loop do
  print "ruby> "
  line = gets
  break unless line
  line.chomp!
  break if line == 'exit' || line == 'quit'
  next if line.empty?
  begin
    result = eval(line, binding_ctx)
    puts "=> #{result.inspect}"
  rescue Exception => e
    $stderr.puts "#{e.class}: #{e.message}"
  end
end
puts
`;

/**
 * Build the VFS image once per Ruby boot. Includes:
 *   - /usr/bin/ruby (the binary, from rubyBytes)
 *   - /tmp + /home as scratch dirs
 *   - The user-supplied script written into the image at scriptPath
 */
async function buildVfsImage(scriptPath: string, scriptContent: string): Promise<Uint8Array> {
  const fs = MemoryFileSystem.create(new SharedArrayBuffer(16 * 1024 * 1024, { maxByteLength: 64 * 1024 * 1024 }), 64 * 1024 * 1024);
  for (const d of ["/tmp", "/home", "/dev"]) ensureDir(fs, d);
  fs.chmod("/tmp", 0o777);
  ensureDirRecursive(fs, "/usr/bin");
  ensureDirRecursive(fs, "/usr/local/share/ruby-demo");
  writeVfsBinary(fs, "/usr/bin/ruby", new Uint8Array(rubyBytes!));
  writeVfsFile(fs, scriptPath, scriptContent);
  return fs.saveImage();
}

// ============================================================
// Interactive REPL mode
// ============================================================

let activeKernel: BrowserKernel | null = null;
let activePtyTerminal: PtyTerminal | null = null;

async function startInteractiveRepl() {
  startBtn.disabled = true;
  stopBtn.disabled = false;

  // Clear the container for xterm.js
  terminalContainer.innerHTML = "";

  try {
    const info = await loadBinaries();

    setStatus("Building VFS image...", "loading");
    const vfsImage = await buildVfsImage(REPL_SCRIPT_PATH, REPL_SCRIPT);

    const kernel = new BrowserKernel({ kernelOwnedFs: true });
    activeKernel = kernel;

    const ptyTerminal = new PtyTerminal(terminalContainer, kernel);
    activePtyTerminal = ptyTerminal;

    if (info) {
      ptyTerminal.terminal.writeln(info.trimEnd());
    }

    setStatus("Starting Ruby REPL...", "running");
    hideStatus();
    ptyTerminal.terminal.focus();

    // Boot the kernel with the baked REPL script as the first process.
    const exitCode = await ptyTerminal.boot({
      kernelWasm: kernelBytes!,
      vfsImage,
      argv: ["/usr/bin/ruby", REPL_SCRIPT_PATH],
      env: RUBY_ENV,
    });

    ptyTerminal.terminal.writeln(`\r\n[Ruby exited with code ${exitCode}]`);
  } catch (e) {
    if (activePtyTerminal) {
      activePtyTerminal.terminal.writeln(`\r\nError: ${e}`);
    }
    setStatus(`Error: ${e}`, "error");
    console.error(e);
  } finally {
    activeKernel = null;
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
}

function stopRepl() {
  if (activePtyTerminal) {
    activePtyTerminal.terminal.writeln("\r\n[Ruby stopped]");
    activePtyTerminal.dispose();
    activePtyTerminal = null;
  }
  activeKernel = null;
  startBtn.disabled = false;
  stopBtn.disabled = true;
}

startBtn.addEventListener("click", startInteractiveRepl);
stopBtn.addEventListener("click", stopRepl);

snippetsEl.addEventListener("change", () => {
  const snippets: Record<string, string> = {
    hello: 'puts "Hello, World!"',
    version: "puts RUBY_VERSION",
    array: "[1,2,3,4,5].map { |x| x ** 2 }",
    hash: '{a: 1, b: 2}.each { |k,v| puts "#{k}=#{v}" }',
    block: '3.times { |i| puts "iteration #{i}" }',
  };
  const key = snippetsEl.value;
  if (key && snippets[key] && activePtyTerminal) {
    activePtyTerminal.write(snippets[key] + "\n");
  }
  snippetsEl.value = "";
});

// ============================================================
// Script (batch) mode
// ============================================================

const EXAMPLES: Record<string, string> = {
  hello: `puts "Hello from Ruby #{RUBY_VERSION} on WebAssembly!"
puts
puts "Config:"
puts "  RUBY_PLATFORM = #{RUBY_PLATFORM}"
puts "  RUBY_VERSION  = #{RUBY_VERSION}"
puts "  RUBY_ENGINE   = #{RUBY_ENGINE}"

features = %w[blocks iterators mixins closures symbols regex]
puts
puts "Ruby features available:"
features.each { |f| puts "  - #{f}" }
`,
  blocks: `# Blocks, Procs, and Lambdas

# Block with each
puts "Counting:"
(1..5).each { |n| puts "  #{n}" }

# Block with map and select
squares = (1..10).map { |n| n ** 2 }
evens = squares.select(&:even?)
puts "\\nSquares: #{squares.join(', ')}"
puts "Even squares: #{evens.join(', ')}"

# Yielding to blocks
def repeat(n)
  n.times { |i| yield i }
end

puts "\\nRepeating:"
repeat(3) { |i| puts "  iteration #{i}" }

# Proc and Lambda
doubler = Proc.new { |x| x * 2 }
tripler = ->(x) { x * 3 }
puts "\\ndouble(5) = #{doubler.call(5)}"
puts "triple(5) = #{tripler.call(5)}"

# Method chaining
result = (1..20)
  .select { |n| n % 3 == 0 }
  .map { |n| n ** 2 }
  .reduce(:+)
puts "\\nSum of squares of multiples of 3 (1..20): #{result}"
`,
  hash: `# Hashes and data structures

students = {
  math:    %w[Alice Bob Charlie],
  science: %w[Bob Diana Eve],
  english: %w[Alice Charlie Eve Frank],
}

puts "Class rosters:"
students.sort.each do |course, names|
  puts "  #{course}: #{names.join(', ')}"
end

# Count appearances
counts = Hash.new(0)
students.each_value do |names|
  names.each { |name| counts[name] += 1 }
end

puts "\\nStudent course counts:"
counts.sort_by { |name, count| [-count, name] }.each do |name, count|
  puts "  #{name}: #{count} courses"
end

# Students in multiple classes
multi = counts.select { |_, c| c > 1 }.keys.sort
puts "\\nStudents in multiple classes: #{multi.join(', ')}"

# Nested hash with default
graph = Hash.new { |h, k| h[k] = [] }
[[1,2], [1,3], [2,4], [3,4], [4,5]].each do |a, b|
  graph[a] << b
  graph[b] << a
end
puts "\\nAdjacency list:"
graph.sort.each { |node, neighbors| puts "  #{node}: #{neighbors}" }
`,
  file: `# File I/O

path = "/tmp/ruby-demo.txt"

# Write a file
File.open(path, "w") do |f|
  (1..10).each do |i|
    f.puts format("Line %02d: %s", i, "x" * (i * 3))
  end
end
puts "Wrote #{path}"

# Read it back
lines = File.readlines(path, chomp: true)
puts "Read #{lines.size} lines"

# Process: show longest lines
sorted = lines.sort_by { |l| -l.length }
puts "\\nTop 3 longest lines:"
sorted.first(3).each do |line|
  puts format("  [%2d chars] %s", line.length, line)
end

# Stats
total_chars = lines.sum(&:length)
puts format("\\nTotal characters: %d", total_chars)
puts format("Average line length: %.1f", total_chars.to_f / lines.size)
`,
  functional: `# Enumerable methods — Ruby's functional programming toolkit

numbers = (1..20).to_a

# map: transform
squares = numbers.map { |n| n ** 2 }
puts "Squares: #{squares.join(', ')}"

# select: filter
evens = numbers.select(&:even?)
puts "Evens: #{evens.join(', ')}"

# Chained: even squares
even_sq = numbers.map { |n| n ** 2 }.select(&:even?)
puts "Even squares: #{even_sq.join(', ')}"

# sort with custom comparator
words = %w[banana apple cherry date elderberry fig grape]
by_length = words.sort_by { |w| [w.length, w] }
puts "\\nSorted by length: #{by_length.join(', ')}"

# reduce (inject)
product = (1..10).reduce(:*)
puts "\\n10! = #{product}"
puts "Sum 1..20 = #{numbers.reduce(:+)}"
puts "Max = #{numbers.max}, Min = #{numbers.min}"

# group_by
grouped = words.group_by { |w| w.length }
puts "\\nGrouped by length:"
grouped.sort.each { |len, ws| puts "  #{len} chars: #{ws.join(', ')}" }

# each_with_object (like fold/accumulate)
freq = "hello world".chars.each_with_object(Hash.new(0)) { |c, h| h[c] += 1 }
puts "\\nCharacter frequencies:"
freq.sort_by { |_, v| -v }.each { |c, n| puts "  '#{c}': #{n}" }
`,
  oop: `# Classes, inheritance, modules

module Speakable
  def speak
    "\#{name} says \#{sound}!"
  end
end

class Animal
  include Speakable
  attr_reader :name, :sound

  def initialize(name:, sound: "...")
    @name = name
    @sound = sound
  end

  def to_s
    "\#{self.class}(\#{name})"
  end
end

class Dog < Animal
  def initialize(name:)
    super(name: name, sound: "Woof")
  end

  def fetch(item)
    "\#{name} fetches the \#{item}!"
  end
end

class Cat < Animal
  def initialize(name:)
    super(name: name, sound: "Meow")
  end

  def purr
    "\#{name} purrs..."
  end
end

pets = [
  Dog.new(name: "Rex"),
  Cat.new(name: "Whiskers"),
  Dog.new(name: "Buddy"),
  Cat.new(name: "Luna"),
]

pets.each { |pet| puts pet.speak }

puts
puts pets[0].fetch("ball")
puts pets[1].purr

puts "\\nAll animals:"
pets.each { |pet| puts "  \#{pet.name} is a \#{pet.class}" }

# Comparable mixin
class Temperature
  include Comparable
  attr_reader :degrees

  def initialize(degrees)
    @degrees = degrees
  end

  def <=>(other)
    degrees <=> other.degrees
  end

  def to_s
    "\#{degrees}°"
  end
end

temps = [72, 65, 80, 55, 90].map { |d| Temperature.new(d) }
puts "\\nTemperatures sorted: \#{temps.sort.join(', ')}"
puts "Hottest: \#{temps.max}, Coldest: \#{temps.min}"
`,
};

function appendBatchOutput(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  batchOutput.appendChild(span);
  batchOutput.scrollTop = batchOutput.scrollHeight;
}

async function runBatch() {
  runBtn.disabled = true;
  batchOutput.textContent = "";

  try {
    const info = await loadBinaries();
    if (info) appendBatchOutput(info, "info");

    const code = codeEl.value;

    setStatus("Building VFS image...", "loading");
    const vfsImage = await buildVfsImage(BATCH_SCRIPT_PATH, code);

    const kernel = new BrowserKernel({
      kernelOwnedFs: true,
      onStdout: (data) => appendBatchOutput(decoder.decode(data)),
      onStderr: (data) => appendBatchOutput(decoder.decode(data), "stderr"),
    });

    setStatus("Running Ruby...", "running");

    const { exit } = await kernel.boot({
      kernelWasm: kernelBytes!,
      vfsImage,
      argv: ["/usr/bin/ruby", BATCH_SCRIPT_PATH],
      env: RUBY_ENV,
    });
    const exitCode = await exit;

    appendBatchOutput(`\nExited with code ${exitCode}\n`, "info");
    hideStatus();
  } catch (e) {
    appendBatchOutput(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
    console.error(e);
  } finally {
    runBtn.disabled = false;
  }
}

runBtn.addEventListener("click", runBatch);

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
