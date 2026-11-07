fn main() -> std::process::ExitCode {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match kandelo_rustc::compiler_main(&args) {
        Ok(code) => std::process::ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(error) => {
            eprintln!("rustc: {error}");
            std::process::ExitCode::from(libc::EXIT_FAILURE as u8)
        }
    }
}
