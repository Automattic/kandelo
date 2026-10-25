# Package-declared network sessions

Packages can optionally ship offer and join procedures for activities on a
Kandelo virtual network. The network panel renders their setup forms, creates
or reuses a room, and launches the declared program. Activity selection is
optional: one invitation form can also share a plain network room. Creating
an invitation creates the room when needed. When connected, choose to keep
the room or leave it and create a replacement; leaving is available in the
same panel. Replacing a hosted room disconnects its members; programs on
the other computers keep running. New rooms suggest editable, random names such
as “Cosmic Otters,” without a fixed prefix. Activities sort alphabetically
by their displayed titles. A completed invitation opens a separate **Active
session** dialog with its metadata, members, link, **Copy link**, **Leave
session**, and **Change activity**. Kandelo attempts to copy the final link
automatically once per completed invitation; clipboard denial leaves the
selectable link and manual copy button available. Change activity returns
to setup for hosts and replaces the invitation after successful preparation. This capability belongs
to a package, independently of demo profiles. Consumers include termchat, fbDOOM, Quake, Freeciv, Netcat, and
Python/PHP directory servers, websites and databases.

Setup, invitation and active-session dialogs keep the same responsive frame
through activity selection, boot, progress and errors. Their body scrolls
independently so the header and footer remain available on short screens.
Activity descriptions and package versions are collapsed under **About this
activity**. The main view shows settings, actions and the current readiness
state. Copy confirmation, machine startup, connection status and dependency
transfers use a prominent status card outside the scrolling body. Transfers show
actual bytes received, a percentage and a progress bar. The session name
precedes the activity and status, with vertical space around status cards. Optional local-file controls and fingerprints are collapsed unless
the invitation requires the guest to choose a file.

For a joined client, **Change activity** lists only other activities
advertised by the hosting computer. The client’s current activity is omitted;
changed settings or data make an updated host offer available to join again.
The button is hidden when there are no alternatives, including while
discovery is pending. Discovery errors still appear in the active dialog. A host publishes its current activity and other
field-free, dependency-free share-only services installed by its image.
Installing a game alone does not advertise a running game. The list updates
on the existing connection; choosing an activity uses its participant form
and joins it without replacing the room. **New session** is a separate
client action that opens local hosting choices and replaces its room only
after successful preparation. A WordPress image advertises both website
and SQL access; a Quake game does not advertise other installed games. Advertising an activity does not launch it on
other computers; each participant explicitly chooses to join.

## Package contract

A versioned JSON manifest is a normal `[[runtime_files]]` member:

```toml
[[runtime_files]]
artifact = "sessions.json"
guest_path = "/usr/share/kandelo/sessions/termchat.json"
```

The build script installs it with `install_local_runtime_file`. Its source
is included in `build.toml.inputs`; the executable and manifest are resolved
as one package closure. Adding this second member moves a formerly scalar
program under its package directory in the resolver mirror. Consumers must
use the new resolver path, rather than retaining a stale scalar alias.

Image composition selects which packages' session files to install and uses
the authoritative runtime-file metadata for their paths and modes. The
canonical shell includes these packages’ declarations. These small files are eager, so
forms are available before lazy executables download. Browser code discovers
them through the running machine's VFS, not a compiled list of applications.
The shell's composition selection lives in
[`package-session-files.ts`](../images/vfs/scripts/package-session-files.ts).

See the complete examples in
[`termchat/sessions.json`](../packages/registry/termchat/sessions.json) and
[`fbdoom/sessions.json`](../packages/registry/fbdoom/sessions.json).

The `kandelo-package-sessions` manifest has `version: 1`, a package name and
package version, and arrays of `offers` and `joins`. Each offer declares:

- An identifier, title and description.
- Host setup `fields` and an optional `launch` procedure. A share-only service
  omits `launch` and requires `attachExisting: true`.
- Optional `hostRequires` paths identify images capable of hosting the offer.
- The identifier of its compatible join procedure.
- `attachExisting`, explicitly permitting sharing without launching again.
- Optional `requiresHost`, for procedures that need to run on the room’s
  hosting machine even when the hostname is implicit in a product launcher.

