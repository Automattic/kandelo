use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::PathBuf;

use runtime_core::persistent_image::{
    DATA_BYTES, ImageBuilder, IntegrityPolicy, PositionedImageWriter,
};
use wasm_posix_shared::Errno;

struct Target {
    file: File,
    path: PathBuf,
    complete: bool,
}

impl Drop for Target {
    fn drop(&mut self) {
        if !self.complete {
            let _ = fs::remove_file(&self.path);
        }
    }
}

impl PositionedImageWriter for Target {
    fn get_size(&self) -> Result<u64, Errno> {
        self.file
            .metadata()
            .map(|metadata| metadata.len())
            .map_err(|_| Errno::EIO)
    }
    fn write_all_at(&mut self, offset: u64, bytes: &[u8]) -> Result<(), Errno> {
        self.file
            .seek(SeekFrom::Start(offset))
            .map_err(|_| Errno::EIO)?;
        self.file.write_all(bytes).map_err(|_| Errno::EIO)
    }
    fn set_size(&mut self, length: u64) -> Result<(), Errno> {
        self.file.set_len(length).map_err(|_| Errno::EIO)
    }
    fn flush(&mut self) -> Result<(), Errno> {
        self.file.sync_all().map_err(|_| Errno::EIO)
    }
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let mut arguments = std::env::args_os().skip(1);
    let source = arguments.next().ok_or("expected source VFSI path")?;
    let path = PathBuf::from(arguments.next().ok_or("expected new target path")?);
    let policy = match arguments
        .next()
        .and_then(|value| value.into_string().ok())
        .as_deref()
    {
        Some("crc32c") => IntegrityPolicy::Crc32c,
        Some("sha256") => IntegrityPolicy::Sha256,
        _ => return Err("expected crc32c or sha256 creation policy".into()),
    };
    if arguments.next().is_some() {
        return Err("unexpected argument".into());
    }
    let mut source = File::open(source)?;
    let length = source.metadata()?.len();
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)?;
    let mut target = Target {
        file,
        path,
        complete: false,
    };
    let mut builder =
        ImageBuilder::begin(length, policy, &mut target).map_err(|error| format!("{error:?}"))?;
    let mut buffer = [0; DATA_BYTES];
    let mut remaining = length;
    while remaining > 0 {
        let count = remaining.min(buffer.len() as u64) as usize;
        source.read_exact(&mut buffer[..count])?;
        let result = if buffer[..count].iter().all(|byte| *byte == 0) {
            builder.push_zeroes(count as u64)
        } else {
            builder.push(&buffer[..count])
        };
        result.map_err(|error| format!("{error:?}"))?;
        remaining -= count as u64;
    }
    let identity = builder.finish().map_err(|error| format!("{error:?}"))?;
    target.complete = true;
    let digest = identity
        .digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    println!(
        "{{\"payloadLength\":{},\"physicalLength\":{},\"identitySha256\":\"{}\"}}",
        identity.payload_length, identity.physical_length, digest
    );
    Ok(())
}
