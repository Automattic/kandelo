//! Sysfs — the synthetic `/sys` tree that describes the devices in `/dev`.
//!
//! Userspace finds devices through sysfs rather than by guessing paths:
//! libudev walks `/sys/dev/char/<major>:<minor>` to a device directory and
//! reads its `uevent`, `subsystem` link and attributes, and libdrm's Linux
//! paths resolve a DRM fd's node type and name the same way. The tree is a
//! subset of Linux's layout for the devices the kernel exposes: the DRM
//! card with its primary and render nodes, and the two evdev devices.
//! Every value comes from the same kernel state the device ioctls report.

extern crate alloc;

use alloc::format;
use alloc::string::String;
use alloc::vec::Vec;

use wasm_posix_shared::mode::{S_IFDIR, S_IFLNK, S_IFREG};
use wasm_posix_shared::{Errno, WasmStat};

use crate::fd::OpenFileDescRef;
use crate::lock::{FileId, KernelFileKind};
use crate::ofd::FileType;
use crate::process::Process;

/// Sentinel host_handle for sysfs directory OFDs.
pub const SYSFS_DIR_HANDLE: i64 = -190;

const ST_DEV: u64 = 0x52;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SysfsKind {
    Dir,
    File,
    Symlink,
}

/// One sysfs entry: a directory, a read-only attribute file with its
/// content, or a symlink with its target.
pub struct SysfsNode {
    pub kind: SysfsKind,
    pub ino: u64,
    pub content: Vec<u8>,
}

const DRM_DEVICE: &str = "/sys/devices/platform/kandelo-drm";

/// The DRM minors under the card: (name, minor).
const DRM_MINORS: [(&str, u32); 2] = [("card0", 0), ("renderD128", 128)];

/// The evdev devices: (input device index, event node minor).
const INPUT_DEVICES: [(u8, u32); 2] = [(0, 64), (1, 65)];

/// Linux's `*_MAX` for each capability bitmap in an input device's
/// `capabilities/` directory and `uevent`.
const INPUT_BITMAPS: [(&str, &str, u16, u16); 9] = [
    ("ev", "EV", 0x00, 0x1f),
    ("key", "KEY", 0x01, 0x2ff),
    ("rel", "REL", 0x02, 0x0f),
    ("abs", "ABS", 0x03, 0x3f),
    ("msc", "MSC", 0x04, 0x07),
    ("led", "LED", 0x11, 0x0f),
    ("snd", "SND", 0x12, 0x07),
    ("ff", "FF", 0x15, 0x7f),
    ("sw", "SW", 0x05, 0x10),
];

pub fn is_namespace_path(path: &[u8]) -> bool {
    path == b"/sys" || path.starts_with(b"/sys/")
}

fn input_device_path(device: u8) -> String {
    format!("/sys/devices/virtual/input/input{device}")
}

/// Print a capability bitmap as Linux's `input_print_bitmap` does: hex
/// words from the highest non-zero one down to word 0, space-separated.
/// Words are 32 bits, the width of `unsigned long` for wasm32 readers.
fn input_bitmap(device: u8, ev_type: u16, max: u16) -> String {
    let mut bytes = alloc::vec![0u8; (max as usize / 8) + 1];
    if ev_type == 0 {
        crate::input::populate_evbit(device, 0, &mut bytes);
    } else {
        let mut ev = [0u8; 4];
        crate::input::populate_evbit(device, 0, &mut ev);
        if ev[(ev_type / 8) as usize] & (1 << (ev_type % 8)) != 0 {
            crate::input::populate_evbit(device, ev_type, &mut bytes);
        }
    }
    let words: Vec<u32> = bytes
        .chunks(4)
        .map(|chunk| {
            let mut word = [0u8; 4];
            word[..chunk.len()].copy_from_slice(chunk);
            u32::from_le_bytes(word)
        })
        .collect();
    let top = words.iter().rposition(|&w| w != 0).unwrap_or(0);
    let printed: Vec<String> = words[..=top].iter().rev().map(|w| format!("{w:x}")).collect();
    printed.join(" ")
}

fn input_uevent(device: u8) -> String {
    let id = crate::input::device_id(device);
    let mut uevent = format!(
        "PRODUCT={:x}/{:x}/{:x}/{:x}\nNAME=\"{}\"\nPROP=0\n",
        id.bustype,
        id.vendor,
        id.product,
        id.version,
        crate::input::device_name(device)
    );
    let mut ev = [0u8; 4];
    crate::input::populate_evbit(device, 0, &mut ev);
    for (_, key, ev_type, max) in INPUT_BITMAPS {
        if ev_type == 0 || ev[(ev_type / 8) as usize] & (1 << (ev_type % 8)) != 0 {
            uevent.push_str(&format!("{key}={}\n", input_bitmap(device, ev_type, max)));
        }
    }
    uevent
}