A join procedure declares its own title, description, participant fields and
launch procedure. A join can request `computer: "default"` to open the
standard shell client image. Host settings and participant settings are separate structures:
joining termchat does not copy the host's username. Doom's offer selects
cooperative, deathmatch or item-respawn deathmatch before starting, while its
join procedure connects a player to the room's `host` network name.

## Forms and launches

Fields have unique identifiers and one of four closed types:

| Type | Constraints |
|---|---|
| `text` | Nonempty default; explicit `maxLength` from 1 to 128; no controls |
| `integer` | Safe integer default and inclusive `min`/`max` bounds |
| `choice` | Unique named options and a valid default; each option owns a bounded list of literal arguments |
| `level` | A declared dependency, `doom-wad` or `quake-pak` format, bounded per-source level catalogs, and a valid default |

### Contextual warnings

Game-specific cautions belong in the package declaration. The UI renders
only the selected entry's warning; it does not concatenate warnings for
other menu entries or put game rules into React components. All warning
strings are optional, nonempty plain text, at most 256 characters:

- `offers[].warning`: relevant whenever that activity is selected.
- `offers[].existingWarning`: relevant only when sharing an already-running
  activity. Quake uses this to ask for its server's current data and level.
- Choice `fields[].options[].warning`: relevant only for that selected value.
- Level `fields[].levelWarnings`: warnings keyed first by declared data
  source identifier, then by a level in that source's catalog. Unknown
  sources/maps are rejected. Selecting another source or level hides the
  previous entry's warning.
- `dependencies[].sources[].warning`: relevant only for the selected data
  source. FreeDM and OpenQuartz use this for their deathmatch notes.
- `dependencies[].fileWarning`: relevant only for the local-file option.

`dependencies[].hint` is acquisition help for the file picker, rather than
a paragraph describing every possible source. It appears when choosing a
local file or when a guest must supply an unknown file. Known sources use
their selected label, acquisition link and optional warning. Their existing
`informationUrl` supplies the optional **About this data** link.

Invitations carry only the host's selected warnings in the bounded display
snapshot, plus any participant-choice warnings needed by the participant
form. All are checked against the installed procedure before Join becomes
available. Session status, errors and the effects of replacing a room remain
shared UI behavior, independent of which package is selected.

A program launch declares an absolute `executable`, absolute `cwd`, `requires` file
paths, a `surface` of `terminal` or `display`, and an `args` array. Arguments
are literals, `{ "field": "offer.name" }`, `{ "field": "join.name" }`, or
`{ "options": "offer.mode" }`. An options reference expands the selected
choice's package-owned argument list. `dependency.<id>.source` supplies a verified dependency’s known source
identifier, or `file` for an uploaded file. This lets a package-owned guest
launcher prepare downloaded data using ordinary guest tools. No preparation
commands or archive paths are accepted from an invitation. `network.host` supplies the room's
resolvable hosting-machine name. References must exist in the relevant form;
a host launch cannot reference participant-only fields.

A website join instead declares `{ "surface": "web", "host": "network.host",
"port": 8080, "path": "/" }`. `localhost` is also supported for a local
preview. Web launches cannot contain executables or arguments. The declaration
comes from the installed, digest-matched package; an invitation cannot supply
an arbitrary destination or command. Joining connects the network first,
verifies an actual HTTP response, then opens the built-in preview. It starts
no client process and no duplicate server.

The preview supports both local listeners and servers on the connected
Kandelo network. Its address field accepts paths on the current site or
`http://localhost:PORT/path`, `http://host:PORT/path`,
`http://peer-N:PORT/path`, and `http://10.89.0.N:PORT/path`.
Network HTTP travels through the same worker-owned session TCP backend as
guest sockets, with partial writes, receive backpressure, bounded responses,
timeouts and cancellation on leave. Local requests retain the existing
injected-listener bridge. Node and browser `fetchInKernel` expose the same
optional `hostname` destination; omitting it selects the local listener.
Changing destinations retires the old bridge and its listeners. Leaving the
room closes a network preview and restores the computer's original local
preview, if it had one. This uses the existing service-worker origin and
cookie handling; it does not introduce an isolated browser origin.

Program launches run as the machine's configured guest account in a fresh terminal.
Each working directory and argument is quoted as a literal shell value;
participant text is not evaluated as a shell template. An existing activity
is shared only when its package permits that operation and the host explicitly
selects it. Sharing an existing instance dispatches no terminal command.

