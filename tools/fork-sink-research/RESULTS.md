# Fork-sink research: raw results (2026-10-02)

Raw output lines behind docs/plans/2026-10-02-fork-sinks.md. Inputs are the
read-only ljubljana corpus (see README.md). Columns are fsa's own report keys.

## Signature-level (corpus.sh)

```
git-remote-http strict exit=0 instrumented_today	8659 closure_same_rules_no_sinks	8658 instrumented_sink	8624 closed(sink)	48 
git-remote-http gate exit=0 instrumented_today	8659 closure_same_rules_no_sinks	8260 instrumented_sink	8199 closed(sink)	61 
git-remote-http equiv exit=0 instrumented_today	8659 closure_same_rules_no_sinks	8260 instrumented_sink	8199 closed(sink)	61 
git-remote-http runtime exit=0 instrumented_today	8659 closure_same_rules_no_sinks	8260 instrumented_sink	4 closed(sink)	2 
foot strict exit=0 instrumented_today	2994 closure_same_rules_no_sinks	2993 instrumented_sink	2883 closed(sink)	58 oracle_stacks	1	oracle_unsound	0	oracle_distinct_needed	8 
foot gate exit=0 instrumented_today	2994 closure_same_rules_no_sinks	2516 instrumented_sink	2368 closed(sink)	97 oracle_stacks	1	oracle_unsound	0	oracle_distinct_needed	7 
foot equiv exit=0 instrumented_today	2994 closure_same_rules_no_sinks	2516 instrumented_sink	2368 closed(sink)	97 oracle_stacks	1	oracle_unsound	0	oracle_distinct_needed	7 
foot runtime exit=0 instrumented_today	2994 closure_same_rules_no_sinks	2516 instrumented_sink	4 closed(sink)	2 oracle_stacks	1	oracle_unsound	0	oracle_distinct_needed	3 
bash strict exit=0 instrumented_today	1940 closure_same_rules_no_sinks	1939 instrumented_sink	1937 closed(sink)	10 oracle_stacks	28	oracle_unsound	0	oracle_distinct_needed	34 
bash gate exit=0 instrumented_today	1940 closure_same_rules_no_sinks	1558 instrumented_sink	1220 closed(sink)	17 oracle_stacks	28	oracle_unsound	0	oracle_distinct_needed	33 
bash equiv exit=0 instrumented_today	1940 closure_same_rules_no_sinks	1558 instrumented_sink	1220 closed(sink)	18 oracle_stacks	28	oracle_unsound	0	oracle_distinct_needed	33 
bash runtime exit=0 instrumented_today	1940 closure_same_rules_no_sinks	1558 instrumented_sink	1203 closed(sink)	22 oracle_stacks	28	oracle_unsound	0	oracle_distinct_needed	32 
git strict exit=0 instrumented_today	5293 closure_same_rules_no_sinks	5292 instrumented_sink	5106 closed(sink)	49 oracle_stacks	8	oracle_unsound	0	oracle_distinct_needed	21 
git gate exit=0 instrumented_today	5293 closure_same_rules_no_sinks	4825 instrumented_sink	4553 closed(sink)	47 oracle_stacks	8	oracle_unsound	0	oracle_distinct_needed	21 
git equiv exit=0 instrumented_today	5293 closure_same_rules_no_sinks	4825 instrumented_sink	4553 closed(sink)	47 oracle_stacks	8	oracle_unsound	0	oracle_distinct_needed	21 
git runtime exit=0 instrumented_today	5293 closure_same_rules_no_sinks	4825 instrumented_sink	4553 closed(sink)	47 oracle_stacks	8	oracle_unsound	0	oracle_distinct_needed	21 
python strict exit=0 instrumented_today	9166 closure_same_rules_no_sinks	9164 instrumented_sink	9163 closed(sink)	18 oracle_stacks	9	oracle_unsound	0	oracle_distinct_needed	38 
python gate exit=0 instrumented_today	9166 closure_same_rules_no_sinks	8695 instrumented_sink	8569 closed(sink)	17 oracle_stacks	9	oracle_unsound	0	oracle_distinct_needed	37 
python equiv exit=0 instrumented_today	9166 closure_same_rules_no_sinks	8695 instrumented_sink	8569 closed(sink)	17 oracle_stacks	9	oracle_unsound	0	oracle_distinct_needed	37 
python runtime exit=0 instrumented_today	9166 closure_same_rules_no_sinks	8695 instrumented_sink	8552 closed(sink)	27 oracle_stacks	9	oracle_unsound	0	oracle_distinct_needed	36 
ruby strict exit=0 instrumented_today	9755 closure_same_rules_no_sinks	9752 instrumented_sink	9691 closed(sink)	219 oracle_stacks	17	oracle_unsound	0	oracle_distinct_needed	57 
ruby gate exit=0 instrumented_today	9755 closure_same_rules_no_sinks	9177 instrumented_sink	8979 closed(sink)	276 oracle_stacks	17	oracle_unsound	0	oracle_distinct_needed	56 
ruby equiv exit=0 instrumented_today	9755 closure_same_rules_no_sinks	9177 instrumented_sink	8979 closed(sink)	276 oracle_stacks	17	oracle_unsound	0	oracle_distinct_needed	56 
ruby runtime exit=0 instrumented_today	9755 closure_same_rules_no_sinks	9177 instrumented_sink	8490 closed(sink)	262 oracle_stacks	17	oracle_unsound	0	oracle_distinct_needed	55 
waybar strict exit=0 instrumented_today	32946 closure_same_rules_no_sinks	32942 instrumented_sink	32764 closed(sink)	297 
waybar gate exit=0 instrumented_today	32946 closure_same_rules_no_sinks	32921 instrumented_sink	30207 closed(sink)	362 
waybar equiv exit=0 instrumented_today	32946 closure_same_rules_no_sinks	32921 instrumented_sink	30207 closed(sink)	362 
waybar runtime exit=0 instrumented_today	32946 closure_same_rules_no_sinks	32921 instrumented_sink	6 closed(sink)	4 
qtgallery strict exit=0 instrumented_today	26586 closure_same_rules_no_sinks	26434 instrumented_sink	26254 closed(sink)	137 
qtgallery gate exit=0 instrumented_today	26586 closure_same_rules_no_sinks	26420 instrumented_sink	17030 closed(sink)	116 
qtgallery equiv exit=0 instrumented_today	26586 closure_same_rules_no_sinks	26420 instrumented_sink	17030 closed(sink)	116 
qtgallery runtime exit=0 instrumented_today	26586 closure_same_rules_no_sinks	26420 instrumented_sink	7 closed(sink)	3 
php strict exit=0 instrumented_today	20369 closure_same_rules_no_sinks	20368 instrumented_sink	20354 closed(sink)	72 
php gate exit=0 instrumented_today	20369 closure_same_rules_no_sinks	20363 instrumented_sink	19796 closed(sink)	50 
php equiv exit=0 instrumented_today	20369 closure_same_rules_no_sinks	20363 instrumented_sink	19796 closed(sink)	51 
php runtime exit=0 instrumented_today	20369 closure_same_rules_no_sinks	20363 instrumented_sink	19743 closed(sink)	24 
php-fpm strict exit=0 instrumented_today	20530 closure_same_rules_no_sinks	20528 instrumented_sink	20514 closed(sink)	72 
php-fpm gate exit=0 instrumented_today	20530 closure_same_rules_no_sinks	20523 instrumented_sink	19907 closed(sink)	50 
php-fpm equiv exit=0 instrumented_today	20530 closure_same_rules_no_sinks	20523 instrumented_sink	19907 closed(sink)	51 
php-fpm runtime exit=0 instrumented_today	20530 closure_same_rules_no_sinks	20523 instrumented_sink	19853 closed(sink)	24 
quickshell strict exit=0 instrumented_today	51942 closure_same_rules_no_sinks	51775 instrumented_sink	51680 closed(sink)	95 
quickshell gate exit=0 instrumented_today	51942 closure_same_rules_no_sinks	45735 instrumented_sink	43097 closed(sink)	76 
quickshell equiv exit=0 instrumented_today	51942 closure_same_rules_no_sinks	45735 instrumented_sink	43097 closed(sink)	76 
quickshell runtime exit=0 instrumented_today	51942 closure_same_rules_no_sinks	45735 instrumented_sink	43015 closed(sink)	32 
```

