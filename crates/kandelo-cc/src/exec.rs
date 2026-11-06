//! Running the compiler and its tools.

use std::path::Path;
use std::process::{Command, Stdio};

pub struct RunResult {
    pub stdout: String,
    pub stderr: String,
    /// 0 on success; nonzero when the program failed, could not start, or
    /// was killed by a signal.
    pub exit_code: i32,
}

/// Run `cmd`, capturing its output.
pub fn run(cmd: &str, args: &[String], cwd: Option<&Path>) -> RunResult {
    run_without_env(cmd, args, cwd, &[])
}

/// `run`, with the named variables removed from the program's environment.
pub fn run_without_env(
    cmd: &str,
    args: &[String],
    cwd: Option<&Path>,
    removed: &[&str],
) -> RunResult {
    let mut command = Command::new(cmd);
    command.args(args).stdin(Stdio::null());
    for name in removed {
        command.env_remove(name);
    }
    if let Some(cwd) = cwd {
        command.current_dir(cwd);
    }
    match command.output() {
        Ok(output) => RunResult {
            stdout: String::from_utf8_lossy(&output.stdout).into_owned(),
            stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
            exit_code: output.status.code().unwrap_or(1),
        },
        Err(_) => RunResult {
            stdout: String::new(),
            stderr: String::new(),
            exit_code: 1,
        },
    }
}

/// Run `cmd` with this process's standard streams; its exit status, or 127
/// when it could not start.
pub fn run_passthrough(cmd: &str, args: &[String]) -> i32 {
    match Command::new(cmd).args(args).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 127,
    }
}