The setup UI prepares declared dependencies and checks other required files.
Other required files are checked for presence; the application remains responsible for its
own data-format and protocol compatibility checks. Starting a replacement
activity first prepares the new data, then cancels the previous activity’s
owned terminal family. The normal configured login/shell is owned before it
can fork; the kernel worker’s job ledger follows its descendants across exec,
reparenting and sessions. Replacement waits for authoritative family exit,
worker detachment and record release, then closes that activity terminal.
This also closes programs subsequently started in that dedicated terminal.
A failed cancellation retains the job identifier for another cleanup attempt.
Other terminals and services started separately or shared as already running
are not cancelled. Device-owner checks still require those programs to quit
before launching another display consumer. Owned interactive terminals use
`timeoutMs: 0` (no deadline) and remain subject to explicit cancellation and
machine teardown. This works for raw-input games as well as terminal apps;
Ctrl+C bytes are not used to simulate process cancellation. Keeping a room
does not restart its members; guests use the new invitation to change their
activity. Choosing a network-only invitation leaves running programs alone.
A graphical program launched from a shell-only profile exposes its actual
framebuffer through the Demo view; the launch can request that view before
the program has opened the device. No framebuffer is fabricated in advance. A display launch can additionally
declare `display: "kms"`: the app mounts and measures the real KMS scanout
canvas before dispatch, then switches to it when a guest owns it. The same
launch can declare `displayScale` between 0.5 and 4, in CSS pixels per guest
pixel. Freeciv uses 1.5 for both hosting and joining, matching its demo's
bitmap presentation independently of device density. The host remeasures
an existing pane before the client selects a video mode. Omission inherits
the image's presentation preference; activity retirement and machine
replacement clear the override. This is installed launch metadata, never a
command-line argument or a preference accepted from invitation URLs. The same
evdev input source captures keyboard and wheel events over a KMS canvas
opened after a terminal-only boot. This does not create a guest display owner
or change Node’s device behavior.

## Starting levels

Doom and Quake declare a `level` host field. The picker uses the selected
source’s catalog, changing to an available level when the game data changes.
Known catalogs were inspected from the exact size/SHA-256-pinned downloads.
Doom catalogs contain 9 shareware, 36 Freedoom Phase 1, and 32 each Phase 2
and FreeDM levels. Quake contains 9 shareware, 10 LibreQuake lite and 14
OpenQuartz levels. Identifiers are displayed as map names; translated human
titles and mode-specific recommendations are not currently supplied.

For local uploads, Kandelo reads WAD or PAK directories on demand, within the
64 MiB dependency cap. It checks directory/lump bounds, recognizes Doom map
markers followed by structural lumps, and excludes Quake brush models by
requiring world/player-spawn entities. It caps directory entries, map count
and total entity text inspected. This is metadata inspection, not a claim
that arbitrary custom game data is engine-compatible. Custom ZIP uploads
are not supported; the known ZIP distributions retain their native guest
preparation path. Freeciv’s world/map setup remains in its native lobby.

A `level` field declares `dependency`, `format`, and `sources` (a source-id
to level-name-array mapping). Source catalogs must match the dependency’s
known source IDs. Valid map names are closed, bounded formats. Host and
guest validate known-source membership; uploaded bytes are inspected again
after verification before launch. Doom’s `{ "options": "offer.level" }`
expands to native `-warp` episode/map arguments; Quake’s field is a literal
argument after `+map`. An invitation cannot insert engine console commands.

Maintainers can run the shared parser against original, extracted data with:

```sh
scripts/dev-shell.sh bash -c 'cd apps/browser-demos && node --import tsx/esm ../../scripts/list-game-levels.ts doom-wad /path/to/game.wad'
```

Use `quake-pak` for a PAK. Verify the original distribution against its
declared size and SHA-256 before extraction; retain the original archive and
notices. Catalog inspection does not redistribute the data in the package.

## Invitations

Activity links retain the ordinary machine `vfs`/`profile` selection unless
the join requests the default client computer. That choice replaces `vfs`
with the standard shell image and removes `profile`, so sharing a service
does not boot another server. Links retain the network room parameters
and add a `#ks1=` fragment. This is a bounded,
canonical base64url JSON offer containing:

