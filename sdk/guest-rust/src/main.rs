fn main() -> std::process::ExitCode {
    let mut arguments = std::env::args();
    let executable = arguments.next().unwrap_or_else(|| "rustc".into());
    let tool = std::path::Path::new(&executable)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("rustc");
    let args = arguments.collect::<Vec<_>>();
    match kandelo_rustc::tool_main(tool, &args) {
        Ok(code) => std::process::ExitCode::from(u8::try_from(code).unwrap_or(1)),
        Err(error) => {
            eprintln!("{tool}: {error}");
            std::process::ExitCode::from(libc::EXIT_FAILURE as u8)
        }
    }
}
