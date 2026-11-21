# ScummVM with static engines

This explicit variant uses the same source, target libraries, portability
patches and fourteen engines as `scummvm`, including SCUMM v7/v8. It selects
upstream's static engine configuration. The ordinary package continues using
lazy engine plugins. Grouped dynamic side modules are currently unsupported;
this variant does not add that missing runtime behavior.

The command is `scummvm-static`; GUI data lives in
`/usr/share/scummvm-static` so both package forms can coexist. The
`scummvm-static-play GAME` image command downloads and verifies the existing
freeware catalog through guest curl and unzip. Game data is separate from
the package. Static linking increases the executable download, compiled code
and initial image allocation; cross-browser gameplay and resource costs must
be measured before promotion.