- Package name and version.
- SHA-256 of the installed session manifest bytes and, for new links,
  a digest of the selected join contract.
- Offer identifier and validated host settings.
- Required content identifiers, names, sizes, SHA-256 fingerprints, optional
  installed-source identifiers, and a transfer or acquisition-hint choice.
- An optional display snapshot: activity description, labeled host choices,
  participant field defaults and constraints, and dependency hints/source labels.

An invitation contains no commands, launch arguments, destination paths,
participant-entered settings or process snapshot. The display snapshot uses
closed, bounded text/integer/choice fields without executable option arguments.
It is unverified information from the link: participant controls stay disabled
and source URLs are not clickable until installed metadata is ready. Kandelo
compares exact-manifest snapshots with the installed procedure. When only
the selected join contract matches, it replaces the link’s presentation with
installed metadata before enabling Join. Commands and download authority
still come only from that procedure.
File contents travel separately over an explicit WebRTC data channel when the
host chooses to send them. Unknown versions, oversized values, invalid references and
unexpected fields fail visibly. The envelope permits at most 8 KiB of decoded
JSON; installed manifests permit 64 KiB each and a bounded catalog.

Opening an activity invitation prepares the image but defers its configured
shell auto-command and init target. The invitation preview renders before host
initialization or image activation can wait. New links show the room name,
activity description, package/version, labeled host settings, participant
controls and dependency/acquisition details before boot. Older links without
display snapshots still work; their full prompts appear after installed
metadata loads. Readiness text distinguishes waiting
for this computer, loading installed procedures, and connecting/preparing
data. Invitation details come from the untrusted link and are verified or
replaced with installed metadata before Join is enabled; the remote host is checked when
joining. The recipient supplies their
own participant settings, and clicks **Join and open**. Only after the kernel
reports the joined network and all required data has been verified and
installed does Kandelo dispatch the join command. Failed
connections do not launch it. The room token and activity fragment are removed
from the address bar after capture so unrelated Share links do not inherit
them. Ordinary network links still discard script-bearing fragments.

An activity link and a `#k1=` startup-script link are distinct link kinds;
the activity builder does not preserve or run an unrelated startup script.
Changing or stopping the machine invalidates pending activity operations.

## Declared activity data

An optional package-level `dependencies` array describes up to two files.
Each entry declares an `id`, `title`, a single-component destination under
`/tmp/`, `allowFile`, an acquisition `hint`, and up to eight known `sources`.
Each source declares an identifier, title, HTTPS URL, exact byte `size` and
`sha256`, and optionally an `installedPath` to reuse an image-provided copy. A source
can include an `informationUrl` for license/source information and
`offerDefaults` validated against the offer fields, such as deathmatch for
FreeDM or cooperative play for LibreQuake.
The launch's `requires` and literal arguments refer to the same destination.
Paths and URLs come from the digest-matched installed manifest, never from
an invitation. Temporary files are ordinary guest VFS files; they do not
become persistent browser downloads or part of the image.

The hosting form selects a known source or a local file. Known sources reuse
matching installed bytes when available, otherwise fetch and verify the
pinned download. Local files are fingerprinted. The host also chooses:

- **Send required files directly over WebRTC:** joining guests request only
  the explicitly published content, identified by its SHA-256. They can
  instead select a matching local file.
- **Send acquisition hints:** the invitation supplies the content identity
  and source identifier, not the file. Guests see the package's explanation
  and a known acquisition link. Joining downloads that known source, or
  guests select a matching local file. For uploaded content without a known
  source, the matching-file picker is required.

The host prepares data before replacing an existing room. Guests verify
size and fingerprint before installing or launching. A wrong local file
leaves the activity unlaunched and can be corrected in the same form without
rejoining the network. Package applications still validate their own file
formats and content compatibility.

The network connection declares purpose `network-activities-v1`, including
an ordered, reliable `activity-data-v1` channel separate from guest network
traffic. Transfers request one 16 KiB chunk at a time with a bounded send
buffer, a 15-second request timeout and cancellation on leave, machine
replacement or channel closure. Preparation is limited to two minutes and
64 MiB per dependency (128 MiB total). No general VFS read service is exposed:
the sender serves only bytes explicitly published for the current offer.
Creating another invitation replaces that published dependency set; leaving
or replacing the room releases it. Old files already installed in the guest
VFS remain until the machine or user removes them.

