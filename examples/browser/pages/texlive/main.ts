/**
 * TeX Live browser demo — pdftex (pdfLaTeX) running inside the POSIX kernel.
 * CodeMirror editor for LaTeX source, PDF preview via iframe.
 */
import { BrowserKernel } from "../../lib/browser-kernel";
import { loadTexliveBundle } from "../../lib/texlive-bundle";
import kernelWasmUrl from "@kernel-wasm?url";
// Multi-output package: install-release nests outputs under the
// program name (`texlive/`) per its layout convention. pdftex.wasm
// is the engine; texlive-bundle.json carries texmf-dist + latex.fmt
// runtime data.
import pdftexWasmUrl from "@binaries/programs/wasm32/texlive/pdftex.wasm?url";
import texliveBundleUrl from "@binaries/programs/wasm32/texlive/texlive-bundle.json?url";

// CodeMirror imports
import { EditorView, keymap, lineNumbers } from "@codemirror/view";
import { EditorState } from "@codemirror/state";
import { defaultKeymap, history, historyKeymap } from "@codemirror/commands";
import { searchKeymap } from "@codemirror/search";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  StreamLanguage,
  bracketMatching,
} from "@codemirror/language";
import { stex } from "@codemirror/legacy-modes/mode/stex";
import { oneDark } from "@codemirror/theme-one-dark";

