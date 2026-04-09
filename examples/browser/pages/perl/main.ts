/**
 * Perl browser demo — Perl 5.40.3 running inside the POSIX kernel.
 * Two modes:
 *   - REPL: xterm.js terminal with PTY-backed I/O (simple eval loop)
 *   - Script: textarea for entering a full script, click Run
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { PtyTerminal } from "../../lib/pty-terminal";
import kernelWasmUrl from "../../../../host/wasm/wasm_posix_kernel.wasm?url";
import perlWasmUrl from "../../../../examples/libs/perl/bin/perl.wasm?url";
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
const encoder = new TextEncoder();

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
let perlBytes: ArrayBuffer | null = null;

async function loadBinaries(): Promise<string> {
  if (kernelBytes && perlBytes) return "";

  setStatus("Loading kernel + Perl (~3.5MB)...", "loading");
  const results = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(perlWasmUrl).then((r) => r.arrayBuffer()),
  ]);
  kernelBytes = results[0];
  perlBytes = results[1];

  return [
    `Kernel: ${(kernelBytes.byteLength / 1024).toFixed(0)}KB`,
    `Perl: ${(perlBytes.byteLength / (1024 * 1024)).toFixed(1)}MB`,
  ].join(", ") + "\n";
}

const PERL_ENV = [
  "HOME=/home",
  "TMPDIR=/tmp",
  "TERM=xterm-256color",
  "LANG=en_US.UTF-8",
  "PATH=/usr/local/bin:/usr/bin:/bin",
];

// A simple REPL script written to the VFS. Perl doesn't have a built-in
// interactive mode, so we provide a minimal eval loop.
const REPL_SCRIPT = `
use strict;
use warnings;
$| = 1;
my $v = $^V;
print "Perl $v REPL (eval loop)\\nType 'exit' to quit.\\n\\n";
while (1) {
    print "perl> ";
    my $line = <STDIN>;
    last unless defined $line;
    chomp $line;
    last if $line eq 'exit' || $line eq 'quit';
    next if $line eq '';
    no strict;
    no warnings;
    my @result = eval($line);
    use strict;
    use warnings;
    if ($@) {
        print STDERR "Error: $@";
    } elsif (@result) {
        for my $r (@result) {
            print defined($r) ? "$r\\n" : "undef\\n";
        }
    }
}
print "\\n";
`;

function writeFile(fs: BrowserKernel["fs"], path: string, content: string): void {
  const data = encoder.encode(content);
  const fd = fs.open(path, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o755);
  fs.write(fd, data, null, data.length);
  fs.close(fd);
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

    const kernel = new BrowserKernel();
    await kernel.init(kernelBytes!);

    // Create directories and write REPL script
    const fs = kernel.fs;
    for (const d of ["/tmp", "/home", "/usr", "/usr/bin"]) {
      try { fs.mkdir(d, 0o755); } catch { /* exists */ }
    }
    writeFile(fs, "/tmp/repl.pl", REPL_SCRIPT);

    activeKernel = kernel;

    // Create PTY terminal
    const ptyTerminal = new PtyTerminal(terminalContainer, kernel);
    activePtyTerminal = ptyTerminal;

    if (info) {
      ptyTerminal.terminal.writeln(info.trimEnd());
    }

    setStatus("Starting Perl REPL...", "running");
    hideStatus();
    ptyTerminal.terminal.focus();

    // Spawn perl running the REPL script with PTY
    const exitCode = await ptyTerminal.spawn(perlBytes!, ["perl", "/tmp/repl.pl"], {
      env: PERL_ENV,
    });

    ptyTerminal.terminal.writeln(`\r\n[Perl exited with code ${exitCode}]`);
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
    activePtyTerminal.terminal.writeln("\r\n[Perl stopped]");
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
    hello: 'print "Hello, World!\\n"',
    version: 'print "Perl $^V\\n"',
    array: 'my @a = (1..5); print join(", ", @a), "\\n"',
    hash: 'my %h = (a => 1, b => 2); print "$_=$h{$_} " for sort keys %h; print "\\n"',
    regex: '"Hello World" =~ /(\\w+)/g; print "Match: $1\\n"',
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
  hello: `use strict;
use warnings;

print "Hello from Perl $^V on WebAssembly!\\n\\n";

print "Config:\\n";
print "  \\$^O = $^O\\n";
print "  \\$^V = $^V\\n";

my @features = qw(regex hashes arrays references closures);
print "\\nPerl features available:\\n";
print "  - $_\\n" for @features;
`,
  regex: `use strict;
use warnings;

my $text = "The quick brown fox jumps over the lazy dog at 3:45pm on 2024-01-15";

# Extract all words
my @words = ($text =~ /\\b([a-zA-Z]+)\\b/g);
print "Words: ", join(", ", @words), "\\n\\n";

# Extract time
if ($text =~ /(\\d{1,2}:\\d{2}(?:am|pm)?)/) {
    print "Time found: $1\\n";
}

# Extract date
if ($text =~ /(\\d{4}-\\d{2}-\\d{2})/) {
    print "Date found: $1\\n";
}

# Substitution
(my $censored = $text) =~ s/\\b(fox|dog)\\b/****/gi;
print "\\nCensored: $censored\\n";

# Split and rejoin
my @parts = split /\\s+/, $text;
print "\\nWord count: ", scalar @parts, "\\n";
print "Reversed: ", join(" ", reverse @parts), "\\n";
`,
  hash: `use strict;
use warnings;

# Hash of arrays (HoA)
my %students = (
    math    => [qw(Alice Bob Charlie)],
    science => [qw(Bob Diana Eve)],
    english => [qw(Alice Charlie Eve Frank)],
);

print "Class rosters:\\n";
for my $class (sort keys %students) {
    print "  $class: ", join(", ", @{$students{$class}}), "\\n";
}

# Count appearances
my %count;
for my $class (values %students) {
    $count{$_}++ for @$class;
}

print "\\nStudent course counts:\\n";
for my $student (sort { $count{$b} <=> $count{$a} || $a cmp $b } keys %count) {
    print "  $student: $count{$student} courses\\n";
}

# Find students in multiple classes
my @multi = grep { $count{$_} > 1 } sort keys %count;
print "\\nStudents in multiple classes: ", join(", ", @multi), "\\n";
`,
  file: `use strict;
use warnings;

# Write a file
my $path = "/tmp/perl-demo.txt";
open(my $fh, '>', $path) or die "Cannot open: $!";
for my $i (1..10) {
    printf $fh "Line %02d: %s\\n", $i, "x" x ($i * 3);
}
close($fh);
print "Wrote $path\\n";

# Read it back
open($fh, '<', $path) or die "Cannot open: $!";
my @lines = <$fh>;
close($fh);
chomp @lines;

print "Read ", scalar @lines, " lines\\n\\n";

# Process: show longest lines
my @sorted = sort { length($b) <=> length($a) } @lines;
print "Top 3 longest lines:\\n";
for my $i (0..2) {
    printf "  [%2d chars] %s\\n", length($sorted[$i]), $sorted[$i];
}

# Stats
my $total_chars = 0;
$total_chars += length($_) for @lines;
printf "\\nTotal characters: %d\\n", $total_chars;
printf "Average line length: %.1f\\n", $total_chars / scalar @lines;
`,
  functional: `use strict;
use warnings;

my @numbers = (1..20);

# map: transform
my @squares = map { $_ ** 2 } @numbers;
print "Squares: ", join(", ", @squares), "\\n";

# grep: filter
my @evens = grep { $_ % 2 == 0 } @numbers;
print "Evens: ", join(", ", @evens), "\\n";

# Chained: even squares
my @even_sq = grep { $_ % 2 == 0 } map { $_ ** 2 } @numbers;
print "Even squares: ", join(", ", @even_sq), "\\n\\n";

# sort with custom comparator
my @words = qw(banana apple cherry date elderberry fig grape);
my @by_length = sort { length($a) <=> length($b) || $a cmp $b } @words;
print "Sorted by length: ", join(", ", @by_length), "\\n";

# reduce (fold)
use List::Util qw(reduce sum max min);
my $product = reduce { $a * $b } 1..10;
printf "\\n10! = %d\\n", $product;
printf "Sum 1..20 = %d\\n", sum(@numbers);
printf "Max = %d, Min = %d\\n", max(@numbers), min(@numbers);

# Schwartzian transform (decorate-sort-undecorate)
my @files = qw(readme.txt main.c lib.h Makefile test.pl config.yml);
my @sorted = map  { $_->[0] }
             sort { $a->[1] cmp $b->[1] }
             map  { [$_, lc $_] }
             @files;
print "\\nCase-insensitive sort: ", join(", ", @sorted), "\\n";
`,
  oop: `use strict;
use warnings;

package Animal {
    sub new {
        my ($class, %args) = @_;
        return bless {
            name  => $args{name}  // "Unknown",
            sound => $args{sound} // "...",
        }, $class;
    }
    sub name  { $_[0]->{name} }
    sub sound { $_[0]->{sound} }
    sub speak {
        my $self = shift;
        printf "%s says %s!\\n", $self->name, $self->sound;
    }
}

package Dog {
    our @ISA = ('Animal');
    sub new {
        my ($class, %args) = @_;
        $args{sound} = "Woof";
        return $class->SUPER::new(%args);
    }
    sub fetch {
        my ($self, $item) = @_;
        printf "%s fetches the %s!\\n", $self->name, $item;
    }
}

package Cat {
    our @ISA = ('Animal');
    sub new {
        my ($class, %args) = @_;
        $args{sound} = "Meow";
        return $class->SUPER::new(%args);
    }
    sub purr {
        printf "%s purrs...\\n", $_[0]->name;
    }
}

package main;

my @pets = (
    Dog->new(name => "Rex"),
    Cat->new(name => "Whiskers"),
    Dog->new(name => "Buddy"),
    Cat->new(name => "Luna"),
);

for my $pet (@pets) {
    $pet->speak;
}

print "\\n";
$pets[0]->fetch("ball");
$pets[1]->purr;

# Polymorphism check
print "\\nAll animals:\\n";
for my $pet (@pets) {
    printf "  %s is a %s\\n", $pet->name, ref($pet);
}
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

    const kernel = new BrowserKernel({
      onStdout: (data) => appendBatchOutput(decoder.decode(data)),
      onStderr: (data) => appendBatchOutput(decoder.decode(data), "stderr"),
    });
    await kernel.init(kernelBytes!);

    // Create directories
    const fs = kernel.fs;
    for (const d of ["/tmp", "/home"]) {
      try { fs.mkdir(d, 0o755); } catch { /* exists */ }
    }

    // Write script to a file in the VFS
    const scriptPath = "/tmp/script.pl";
    const scriptBytes = encoder.encode(code);
    const fd = fs.open(scriptPath, 0x241 /* O_WRONLY|O_CREAT|O_TRUNC */, 0o644);
    fs.write(fd, scriptBytes, null, scriptBytes.length);
    fs.close(fd);

    setStatus("Running Perl...", "running");

    const exitCode = await kernel.spawn(perlBytes!, ["perl", scriptPath], {
      env: PERL_ENV,
    });

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