## Typed: fpa plugin-v3 registry targets (corpus-typed.sh registry)

```
git-remote-http registry strict exit=0 instrumented_today	8659 closure_same_rules_no_sinks	8321 instrumented_sink	8285 closed(sink)	53 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
git-remote-http registry gate exit=0 instrumented_today	8659 closure_same_rules_no_sinks	7447 instrumented_sink	7136 closed(sink)	122 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
git-remote-http registry equiv exit=0 instrumented_today	8659 closure_same_rules_no_sinks	7447 instrumented_sink	7136 closed(sink)	122 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
git-remote-http registry runtime exit=0 instrumented_today	8659 closure_same_rules_no_sinks	7447 instrumented_sink	4 closed(sink)	2 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	1 
foot registry strict exit=0 instrumented_today	2994 closure_same_rules_no_sinks	2786 instrumented_sink	1024 closed(sink)	8 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	1	oracle_unsound	1	oracle_distinct_needed	8 
foot registry gate exit=0 instrumented_today	2994 closure_same_rules_no_sinks	1036 instrumented_sink	4 closed(sink)	2 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	1	oracle_unsound	0	oracle_distinct_needed	3 
foot registry equiv exit=0 instrumented_today	2994 closure_same_rules_no_sinks	1036 instrumented_sink	4 closed(sink)	2 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	1	oracle_unsound	0	oracle_distinct_needed	3 
foot registry runtime exit=0 instrumented_today	2994 closure_same_rules_no_sinks	1036 instrumented_sink	4 closed(sink)	2 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	1	oracle_unsound	0	oracle_distinct_needed	3 
bash registry strict exit=0 instrumented_today	1940 closure_same_rules_no_sinks	1939 instrumented_sink	1937 closed(sink)	10 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	28	oracle_unsound	0	oracle_distinct_needed	34 
bash registry gate exit=0 instrumented_today	1940 closure_same_rules_no_sinks	1558 instrumented_sink	1220 closed(sink)	17 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	28	oracle_unsound	0	oracle_distinct_needed	33 
bash registry equiv exit=0 instrumented_today	1940 closure_same_rules_no_sinks	1558 instrumented_sink	1218 closed(sink)	18 sinks_with_escape_no_catcher	3	sinks_with_escape_catcher_above	0 oracle_stacks	28	oracle_unsound	0	oracle_distinct_needed	32 
bash registry runtime exit=0 instrumented_today	1940 closure_same_rules_no_sinks	1558 instrumented_sink	1203 closed(sink)	22 sinks_with_escape_no_catcher	3	sinks_with_escape_catcher_above	18 oracle_stacks	28	oracle_unsound	0	oracle_distinct_needed	32 
git registry strict exit=0 instrumented_today	5293 closure_same_rules_no_sinks	5287 instrumented_sink	25 closed(sink)	4 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	8	oracle_unsound	0	oracle_distinct_needed	3 
git registry gate exit=0 instrumented_today	5293 closure_same_rules_no_sinks	4601 instrumented_sink	25 closed(sink)	4 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	8	oracle_unsound	0	oracle_distinct_needed	3 
git registry equiv exit=0 instrumented_today	5293 closure_same_rules_no_sinks	4601 instrumented_sink	25 closed(sink)	4 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	8	oracle_unsound	0	oracle_distinct_needed	3 
git registry runtime exit=0 instrumented_today	5293 closure_same_rules_no_sinks	4601 instrumented_sink	25 closed(sink)	4 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	8	oracle_unsound	0	oracle_distinct_needed	3 
python registry strict exit=0 instrumented_today	9166 closure_same_rules_no_sinks	9098 instrumented_sink	9097 closed(sink)	18 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	9	oracle_unsound	0	oracle_distinct_needed	38 
python registry gate exit=0 instrumented_today	9166 closure_same_rules_no_sinks	8245 instrumented_sink	8200 closed(sink)	15 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	9	oracle_unsound	0	oracle_distinct_needed	37 
python registry equiv exit=0 instrumented_today	9166 closure_same_rules_no_sinks	8245 instrumented_sink	8200 closed(sink)	15 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	9	oracle_unsound	0	oracle_distinct_needed	37 
python registry runtime exit=0 instrumented_today	9166 closure_same_rules_no_sinks	8245 instrumented_sink	8157 closed(sink)	12 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	11 oracle_stacks	9	oracle_unsound	0	oracle_distinct_needed	36 
ruby registry strict exit=0 instrumented_today	9755 closure_same_rules_no_sinks	9629 instrumented_sink	9537 closed(sink)	225 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	17	oracle_unsound	0	oracle_distinct_needed	57 
ruby registry gate exit=0 instrumented_today	9755 closure_same_rules_no_sinks	8641 instrumented_sink	8432 closed(sink)	212 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 oracle_stacks	17	oracle_unsound	0	oracle_distinct_needed	56 
ruby registry equiv exit=0 instrumented_today	9755 closure_same_rules_no_sinks	8641 instrumented_sink	8431 closed(sink)	212 sinks_with_escape_no_catcher	1	sinks_with_escape_catcher_above	0 oracle_stacks	17	oracle_unsound	0	oracle_distinct_needed	56 
ruby registry runtime exit=0 instrumented_today	9755 closure_same_rules_no_sinks	8641 instrumented_sink	7978 closed(sink)	150 sinks_with_escape_no_catcher	1	sinks_with_escape_catcher_above	147 oracle_stacks	17	oracle_unsound	0	oracle_distinct_needed	55 
quickshell registry strict exit=0 instrumented_today	108860 closure_same_rules_no_sinks	108100 instrumented_sink	107787 closed(sink)	166 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
quickshell registry gate exit=0 instrumented_today	108860 closure_same_rules_no_sinks	108097 instrumented_sink	72335 closed(sink)	28 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
quickshell registry equiv exit=0 instrumented_today	108860 closure_same_rules_no_sinks	108097 instrumented_sink	72335 closed(sink)	28 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
quickshell registry runtime exit=0 instrumented_today	108860 closure_same_rules_no_sinks	108097 instrumented_sink	72295 closed(sink)	28 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	26 
qtgallery registry strict exit=0 instrumented_today	26586 closure_same_rules_no_sinks	26122 instrumented_sink	25934 closed(sink)	141 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
qtgallery registry gate exit=0 instrumented_today	26586 closure_same_rules_no_sinks	26120 instrumented_sink	14845 closed(sink)	20 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
qtgallery registry equiv exit=0 instrumented_today	26586 closure_same_rules_no_sinks	26120 instrumented_sink	14845 closed(sink)	21 sinks_with_escape_no_catcher	1	sinks_with_escape_catcher_above	0 
qtgallery registry runtime exit=0 instrumented_today	26586 closure_same_rules_no_sinks	26120 instrumented_sink	7 closed(sink)	3 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	3 
waybar registry strict exit=0 instrumented_today	32946 closure_same_rules_no_sinks	32686 instrumented_sink	32505 closed(sink)	300 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
waybar registry gate exit=0 instrumented_today	32946 closure_same_rules_no_sinks	32667 instrumented_sink	28828 closed(sink)	127 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
waybar registry equiv exit=0 instrumented_today	32946 closure_same_rules_no_sinks	32667 instrumented_sink	28828 closed(sink)	133 sinks_with_escape_no_catcher	6	sinks_with_escape_catcher_above	0 
waybar registry runtime exit=0 instrumented_today	32946 closure_same_rules_no_sinks	32667 instrumented_sink	6 closed(sink)	4 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	4 
php registry strict exit=0 instrumented_today	20369 closure_same_rules_no_sinks	20368 instrumented_sink	20354 closed(sink)	72 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
php registry gate exit=0 instrumented_today	20369 closure_same_rules_no_sinks	20363 instrumented_sink	19796 closed(sink)	50 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
php registry equiv exit=0 instrumented_today	20369 closure_same_rules_no_sinks	20363 instrumented_sink	19796 closed(sink)	51 sinks_with_escape_no_catcher	1	sinks_with_escape_catcher_above	0 
php registry runtime exit=0 instrumented_today	20369 closure_same_rules_no_sinks	20363 instrumented_sink	19743 closed(sink)	24 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	23 
php-fpm registry strict exit=0 instrumented_today	20530 closure_same_rules_no_sinks	20528 instrumented_sink	20514 closed(sink)	72 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
php-fpm registry gate exit=0 instrumented_today	20530 closure_same_rules_no_sinks	20523 instrumented_sink	19907 closed(sink)	50 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0 
php-fpm registry equiv exit=0 instrumented_today	20530 closure_same_rules_no_sinks	20523 instrumented_sink	19907 closed(sink)	51 sinks_with_escape_no_catcher	1	sinks_with_escape_catcher_above	0 
php-fpm registry runtime exit=0 instrumented_today	20530 closure_same_rules_no_sinks	20523 instrumented_sink	19853 closed(sink)	24 sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	23 
```

