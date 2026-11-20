project('kandelo-plugins', 'c')

dl = dependency('dl')

# export_dynamic: export the program's symbols to the modules it loads.
executable('host', 'host.c', dependencies: dl, export_dynamic: true,
  install: true)

shared_module('greet', 'plugin.c', install: true)
