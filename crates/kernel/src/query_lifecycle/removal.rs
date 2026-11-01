//! Actual ordered removal effects, retained across physical cleanup waits.
//! Child reaps use the explicit table and an owned intent, never global table
//! reborrows or recursive lifecycle-registry locking.
use super::{Completion, Intent, Progress, Request};
use crate::{
    dri_release::{DriReleaseOwner, DriReleaseProgress, DriReleaseTransaction},
    process::HostIO,
    process_table::{ProcessTable, RemoveProcessResult},
};
use alloc::vec::Vec;
use wasm_posix_shared::Errno;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(super) enum RemovalDone {
    Removed,
    InitReaped { pid: u32, status: i32, signal: u32 },
}
pub(super) enum RemovalProgress {
    Pending,
    Fault,
    Complete(RemovalDone),
}
#[derive(Clone, Copy)]
enum Phase {
    Dri,
    Directories(usize),
    Files(usize),
    Framebuffer,
    Network(usize),
    Mice,
    Clipboard,
    Children(usize),
    Notice,
    Done,
}
struct Frame {
    completion: Completion,
    pid: u32,
    phase: Phase,
    dri: Option<DriReleaseTransaction>,
    child: Option<Intent>,
    attempting: bool,
}
fn result(completion: &mut Completion) -> &mut RemoveProcessResult {
    match completion {
        Completion::Removed(result) => result,
        Completion::InitReaped(reap) => &mut reap.removal,
        _ => unreachable!("removal completion"),
    }
}
impl Frame {
    /// Preserve even an internally unexpected payload. A contained frame never
    /// interprets its completion or enters another host operation.
    fn contained(completion: Completion, pid: u32) -> Self {
        Self {
            completion,
            pid,
            phase: Phase::Dri,
            dri: None,
            child: None,
            attempting: true,
        }
    }
    fn new(
        mut completion: Completion,
        owner: DriReleaseOwner,
    ) -> Result<Self, (Errno, Completion)> {
        let effects = core::mem::take(&mut result(&mut completion).dri_effects);
        let dri = match DriReleaseTransaction::new(owner, effects) {
            Ok(dri) => dri,
            Err((error, effects)) => {
                result(&mut completion).dri_effects = effects;
                return Err((error, completion));
            }
        };
        Ok(Self {
            completion,
            pid: owner.pid,
            phase: Phase::Dri,
            dri: Some(dri),
            child: None,
            attempting: false,
        })
    }
}
pub(super) struct RemovalReceiver {
    frames: Vec<Frame>,
    done: RemovalDone,
}
impl RemovalReceiver {
    pub(super) fn new(
        completion: Completion,
        owner: DriReleaseOwner,
    ) -> Result<Self, (Errno, Completion)> {
        let mut frames = Vec::new();
        if frames.try_reserve_exact(1).is_err() {
            return Err((Errno::ENOMEM, completion));
        }
        let done = match &completion {
            Completion::Removed(_) => RemovalDone::Removed,
            Completion::InitReaped(reap) => RemovalDone::InitReaped {
                pid: reap.pid,
                status: reap.exit_status,
                signal: reap.exit_signal,
            },
            _ => unreachable!("removal completion"),
        };
        frames.push(Frame::new(completion, owner)?);
        Ok(Self { frames, done })
    }
    #[cfg(test)]
    pub(super) fn held_completion(&self) -> Option<&Completion> {
        self.frames.first().map(|f| &f.completion)
    }