This wire-purpose change requires both pages to run the current application;
connections from older pages fail the purpose/channel compatibility check.
It does not change the guest networking protocol or kernel ABI.

## Current scope

This first version supplies procedures for the existing IPv4 virtual network
room. It does not introduce a persistent lobby, activity discovery service,
application readiness protocol, or automatic recognition of manually launched
processes. A published offer records the host's explicit setup; it does not
prove that a program has finished starting or is still running. The terminal
and application report launch failures normally.

Termchat's existing-instance option assumes its default discovery settings;
custom discovery groups are not extracted from a process or config file.
fbDOOM declares a new private two-to-four-player game. Its form offers the
pinned Episode 1 shareware WAD, Freedoom Phase 1, Freedoom Phase 2, FreeDM,
or a local IWAD picker, including when launched from a bare shell. Hosting an arbitrary already-running Doom game is not offered.
Activities whose join command targets `network.host`, or whose dependencies
need to be served by the WebRTC hub, must be offered by the room’s hosting
computer. Joined participants can keep the room to offer discovery-only
activities such as termchat, share a plain network invite, or replace the
room to host a server-based activity on their own computer.

The room still belongs to its hosting machine. Leaving or replacing that
machine ends the room. Exiting an activity leaves the network connected; its plain network link
remains usable while that room exists. Activity links record setup intent,
and peer data remains available only for the currently published offer.
Termchat’s received-file storage is unchanged. No kernel ABI change is involved.


## Activity catalog and game data

| Package | Host and guest behavior |
|---|---|
| termchat | Discovery chat and file transfer; existing-instance sharing |
| fbdoom | Cooperative/deathmatch with 2–4 players and matching IWAD data |
| tyrquake | Cooperative/deathmatch server and named players with matching game data |
| freeciv-browser-bundle | Dedicated server plus SDL2 clients; Freeciv’s native pregame lobby |
| netcat | One-to-one TCP text connection on a selected unprivileged port |
| python-browser-bundle | Python’s built-in HTTP directory server; guest Kandelo web preview |
| php | PHP’s built-in HTTP server; guest Kandelo web preview |
| nginx-vfs, nginx-php-vfs, nginx-python-vfs | Share the running website; guest Kandelo web preview |
| wordpress, lamp | Share WordPress with SQLite or MariaDB; guest Kandelo web preview. The MariaDB image also offers a WordPress MySQL connection in an interactive SQL terminal. |
| ruby-todo-vfs | Share the running todo app; guest Kandelo web preview |
| redis-vfs | Share a live voting board and phpCacheAdmin command console/key browser. PHP serves both against the same Redis database. Guest Kandelo web preview. |

Service images own their declarations, embedded by the image builder. The
standard shell carries identical client-only definitions under
`/usr/share/kandelo/session-clients`, separate from host procedures under
`/usr/share/kandelo/sessions`. Client-only entries cannot create offers.
When an image installs both copies, their bytes must match. This lets a
lightweight client resolve the invitation without advertising servers it
does not have. The gallery offers the Redis voting board and WordPress with
MariaDB; standalone MariaDB entries have been removed. The underlying database
recipes remain available for development and tests. The WordPress MySQL
activity connects the upstream MariaDB CLI to the host's existing `wordpress`
database on TCP port 3306. Its declaration explains that this temporary demo
has no database password and invitees can edit the host's database. WordPress
itself continues using its local Unix socket. The Redis
image explicitly permits unauthenticated remote commands on this virtual
network; its sockets do not expose a physical host port.

The board's **Explore Redis** link opens unmodified phpCacheAdmin 2.7.3 at
`/admin/`, initially on its command console. Its key browser, command
history and console operate on the board's real Redis database; writes
become visible when the board refreshes. The homepage link returns to the
board. Both views are available through the same activity invitation.
The Redis image installs the pinned source package's bundled Predis and
Twig archives and PHP's normal Phar extension. Configuration, templates
and archives are not public HTTP assets. Command history and metrics are
temporary guest files, and invited people can edit or delete board data,
as the activity declaration explains. Third-party notices accompany the
image under `/usr/share/licenses/phpcacheadmin`.

