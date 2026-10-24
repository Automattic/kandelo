//! Opt-in diagnostics for long native transforms; never part of artifact data.

use std::{fmt, time::Instant};

pub(crate) struct Progress {
    enabled: bool,
    phase: &'static str,
    started: Instant,
}

impl Progress {
    pub(crate) fn new(phase: &'static str) -> Self {
        Self {
            enabled: std::env::var_os("WPK_FORK_PROGRESS").is_some_and(|v| v == "1"),
            phase,
            started: Instant::now(),
        }
    }

    pub(crate) fn note(&self, message: fmt::Arguments<'_>) {
        if self.enabled {
            eprintln!(
                "[native {} +{:.1}s] {message}",
                self.phase,
                self.started.elapsed().as_secs_f64(),
            );
        }
    }

    pub(crate) fn enabled(&self) -> bool {
        self.enabled
    }
}
