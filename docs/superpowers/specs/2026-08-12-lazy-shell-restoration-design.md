# Bottle-Backed Lazy Shell Restoration Design

## Goal

Restore the canonical lightweight shell by feeding the active flat Homebrew
bottle selection into Kandelo's existing deferred-tree machinery. Rebuild and
publish only the package closure needed by the browser Node demo, then verify
that `npm install --verbose cowsay` works on GitHub Pages.

## Scope

The flat selection remains the only bottle list. The shell embeds the Bash
closure, defers the other 37 bottle trees, and uses the existing sealed lazy
activation machinery for the Homebrew bootstrap ZIP, libyaml, and Ruby. The
existing package resolver rebuilds the shell, Node image, and any directly
affected reverse-dependent VFS packages whose revisions must remain coherent.

The browser networking fix stays at the configured CORS-proxy boundary. It
forwards only header names supported by today's WordPress Playground proxy,
without npm- or Pacote-specific behavior.

Publication uses the repository's current staging, merge-candidate,
activation, and Pages workflows. This restoration does not redesign their
authority model. Changes to those workflows are limited to compatibility fixes
that an actual candidate run proves necessary.

## Acceptance

- The canonical compressed shell is smaller than 10 MiB.
- Boot fetches exactly the bootstrap ZIP, libyaml, and Ruby cohort.
- The remaining 35 Homebrew bottle trees stay pending until first use.
- A second use of a deferred tree does not download it again.
- Shell-derived images preserve the same pending registry and mirror identity.
- Browser Node installs `cowsay` through the configured HTTP proxy without a
  Pacote-header CORS preflight failure.
- The admitted package generation deploys successfully to GitHub Pages and the
  live demo passes the same checks.

## Explicitly Deferred

- compatibility for already-downloaded historical VFS images;
- browser persistence for VFS images;
- generalized publication or mirror-workflow redesign;
- broader provenance, callback-mutation, shared-buffer-alias, base-image, and
  hardlink defense-in-depth beyond the trusted package builder path; and
- exhaustive acceptance across unrelated browser products.

ABI 42 and `abi/snapshot.json` remain unchanged.
