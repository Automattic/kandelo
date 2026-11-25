# ICU

Use the installed `icu-uc`, `icu-i18n`, and `icu-io` pkg-config modules to locate the headers and libraries relative to the package directory. The package carries the static libraries and `share/icu.dat`. The native tools and their configuration are build inputs. The published install omits the legacy `icu-config` script and the `Makefile.inc` and `pkgdata.inc` build-tool fragments.