// --- Examples ---
const EXAMPLES: Record<string, string> = {
  hello: `\\documentclass{article}
\\begin{document}
Hello, World! This PDF was typeset by \\LaTeX{} running as WebAssembly
inside a POSIX kernel in your browser.

\\medskip
\\noindent\\textbf{How it works:}
\\begin{enumerate}
  \\item You edit \\LaTeX{} source in the editor
  \\item pdftex compiles it inside a WebAssembly POSIX kernel
  \\item The resulting PDF is displayed in the preview pane
\\end{enumerate}
\\end{document}
`,

  math: `\\documentclass{article}
\\usepackage{amsmath, amssymb}
\\begin{document}

\\section*{Mathematical Typesetting}

Euler's identity:
\\[ e^{i\\pi} + 1 = 0 \\]

The Gaussian integral:
\\[ \\int_{-\\infty}^{\\infty} e^{-x^2} \\, dx = \\sqrt{\\pi} \\]

A summation:
\\[ \\sum_{n=1}^{\\infty} \\frac{1}{n^2} = \\frac{\\pi^2}{6} \\]

A matrix equation:
\\[
\\begin{pmatrix}
  a & b \\\\
  c & d
\\end{pmatrix}
\\begin{pmatrix}
  x \\\\
  y
\\end{pmatrix}
=
\\begin{pmatrix}
  ax + by \\\\
  cx + dy
\\end{pmatrix}
\\]

Maxwell's equations in differential form:
\\begin{align}
  \\nabla \\cdot \\mathbf{E}  &= \\frac{\\rho}{\\varepsilon_0} \\\\
  \\nabla \\cdot \\mathbf{B}  &= 0 \\\\
  \\nabla \\times \\mathbf{E} &= -\\frac{\\partial \\mathbf{B}}{\\partial t} \\\\
  \\nabla \\times \\mathbf{B} &= \\mu_0 \\mathbf{J} + \\mu_0 \\varepsilon_0 \\frac{\\partial \\mathbf{E}}{\\partial t}
\\end{align}

\\end{document}
`,

  paper: `\\documentclass[11pt]{article}
\\usepackage{amsmath, amssymb}
\\usepackage[margin=1in]{geometry}
\\usepackage{hyperref}

\\title{On Running \\LaTeX{} in WebAssembly}
\\author{wasm-posix-kernel}
\\date{\\today}

\\begin{document}
\\maketitle

\\begin{abstract}
We demonstrate that a full \\LaTeX{} distribution can run inside a
POSIX-compliant kernel compiled to WebAssembly. The pdftex engine
executes in the browser with no server-side processing, producing
publication-quality PDF output from \\LaTeX{} source.
\\end{abstract}

\\section{Introduction}
The wasm-posix-kernel project implements a centralized POSIX kernel
as a WebAssembly module. User programs---compiled C binaries such as
\\texttt{pdftex}---communicate with the kernel via shared-memory IPC
channels.

\\section{Architecture}
The compilation pipeline proceeds as follows:
\\begin{enumerate}
  \\item The user's \\LaTeX{} source is written to a virtual filesystem
  \\item \\texttt{pdftex} is spawned as a process within the kernel
  \\item The engine reads macros, fonts, and configuration from the VFS
  \\item The resulting PDF is read back and displayed via a blob URL
\\end{enumerate}

\\section{Results}
The Quadratic Formula:
\\begin{equation}
  x = \\frac{-b \\pm \\sqrt{b^2 - 4ac}}{2a}
  \\label{eq:quadratic}
\\end{equation}

Equation~\\eqref{eq:quadratic} demonstrates cross-referencing.

\\section{Conclusion}
Running \\LaTeX{} in the browser opens possibilities for client-side
document processing with zero server infrastructure.

\\end{document}
`,

  tikz: `\\documentclass[border=10pt]{standalone}
\\usepackage{tikz}
\\usetikzlibrary{arrows.meta, positioning}

\\begin{document}
\\begin{tikzpicture}[
  node distance=1.5cm,
  block/.style={rectangle, draw, fill=blue!20, rounded corners,
                minimum height=2em, minimum width=6em,
                text centered, font=\\small},
  arrow/.style={-{Stealth[length=3mm]}, thick}
]

% Nodes
\\node[block] (editor)   {LaTeX Editor};
\\node[block, below=of editor] (vfs)  {Virtual FS};
\\node[block, below=of vfs] (pdftex) {pdftex.wasm};
\\node[block, below left=of pdftex] (fonts) {Fonts};
\\node[block, below right=of pdftex] (macros) {Macros};
\\node[block, below=2cm of pdftex] (pdf)    {PDF Output};
\\node[block, below=of pdf] (preview) {Browser Preview};

% Arrows
\\draw[arrow] (editor)  -- node[right, font=\\scriptsize] {.tex} (vfs);
\\draw[arrow] (vfs)     -- (pdftex);
\\draw[arrow] (fonts)   -- (pdftex);
\\draw[arrow] (macros)  -- (pdftex);
\\draw[arrow] (pdftex)  -- node[right, font=\\scriptsize] {.pdf} (pdf);
\\draw[arrow] (pdf)     -- node[right, font=\\scriptsize] {blob URL} (preview);

% Background label
\\node[above=0.5cm of editor, font=\\large\\bfseries] {LaTeX in WebAssembly};

\\end{tikzpicture}
\\end{document}
`,

  tables: `\\documentclass{article}
\\usepackage{booktabs}
\\usepackage{xcolor}
\\usepackage[margin=1in]{geometry}
\\usepackage{array}

\\begin{document}

\\section*{Tables \\& Color}

\\subsection*{Programming Language Comparison}

\\begin{table}[h]
\\centering
\\begin{tabular}{@{} l l r r @{}}
\\toprule
\\textbf{Language} & \\textbf{Paradigm} & \\textbf{Year} & \\textbf{TIOBE \\%} \\\\
\\midrule
Python     & Multi-paradigm & 1991 & 28.11 \\\\
C          & Procedural     & 1972 & 15.23 \\\\
Java       & Object-oriented & 1995 & 12.54 \\\\
JavaScript & Multi-paradigm & 1995 &  8.19 \\\\
Rust       & Multi-paradigm & 2015 &  2.81 \\\\
\\bottomrule
\\end{tabular}
\\caption{Top programming languages (illustrative data)}
\\end{table}

\\subsection*{Color Palette}

\\LaTeX{} with \\texttt{xcolor}:

\\begin{itemize}
  \\item \\textcolor{red}{Red text}
  \\item \\textcolor{blue}{Blue text}
  \\item \\textcolor{green!60!black}{Green text}
  \\item \\colorbox{yellow!30}{Highlighted text}
  \\item \\colorbox{blue!20}{\\textcolor{blue!80!black}{Badge style}}
\\end{itemize}

\\subsection*{Alternating Row Colors}

\\rowcolors{2}{gray!15}{white}
\\begin{tabular}{@{} l r r @{}}
\\toprule
\\textbf{Month} & \\textbf{Revenue} & \\textbf{Growth} \\\\
\\midrule
January   & \\$12,400 & --- \\\\
February  & \\$13,100 & +5.6\\% \\\\
March     & \\$14,800 & +13.0\\% \\\\
April     & \\$14,200 & $-4.1$\\% \\\\
May       & \\$16,500 & +16.2\\% \\\\
\\bottomrule
\\end{tabular}

\\end{document}
`,

  resume: `\\documentclass[11pt]{article}
\\usepackage[margin=0.75in]{geometry}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage{hyperref}

\\pagestyle{empty}

% Section formatting
\\titleformat{\\section}{\\large\\bfseries\\uppercase}{}{0em}{}[\\titlerule]
\\titlespacing{\\section}{0pt}{1.5ex}{1ex}

\\begin{document}

\\begin{center}
  {\\LARGE\\bfseries Jane Doe} \\\\[0.5em]
  \\href{mailto:jane@example.com}{jane@example.com} \\quad|\\quad
  (555) 123-4567 \\quad|\\quad
  San Francisco, CA
\\end{center}

\\section{Experience}

\\textbf{Senior Software Engineer} \\hfill 2022 -- Present \\\\
\\textit{Acme Corp} \\hfill San Francisco, CA
\\begin{itemize}[nosep, leftmargin=1.5em]
  \\item Led migration of monolithic application to microservices architecture
  \\item Reduced API latency by 40\\% through caching and query optimization
  \\item Mentored team of 4 junior engineers
\\end{itemize}

\\medskip
\\textbf{Software Engineer} \\hfill 2019 -- 2022 \\\\
\\textit{StartupCo} \\hfill Remote
\\begin{itemize}[nosep, leftmargin=1.5em]
  \\item Built real-time data pipeline processing 10M events/day
  \\item Implemented CI/CD pipeline reducing deployment time by 60\\%
  \\item Contributed to open-source WebAssembly tooling
\\end{itemize}

\\section{Education}

\\textbf{B.S.\\ Computer Science} \\hfill 2019 \\\\
\\textit{University of California, Berkeley}

\\section{Skills}

\\textbf{Languages:} Rust, TypeScript, Python, C, Go \\\\
\\textbf{Technologies:} WebAssembly, Kubernetes, PostgreSQL, Redis \\\\
\\textbf{Tools:} Git, Docker, Terraform, GitHub Actions

\\end{document}
`,
};

