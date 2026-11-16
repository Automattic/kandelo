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

/// Run `cmd` with this process's stdin and stdout, copying its standard
/// error through to ours as it arrives and also returning it, so a caller can
/// add guidance after a failure without delaying or hiding the program's own
/// diagnostics. The exit status is 127 when it could not start.
pub fn run_passthrough_capturing_stderr(cmd: &str, args: &[String]) -> (i32, String) {
    use std::io::{Read, Write};
    let mut child = match Command::new(cmd).args(args).stderr(Stdio::piped()).spawn() {
        Ok(child) => child,
        Err(_) => return (127, String::new()),
    };
    let mut captured = Vec::new();
    if let Some(mut stderr) = child.stderr.take() {
        let mut buffer = [0u8; 8192];
        let mut ours = std::io::stderr();
        loop {
            match stderr.read(&mut buffer) {
                Ok(0) => break,
                Ok(n) => {
                    let _ = ours.write_all(&buffer[..n]);
                    captured.extend_from_slice(&buffer[..n]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
    }
    let code = match child.wait() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 1,
    };
    (code, String::from_utf8_lossy(&captured).into_owned())
}

/// Run `cmd` with this process's standard streams; its exit status, or 127
/// when it could not start.
pub fn run_passthrough(cmd: &str, args: &[String]) -> i32 {
    match Command::new(cmd).args(args).status() {
        Ok(status) => status.code().unwrap_or(1),
        Err(_) => 127,
    }
}
