# Makefile for GNU tar sources.

# Copyright 1994-2023 Free Software Foundation, Inc.

# This file is part of GNU tar.

# GNU tar is free software; you can redistribute it and/or modify
# it under the terms of the GNU General Public License as published by
# the Free Software Foundation; either version 3 of the License, or
# (at your option) any later version.

# GNU tar is distributed in the hope that it will be useful,
# but WITHOUT ANY WARRANTY; without even the implied warranty of
# MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
# GNU General Public License for more details.

# You should have received a copy of the GNU General Public License
# along with this program.  If not, see <http://www.gnu.org/licenses/>.

bin_PROGRAMS = tar

noinst_HEADERS = arith.h common.h tar.h xattrs.h
tar_SOURCES = \
 buffer.c\
 checkpoint.c\
 compare.c\
 create.c\
 delete.c\
 exit.c\
 exclist.c\
 extract.c\
 xheader.c\
 incremen.c\
 list.c\
 map.c\
 misc.c\
 names.c\
 sparse.c\
 suffix.c\
 system.c\
 tar.c\
 transform.c\
 unlink.c\
 update.c\
 utf8.c\
 warning.c\
 xattrs.c

AM_CPPFLAGS = -I$(top_srcdir)/gnu -I../ -I../gnu -I$(top_srcdir)/lib -I../lib
AM_CFLAGS = $(WARN_CFLAGS) $(WERROR_CFLAGS)

tar_LDADD = $(LIBS) ../lib/libtar.a ../gnu/libgnu.a\
 $(LIB_ACL) $(LIB_CLOCK_GETTIME) $(LIB_EACCESS)\
 $(LIB_GETRANDOM) $(LIB_HARD_LOCALE) $(FILE_HAS_ACL_LIB) $(LIB_MBRTOWC)\
 $(LIB_SELINUX) $(LIB_SETLOCALE_NULL)
