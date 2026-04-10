# This file is part of GNU tar testsuite. -*- Autotest -*-
# Copyright 2018-2023 Free Software Foundation, Inc.
#
# GNU tar is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3 of the License, or
# (at your option) any later version.
#
# GNU tar is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.
#
# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

dnl TAR_CHECK_COMPRESS(TOOL, SUF[, SUF2])
dnl Tests whether tar can create archives using TOOL (i.e. using the --TOOL
dnl command line option). SUF and optional SUF2 are suffixes for created
dnl archives (without leading dot). Tar should be able to use TOOL to
dnl automatically decompress archives with names ending on these suffixes.
m4_define([TAR_CHECK_COMPRESS],
[AT_SETUP([compress: $1])
AT_KEYWORDS([compression compress-$1 $1])

AT_CHECK([
AT_GZIP_PREREQ($1)
unset TAR_OPTIONS

touch empty
set -e
: create with --$1
tar --$1 -cf k.tar.$2 empty
tar tf k.tar.$2

m4_foreach([SUF], m4_quote(m4_shift($@)),
[
echo testing .SUF
tar -acf k2.tar.SUF empty
cat k2.tar.SUF | $1 -d > k.SUF.tar
tar tf k.SUF.tar
])

# Extraction: ensure compressed format is correctly recognized
rm -f empty
tar xf k.tar.$2
test -f empty
],
[0],
[empty
m4_foreach([SUF],m4_quote(m4_shift($@)),[testing .SUF
empty
])])

AT_CLEANUP
])
