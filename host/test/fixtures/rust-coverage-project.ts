// An ordinary offline Cargo project. Profile files and counters come from
// LLVM's runtime; the fixture never supplies profile bytes or counter values.
export const rustCoverageSource = `use std::{env, fs, process::Command, thread};

#[inline(never)]
fn classify(value: i32) -> &'static str {
    if value > 0 {
        "positive"
    } else {
        "nonpositive"
    }
}

fn main() {
    let mode = env::args().nth(1).unwrap_or_else(|| "positive".into());
    match mode.as_str() {
        "positive" => println!("{}", classify(1)),
        "negative" => println!("{}", classify(-1)),
        "subprocess" => {
            let child = Command::new(env::current_exe().unwrap()).arg("negative").output().unwrap();
            assert!(child.status.success());
            print!("{}", String::from_utf8(child.stdout).unwrap());
            println!("{}", classify(1));
        }
        "threaded" => {
            let gate = std::sync::Arc::new(std::sync::Mutex::new(()));
            let threads: Vec<_> = (0..4).map(|_| {
                let gate = gate.clone();
                thread::spawn(move || {
                    for i in 0..100 {
                        // Keep the observed function's ordinary counter updates
                        // synchronized, as LLVM's default updates are not atomic.
                        let _guard = gate.lock().unwrap();
                        assert_eq!(classify(if i % 2 == 0 { 1 } else { -1 }),
                            if i % 2 == 0 { "positive" } else { "nonpositive" });
                    }
                })
            }).collect();
            for task in threads { task.join().unwrap(); }
            println!("threads-completed");
        }
        "list" => {
            let prefix = env::args().nth(2).unwrap();
            let mut names: Vec<_> = fs::read_dir("coverage-data").unwrap()
                .map(|entry| entry.unwrap().path())
                .filter(|path| path.file_name().unwrap().to_str().unwrap().starts_with(&prefix)
                    && path.extension().is_some_and(|ext| ext == "profraw"))
                .collect();
            names.sort();
            for path in names { println!("{}", path.display()); }
        }
        _ => panic!("unknown coverage mode"),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn positive() { assert_eq!(super::classify(1), "positive"); }
    #[test]
    fn nonpositive() { assert_eq!(super::classify(-1), "nonpositive"); }
}
`;
export const rustCoverageFiles = {
  'coverage-probe/Cargo.toml': `[package]
name="coverage-probe"
version="0.1.0"
edition="2024"
[workspace]
[profile.dev]
debug=2
codegen-units=1
incremental=false
`,
  'coverage-probe/src/main.rs': rustCoverageSource,
  'coverage-probe/coverage-data/.keep': '',
};
