# Integration Batch Manifests

Each `batch-<PR>.json` file is an immutable receipt for one integration batch.
The batch may contain unrelated fixes. What it must share is one declared
validation treatment whose required suites are the union of every absorbed
source PR's requirements.

Receipts are append-only. A batch PR adds exactly its own receipt and cannot
change the validation authority that verifies it.

See [`docs/integration-batches.md`](../../docs/integration-batches.md) for the
manifest schema and maintainer workflow.
