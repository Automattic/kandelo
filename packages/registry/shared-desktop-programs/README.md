# Shared desktop program artifacts

This opt-in package runs the formal SDK memory-group preparer on its declared
ordinary dependencies. Every prepared executable has its own deterministic
ZIP, so booting a shell does not fetch an unused graphical application. The
manifest binds each input, prepared program and archive by SHA-256 and size.
It changes neither the ordinary package outputs nor the ordinary shell's
execution mode.

The normal shell and partial shells selecting this package retain ordinary
programs at their normal guest paths and install SDK alternatives as lazy
private executables. An explicitly selected desktop root binds its implementation
to the retained ordinary executable; grouped descendants use the same selection. The embedding host must still explicitly
enable the trusted memory-group backend. An image or URL cannot grant it.
Group participants trust one another; this is not a process isolation boundary.

SFWBar links the real upstream application menu into its executable.
ScummVM uses the separate static-engine variant because grouped dynamic side
modules remain unsupported. That does not certify every engine or game.

Partial images install named packages, while the resolver builds dependencies.
Select the ordinary application/data packages too:

```sh
./run.sh partial shell shared-desktop-programs cage foot sway swaybg freeciv-browser-bundle scummvm-static curl unzip sysklogd desktop-data sfwbar bibata-cursor-theme
./run.sh browser --partial
```

Add `cage-docs sway-docs foot-docs freeciv-docs scummvm-docs` for upstream manuals.
The normal partial manifest and image are the only image outputs; prepared
program ZIPs remain package-owned lazy references. The separate historical
image-preparation tool remains available for reproducing earlier experiments.

The shell owns the Cage, Sway and Sway/SFWBar profiles. Each requests the
memory-group backend explicitly; other shell activities remain ordinary.
Normal filesystem persistence is separate from the unsupported persistent
writable shared-mapping operation. The historical separate image remains
available during migration and is not needed by the shell profiles.
