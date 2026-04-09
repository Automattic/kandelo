# Make GNU rmt.

# Copyright 2022-2023 Free Software Foundation, Inc.

## This program is free software; you can redistribute it and/or modify
## it under the terms of the GNU General Public License as published by
## the Free Software Foundation; either version 3, or (at your option)
## any later version.

## This program is distributed in the hope that it will be useful,
## but WITHOUT ANY WARRANTY; without even the implied warranty of
## MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
## GNU General Public License for more details.

## You should have received a copy of the GNU General Public License
## along with this program; if not, write to the Free Software
## Foundation, Inc., 51 Franklin Street, Fifth Floor, Boston, MA
## 02110-1301, USA.

rmtdir=$(DEFAULT_RMT_DIR)
rmt_PROGRAMS = @PU_RMT_PROG@
EXTRA_PROGRAMS = rmt

rmt_SOURCES = rmt.c

AM_CPPFLAGS = -I$(top_srcdir)/gnu -I../ -I../gnu -I$(top_srcdir)/lib \
  -I$(top_srcdir)/paxlib

LDADD = ../gnu/libgnu.a $(LIBINTL)

rmt_LDADD = $(LDADD) $(LIB_SETSOCKOPT)

rmt.o: ../gnu/configmake.h
