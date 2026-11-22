# Pinned Node source

The normal resolver downloads and verifies the archive declared in package.toml.
Consumers stage it inside their private recipe work directories. No upstream
source or generated per-file inventory is checked into this package. Bridge
source receipts are generated from that verified tree during the build.