// --- DOM elements ---
const editorContainer = document.getElementById("editor") as HTMLDivElement;
const compileBtn = document.getElementById("compile") as HTMLButtonElement;
const examplesEl = document.getElementById("examples") as HTMLSelectElement;
const statusDiv = document.getElementById("status") as HTMLDivElement;
const pdfPreview = document.getElementById("pdf-preview") as HTMLIFrameElement;
const pdfPlaceholder = document.getElementById(
  "pdf-placeholder",
) as HTMLDivElement;
const logPanel = document.getElementById("log-panel") as HTMLDivElement;
const compileLog = document.getElementById("compile-log") as HTMLPreElement;
const toggleLogBtn = document.getElementById("toggle-log") as HTMLButtonElement;

const decoder = new TextDecoder();
const encoder = new TextEncoder();

// --- CodeMirror setup ---
const editor = new EditorView({
  state: EditorState.create({
    doc: EXAMPLES.hello,
    extensions: [
      lineNumbers(),
      history(),
      bracketMatching(),
      syntaxHighlighting(defaultHighlightStyle),
      StreamLanguage.define(stex),
      oneDark,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        {
          key: "Ctrl-Enter",
          mac: "Cmd-Enter",
          run: () => {
            compile();
            return true;
          },
        },
      ]),
      EditorView.lineWrapping,
    ],
  }),
  parent: editorContainer,
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

// --- Log toggle ---
let logVisible = false;
toggleLogBtn.addEventListener("click", () => {
  logVisible = !logVisible;
  logPanel.classList.toggle("hidden", !logVisible);
  toggleLogBtn.textContent = logVisible ? "Hide Log" : "Show Log";
});

function appendLog(text: string, cls?: string) {
  const span = document.createElement("span");
  if (cls) span.className = cls;
  span.textContent = text;
  compileLog.appendChild(span);
  compileLog.scrollTop = compileLog.scrollHeight;
}

// --- Binary loading ---
let kernelBytes: ArrayBuffer | null = null;
let pdftexBytes: ArrayBuffer | null = null;

async function loadBinaries(): Promise<void> {
  if (kernelBytes && pdftexBytes) return;

  setStatus("Loading kernel + pdftex...", "loading");
  const results = await Promise.all([
    fetch(kernelWasmUrl).then((r) => r.arrayBuffer()),
    fetch(pdftexWasmUrl).then((r) => r.arrayBuffer()),
  ]);
  kernelBytes = results[0];
  pdftexBytes = results[1];
}

// --- Compilation ---
let compiling = false;
let pdfBlobUrl: string | null = null;