/// Every sysfs entry, parents before children.
fn entries() -> Vec<(String, SysfsKind, Vec<u8>)> {
    let mut out: Vec<(String, SysfsKind, Vec<u8>)> = Vec::new();
    let mut dir = |path: &str| out.push((path.into(), SysfsKind::Dir, Vec::new()));
    for path in [
        "/sys",
        "/sys/bus",
        "/sys/bus/platform",
        "/sys/bus/platform/devices",
        "/sys/bus/platform/drivers",
        "/sys/bus/platform/drivers/kandelo-drm",
        "/sys/class",
        "/sys/class/drm",
        "/sys/class/input",
        "/sys/dev",
        "/sys/dev/block",
        "/sys/dev/char",
        "/sys/devices",
        "/sys/devices/platform",
        DRM_DEVICE,
        "/sys/devices/platform/kandelo-drm/drm",
        "/sys/devices/virtual",
        "/sys/devices/virtual/input",
    ] {
        dir(path);
    }
    let file = |out: &mut Vec<_>, path: String, content: String| {
        out.push((path, SysfsKind::File, content.into_bytes()))
    };
    let link = |out: &mut Vec<_>, path: String, target: &str| {
        out.push((path, SysfsKind::Symlink, target.as_bytes().to_vec()))
    };

    link(
        &mut out,
        "/sys/bus/platform/devices/kandelo-drm".into(),
        "../../../devices/platform/kandelo-drm",
    );
    link(
        &mut out,
        "/sys/bus/platform/drivers/kandelo-drm/kandelo-drm".into(),
        "../../../../devices/platform/kandelo-drm",
    );
    file(&mut out, format!("{DRM_DEVICE}/uevent"), "DRIVER=kandelo-drm\nMODALIAS=platform:kandelo-drm\n".into());
    file(&mut out, format!("{DRM_DEVICE}/modalias"), "platform:kandelo-drm\n".into());
    link(&mut out, format!("{DRM_DEVICE}/subsystem"), "../../../bus/platform");
    link(&mut out, format!("{DRM_DEVICE}/driver"), "../../../bus/platform/drivers/kandelo-drm");
    for (name, minor) in DRM_MINORS {
        let path = format!("{DRM_DEVICE}/drm/{name}");
        out.push((path.clone(), SysfsKind::Dir, Vec::new()));
        file(
            &mut out,
            format!("{path}/uevent"),
            format!("MAJOR=226\nMINOR={minor}\nDEVNAME=dri/{name}\nDEVTYPE=drm_minor\n"),
        );
        file(&mut out, format!("{path}/dev"), format!("226:{minor}\n"));
        link(&mut out, format!("{path}/subsystem"), "../../../../../class/drm");
        link(&mut out, format!("{path}/device"), "../../../kandelo-drm");
        let target = format!("../../devices/platform/kandelo-drm/drm/{name}");
        link(&mut out, format!("/sys/class/drm/{name}"), &target);
        link(&mut out, format!("/sys/dev/char/226:{minor}"), &target);
    }

    for (device, minor) in INPUT_DEVICES {
        let path = input_device_path(device);
        let id = crate::input::device_id(device);
        out.push((path.clone(), SysfsKind::Dir, Vec::new()));
        file(&mut out, format!("{path}/uevent"), input_uevent(device));
        file(&mut out, format!("{path}/name"), format!("{}\n", crate::input::device_name(device)));
        file(&mut out, format!("{path}/phys"), "\n".into());
        file(&mut out, format!("{path}/uniq"), "\n".into());
        file(&mut out, format!("{path}/properties"), "0\n".into());
        link(&mut out, format!("{path}/subsystem"), "../../../../class/input");
        out.push((format!("{path}/id"), SysfsKind::Dir, Vec::new()));
        for (attr, value) in [
            ("bustype", id.bustype),
            ("vendor", id.vendor),
            ("product", id.product),
            ("version", id.version),
        ] {
            file(&mut out, format!("{path}/id/{attr}"), format!("{value:04x}\n"));
        }
        out.push((format!("{path}/capabilities"), SysfsKind::Dir, Vec::new()));
        for (attr, _, ev_type, max) in INPUT_BITMAPS {
            file(
                &mut out,
                format!("{path}/capabilities/{attr}"),
                format!("{}\n", input_bitmap(device, ev_type, max)),
            );
        }
        let event = format!("event{device}");
        let event_path = format!("{path}/{event}");
        out.push((event_path.clone(), SysfsKind::Dir, Vec::new()));
        file(
            &mut out,
            format!("{event_path}/uevent"),
            format!("MAJOR=13\nMINOR={minor}\nDEVNAME=input/{event}\n"),
        );
        file(&mut out, format!("{event_path}/dev"), format!("13:{minor}\n"));
        link(&mut out, format!("{event_path}/subsystem"), "../../../../../class/input");
        link(&mut out, format!("{event_path}/device"), &format!("../../input{device}"));
        let input_target = format!("../../devices/virtual/input/input{device}");
        link(&mut out, format!("/sys/class/input/input{device}"), &input_target);
        link(&mut out, format!("/sys/class/input/{event}"), &format!("{input_target}/{event}"));
        link(&mut out, format!("/sys/dev/char/13:{minor}"), &format!("{input_target}/{event}"));
    }
    out
}

