require "find"
require_relative "../Kandelo/formula_support/kandelo_package"

class Perl < Formula
  include KandeloPackageFormula
  SOURCE_URL = "https://www.cpan.org/src/5.0/perl-5.40.3.tar.gz"
  SOURCE_SHA256 = "4c155b4e6160682b38919b55ac319081b898db11857cf18a7d9ffed2648ccaff"
  PERL_PRIVLIB = "5.40.3"
  EXCLUDE_DIRS = %w[
    .git benchmark benchmarks blib corpus demo eg hints t test tests xt
  ].freeze
  EXCLUDE_PATTERNS = [
    /\.bs\z/,
    /\.c\z/,
    /\.h\z/,
    /\.o\z/,
    /\.pod\z/,
    /\.t\z/,
    /\.xs\z/,
    /Changes\z/,
    /ChangeLog\z/,
    /COPYING\z/,
    /LICENSE\z/,
    /MANIFEST\z/,
    /META\.(json|yml)\z/,
    /Makefile(\.PL)?\z/,
    /README/,
  ].freeze

  desc "Perl interpreter for Kandelo"
  homepage "https://www.perl.org/"
  url SOURCE_URL
  sha256 SOURCE_SHA256
  license any_of: ["Artistic-1.0-Perl", "GPL-1.0-or-later"]

  skip_clean "bin"

  def install
    out_dir = kandelo_build_package("perl", "build-perl.sh", SOURCE_URL, SOURCE_SHA256,
      script_env: { "PERL_VERSION" => version.to_s })
    kandelo_install_bin(out_dir, "perl.wasm", "perl")
    install_runtime(kandelo_root)
  end

  test do
    output = kandelo_run_wasm(bin/"perl", ["-e", "use strict; use warnings; print 2 + 3"],
      env: { "PERL5LIB" => (lib/"perl5/#{PERL_PRIVLIB}").to_s })
    assert_match "5", output
  end

  def install_runtime(root)
    src = first_existing_dir(
      buildpath/"kandelo-package-work/perl-src",
      Pathname.new(root)/"packages/registry/perl/perl-src",
    )
    odie "Perl source tree not found at #{src}" unless src.directory?

    dest = lib/"perl5/#{PERL_PRIVLIB}"
    rm_rf dest
    mkdir_p dest
    install_perl_tree(src/"lib", dest)
    Dir["#{src}/dist/*"].sort.each do |dist_dir|
      install_perl_tree(Pathname.new(dist_dir), dest)
    end
    Dir["#{src}/cpan/*/lib", "#{src}/dist/*/lib", "#{src}/ext/*/lib"].sort.each do |lib_dir|
      install_perl_tree(Pathname.new(lib_dir), dest)
    end
  end

  def install_perl_tree(src, dest)
    return unless src.directory?

    Find.find(src.to_s) do |path|
      source = Pathname.new(path)
      rel = source.relative_path_from(src).to_s
      basename = source.basename.to_s
      if source.directory?
        Find.prune if rel != "." && EXCLUDE_DIRS.include?(basename)
        next
      end
      next unless source.file?
      next unless include_runtime_file?(basename)

      target = dest/rel
      target.dirname.mkpath
      data = File.binread(source)
      if rel == "warnings.pm"
        data = data.gsub(
          "delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)};",
          "# delete @warnings::{qw(NORMAL FATAL MESSAGE LEVEL)}; # patched for wasm32",
        )
      end
      File.binwrite(target, data)
    end
  end

  def include_runtime_file?(basename)
    return false if EXCLUDE_PATTERNS.any? { |pattern| basename.match?(pattern) }
    basename.match?(/\.(pm|pl|ph)\z/) || basename.start_with?("Config_")
  end

  def first_existing_dir(*paths)
    paths.find(&:directory?) || paths.first
  end
end
