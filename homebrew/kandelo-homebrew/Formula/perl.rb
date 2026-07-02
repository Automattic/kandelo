require_relative "../Kandelo/formula_support/kandelo_package"

class Perl < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.cpan.org/src/5.0/perl-5.40.3.tar.gz"
  SOURCE_SHA256 = "4c155b4e6160682b38919b55ac319081b898db11857cf18a7d9ffed2648ccaff"
  PERL_PRIVLIB = "5.40.3"

  desc "Perl interpreter for Kandelo (with generated core-module runtime)"
  homepage "https://www.perl.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license any_of: ["Artistic-1.0-Perl", "GPL-1.0-or-later"]

  skip_clean "bin"
  skip_clean "lib/perl5"

  def install
    out_dir = kandelo_build_package("perl", "build-perl.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "PERL_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "perl.wasm", "perl")

    # Ship the generated core-module runtime library (XSLoader.pm, Config*.pm,
    # File::Spec and the rest of the pure-perl core tree) so the runtime can
    # load File::Spec (-> Cwd -> XSLoader); the bare perl.wasm carries none.
    # build-perl.sh stages perl-src/lib via `make all` and zips it as
    # perl-runtime.zip. The test's PERL5LIB (below) points at the installed
    # lib/perl5/#{PERL_PRIVLIB}.
    runtime_stage = buildpath/"perl-runtime-stage"
    system "unzip", "-q", out_dir/"perl-runtime.zip", "-d", runtime_stage
    (prefix/"lib").install Dir["#{runtime_stage}/lib/*"]
  end

  test do
    # LC_ALL=C: perl 5.40 panics at startup parsing the composite default
    # locale Kandelo's musl setlocale returns ('C.UTF-8;C;C;C;C;C') -- a
    # separate platform boundary (kd-dvph), not this package's gap.
    env = { "PERL5LIB" => (lib/"perl5/#{PERL_PRIVLIB}").to_s, "LC_ALL" => "C" }

    # Interpreter smoke (the minimal strict/warnings arithmetic check).
    assert_match "5", kandelo_run_wasm(bin/"perl",
      ["-e", "use strict; use warnings; print 2 + 3"], env: env)

    # Regression guard for the reported gap (kd-k7zy): File::Spec must load and
    # build the expected path, XSLoader.pm (the missing generated file) must
    # load, and an XS core module must bootstrap through XSLoader::load.
    prog = <<~PERL
      use strict; use warnings;
      use File::Spec;
      use XSLoader;
      use POSIX ();
      my $p = File::Spec->catfile("a", "b", "c.txt");
      die "File::Spec catfile: $p" unless $p eq "a/b/c.txt";
      die "POSIX floor" unless POSIX::floor(3.7) == 3;
      print "perl-runtime-ok xsloader=$XSLoader::VERSION";
    PERL
    assert_match "perl-runtime-ok xsloader=",
      kandelo_run_wasm(bin/"perl", ["-e", prog], env: env)
  end
end