## Quickshell main-direct what-if (typed link: runtime, equiv; shipped shape: runtime)

```
instrumented_today	108860
closure_same_rules_no_sinks	108097
instrumented_sink	11
closed(sink)	4
sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	4
instrumented_today	108860
closure_same_rules_no_sinks	108097
instrumented_sink	72335
closed(sink)	28
sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	0
instrumented_today	51942
closure_same_rules_no_sinks	45735
instrumented_sink	6
closed(sink)	4
sinks_with_escape_no_catcher	0	sinks_with_escape_catcher_above	4
```

## Shipped-shape sizes (sizes.py, size-set.py)

```
foot: uninstrumented code 2223173 file 3074386
  variant    functions       code       file   code+%
  today              -    3572795    4459371    60.7%
  gate            2369    3326860    4209642    49.6%
  equiv           2369    3326860    4209642    49.6%
  runtime            4    2069350    2934355    -6.9%
git: uninstrumented code 2692160 file 3219449
  variant    functions       code       file   code+%
  today              -    5462665    6035169   102.9%
  gate            4553    4995242    5564868    85.5%
  equiv           4553    4995242    5564868    85.5%
  runtime         4553    4995242    5564868    85.5%
bash: uninstrumented code 963297 file 1283909
  variant    functions       code       file   code+%
  today              -    1663824    2003381    72.7%
  gate            1220    1381200    1718280    43.4%
  equiv           1220    1381200    1718280    43.4%
  runtime         1203    1342971    1679825    39.4%
python: uninstrumented code 4654631 file 7769902
  variant    functions       code       file   code+%
  today              -    8663096   11873579    86.1%
  gate            8570    8507631   11715937    82.8%
  equiv           8570    8507631   11715937    82.8%
  runtime         8553    8490944   11699214    82.4%
quickshell: uninstrumented code 16624177 file 29412625
  variant    functions       code       file   code+%
  today              -   37963861   51370603   128.4%
  gate           43097   32602910   45975541    96.1%
  equiv          43097   32602910   45975541    96.1%
  runtime        43015   32466329   45838680    95.3%
foot floor(empty allowlist): set 0 names, 0 present in target; code 2068342 file 2933338; allowlist: activations 3001 -> 1
git floor(empty allowlist): set 0 names, 0 present in target; code 2684012 file 3227344; allowlist: activations 5293 -> 1
bash floor(empty allowlist): set 0 names, 0 present in target; code 963654 file 1292921; allowlist: activations 1940 -> 1
python floor(empty allowlist): set 0 names, 0 present in target; code 4643137 file 7783972; allowlist: activations 9172 -> 1
quickshell floor(empty allowlist): set 0 names, 0 present in target; code 16895116 file 29889747; allowlist: activations 51943 -> 1
git typed strict: set 25 names, 25 present in target; code 2690059 file 3233710; allowlist: activations 5293 -> 26
foot typed gate: set 4 names, 4 present in target; code 2069350 file 2934355; allowlist: activations 3001 -> 5
bash typed gate: set 1217 names, 1217 present in target; code 1376826 file 1713820; allowlist: activations 1940 -> 1218
python typed gate: set 8111 names, 8111 present in target; code 8345178 file 11551087; allowlist: activations 9172 -> 8112
quickshell typed gate: set 68493 names, 38084 present in target; code 31009244 file 44333304; allowlist: activations 51943 -> 38065
quickshell typed runtime: set 68453 names, 38065 present in target; code 31002532 file 44326621; allowlist: activations 51943 -> 38046
quickshell: uninstrumented code 16624177 file 29412625
  variant    functions       code       file   code+%
  runtime-md         6   16975453   29970276     2.1%
  equiv-md       43097   32602910   45975541    96.1%
  gate-md        43097   32602910   45975541    96.1%
git: uninstrumented code 2692160 file 3219449
  variant    functions       code       file   code+%
  runtime-md      4553    4995242    5564868    85.5%
bash: uninstrumented code 963297 file 1283909
  variant    functions       code       file   code+%
  runtime-md      1203    1342971    1679825    39.4%
python: uninstrumented code 4654631 file 7769902
  variant    functions       code       file   code+%
  runtime-md      8553    8490944   11699214    82.4%
```

