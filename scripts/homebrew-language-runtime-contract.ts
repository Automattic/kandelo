import { KANDELO_HOMEBREW_GUEST_LAYOUT } from
  "../host/src/homebrew-guest-layout";

const HOMEBREW_PREFIX = KANDELO_HOMEBREW_GUEST_LAYOUT.prefix;
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

export interface OptionalShellLanguageLayerInvocation extends LanguageRuntimeInvocation {
  packageName: string;
  dependencyPackages: readonly string[];
  launcherPackages: readonly string[];
  terminalCommand: string;
}

const OPTIONAL_SHELL_LAYER_PYTHON_PROGRAM = [
  "import json, os, site, sys, tempfile, zlib",
  `expected_prefix = '${PYTHON_PREFIX}'`,
  "assert sys.version_info[:3] == (3, 13, 3)",
  "assert sys.prefix == expected_prefix",
  "assert sys.exec_prefix == expected_prefix",
  "assert os.path.isdir(expected_prefix + '/lib/python3.13/lib-dynload')",
  "assert expected_prefix + '/lib/python3.13/site-packages' in site.getsitepackages()",
  "assert json.loads('{\"kandelo\":[3,1,3]}') == {'kandelo':[3,1,3]}",
  "assert zlib.decompress(zlib.compress(b'kandelo-python')) == b'kandelo-python'",
  "handle = tempfile.NamedTemporaryFile(mode='w+', delete=False, dir='/tmp')",
  "path = handle.name",
  "_ = handle.write('python-file-ok')",
  "handle.flush()",
  "handle.seek(0)",
  "assert handle.read() == 'python-file-ok'",
  "handle.close()",
  "os.unlink(path)",
  "print('optional-shell-layer-python-ok:3.13.3')",
].join("; ");

const OPTIONAL_SHELL_LAYER_PERL_PROGRAM = [
  "use strict; use warnings",
  "use Config",
  "use File::Spec",
  "use List::Util qw(sum)",
  "use POSIX qw(_exit)",
  "die 'wrong Perl version' unless $^V eq v5.40.3",
  `die 'wrong Perl prefix' unless $Config{prefix} eq '${HOMEBREW_PREFIX}/opt/perl'`,
  "my $path = File::Spec->catfile('/tmp', 'kandelo-perl-runtime.txt')",
  "open my $out, '>', $path or die $!",
  "print {$out} 'perl-file-ok'",
  "close $out or die $!",
  "open my $in, '<', $path or die $!",
  "my $contents = <$in>",
  "close $in or die $!",
  "unlink $path or die $!",
  "die 'file roundtrip failed' unless $contents eq 'perl-file-ok'",
  "pipe(my $reader, my $writer) or die $!",
  "my $pid = fork()",
  "die 'fork failed' unless defined $pid",
  "if ($pid == 0) { close $reader; print {$writer} 'child:' . sum(1, 2, 3); close $writer; _exit(0) }",
  "close $writer",
  "my $child = <$reader>",
  "close $reader",
  "my $waited = waitpid($pid, 0)",
  "die 'child failed' unless $waited == $pid && $? == 0 && $child eq 'child:6'",
  'print "optional-shell-layer-perl-ok:v5.40.3\\n"',
].join("; ");

const OPTIONAL_SHELL_LAYER_ERLANG_EXPRESSION =
  [
    'ok = file:write_file("/tmp/kandelo-erlang-runtime.txt", <<"erlang-file-ok">>)',
    '{ok, <<"erlang-file-ok">>} = file:read_file("/tmp/kandelo-erlang-runtime.txt")',
    'ok = file:delete("/tmp/kandelo-erlang-runtime.txt")',
    "Parent = self()",
    "spawn(fun() -> Parent ! {child, lists:sum([1,2,3])} end)",
    "receive {child, 6} -> ok after 5000 -> erlang:error(child_timeout) end",
    'io:format("optional-shell-layer-erlang-ok:28.2~n")',
    "halt()",
  ].join(", ") + ".";

