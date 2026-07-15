# Integration Batches

Integration batches let maintainers test and rebase-merge many independently
reviewable fixes together. The fixes do not need a common theme. The batch is
coherent when its validation treatment covers the union of the source changes,
its ABI effect is truthful, and every source commit remains independently
bisectable after the rebase merge.

Release-control, approval, or permission changes that define the batch's own
validation authority should remain standalone when including them would make
their validation circular. Ordinary unrelated kernel, host, package, and build
fixes may share a batch.

## Manifest Contract

A batch PR adds `.github/integration-batches/batch-<PR>.json`. The file records:

- the batch PR, exact base commit, default branch, required `rebase` merge
  method, and aggregate ABI effect;
- one validation treatment and the sorted union of required validation IDs;
- every absorbed source PR's exact same-repository head and branch;
- every commit in each source PR, mapped to one unique pre-merge batch commit
  with their shared context-free stable Git patch ID.

Example:

```json
{
  "schema_version": 1,
  "batch": {
    "pull_request": 1001,
    "base_ref": "main",
    "base_sha": "0000000000000000000000000000000000000000",
    "merge_method": "rebase",
    "abi": {
      "effect": "breaking",
      "from_version": 39,
      "to_version": 40
    },
    "validation": {
      "treatment": "abi-kernel-train",
      "required": [
        "abi-snapshot",
        "browser",
        "host-integration",
        "kernel-unit",
        "libc",
        "package-universe",
        "posix",
        "sortix"
      ]
    }
  },
  "sources": [
    {
      "pull_request": 864,
      "head_sha": "1111111111111111111111111111111111111111",
      "head_ref": "fix/fifo-named-pipes",
      "abi_effect": "breaking",
      "required_validation": [
        "abi-snapshot",
        "host-integration",
        "kernel-unit",
        "libc",
        "package-universe",
        "posix",
        "sortix"
      ],
      "commits": [
        {
          "source_sha": "1111111111111111111111111111111111111111",
          "batch_sha": "2222222222222222222222222222222222222222",
          "patch_id": "3333333333333333333333333333333333333333"
        }
      ]
    }
  ]
}
```

Allowed ABI effects are `none`, `compatible`, and `breaking`. A non-breaking
batch keeps the same ABI version. A breaking batch must increase it. The batch
effect must equal the strongest source effect. The verifier reads
`ABI_VERSION` from `base_sha` and the batch head, so the recorded versions
cannot disagree with the code. This mechanical check does not classify
semantic ABI changes; reviewers and the ordinary ABI snapshot gate still own
that decision.

Allowed validation IDs are `abi-snapshot`, `kernel-unit`, `fork-instrument`,
`host-integration`, `browser`, `browser-assets`, `libc`, `posix`, `sortix`,
`package-publish`, `package-universe`, `homebrew-pilot`, `vfs-node`,
`vfs-browser`, and `docs`. Lists are sorted and duplicate-free. Add a new ID to
the validator and this reference together when the validation contract grows.

The manifest is added after the source commits have been rebased or
cherry-picked into the batch, so its own commit can refer to their stable SHAs.
`base_sha` is the parent of the batch's first commit. Do not amend mapped batch
commits or rebase the batch after recording them; regenerate the manifest
instead.

Generate each `patch_id` from a zero-context binary diff:

```bash
git show --format= --full-index --binary --unified=0 <commit> | git patch-id --stable
```

The zero-context form identifies the lines and file metadata the commit changes
without binding the ID to nearby unchanged lines. This lets a source commit and
its rebased batch commit retain one manifest identity when only their
surrounding context moved. A non-whitespace change to an added or removed line
produces a different ID. Git patch IDs normalize whitespace, so the exact
replay and tree check below remains authoritative for every byte-level change,
including whitespace.

A context-free patch ID is an identifier, not sufficient proof that a change
was applied in the right place. For every source-to-batch mapping, the verifier
also performs a clean three-way replay of the source commit onto the mapped
batch commit's parent. The replayed tree must exactly equal the mapped batch
commit's tree. This rejects an identical textual change moved to a different
location, as well as conflict resolutions or other edits that are not the
source change rebased onto the batch history.

Receipts are append-only. A manifest-bearing PR must add exactly its own
`batch-<PR>.json` and cannot modify, delete, or add another receipt. It also
cannot change the scripts, workflows, dev shell, scope classifier, or publish
flow that supply its validation authority. Land those control-plane changes as
standalone PRs first.

## Verification And Merge

`Verify integration batch` checks the proposed batch against live GitHub state.
It fails closed unless every source PR is open, same-repository, based on the
default branch, still at the recorded head, and represented completely. The
recorded batch base must also still be the live default-branch tip. It
recomputes every context-free stable patch ID, proves every mapped commit by
clean three-way replay and exact tree equality, and rejects empty commits,
merge commits, duplicate patch identities, omitted source commits, protected
branches, or API uncertainty.

The verifier is a read-only `pull_request_target` workflow, so its definition
comes from the default branch rather than the candidate batch. It rejects fork
heads, checks out the exact untrusted head without persisting credentials, and
runs the trusted default branch's verifier and dev shell against that checkout.
This prevents a batch from weakening the check that certifies it.

The ordinary Prepare merge workflow remains the validation authority. Run the
union of the manifest's suites, obtain `merge-gate=success` on the exact batch
head, and rebase-merge the batch. Do not squash or create a merge commit.

## Closing Absorbed PRs

After the batch merges, dispatch `Finalize integration batch` from the default
branch with its PR number. The default `dry-run` mode only prints the plan.

Before either planning or applying, the finalizer freshly proves that:

- the batch PR merged from this repository into the default branch;
- its complete original commit sequence maps in order to one contiguous linear
  sequence ending at GitHub's recorded merge SHA;
- every corresponding original and landed commit has both the same context-free
  stable patch ID and exact tree, and the final landed tree equals the reviewed
  batch head;
- the original and landed sequences both start at the manifest's exact base,
  which is also the batch head's merge base;
- the immutable manifest in the original head, landed sequence, and current
  default branch is byte-identical;
- the exact original batch head's latest `merge-gate` status is successful;
- every source PR still has its recorded head and complete commit list;
- every source mapping and branch remains exact and unprotected;
- no recorded source branch is also the head of another open pull request;
- the default branch did not advance during verification.

In `apply` mode, the workflow rechecks each source immediately before mutation.
It deletes a present source branch with Git's exact-SHA `force-with-lease`, then
closes the unmerged source PR. An absent branch or already-closed PR is accepted
only during post-merge finalization, which makes a partially completed run safe
to resume. Fork branches, changed heads, protected/default branches, merged
source PRs, ambiguous patch IDs, unexpected API data, and network uncertainty
remain hard failures.

The finalizer never merges the batch, changes its manifest, rewrites commits,
or claims that a listed validation suite ran. The merge gate supplies that
evidence; the manifest records which evidence the batch was required to earn.
