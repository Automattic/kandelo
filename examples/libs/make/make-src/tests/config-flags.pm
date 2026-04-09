# This is a -*-perl-*- script
#
# Set variables that were defined by configure, in case we need them
# during the tests.

%CONFIG_FLAGS = (
    AM_LDFLAGS      => '',
    AR              => 'wasm32posix-ar',
    CC              => 'wasm32posix-cc',
    CFLAGS          => '-DMK_OS_ZOS',
    CPP             => 'wasm32posix-cc -E',
    CPPFLAGS        => '',
    GUILE_CFLAGS    => '',
    GUILE_LIBS      => '',
    LDFLAGS         => '',
    LIBS            => '',
    USE_SYSTEM_GLOB => 'no'
);

1;
