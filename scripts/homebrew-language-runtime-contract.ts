const HOMEBREW_PREFIX = "/home/linuxbrew/.linuxbrew";
const PYTHON_PREFIX = `${HOMEBREW_PREFIX}/Cellar/python/3.13.3_1`;
const ERLANG_KEG = `${HOMEBREW_PREFIX}/Cellar/erlang/28.2_1`;
const SHELL = "/bin/sh";
const SHELL_EXEC = 'exec "$@"';

const PYTHON_PROGRAM = [
  "import json, os, site, sys, zlib",
  `expected_prefix = '${PYTHON_PREFIX}'`,
  "assert sys.version_info[:3] == (3, 13, 3)",
  "assert sys.prefix == expected_prefix",
  "assert sys.exec_prefix == expected_prefix",
  "assert os.path.isdir(expected_prefix + '/lib/python3.13/lib-dynload')",
  "assert os.path.isfile(expected_prefix + '/lib/python3.13/lib-dynload/README.txt')",
  "assert expected_prefix + '/lib/python3.13/site-packages' in site.getsitepackages()",
  "assert json.loads('{\"kandelo\":[3,1,3]}') == {'kandelo':[3,1,3]}",
  "assert zlib.decompress(zlib.compress(b'kandelo-python')) == b'kandelo-python'",
  "print('python-runtime-ok:' + sys.executable)",
].join("; ");

const ERLANG_ARGS = [
  "+S",
  "1:1",
  "+A",
  "0",
  "+SDio",
  "1",
  "+SDcpu",
  "1:1",
  "-mode",
  "embedded",
  "-noshell",
  "-noinput",
];

export interface LanguageRuntimeInvocation {
  label: string;
  executable: string;
  argv: string[];
  expectedStdout: string;
}

export const LANGUAGE_RUNTIME_REQUESTED_PACKAGES = [
  "dash",
  "python",
  "erlang",
] as const;

function pythonInvocation(
  name: string,
  source: "global" | "/bin" | "/usr/bin",
): LanguageRuntimeInvocation {
  const command = source === "global" ? name : `${source}/${name}`;
  const expectedExecutable =
    source === "global" ? `${HOMEBREW_PREFIX}/bin/${name}` : command;
  return {
    label: `Homebrew ${name} (${source})`,
    executable: SHELL,
    argv: [SHELL, "-c", SHELL_EXEC, "sh", command, "-c", PYTHON_PROGRAM],
    expectedStdout: `python-runtime-ok:${expectedExecutable}\n`,
  };
}

function erlangInvocation(
  label: "global" | "bin" | "usr-bin" | "opt" | "keg",
  command: string,
): LanguageRuntimeInvocation {
  const expression = `io:format("erlang-${label}-ok:~p~n", [lists:sum([1,2,3])]), halt().`;
  return {
    label: `Homebrew erl (${label})`,
    executable: SHELL,
    argv: [
      SHELL,
      "-c",
      SHELL_EXEC,
      "sh",
      command,
      ...ERLANG_ARGS,
      "-eval",
      expression,
    ],
    expectedStdout: `erlang-${label}-ok:6\n`,
  };
}

export const LANGUAGE_RUNTIME_INVOCATIONS: readonly LanguageRuntimeInvocation[] =
  [
    ...["python", "python3", "python3.13"].flatMap((name) => [
      pythonInvocation(name, "global"),
      pythonInvocation(name, "/bin"),
      pythonInvocation(name, "/usr/bin"),
    ]),
    erlangInvocation("global", "erl"),
    erlangInvocation("bin", "/bin/erl"),
    erlangInvocation("usr-bin", "/usr/bin/erl"),
    erlangInvocation("opt", `${HOMEBREW_PREFIX}/opt/erlang/bin/erl`),
    erlangInvocation("keg", `${ERLANG_KEG}/bin/erl`),
  ];