    pub(super) fn step(
        &mut self,
        table: &mut ProcessTable,
        host: &mut dyn HostIO,
    ) -> RemovalProgress {
        loop {
            // Reserve BEFORE a child intent can consume its process. There is
            // no arbitrary genealogy limit. Allocation refusal retains the
            // existing frames and permits explicit renewed work without replay.
            let needs_child_slot = self.frames.last().is_some_and(|frame| {
                let Phase::Children(index) = frame.phase else {
                    return false;
                };
                let removal = match &frame.completion {
                    Completion::Removed(result) => result,
                    Completion::InitReaped(reap) => &reap.removal,
                    _ => unreachable!("removal completion"),
                };
                index < removal.adopted_zombies.len()
            });
            if needs_child_slot && self.frames.try_reserve(1).is_err() {
                return RemovalProgress::Pending;
            }
            let Some(frame) = self.frames.last_mut() else {
                return RemovalProgress::Complete(self.done);
            };
            if frame.attempting {
                return RemovalProgress::Fault;
            }
            match frame.phase {
                Phase::Dri => match frame.dri.as_mut().unwrap().step(host) {
                    DriReleaseProgress::Complete => frame.phase = Phase::Directories(0),
                    DriReleaseProgress::Pending | DriReleaseProgress::Uncertain => {
                        return RemovalProgress::Pending;
                    }
                    DriReleaseProgress::Rejected(_) => return RemovalProgress::Fault,
                },
                Phase::Directories(index) => {
                    if let Some(&handle) = result(&mut frame.completion).host_dir_closes.get(index)
                    {
                        frame.attempting = true;
                        let _ = host.host_close(handle);
                        frame.attempting = false;
                        frame.phase = Phase::Directories(index + 1);
                    } else {
                        frame.phase = Phase::Files(0);
                    }
                }
                Phase::Files(index) => {
                    if let Some(&handle) = result(&mut frame.completion).host_closes.get(index) {
                        frame.attempting = true;
                        let _ = host.host_close(handle);
                        frame.attempting = false;
                        frame.phase = Phase::Files(index + 1);
                    } else {
                        frame.phase = Phase::Framebuffer;
                    }
                }
                Phase::Framebuffer => {
                    frame.attempting = true;
                    if result(&mut frame.completion).had_framebuffer_binding {
                        host.unbind_framebuffer(frame.pid as i32);
                    }
                    crate::syscalls::maybe_release_fb0(frame.pid);
                    frame.attempting = false;
                    frame.phase = Phase::Network(0);
                }
                Phase::Network(index) => {
                    if let Some(&handle) = result(&mut frame.completion).host_net_closes.get(index)
                    {
                        frame.attempting = true;
                        let _ = host.host_net_close(handle);
                        frame.attempting = false;
                        frame.phase = Phase::Network(index + 1);
                    } else {
                        frame.phase = Phase::Mice;
                    }
                }
                Phase::Mice => {
                    frame.attempting = true;
                    crate::syscalls::maybe_release_mice(frame.pid);
                    frame.attempting = false;
                    frame.phase = Phase::Clipboard;
                }
                Phase::Clipboard => {
                    frame.attempting = true;
                    crate::clipboard::release(frame.pid);
                    frame.attempting = false;
                    frame.phase = Phase::Children(0);
                }
                Phase::Children(index) => {
                    let Some(&pid) = result(&mut frame.completion).adopted_zombies.get(index)
                    else {
                        frame.phase = Phase::Notice;
                        continue;
                    };
                    if frame.child.is_none() {
                        match Intent::capture(table, Request::ReapInit { pid }) {
                            Ok(intent) => frame.child = Some(intent),
                            // Existing removal ignores failed adopted-child reaps.
                            Err(_) => {
                                frame.phase = Phase::Children(index + 1);
                                continue;
                            }
                        }
                    }
                    let generation = frame.child.as_ref().unwrap().generation;
                    frame.attempting = true;
                    let progress = frame.child.as_mut().unwrap().step(table, host);
                    frame.attempting = false;
                    match progress {
                        Ok(Progress::PendingOwned) => return RemovalProgress::Pending,
                        Ok(Progress::ProtocolFaultOwned) => return RemovalProgress::Fault,
                        Ok(Progress::Complete(completion @ Completion::InitReaped(_))) => {
                            // Advance only once: the child frame now owns every
                            // effect and must finish before its parent's notice.
                            frame.child = None;
                            frame.phase = Phase::Children(index + 1);
                            match Frame::new(completion, DriReleaseOwner { pid, generation }) {
                                Ok(child) => self.frames.push(child),
                                Err((_error, completion)) => {
                                    // Keep the actual consumed child in the
                                    // pre-reserved slot, permanently contained.
                                    self.frames.push(Frame::contained(completion, pid));
                                    return RemovalProgress::Fault;
                                }
                            }
                        }
                        Ok(Progress::Complete(completion)) => {
                            // A future/incorrect ReapInit implementation could
                            // return another owned removal. Preserve it in the
                            // slot reserved before entry, rather than dropping
                            // its device/handle obligations on this fault path.
                            frame.child = None;
                            frame.phase = Phase::Children(index + 1);
                            self.frames.push(Frame::contained(completion, pid));
                            return RemovalProgress::Fault;
                        }
                        Err(_) => {
                            frame.child = None;
                            frame.phase = Phase::Children(index + 1);
                        }
                    }
                }
                Phase::Notice => {
                    frame.attempting = true;
                    if let Completion::InitReaped(reap) = &frame.completion {
                        crate::exchange::activation::on_reaped(
                            reap.pid,
                            reap.exit_status,
                            reap.exit_signal,
                        );
                    }
                    frame.attempting = false;
                    frame.phase = Phase::Done;
                }
                Phase::Done => {
                    self.frames.pop();
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::syscalls::DriReleaseEffect;

    #[test]
    fn contained_unexpected_completion_keeps_every_owned_removal_effect() {
        let removal = RemoveProcessResult {
            had_framebuffer_binding: true,
            host_closes: alloc::vec![14],
            host_dir_closes: alloc::vec![15],
            host_net_closes: alloc::vec![16],
            dri_effects: alloc::vec![DriReleaseEffect::DestroyBo(17)],
            adopted_zombies: alloc::vec![18],
        };
        let frame = Frame::contained(Completion::Removed(removal), 19);
        assert!(frame.attempting);
        assert!(frame.dri.is_none());
        let Completion::Removed(held) = &frame.completion else {
            panic!("the actual unexpected payload must remain owned");
        };
        assert!(held.had_framebuffer_binding);
        assert_eq!(held.host_closes, [14]);
        assert_eq!(held.host_dir_closes, [15]);
        assert_eq!(held.host_net_closes, [16]);
        assert_eq!(held.dri_effects, [DriReleaseEffect::DestroyBo(17)]);
        assert_eq!(held.adopted_zombies, [18]);
    }
}
