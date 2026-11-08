//! Real guest installation, deliberately leaving project and Cargo caches alone.
use std::{
    fs,
    io::{Read, Write},
    os::unix::fs::{symlink, MetadataExt, PermissionsExt},
    path::Path,
    process::Command,
    time::{Duration, UNIX_EPOCH},
};

const DRIVER: &str = "/usr/bin/kandelo-rustc";
const STATE: &str = "/var/lib/kandelo/sdk-upgrade";

fn stats() -> String {
    let m = fs::metadata(DRIVER).unwrap();
    format!("{} {} {} {}", m.ino(), m.len(), m.mtime(), m.mtime_nsec())
}

fn set_time() {
    let time = UNIX_EPOCH + Duration::from_secs(1_700_000_000);
    fs::File::options()
        .write(true)
        .open(DRIVER)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(time))
        .unwrap();
}

fn leb(mut n: usize) -> Vec<u8> {
    let mut result = Vec::new();
    loop {
        let byte = (n & 127) as u8;
        n >>= 7;
        result.push(byte | if n == 0 { 0 } else { 128 });
        if n == 0 {
            return result;
        }
    }
}

fn pad_old_driver(wanted: usize) {
    let mut bytes = fs::read(DRIVER).unwrap();
    assert_eq!(&bytes[..8], b"\0asm\x01\0\0\0");
    let name = b"kandelo.test.sdk-upgrade-padding";
    let difference = wanted
        .checked_sub(bytes.len())
        .expect("new driver must be larger than old driver");
    let payload = (difference.saturating_sub(10)..difference)
        .find(|n| 1 + leb(*n).len() + n == difference)
        .expect("custom-section padding size");
    assert!(payload > name.len() + 1);
    bytes.push(0);
    bytes.extend(leb(payload));
    bytes.extend(leb(name.len()));
    bytes.extend(name);
    bytes.resize(wanted, 0);
    // Integrity-bound lazy files are immutable. Convert this one to an
    // ordinary guest file BEFORE priming Cargo's baseline cache. Only a
    // benign custom section is added; original executable instructions remain.
    fs::remove_file(DRIVER).unwrap();
    fs::write(DRIVER, bytes).unwrap();
    fs::set_permissions(DRIVER, fs::Permissions::from_mode(0o755)).unwrap();
    set_time();
    fs::write(format!("{STATE}/driver-stat-before"), stats()).unwrap();
    println!("padded-old-driver: {}", stats());
}

fn install_tree(source: &Path, destination: &Path) {
    fs::create_dir_all(destination).unwrap();
    for entry in fs::read_dir(source).unwrap() {
        let entry = entry.unwrap();
        let from = entry.path();
        let to = destination.join(entry.file_name());
        let metadata = fs::symlink_metadata(&from).unwrap();
        if metadata.is_dir() {
            install_tree(&from, &to);
        } else if metadata.file_type().is_symlink() {
            if fs::symlink_metadata(&to).is_ok() {
                fs::remove_file(&to).unwrap();
            }
            symlink(fs::read_link(from).unwrap(), to).unwrap();
        } else {
            // A former public command can become a symlink (and vice versa).
            // Do not follow an obsolete alias when installing a regular file.
            // Lazy package files are integrity-bound and immutable. Package
            // installation replaces them. The baseline driver is already an
            // ordinary guest file, so copying it preserves the observed inode.
            if to != Path::new(DRIVER) && fs::symlink_metadata(&to).is_ok() {
                fs::remove_file(&to).unwrap();
            }
            if to == Path::new(DRIVER) {
                fs::copy(&from, &to).unwrap();
                fs::set_permissions(&to, fs::Permissions::from_mode(metadata.mode())).unwrap();
            } else {
                // Stage and installation share the persistent filesystem.
                // Move completed files into place rather than writing a
                // second full copy of the ~900 MiB SDK to the journal.
                fs::rename(&from, &to).unwrap();
            }
            eprintln!("installed {}", to.display());
        }
    }
}

fn upgrade() {
    let stage = format!("{STATE}/stage");
    eprintln!("extracting complete new SDK");
    assert!(Command::new("/usr/bin/unzip")
        .args(["-q", "-o", &format!("{STATE}/new-sdk.zip"), "-d", &stage])
        .status()
        .unwrap()
        .success());
    eprintln!("SDK extracted; replacing installed files");
    // Hashed old standard-library filenames must disappear during a real
    // upgrade, or rustc can correctly reject two different matching rlibs.
    fs::remove_dir_all("/usr/lib/rustlib/wasm32-unknown-kandelo-std/lib").unwrap();
    install_tree(Path::new(&stage), Path::new("/usr"));
    set_time();
    let before = fs::read_to_string(format!("{STATE}/driver-stat-before")).unwrap();
    assert_eq!(
        before,
        stats(),
        "replacement must retain actual inode, size and mtime"
    );
    let mut input = fs::File::open(format!("{stage}/bin/kandelo-rustc")).unwrap();
    let mut installed = fs::File::open(DRIVER).unwrap();
    loop {
        let mut a = [0; 65536];
        let mut b = [0; 65536];
        let n = input.read(&mut a).unwrap();
        installed.read_exact(&mut b[..n]).unwrap();
        assert_eq!(&a[..n], &b[..n], "installed new driver is unmodified");
        if n == 0 {
            break;
        }
    }
    fs::remove_dir_all(stage).unwrap();
    println!("installed-new-driver: {}", stats());
    std::io::stdout().flush().unwrap();
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    match args.get(1).map(String::as_str) {
        Some("pad") => pad_old_driver(args[2].parse().unwrap()),
        Some("install") => upgrade(),
        _ => panic!("expected pad <new-driver-size> or install"),
    }
}
