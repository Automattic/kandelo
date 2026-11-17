ACLOCAL_AMFLAGS = -I m4

bin_PROGRAMS = host
host_SOURCES = host.c
# Export the program's symbols to the modules it loads.
host_LDFLAGS = -export-dynamic

# A dlopen module: built shared, as greet.so.
pkglib_LTLIBRARIES = greet.la
greet_la_SOURCES = plugin.c
greet_la_LDFLAGS = -module -avoid-version

# An ordinary library: built static only.
lib_LTLIBRARIES = libcounter.la
libcounter_la_SOURCES = counter.c

EXTRA_DIST = CMakeLists.txt meson.build shared-refused-cmake shared-refused-meson
