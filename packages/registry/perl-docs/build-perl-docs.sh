#!/usr/bin/env bash
# Ship Perl's manual as perl-docs.zip, a lazy archive mounted at /usr/.
#
# Perl writes its manual in POD. Its install step (installman) renders the
# section 1 pages listed in pod.lst with Pod::Man; this does the same, with
# the options installman passes. Two differences, both because no perl is
# built here:
#
# - The release string is set to this Perl's version. Pod::Man would
#   otherwise stamp the version of the perl running it (the build host's).
# - The date is this release's date from pod/perlhist.pod, not the build
#   clock.
#
# Not shipped: the pages Perl's build generates rather than ships
# (perltoc, perlapi, ...) and the pages it copies from README.<os> files
# (other operating systems and translations), both as listed by
# Porting/pod_lib.pl. Section 3 module pages are not shipped either.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$HERE/../../.." && pwd)"
# shellcheck source=/dev/null
source "$REPO_ROOT/scripts/install-package-man-pages.sh"
kandelo_man_pages_stage_source "$HERE"
SRC="$KANDELO_MAN_PAGES_SOURCE"
VERSION="$WASM_POSIX_DEP_VERSION"
OUT="$SRC/kandelo-man1"

(
    cd "$SRC"
    rm -rf "$OUT"
    mkdir -p "$OUT"
    POD_MAN_DATE="$(perl -MTime::Piece -ne \
        'print Time::Piece->strptime($1, "%Y-%b-%d")->ymd if /^\s+\Q'"$VERSION"'\E\s+(\d{4}-\w{3}-\d{2})\s*$/' \
        pod/perlhist.pod)"
    [ -n "$POD_MAN_DATE" ] || { echo "build-perl-docs: no $VERSION release date in perlhist.pod" >&2; exit 1; }
    export POD_MAN_DATE
    KANDELO_PERL_VERSION="$VERSION" KANDELO_MAN_OUT="$OUT" perl -e '
        use strict;
        use warnings;
        use Pod::Man;
        require "./Porting/pod_lib.pl";
        # pod_lib.pl, the list installman reads, also names the pages that
        # Perl generates during its build and the ones it copies from
        # README.<os> files.
        my $meta = get_pod_metadata();
        my %generated = map { ($_ => 1) } keys %{ $meta->{generated} };
        my %readme = map { ("perl$_" => 1) } keys %{ $meta->{readmes} };
        my %copy = map { ($_ => 1) } keys %{ $meta->{copies} };
        for my $entry (@{ $meta->{master} }) {
            my ($name, $path) = @$entry;
            next if $generated{"$name.pod"} || $readme{$name} || $copy{"$name.pod"};
            -f $path or die "build-perl-docs: $path is missing\n";
            my $parser = Pod::Man->new(
                section => 1, official => 1,
                center  => "Perl Programmers Reference Guide",
                release => "perl v$ENV{KANDELO_PERL_VERSION}",
            );
            $parser->parse_from_file($path, "$ENV{KANDELO_MAN_OUT}/$name.1");
            print "$name\n";
        }
    ' > "$OUT.list"
)

pages=()
while IFS= read -r name; do
    pages+=("kandelo-man1/$name.1")
done < "$OUT.list"
[ "${#pages[@]}" -gt 100 ] || { echo "build-perl-docs: only ${#pages[@]} pages" >&2; exit 1; }

# This release's delta is installed under its versioned name too.
delta="perl$(printf '%s' "$VERSION" | tr -d .)delta.1"
install_package_man_pages perl-docs "$SRC" "${pages[@]}" "$delta=perldelta.1"