pub fn lookup(path: &[u8]) -> Option<SysfsNode> {
    entries()
        .into_iter()
        .enumerate()
        .find(|(_, (p, _, _))| p.as_bytes() == path)
        .map(|(index, (_, kind, content))| SysfsNode { kind, ino: index as u64 + 1, content })
}

/// The entries of a sysfs directory, as (name, kind, ino), or `None` when
/// `path` is not a sysfs directory.
pub fn children(path: &[u8]) -> Option<Vec<(Vec<u8>, SysfsKind, u64)>> {
    if lookup(path)?.kind != SysfsKind::Dir {
        return None;
    }
    let mut prefix = path.to_vec();
    prefix.push(b'/');
    Some(
        entries()
            .into_iter()
            .enumerate()
            .filter_map(|(index, (p, kind, _))| {
                let name = p.as_bytes().strip_prefix(prefix.as_slice())?;
                (!name.contains(&b'/')).then(|| (name.to_vec(), kind, index as u64 + 1))
            })
            .collect(),
    )
}

/// Open a sysfs entry read-only. A directory gets a listing OFD; an
/// attribute file gets a snapshot of its content, as procfs files do.
pub fn open(proc: &mut Process, path: Vec<u8>, oflags: u32) -> Result<i32, Errno> {
    use wasm_posix_shared::fd_flags::{FD_CLOEXEC, FD_CLOFORK};
    use wasm_posix_shared::flags::{
        O_CLOEXEC, O_CLOFORK, O_CREAT, O_DIRECTORY, O_EXCL, O_NOFOLLOW, O_RDWR, O_TRUNC, O_WRONLY,
    };

    let node = lookup(&path).ok_or(Errno::ENOENT)?;
    if oflags & O_CREAT != 0 && oflags & O_EXCL != 0 {
        return Err(Errno::EEXIST);
    }
    match node.kind {
        SysfsKind::Symlink => return Err(Errno::ELOOP),
        SysfsKind::Dir if oflags & (O_WRONLY | O_RDWR) != 0 => return Err(Errno::EISDIR),
        SysfsKind::File if oflags & O_DIRECTORY != 0 => return Err(Errno::ENOTDIR),
        _ if oflags & (O_WRONLY | O_RDWR) != 0 => return Err(Errno::EACCES),
        _ => {}
    }

    let creation_flags =
        O_CREAT | O_EXCL | O_TRUNC | O_CLOEXEC | O_CLOFORK | O_DIRECTORY | O_NOFOLLOW;
    let status_flags = oflags & !creation_flags;
    let mut fd_flags = 0u32;
    if oflags & O_CLOEXEC != 0 {
        fd_flags |= FD_CLOEXEC;
    }
    if oflags & O_CLOFORK != 0 {
        fd_flags |= FD_CLOFORK;
    }

    let (ofd_idx, buf_idx) = if node.kind == SysfsKind::Dir {
        let ofd_idx = proc.ofd_table.create(FileType::Directory, status_flags, SYSFS_DIR_HANDLE, path);
        proc.ofd_table.get_mut(ofd_idx).unwrap().dir_host_handle = SYSFS_DIR_HANDLE;
        (ofd_idx, None)
    } else {
        let buf_idx = crate::descriptor_backing::with_procfs_bufs(|table| {
            table.alloc(crate::descriptor_backing::ProcfsBacking::new(node.content))
        });
        let host_handle = crate::procfs::procfs_buf_handle(buf_idx);
        let ofd_idx = proc.ofd_table.create(FileType::Regular, status_flags, host_handle, path);
        proc.ofd_table.get_mut(ofd_idx).unwrap().file_id = Some(FileId::Kernel {
            kind: KernelFileKind::SysFsRegular,
            object_id: node.ino,
        });
        (ofd_idx, Some(buf_idx))
    };
    proc.fd_table.alloc(OpenFileDescRef(ofd_idx), fd_flags).inspect_err(|_| {
        proc.ofd_table.dec_ref(ofd_idx);
        if let Some(buf_idx) = buf_idx {
            crate::descriptor_backing::with_procfs_bufs(|table| table.release(buf_idx));
        }
    })
}

