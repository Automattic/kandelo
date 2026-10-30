# Desktop panel integration

The shell image source wires SFWBar 1.0_beta17 into the Sway and Labwc
profiles. Its source configuration provides an application menu, a window
task list and a clock. Normal package/image builds and rendered session
validation are still required before claiming this panel works on Kandelo.

The `sfwbar` package owns its executable, loadable `appmenu.so`, panel and
window-operation configuration, a Sway configuration wrapper, the terminal
launcher and three application entries. All are lazy files from the same
resolver package closure. The shell image installs them at the guest paths
in the package manifest. Programs and the terminal script are executable;
configuration, application entries and the loadable module are mode 0644.

Sway selects `/etc/xdg/sfwbar/sway.config`. That wrapper includes the
existing `/usr/share/kandelo/sway/config`, preserving its readable fonts,
startup and keyboard bindings, then replaces the existing bar command.
Sway owns that bar process through its normal bar lifecycle.

Labwc's upstream `-s` option parses a command without invoking a shell.
Its profile explicitly starts `/bin/sh -c` to background the panel and exec
the configured foot terminal. Both are normal Wayland clients; compositor
shutdown and client cleanup must be checked through the normal runtime.
The terminal launcher selects the actual Sway or Labwc foot configuration.
Application entries target installed executables, including the native
`wlpaint` client rather than the `wayland-demo` package name.

Focused image-contract tests check the composed image's lazy file paths,
modes, package ownership and application executable targets. They do not
establish GTK module loading, rendered menu/task-list behavior, process
cleanup or performance. Those remain normal consumer-validation gates.
