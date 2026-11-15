#!/bin/sh
# The executable Meson built, run by a test script Meson found.
test "$("$1" + 40 2)" = 42