## Witness paths

```
THROW-PATH	__wasm_posix_after_fork_child	__syscall1 -> __do_syscall_impl(long, long long, long long, long long, long long, long long, long long, int, unsigned int) -> __syscall_cp_check -> __pthread_exit -> exit -> __funcs_on_exit -> __cxx_global_array_dtor -> qs::ipc::IpcServerConnection::onReadyRead() -> __wasm_longjmp
THROW-PATH	_exit	_Exit -> __syscall1 -> __do_syscall_impl(long, long long, long long, long long, long long, long long, long long, int, unsigned int) -> __syscall_cp_check -> __pthread_exit -> exit -> __funcs_on_exit -> __cxx_global_array_dtor -> qs::ipc::IpcServerConnection::onReadyRead() -> __wasm_longjmp
THROW-PATH	vforkfd	(anonymous namespace)::QChildProcess::startProcess(void*) -> (anonymous namespace)::QChildProcess::startProcess() const -> std::__1::locale::__imp::~__imp() -> qs::ipc::IpcServerConnection::onReadyRead() -> __wasm_longjmp
THROW-PATH	QProcessPrivate::startDetached(long long*)::$_0::operator()() const	(anonymous namespace)::QChildProcess::startChild(int*) -> vforkfd -> (anonymous namespace)::QChildProcess::startProcess(void*) -> (anonymous namespace)::QChildProcess::startProcess() const -> std::__1::locale::__imp::~__imp() -> qs::ipc::IpcServerConnection::onReadyRead() -> __wasm_longjmp
THROW-PATH	_dbus_connect_exec	close -> __syscall_cp -> __syscall_cp_cancel_preflight -> __pthread_exit -> exit -> __funcs_on_exit -> __cxx_global_array_dtor -> qs::ipc::IpcServerConnection::onReadyRead() -> __wasm_longjmp
FORK-PATH	forkfd_initialize	__sigaction -> __block_all_sigs -> __syscall4 -> __do_syscall_impl(long, long long, long long, long long, long long, long long, long long, int, unsigned int) -> __syscall_cp_check -> __pthread_exit -> exit -> __funcs_on_exit -> __cxx_global_array_dtor -> qs::ipc::IpcServerConnection::onReadyRead() -> (anonymous namespace)::itanium_demangle::ReferenceType::printLeft((anonymous namespace)::itanium_demangle::OutputBuffer&) const -> main -> qs::launch::main(int, char**) -> qs::launch::runCommand(int, char**, QCoreApplication*) -> fork -> _Fork -> kernel_fork
FORK-PATH	calloc	default_malloc -> __libc_malloc_impl -> __unlock -> __syscall3 -> __do_syscall_impl(long, long long, long long, long long, long long, long long, long long, int, unsigned int) -> __syscall_cp_check -> __pthread_exit -> exit -> __funcs_on_exit -> __cxx_global_array_dtor -> qs::ipc::IpcServerConnection::onReadyRead() -> (anonymous namespace)::itanium_demangle::ReferenceType::printLeft((anonymous namespace)::itanium_demangle::OutputBuffer&) const -> main -> qs::launch::main(int, char**) -> qs::launch::runCommand(int, char**, QCoreApplication*) -> fork -> _Fork -> kernel_fork
FORK-PATH	close	__syscall_cp -> __syscall_cp_cancel_preflight -> __pthread_exit -> exit -> __funcs_on_exit -> __cxx_global_array_dtor -> qs::ipc::IpcServerConnection::onReadyRead() -> (anonymous namespace)::itanium_demangle::ReferenceType::printLeft((anonymous namespace)::itanium_demangle::OutputBuffer&) const -> main -> qs::launch::main(int, char**) -> qs::launch::runCommand(int, char**, QCoreApplication*) -> fork -> _Fork -> kernel_fork
```

## Oracle failure (typed, strict, foot)

```
ORACLE-UNSOUND	pid=101 mode=0	missing ["libc_start_main_stage2", "__libc_start_main", "_start"]
ORACLE	pid=101 mode=0	frames 8	needed 8	boundary <none: full stack>
```

## Fixtures

```
ok   sink_exit static: 2 [spawn]
ok   child_returns static: 3 [-]
ok   escape_caught equiv: 3 [-]
ok   escape_caught runtime: 2 [spawn]
ok   escape_uncaught equiv: 2 [spawn]
ok   escape_uncaught static: 3 [-]
ok   o0_slot static: 2 [spawn]
ok   o0_escape static: 3 [-]
ok   indirect_child static: 3 [-]
ok   param_child static: 2 [spawn]
ok   param_child static: 3 [-]
```
