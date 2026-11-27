# library() defaults to shared; a Kandelo program cannot be linked against
# a shared library, so Meson refuses the link with a clear message.
project('shared-refused', 'c')
counter = library('counter', 'counter.c')
executable('use-counter', 'use.c', link_with: counter)
