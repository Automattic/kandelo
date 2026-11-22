# Pinned upstream Node source

This source-only dependency supplies the complete Node 26.13.0 archive through
the normal resolver. Its identity must match `third_party/nodejs/sources.json`.
Consumers stage a private copy with `kandelo_package_stage_source_dependency`;
the verified source cache remains immutable.

The runtime uses the original build inputs and complete native owners. Source
availability neither selects a feature profile nor establishes runtime support.
Unused V8 engine/compiler sources in the archive are not runtime requirements.
