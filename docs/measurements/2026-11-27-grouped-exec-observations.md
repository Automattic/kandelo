# Grouped exec image verification

The kernel already retains an owned image observation while it rereads the
file for binding. Grouped exec now compares those two byte slices directly
and uses the source digest already calculated by its backing binding. This
removes two image hashes and one redundant source hash per bind. The image
reread, ABI and image admission, metadata checks, source binding, and commit
revalidation remain in the same transaction.

## Desktop measurements

The baseline is develop `e58ab40d00a94313d2bb7a4cfedc8a41307137ea`.
Both kernel artifacts come from the normal SourceOnly build. The control
hash is `62caee617cf7fd3aff5b17927ba6cb96fb5f796457757160118775475fe10d1a`
and the candidate hash is
`9eaa8327abfea93bf841839f249d36678f6d42d25fdd4e9b1a97b9c16029abb8`.
Both arms used the same frozen Sway host, packaged process Worker
`9d689648579cc793d1973da7fc87aa60080e80867726e1bd5d09ab8951ed2531`
and partial shell image
`abce61e1fc4a1a942c40fbcc39426c1c41ff2bbc7710db5efb46c617800a1149`
at 2634 × 1806, DPR 2.

Each shortcut interval included three successful kernel image binds, for the
shell launched by Sway, Foot and the interactive shell launched by Foot. The
bind measure sums the three synchronous kernel calls. The fitted-prompt
measure spans the trusted input through the next full-sized terminal
background and visible prompts in all tiles.

| Engine and scope | Bind median, control → candidate | Fitted prompt median, control → candidate |
| --- | ---: | ---: |
| Installed Firefox 161, eight launches per arm in A-B-B-A order | 246.00 → 126.08 ms | 1,875.72 → 1,901.46 ms |
| Playwright WebKit, four launches per arm | 184.90 → 88.40 ms | 1,120.05 → 951.84 ms |

All arms fitted their expected prompts. Both Firefox controls and the first
Firefox candidate missed a later cursor observation. Both WebKit runs
completed the cursor checks. Machine load varied during the tests. The
binding improvement repeated in both engines. The launch measurements have
no established Firefox speedup and provide only one comparison in WebKit.

## Validation

The normal kernel build, ABI snapshot and program-digest check, and 55
native exec-target tests passed. The new native case rejects changed image
bytes with identical metadata, leaves the old target intact and accepts an
unchanged retry. The real Node C SDK fixture passed 16 grouped exec handoffs
with old live pthreads and reclamation checks.

The initial native command was missing the separately listed frozen
preparation fixture. The rerun verified all fixture hashes. The first ABI
command was missing the SDK on its path. The repository development shell
supplied the SDK and the check passed. Native Safari and the complete
benchmark suites were outside this comparison.
