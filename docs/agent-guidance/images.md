# Filesystem Image Contract

Read [Kandelo's filesystem layout](../filesystem-layout.md) before changing
an image builder, package runtime-file destination, archive mount prefix,
service path, or rootfs manifest. Kandelo-provided images follow FHS 3.0.
Debian and FreeBSD layouts are reference points for ambiguous placements,
not authorities over Kandelo's policy. Record the reason for a new placement
in the layout document rather than copying a neighboring recipe's accident.

- Give each command one canonical location. Essential user commands belong
  in `/bin`, other user commands in `/usr/bin`, boot/recovery administration
  in `/sbin`, other administration in `/usr/sbin`. Do not mirror command
  lists across these directories or merge `/bin` into `/usr/bin`.
- Reserve `/usr/local` for the machine administrator. Kandelo's distribution
  packages, wrappers and demo helpers are shipped software, even when small
  or written in shell; they must not install there.
- Put private executable helpers in `/usr/libexec`, libraries in `/usr/lib`,
  static portable data in `/usr/share`, configuration in `/etc`, served
  site data in `/srv`, mutable application state in `/var/lib`, logs in
  `/var/log`, caches in `/var/cache` and transient state in `/run`.
- Keep `/usr` usable read-only. Writable test work trees and generated
  application state do not belong beside installed executables or static data.
- Preserve the core image's account databases and supplementary groups when
  adding services. `maker` inherits sudo access through `wheel`; a service
  image must not replace that foundation with a smaller account/group list.
- Update every consumer of a moved path: compiled prefixes, archive members,
  manifests, lazy specs, provenance, service definitions, launchers, demo and
  session metadata, suite runners, tests and current reference docs.
- Preserve lazy loading, file permissions, ownership and program-original
  identity. A presentation alias or a post-boot host fix is not an image fix.
- Add new builder inputs to the affected recipes and bump revisions when
  output bytes change. Build through the normal resolver, including affected
  dormant images. Run `scripts/check-image-layout.ts` on built products;
  the automated audit catches common mistakes but is not a complete FHS
  conformance proof. Also boot and exercise changed paths on both hosts.

See [packages and builds](packages-and-builds.md) and
[browser and user behavior](browser-and-user.md) for the remaining contracts.
