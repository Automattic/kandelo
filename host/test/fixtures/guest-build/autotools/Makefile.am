ACLOCAL_AMFLAGS = -I m4
SUBDIRS = po
AM_YFLAGS = -d

noinst_LTLIBRARIES = libops.la
libops_la_SOURCES = ops.c ops.h

bin_PROGRAMS = calc
calc_SOURCES = main.c parse.y keywords.h
calc_CFLAGS = $(GREETING_CFLAGS) -DLOCALEDIR=\"$(localedir)\"
calc_LDADD = libops.la
BUILT_SOURCES = keywords.h parse.h

keywords.h: keywords.gperf
	$(GPERF) --output-file=$@ $(srcdir)/keywords.gperf

info_TEXINFOS = calc.texi

man_MANS = calc.1
calc.1: calc$(EXEEXT)
	$(HELP2MAN) --no-info --output=$@ ./calc$(EXEEXT)

TESTS = check-calc.sh
EXTRA_DIST = keywords.gperf check-calc.sh greeting.pc
CLEANFILES = keywords.h calc.1