/// List a sysfs directory from cookie `offset`, as the procfs and devfs
/// readers do.
pub fn getdents64(path: &[u8], buf: &mut [u8], offset: i64) -> Result<(usize, i64, bool), Errno> {
    const DT_DIR: u8 = 4;
    const DT_REG: u8 = 8;
    const DT_LNK: u8 = 10;
    let dir = lookup(path).ok_or(Errno::ENOENT)?;
    let mut parent = path.to_vec();
    if let Some(pos) = parent.iter().rposition(|&b| b == b'/') {
        parent.truncate(pos.max(1));
    }
    let parent_ino = lookup(&parent).map(|node| node.ino).unwrap_or(dir.ino);
    let entries: Vec<(Vec<u8>, u8, u64)> = children(path)
        .ok_or(Errno::ENOTDIR)?
        .into_iter()
        .map(|(name, kind, ino)| {
            let d_type = match kind {
                SysfsKind::Dir => DT_DIR,
                SysfsKind::File => DT_REG,
                SysfsKind::Symlink => DT_LNK,
            };
            (name, d_type, ino)
        })
        .collect();
    crate::procfs::write_virtual_dirents64(buf, offset, dir.ino, parent_ino, &entries)
}

pub fn stat(node: &SysfsNode) -> WasmStat {
    let (mode, nlink) = match node.kind {
        SysfsKind::Dir => (S_IFDIR | 0o755, 2),
        SysfsKind::File => (S_IFREG | 0o444, 1),
        SysfsKind::Symlink => (S_IFLNK | 0o777, 1),
    };
    WasmStat {
        st_dev: ST_DEV,
        st_ino: node.ino,
        st_mode: mode,
        st_nlink: nlink,
        st_uid: 0,
        st_gid: 0,
        st_size: if node.kind == SysfsKind::Dir { 0 } else { node.content.len() as u64 },
        st_atime_sec: 0,
        st_atime_nsec: 0,
        st_mtime_sec: 0,
        st_mtime_nsec: 0,
        st_ctime_sec: 0,
        st_ctime_nsec: 0,
        _pad: 0,
        st_rdev: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn content(path: &str) -> String {
        String::from_utf8(lookup(path.as_bytes()).unwrap().content).unwrap()
    }

    #[test]
    fn every_entry_has_a_directory_parent() {
        for (path, _, _) in entries().iter().skip(1) {
            let parent = &path[..path.rfind('/').unwrap()];
            assert_eq!(lookup(parent.as_bytes()).unwrap().kind, SysfsKind::Dir, "{path}");
        }
    }

    #[test]
    fn drm_minors_describe_their_node() {
        assert_eq!(
            content("/sys/devices/platform/kandelo-drm/drm/card0/uevent"),
            "MAJOR=226\nMINOR=0\nDEVNAME=dri/card0\nDEVTYPE=drm_minor\n"
        );
        assert_eq!(content("/sys/dev/char/226:128"), "../../devices/platform/kandelo-drm/drm/renderD128");
        let names: Vec<Vec<u8>> = children(b"/sys/devices/platform/kandelo-drm/drm")
            .unwrap()
            .into_iter()
            .map(|(name, _, _)| name)
            .collect();
        assert_eq!(names, [b"card0".to_vec(), b"renderD128".to_vec()]);
    }

    #[test]
    fn input_uevent_prints_the_evdev_bitmaps_in_32_bit_words() {
        let keyboard = content("/sys/devices/virtual/input/input0/uevent");
        assert!(keyboard.starts_with("PRODUCT=6/1209/1/1\nNAME=\"wpk virtual keyboard\"\n"));
        assert!(keyboard.contains("\nEV=3\n"));
        assert!(!keyboard.contains("REL="));

        let pointer = content("/sys/devices/virtual/input/input1/uevent");
        assert!(pointer.contains("\nEV=f\n"));
        assert!(pointer.contains("\nKEY=1f0000 0 0 0 0 0 0 0 0\n"));
        assert!(pointer.contains("\nREL=140\n"));
        assert!(pointer.contains("\nABS=3\n"));
        assert_eq!(content("/sys/devices/virtual/input/input1/capabilities/sw"), "0\n");
    }

    #[test]
    fn children_lists_only_direct_entries() {
        let names: Vec<Vec<u8>> = children(b"/sys/dev/char")
            .unwrap()
            .into_iter()
            .map(|(name, _, _)| name)
            .collect();
        assert_eq!(names.len(), 4);
        assert!(children(b"/sys/dev/char/13:64").is_none());
        assert!(lookup(b"/sys/nope").is_none());
    }
}
