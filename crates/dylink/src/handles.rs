//! `dlopen` handles, reference counts, and `dlerror` state.
//!
//! Ports `DynamicLinker`'s handle half (`host/src/dylink.ts:2594-4188`):
//! `dlopenMain`, `openLoadedLibrary`, `replayOpen`, `closeHandle`, `dlclose`,
//! `replayClose`, `dlerror`, `registerDependencyEdges` and
//! `rebuildDependencyBookkeeping`.
//!
//! Two counts, and they are not the same count:
//!
//! - a **handle reference count**, incremented by each `dlopen` of an object
//!   that already has a handle and decremented by `dlclose`; and
//! - a **dependency retain count**, one per live object that names this one as
//!   a `DT_NEEDED` or runtime-provider edge.
//!
//! An object is unloadable only when both reach zero — POSIX's rule that an
//! object stays loaded while anything still needs it.

use alloc::collections::{BTreeMap, BTreeSet};
use alloc::string::String;
use alloc::vec::Vec;

use crate::error::{DylinkError, DylinkResult};

/// `dlopen(NULL, ...)`. POSIX's `RTLD_DEFAULT` pseudo-handle for the main
/// image's global scope. Never refcounted, never closeable.
pub const MAIN_PROGRAM_HANDLE: u32 = 1;

/// The `dlopen` handle table.
#[derive(Clone, Debug)]
pub struct HandleTable {
    next_handle: u32,
    by_handle: BTreeMap<u32, String>,
    by_library: BTreeMap<String, u32>,
    references: BTreeMap<u32, u32>,
    /// `library -> number of live objects that need it`.
    dependency_retains: BTreeMap<String, u32>,
    /// Objects whose outgoing dependency edges are already counted.
    dependency_owners: BTreeSet<String>,
    last_error: Option<String>,
}

impl Default for HandleTable {
    fn default() -> Self {
        HandleTable {
            next_handle: MAIN_PROGRAM_HANDLE + 1,
            by_handle: BTreeMap::new(),
            by_library: BTreeMap::new(),
            references: BTreeMap::new(),
            dependency_retains: BTreeMap::new(),
            dependency_owners: BTreeSet::new(),
            last_error: None,
        }
    }
}

impl HandleTable {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn next_handle(&self) -> u32 {
        self.next_handle
    }

    /// Adopt a fork parent's exact allocator position.
    pub fn set_next_handle(&mut self, next: u32) -> DylinkResult<()> {
        if next <= MAIN_PROGRAM_HANDLE {
            return Err(DylinkError::HandleOutOfRange { handle: next });
        }
        self.next_handle = next;
        Ok(())
    }

    pub fn handle_for(&self, library: &str) -> Option<u32> {
        self.by_library.get(library).copied()
    }

    pub fn library_for(&self, handle: u32) -> Option<&str> {
        self.by_handle.get(&handle).map(String::as_str)
    }

    pub fn reference_count(&self, handle: u32) -> Option<u32> {
        self.references.get(&handle).copied()
    }

    pub fn dependency_retains(&self, library: &str) -> u32 {
        self.dependency_retains.get(library).copied().unwrap_or(0)
    }

    /// `dlopen` an object that is already loaded: allocate a handle, or bump
    /// the existing one's reference count.
    ///
    /// `replay_handle` pins the parent's exact handle during fork replay; a
    /// mismatch is an error rather than a silent renumbering, because the guest
    /// holds the parent's handle values in its own memory.
    pub fn open(&mut self, library: &str, replay_handle: Option<u32>) -> DylinkResult<u32> {
        if let Some(existing) = self.by_library.get(library).copied() {
            if let Some(replay) = replay_handle {
                if replay != existing {
                    return Err(DylinkError::HandleOutOfRange { handle: replay });
                }
            }
            let references = self
                .references
                .get(&existing)
                .copied()
                .filter(|count| *count > 0)
                .ok_or(DylinkError::InvalidHandle { handle: existing })?;
            let next = references
                .checked_add(1)
                .ok_or(DylinkError::HandleOutOfRange { handle: existing })?;
            self.references.insert(existing, next);
            self.last_error = None;
            return Ok(existing);
        }

        let handle = match replay_handle {
            Some(replay) => {
                if replay <= MAIN_PROGRAM_HANDLE || self.by_handle.contains_key(&replay) {
                    return Err(DylinkError::HandleOutOfRange { handle: replay });
                }
                self.next_handle = self.next_handle.max(
                    replay.checked_add(1).ok_or(DylinkError::HandleOutOfRange { handle: replay })?,
                );
                replay
            }
            None => {
                let handle = self.next_handle;
                self.next_handle = handle
                    .checked_add(1)
                    .ok_or(DylinkError::HandleOutOfRange { handle })?;
                handle
            }
        };
        self.by_handle.insert(handle, String::from(library));
        self.by_library.insert(String::from(library), handle);
        self.references.insert(handle, 1);
        self.last_error = None;
        Ok(handle)
    }