The bundled PHP-FPM and SMTP capture processes are internal loopback
backends, not separately exposed services. The current FFmpeg binary
includes only file and pipe protocols, so it has no network activity.

Network clients such as curl, wget, Git, ELinks, npm and Composer do not
independently define a hosted activity. The Git package omits git-daemon
and git-http-backend. Programming runtimes and socket
libraries need an application before they have meaningful offer/join
procedures. The bundled NetHack, ScummVM adventures and LÖVE games do not
supply a supported network multiplayer workflow.

Known downloads are pinned by URL, exact size and SHA-256. The browser
verifies the original bytes before transfer or installation. Downloads use
the host’s configured CORS proxy when a source cannot be fetched directly;
no invitation supplies a proxy or download authority. A display snapshot can
repeat a source URL, but it must match the installed declaration before it
becomes a clickable acquisition link or can be used by the activity.

Doom’s package-owned `doom-activity` launcher extracts the selected WAD
from the upstream [Freedoom 0.13.0 distributions](https://github.com/freedoom/freedoom/releases/tag/v0.13.0)
inside the guest, keeping the verified input at
`/tmp/kandelo-doom-data.bin` and preparing a guest-owned
`/tmp/kandelo-doom.wad`. It retains `COPYING.txt`, `CREDITS.txt` and
`CREDITS-MUSIC.txt` under `/tmp/kandelo-doom-notices`. Phase 1 and Phase 2
are standalone free campaigns; FreeDM is intended for deathmatch. These
are distinct from commercial Doom II, which has no shareware release.
Uploaded IWADs are passed to the engine for format validation. Acquisition
hints allow each player to supply a matching commercial file separately.

Quake offers the same intact `quake106.zip` distribution as the existing
Quake demo, [LibreQuake 0.09 beta’s lite release](https://github.com/lavenderdotpet/LibreQuake/releases/tag/v0.09-beta),
[OpenQuartz 2004.08.01](https://sourceforge.net/projects/openquartz/files/Open%20Quartz%20game%20content/Open%20Quartz%202004.08.01/),
or the player’s own `pak0.pak`. The package’s `quake-data` helper is reused
by the demo and activity. It extracts the original shareware inside the
machine with unzip/lha; the standalone extracted shareware PAK is not a
catalog download. LibreQuake’s release documentation and notices remain in
the extracted tree. OpenQuartz includes its original documentation/license
archive; its `informationUrl` links to the accompanying source distribution.
Activity game data lives separately under
`/tmp/kandelo-quake`; the ordinary demo’s installation is preserved.

Freeciv includes its ordinary game data in the existing lazy package. It
needs no separately purchased assets. The host starts the dedicated server
and joins it; invited players choose their own names and join the native
lobby. Game setup stays in Freeciv. Sharing without restart requires an
already-hosted multiplayer server; it does not convert a single-player game.
Custom rulesets/scenarios and automatic save-game conversion are outside
these initial procedures.

OpenQuartz supplies a `quake.rc` without TyrQuake's `stuffcmds` command, so it
would otherwise ignore `+map` and `+connect`. Its activity launcher supplies
a native `-game activity` startup-config overlay that executes those arguments.
The downloaded archive, original PAKs and accompanying license/source notices
remain unchanged.

## Invitation compatibility and discovery

New invitations carry a SHA-256 digest of the selected join contract: package
version, offer fields, dependency declarations and the selected participant
procedure, including its launch and client-computer choice. A matching contract
permits host-only title, description or warning changes without requiring
identical manifest bytes. The installed declaration remains authoritative
for launches, validation and displayed warnings. A changed client command,
port or required data still rejects the invitation. Legacy links without
this digest require an exact whole-manifest SHA-256 match. An incompatible
invitation offers **Join network only**, which connects without launching
the activity, or **Dismiss**.

The room host advertises validated offers over the reliable
`activity-offers-v1` channel of `network-activities-v2` peer connections.
Messages are limited to 16 KiB and 32 distinct offers. Clients cannot
advertise back to the host. Offers carry parameters and bounded display
metadata, never launch code. The client resolves every selection against its
installed declaration and checks that the host still advertises it before
launch. Discovery failure is shown separately from the network connection.
