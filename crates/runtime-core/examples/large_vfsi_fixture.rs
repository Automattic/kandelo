use std::env;
use std::fs::{self, File};
use std::io::{Seek, SeekFrom, Write};

use runtime_core::kandelo_image_write::{
    Content, ContentSource, KandeloImageConfig, KandeloImageWriter,
};
use runtime_core::vfsi_container::{self, ContainerSections};
use wasm_posix_shared::Errno;

const MIB: u64 = 1024 * 1024;
const FILE_SIZE: u64 = (1u64 << 32) - 16 * MIB;
const IMAGE_SIZE: u64 = (1u64 << 32) + 64 * MIB;
const TAIL_BYTES: u64 = 2 * MIB;

struct LargeFile;

impl ContentSource for LargeFile {
    fn read_exact_at(&self, id: u64, offset: u64, destination: &mut [u8]) -> Result<(), Errno> {
        if id != 1 {
            return Err(Errno::EIO);
        }
        destination.fill(0);
        let tail_start = FILE_SIZE - TAIL_BYTES - 13;
        if offset + destination.len() as u64 <= tail_start {
            return Ok(());
        }
        for (index, byte) in destination.iter_mut().enumerate() {
            let position = offset + index as u64;
            if (tail_start..tail_start + TAIL_BYTES).contains(&position) {
                let tail_position = position - tail_start;
                *byte = ((tail_position / 4096) ^ tail_position) as u8;
            }
        }
        Ok(())
    }
}

fn image_result<T>(result: Result<T, Errno>) -> Result<T, Box<dyn std::error::Error>> {
    result.map_err(|error| format!("{error:?}").into())
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut args = env::args_os().skip(1);
    let output = args.next().ok_or("expected output image path")?;
    let guest_program = args.next().ok_or("expected guest program path")?;
    if args.next().is_some() {
        return Err("unexpected argument".into());
    }
    let program = fs::read(guest_program)?;
    let mut writer = image_result(KandeloImageWriter::mkfs(KandeloImageConfig {
        size_bytes: IMAGE_SIZE,
        max_size_bytes: Some(IMAGE_SIZE),
        growable_to_bytes: IMAGE_SIZE,
        now_ms: wasm_posix_shared::KANDELO_REFERENCE_EPOCH_MILLIS,
    }))?;
    writer.declare_deferred_section();
    let bin = image_result(writer.mkdir(writer.root(), b"bin", 0o755))?;
    image_result(writer.create_file(
        bin,
        b"persistence-overwrite",
        0o755,
        Content::Bytes(&program),
    ))?;
    image_result(writer.create_file(writer.root(), b"state", 0o644, Content::Bytes(b"before\n")))?;
    image_result(writer.create_file(
        writer.root(),
        b"large",
        0o644,
        Content::Deferred {
            id: 1,
            len: FILE_SIZE,
        },
    ))?;
    let body = image_result(writer.finish())?;
    if body.len() <= u32::MAX as u64 || body.resident_bytes() >= 128 * MIB {
        return Err("fixture is not a bounded-memory v2 image".into());
    }
    let sections = ContainerSections {
        lazy_json: b"",
        archive_json: None,
        metadata_json: None,
        kernel_lazy: None,
    };
    let header = image_result(vfsi_container::header_for_body(
        body.len(),
        sections.flags(),
    ))?;
    let trailer = image_result(vfsi_container::trailer(&sections))?;
    let mut file = File::create(output)?;
    file.write_all(&header)?;
    let mut buffer = vec![0; MIB as usize];
    let mut offset = 0;
    while offset < body.len() {
        let count = image_result(body.read_at(&LargeFile, offset, &mut buffer))?;
        if count == 0 {
            return Err("fixture body ended early".into());
        }
        if buffer[..count].iter().any(|byte| *byte != 0) {
            file.seek(SeekFrom::Start(header.len() as u64 + offset))?;
            file.write_all(&buffer[..count])?;
        }
        offset += count as u64;
    }
    file.seek(SeekFrom::Start(header.len() as u64 + body.len()))?;
    file.write_all(&trailer)?;
    file.set_len(header.len() as u64 + body.len() + trailer.len() as u64)?;
    file.sync_all()?;
    Ok(())
}
