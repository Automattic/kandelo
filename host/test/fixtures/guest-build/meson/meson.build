project('calc', 'c', version : '1.0', default_options : ['warning_level=2'])

cc = meson.get_compiler('c')
conf = configuration_data()
conf.set_quoted('CALC_VERSION', meson.project_version())
conf.set_quoted('CALC_SYSTEM', host_machine.system())
conf.set_quoted('CALC_CPU_FAMILY', host_machine.cpu_family())
# Meson's probes compile and link against the guest SDK's sysroot.
conf.set10('HAVE_UNISTD_H', cc.has_header('unistd.h'))
conf.set10('HAVE_GETOPT', cc.has_function('getopt', prefix : '#include <unistd.h>'))
conf.set('SIZEOF_LONG', cc.sizeof('long'))
configure_file(output : 'config.h', configuration : conf)

ops = static_library('ops', 'ops.c')
calc = executable('calc', 'main.c', link_with : ops, install : true)

test('sum', calc, args : ['+', '2', '3', '5'])
test('product', calc, args : ['*', '6', '7', '42'])
test('script', find_program('check-calc.sh'), args : [calc])