async function compile() {
  if (compiling) return;
  compiling = true;
  compileBtn.disabled = true;
  compileLog.textContent = "";

  try {
    await loadBinaries();

    // Initialize kernel
    const kernel = new BrowserKernel({
      fsSize: 512 * 1024 * 1024,
      maxFsSize: 512 * 1024 * 1024,
      onStdout: (data) => appendLog(decoder.decode(data)),
      onStderr: (data) => appendLog(decoder.decode(data), "stderr"),
    });
    await kernel.init(kernelBytes!);

    const fs = kernel.fs;

    // Create directories
    for (const d of ["/usr", "/usr/share", "/tmp", "/home"]) {
      try {
        fs.mkdir(d, 0o755);
      } catch {
        /* exists */
      }
    }

    // Load TeX Live bundle
    setStatus("Loading TeX Live distribution...", "loading");
    const loaded = await loadTexliveBundle(
      fs,
      texliveBundleUrl,
      (current, total) => {
        setStatus(`Loading TeX Live... ${current}/${total} files`, "loading");
      },
    );
    appendLog(`TeX Live distribution loaded (${loaded} files)\n`, "info");

    // Write LaTeX source to VFS
    const source = editor.state.doc.toString();
    const sourceBytes = encoder.encode(source);
    const O_WRONLY = 1;
    const O_CREAT = 0x40;
    const O_TRUNC = 0x200;
    const fd = fs.open(
      "/tmp/input.tex",
      O_WRONLY | O_CREAT | O_TRUNC,
      0o644,
    );
    fs.write(fd, sourceBytes, 0, sourceBytes.length);
    fs.close(fd);

    // kpathsea needs argv[0] to resolve to an existing file so it
    // can determine its installation directory. Using "pdflatex" as
    // the program name triggers PDF output mode (vs DVI).
    try {
      fs.mkdir("/usr/bin", 0o755);
    } catch { /* already exists */ }
    const marker = fs.open("/usr/bin/pdflatex", O_WRONLY | O_CREAT | O_TRUNC, 0o755);
    fs.close(marker);

    // Set up environment
    const env = [
      "HOME=/home",
      "TMPDIR=/tmp",
      "PATH=/usr/local/bin:/usr/bin:/bin",
      "TEXMFDIST=/usr/share/texmf-dist",
      "TEXMFCNF=/usr/share/texmf-dist/web2c",
    ];

    setStatus("Compiling LaTeX...", "running");

    // Show log on compilation
    if (!logVisible) {
      logVisible = true;
      logPanel.classList.remove("hidden");
      toggleLogBtn.textContent = "Hide Log";
    }

    const exitCode = await kernel.spawn(
      pdftexBytes!,
      [
        "/usr/bin/pdflatex",
        "--output-format=pdf",
        "-interaction=nonstopmode",
        "-output-directory=/tmp",
        "-fmt=latex",
        "/tmp/input.tex",
      ],
      { env, stdin: new Uint8Array(0) },
    );

    appendLog(`\npdftex exited with code ${exitCode}\n`, "info");

    if (exitCode === 0) {
      // Read PDF from VFS
      try {
        const pdfFd = fs.open("/tmp/input.pdf", 0 /* O_RDONLY */, 0);
        const stat = fs.fstat(pdfFd);
        const pdfData = new Uint8Array(stat.size);
        fs.read(pdfFd, pdfData, null, stat.size);
        fs.close(pdfFd);

        // Create blob URL and display
        if (pdfBlobUrl) URL.revokeObjectURL(pdfBlobUrl);
        const blob = new Blob([pdfData], { type: "application/pdf" });
        pdfBlobUrl = URL.createObjectURL(blob);
        pdfPreview.src = pdfBlobUrl;
        pdfPreview.style.display = "block";
        pdfPlaceholder.style.display = "none";

        setStatus("Compilation successful", "running");
        setTimeout(hideStatus, 2000);
      } catch (e) {
        appendLog(`\nError reading PDF: ${e}\n`, "stderr");
        setStatus("PDF not generated — check log for errors", "error");
      }
    } else {
      setStatus("Compilation failed — check log for errors", "error");
    }

    // Clean up kernel
    try {
      await kernel.destroy();
    } catch {
      /* already destroyed */
    }
  } catch (e) {
    appendLog(`\nError: ${e}\n`, "stderr");
    setStatus(`Error: ${e}`, "error");
    console.error(e);
  } finally {
    compiling = false;
    compileBtn.disabled = false;
  }
}

compileBtn.addEventListener("click", compile);

// --- Example selector ---
examplesEl.addEventListener("change", () => {
  const key = examplesEl.value;
  if (key && EXAMPLES[key]) {
    editor.dispatch({
      changes: {
        from: 0,
        to: editor.state.doc.length,
        insert: EXAMPLES[key],
      },
    });
  }
  examplesEl.value = "";
});