const OPTIONAL_SHELL_LAYER_RUBY_PROGRAM = [
  "raise 'RUBYLIB leaked' if ENV.key?('RUBYLIB')",
  "raise 'wrong Ruby version' unless RUBY_VERSION == '4.0.5'",
  "require 'rbconfig'",
  "prefix = RbConfig::CONFIG['prefix']",
  `allowed = ['${HOMEBREW_PREFIX}/opt/ruby', '${HOMEBREW_PREFIX}/Cellar/ruby/4.0.5_1']`,
  'raise "wrong Ruby prefix: #{prefix}" unless allowed.include?(prefix)',
  "require 'pathname'",
  "require 'json'",
  "require 'yaml'",
  "require 'zlib'",
  "require 'rubygems'",
  "require 'bundler'",
  "require 'tempfile'",
  "data = {'name'=>'kandelo','nums'=>[1,2,3],'nested'=>{'ok'=>true}}",
  "raise 'pathname failed' unless Pathname('/tmp').join('ruby').to_s == '/tmp/ruby'",
  "raise 'JSON failed' unless JSON.parse(JSON.generate(data)) == data",
  "raise 'YAML failed' unless YAML.load(YAML.dump(data)) == data",
  "packed = Zlib::Deflate.deflate('kandelo-ruby')",
  "raise 'zlib failed' unless Zlib::Inflate.inflate(packed) == 'kandelo-ruby'",
  "Tempfile.create('kandelo-ruby', '/tmp') { |file| file.write('ruby-file-ok'); file.flush; file.rewind; raise 'file failed' unless file.read == 'ruby-file-ok' }",
  "raise 'RubyGems version failed' unless Gem::VERSION == '4.0.10'",
  "raise 'Bundler version failed' unless Bundler::VERSION == '4.0.10'",
  "puts 'optional-shell-layer-ruby-ok:4.0.5:rubygems-4.0.10:bundler-4.0.10'",
].join("; ");

function optionalShellLanguageLayerInvocation(
  label: string,
  packageName: string,
  dependencyPackages: readonly string[],
  launcherPackages: readonly string[],
  command: string,
  args: readonly string[],
  expectedStdout: string,
): OptionalShellLanguageLayerInvocation {
  const argv = [SHELL, "-c", SHELL_EXEC, "sh", command, ...args];
  return {
    label,
    packageName,
    dependencyPackages,
    launcherPackages,
    executable: SHELL,
    argv,
    expectedStdout,
    terminalCommand: argv.map(shellQuote).join(" "),
  };
}

function shellQuote(value: string): string {
  if (/^[a-zA-Z0-9_./:+@=-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

/**
 * Acceptance cases for optional language-bottle layers mounted onto the shell
 * base. These fixtures are not the default shell's package inventory or an
 * input to its composition. They deliberately use only the normal PATH and
 * package wrappers: no language-specific runtime or library-path overrides are
 * allowed.
 */
export const OPTIONAL_SHELL_LANGUAGE_LAYER_INVOCATIONS:
  readonly OptionalShellLanguageLayerInvocation[] = [
    optionalShellLanguageLayerInvocation(
      "optional shell-layer Python",
      "kandelo-dev/tap-core/python",
      ["kandelo-dev/tap-core/zlib"],
      [],
      "python",
      ["-c", OPTIONAL_SHELL_LAYER_PYTHON_PROGRAM],
      "optional-shell-layer-python-ok:3.13.3\n",
    ),
    optionalShellLanguageLayerInvocation(
      "optional shell-layer Perl",
      "kandelo-dev/tap-core/perl",
      [],
      [],
      "perl",
      ["-e", OPTIONAL_SHELL_LAYER_PERL_PROGRAM],
      "optional-shell-layer-perl-ok:v5.40.3\n",
    ),
    optionalShellLanguageLayerInvocation(
      "optional shell-layer Erlang",
      "kandelo-dev/tap-core/erlang",
      [],
      // WHY: erl is installed as a #!/bin/sh wrapper. Track the selected
      // shell bottle explicitly without pretending it is an Erlang library.
      ["kandelo-dev/tap-core/dash"],
      "erl",
      [...ERLANG_ARGS, "-eval", OPTIONAL_SHELL_LAYER_ERLANG_EXPRESSION],
      "optional-shell-layer-erlang-ok:28.2\n",
    ),
    optionalShellLanguageLayerInvocation(
      "optional shell-layer Ruby",
      "kandelo-dev/tap-core/ruby",
      ["kandelo-dev/tap-core/zlib"],
      [],
      "ruby",
      ["-e", OPTIONAL_SHELL_LAYER_RUBY_PROGRAM],
      "optional-shell-layer-ruby-ok:4.0.5:rubygems-4.0.10:bundler-4.0.10\n",
    ),
  ];
