# Fork resume slot registration

The process continuation table dispatches typed resume thunks by activation
and function ordinal. Registration now keeps one ordinal-to-slot lookup per
activation. The native table retains the function objects. The lookup also
identifies the slots to clear on unload. Registration reserves all missing
slots in one native growth. If a native insertion rejects a thunk, the
activation stays unpublished, written slots are cleared, and the capacity
can be reused on retry.

## Desktop comparison

The change is based on develop at `e58ab40d00a94313d2bb7a4cfedc8a41307137ea`.
The desktop comparison applies it in isolation to the same frozen grouped
Sway host stack at `dffcfca5325666d5e02cacdef03d4f14893a4584` plus the
existing reviewed host changes. Both arms used the same fork initialization
kernel (`a0ac2daa12706d37f55b742316bec808716e628a0100d6bb19f740eee0af4249`)
and partial shell image
(`abce61e1fc4a1a942c40fbcc39426c1c41ff2bbc7710db5efb46c617800a1149`).

The recording-sized desktop ran at 2634 × 1806 and DPR 2. Each completed arm
recorded eight child registrations for the same Sway executable with 10,176
resume targets. The timed registration starts after resolving the thunks
and includes activation registration and insertion into the resume table.

| Browser | Control median and range | Batched median and range |
| --- | ---: | ---: |
| Installed Firefox 161 | 9.51 ms, 7.60–12.00 | 5.60 ms, 5.48–15.90 |
| Playwright WebKit | 21.91 ms, 18.96–24.32 | 4.30 ms, 3.22–5.86 |

A fresh Sway child calls native table growth once for 10,176 entries.
Previously it called growth 10,176 times. The native function insertions
still execute. Firefox's median whole Worker replay interval increased from
64.95 to 77.00 ms across these loaded runs. A second Firefox control timed
out selecting the Graphics pane. The comparison supports the registration
work reduction. End-to-end terminal launch time remains unresolved.

## Validation

The host distribution build and 38 replay, resume-catalog, activation and
process continuation tests passed. Real SDK tests of grouped fork-pool
refusal and fork-replay refusal passed in Node using the normally built
ABI-matched kernel
`62caee617cf7fd3aff5b17927ba6cb96fb5f796457757160118775475fe10d1a`.
Each fixture injected 16 failures and exercised a successful fork and
reclamation. The first SDK command selected the full fixture inventory
because the development shell filtered the probe environment. Its link
failed at an unresolved `mprotect`. The explicit targeted commands ran
the repository's unmodified fixtures.
