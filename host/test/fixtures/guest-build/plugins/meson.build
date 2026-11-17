project('kandelo-plugins', 'c')

cc = meson.get_compiler('c')
# Kandelo's dlopen(3) loader is the SDK's libdl.
dl = cc.find_library('dl')

# export_dynamic: export the program's symbols to the modules it loads.
executable('host', 'host.c', dependencies: dl, export_dynamic: true,
  install: true)

shared_module('greet', 'plugin.c', install: true)