    /// The outcome of a `dlclose`.
    pub fn close(&mut self, handle: u32) -> DylinkResult<CloseOutcome> {
        if handle == MAIN_PROGRAM_HANDLE {
            self.last_error = None;
            return Ok(CloseOutcome::MainImage);
        }
        let library = self
            .by_handle
            .get(&handle)
            .cloned()
            .ok_or(DylinkError::InvalidHandle { handle })?;
        if self.by_library.get(&library) != Some(&handle) {
            return Err(DylinkError::InvalidHandle { handle });
        }
        let references = self
            .references
            .get(&handle)
            .copied()
            .filter(|count| *count > 0)
            .ok_or(DylinkError::InvalidHandle { handle })?;
        if references > 1 {
            self.references.insert(handle, references - 1);
            self.last_error = None;
            return Ok(CloseOutcome::StillReferenced { library, remaining: references - 1 });
        }
        self.by_handle.remove(&handle);
        self.by_library.remove(&library);
        self.references.remove(&handle);
        self.last_error = None;
        Ok(CloseOutcome::Released { library })
    }

    /// Recount every dependency edge from the live object closure.
    ///
    /// `edges` yields `(object, its runtime dependency names)` in
    /// dependency-first load order. Insertion order makes recursive dependency
    /// loads cheap, and the relationship stays derivable from immutable
    /// `dylink.0` metadata plus recorded provider edges.
    pub fn rebuild_dependency_edges<I, D>(&mut self, edges: I) -> DylinkResult<()>
    where
        I: IntoIterator<Item = (String, D)>,
        D: IntoIterator<Item = String>,
    {
        self.dependency_retains.clear();
        self.dependency_owners.clear();
        self.register_dependency_edges(edges)
    }

    /// Count edges for objects not yet accounted for.
    pub fn register_dependency_edges<I, D>(&mut self, edges: I) -> DylinkResult<()>
    where
        I: IntoIterator<Item = (String, D)>,
        D: IntoIterator<Item = String>,
    {
        for (owner, dependencies) in edges {
            if self.dependency_owners.contains(&owner) {
                continue;
            }
            for dependency in dependencies {
                let retains = self.dependency_retains(&dependency);
                let next = retains.checked_add(1).ok_or(DylinkError::DependencyMissing {
                    library: owner.clone(),
                    dependency: dependency.clone(),
                })?;
                self.dependency_retains.insert(dependency, next);
            }
            self.dependency_owners.insert(owner);
        }
        Ok(())
    }

    /// May this object be unloaded now?
    pub fn is_unloadable(&self, library: &str) -> bool {
        self.by_library.get(library).is_none() && self.dependency_retains(library) == 0
    }

    /// Objects with neither a live handle nor a dependency retain, in the order
    /// given. `dlclose` releases these transitively.
    pub fn unretained<'a>(&'a self, candidates: &'a [String]) -> impl Iterator<Item = &'a str> {
        candidates
            .iter()
            .filter(move |library| self.is_unloadable(library))
            .map(String::as_str)
    }

    /// Record an error for the next `dlerror()`.
    pub fn set_error(&mut self, message: impl Into<String>) {
        self.last_error = Some(message.into());
    }

    pub fn clear_error(&mut self) {
        self.last_error = None;
    }

    /// POSIX `dlerror()`: return the pending message and clear it. A second
    /// call with no intervening failure returns nothing.
    pub fn take_error(&mut self) -> Option<String> {
        self.last_error.take()
    }

    /// Live handles, for the fork archive.
    pub fn entries(&self) -> Vec<(u32, String, u32)> {
        self.by_handle
            .iter()
            .map(|(handle, library)| {
                (*handle, library.clone(), self.references.get(handle).copied().unwrap_or(0))
            })
            .collect()
    }
}

/// What `dlclose` did.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum CloseOutcome {
    /// `dlclose` of the main-image pseudo-handle. A no-op, and not an error.
    MainImage,
    /// The handle survives with a lower reference count.
    StillReferenced { library: String, remaining: u32 },
    /// The last handle reference is gone. The caller must now check dependency
    /// retains before unloading anything.
    Released { library: String },
}
