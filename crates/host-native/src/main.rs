//! Dedicated kernel and guest threads, using the same shared mailbox as the
//! JavaScript hosts. This runner serves the capabilities exercised by the
//! smoke fixture. Reaching any other import fails the run.

use anyhow::{Context, Result, bail, ensure};
use runtime_core::kandelo_image_write::{
    Content, KandeloImageConfig, KandeloImageWriter, NoContent,
};
use runtime_core::vfsi_container::{self, ContainerSections};
use std::env;
use std::path::Path;
use std::sync::atomic::{AtomicU8, AtomicU32, Ordering};
use std::thread;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use wasm_posix_shared::process_memory;

use wasm_posix_shared::{
    ABI_VERSION, ChannelStatus, Errno, Syscall,
    abi::{
        HOST_ADAPTER_MANIFEST_MAGIC, HOST_ADAPTER_MANIFEST_SIZE, HOST_ADAPTER_VERSION,
        HostAdapterManifest, extended_syscalls,
    },
    channel::*,
    clock, wait_completion_wire as wait,
};
use wasmtime::{
    Caller, Config, Engine, ExternType, Global, GlobalType, Linker, Module, Mutability,
    SharedMemory, Store, Val, ValType,
};

const PAGE_BYTES: usize = process_memory::WASM_PAGE_SIZE as usize;
const LIMIT: Duration = Duration::from_secs(10);

fn main() -> Result<()> {
    let args: Vec<_> = env::args_os().skip(1).collect();
    match args.as_slice() {
        [command, path] if command == "image" => {
            let mut writer = KandeloImageWriter::mkfs(KandeloImageConfig::fixed(2 * 1024 * 1024))
                .map_err(|e| anyhow::anyhow!("create smoke image: {e:?}"))?;
            writer
                .create_file(writer.root(), b"probe", 0o644, Content::Bytes(b"kandelo\n"))
                .map_err(|e| anyhow::anyhow!("write smoke image: {e:?}"))?;
            writer
                .declare_deferred_section()
                .map_err(|e| anyhow::anyhow!("mark smoke image without deferred files: {e:?}"))?;
            let body = writer
                .finish()
                .and_then(|image| image.to_vec(&NoContent))
                .map_err(|e| anyhow::anyhow!("serialize smoke image: {e:?}"))?;
            let image = vfsi_container::wrap(
                &body,
                &ContainerSections {
                    lazy_json: b"",
                    archive_json: None,
                    metadata_json: None,
                    kernel_lazy: None,
                },
            )
            .map_err(|e| anyhow::anyhow!("wrap smoke image: {e:?}"))?;
            std::fs::write(path, image)?;
        }
        [command, kernel, image, guest] if command == "run" => {
            let parked = run(Path::new(kernel), &std::fs::read(image)?, Path::new(guest))?;
            ensure!(
                parked > 0,
                "fixture completed without exercising kernel-owned parking"
            );
            println!("Wasmtime guest exited successfully after {parked} kernel-owned wait(s)");
        }
        _ => bail!(
            "usage: host-native image <rootfs.vfs> | run <kernel.wasm> <rootfs.vfs> <guest.wasm>"
        ),
    }
    Ok(())
}

fn wasm_memory(module: &Module) -> Result<wasmtime::MemoryType> {
    module
        .imports()
        .find_map(|import| match import.ty() {
            ExternType::Memory(memory) if import.module() == "env" && import.name() == "memory" => {
                Some(memory)
            }
            _ => None,
        })
        .context("missing env.memory import")
}

/// Access the engine's shared bytes without producing slices that promise
/// exclusive access. The kernel runs serially, and the guest does not touch
/// request or result bytes while it has yielded the channel to the pump.
fn read(memory: &SharedMemory, addr: u64, size: usize) -> Result<Vec<u8>> {
    let range = memory_range(memory, addr, size).context("shared memory read out of range")?;
    Ok(range
        .iter()
        .map(|byte| unsafe { AtomicU8::from_ptr(byte.get()).load(Ordering::Relaxed) })
        .collect())
}

fn write(memory: &SharedMemory, addr: u64, bytes: &[u8]) -> Result<()> {
    let range =
        memory_range(memory, addr, bytes.len()).context("shared memory write out of range")?;
    for (dst, &value) in range.iter().zip(bytes) {
        unsafe { AtomicU8::from_ptr(dst.get()).store(value, Ordering::Relaxed) };
    }
    Ok(())
}

fn memory_range(
    memory: &SharedMemory,
    addr: u64,
    size: usize,
) -> Option<&[std::cell::UnsafeCell<u8>]> {
    let start = usize::try_from(addr).ok()?;
    memory.data().get(start..start.checked_add(size)?)
}

fn atomic_status(memory: &SharedMemory, channel: u64) -> &AtomicU32 {
    // SAFETY: the channel starts on a Wasm page. Its status word is aligned
    // and always accessed atomically, including in the guest's libc.
    let byte = &memory.data()[channel as usize + STATUS_OFFSET];
    unsafe { AtomicU32::from_ptr(byte.get().cast()) }
}

struct KernelHost {
    memory: SharedMemory,
    guest: SharedMemory,
    image: Vec<u8>,
    process: u32,
    clock_start: Instant,
}

fn link_kernel(
    engine: &Engine,
    module: &Module,
    store: &mut Store<KernelHost>,
) -> Result<wasmtime::Instance> {
    let mut linker = Linker::new(engine);
    let memory = store.data().memory.clone();
    linker.define(&mut *store, "env", "memory", memory)?;
    linker.func_wrap("env", "host_is_thread_worker", || -> i32 { 0 })?;
    linker.func_wrap(
        "env",
        "host_image_read",
        |caller: Caller<'_, KernelHost>, ptr: u32, len: u32, lo: u32, hi: u32| -> i32 {
            let host = caller.data();
            let offset = (u64::from(hi) << 32) | u64::from(lo);
            let Ok(start) = usize::try_from(offset) else {
                return 0;
            };
            let bytes = host.image.get(start..).unwrap_or_default();
            let bytes = &bytes[..bytes.len().min(len as usize)];
            match write(&host.memory, u64::from(ptr), bytes) {
                Ok(()) => bytes.len() as i32,
                Err(_) => -(Errno::EFAULT as i32),
            }
        },
    )?;
    linker.func_wrap(
        "env",
        "host_clock_gettime",
        |caller: Caller<'_, KernelHost>, id: u32, sec: u32, nsec: u32| -> i32 {
            let host = caller.data();
            let elapsed = match id {
                clock::CLOCK_REALTIME => match SystemTime::now().duration_since(UNIX_EPOCH) {
                    Ok(elapsed) => elapsed,
                    Err(_) => return -(Errno::EOVERFLOW as i32),
                },
                clock::CLOCK_MONOTONIC => host.clock_start.elapsed(),
                _ => return -(Errno::EINVAL as i32),
            };
            if write(
                &host.memory,
                u64::from(sec),
                &(elapsed.as_secs() as i64).to_le_bytes(),
            )
            .is_err()
                || write(
                    &host.memory,
                    u64::from(nsec),
                    &i64::from(elapsed.subsec_nanos()).to_le_bytes(),
                )
                .is_err()
            {
                return -(Errno::EFAULT as i32);
            }
            0
        },
    )?;
    linker.func_wrap(
        "env",
        "host_proc_validate_range",
        |caller: Caller<'_, KernelHost>, pid: u32, addr: u64, len: u32| -> i32 {
            let host = caller.data();
            if pid != host.process || memory_range(&host.guest, addr, len as usize).is_none() {
                return -(Errno::EFAULT as i32);
            }
            0
        },
    )?;
    for (name, read_guest) in [
        ("host_proc_read_bytes", true),
        ("host_proc_write_bytes", false),
    ] {
        linker.func_wrap(
            "env",
            name,
            move |caller: Caller<'_, KernelHost>, pid: u32, addr: u64, ptr: u32, len: u32| -> i32 {
                let host = caller.data();
                if pid != host.process {
                    return -(Errno::ESRCH as i32);
                }
                let (from, from_addr, to, to_addr) = if read_guest {
                    (&host.guest, addr, &host.memory, u64::from(ptr))
                } else {
                    (&host.memory, u64::from(ptr), &host.guest, addr)
                };
                match read(from, from_addr, len as usize)
                    .and_then(|bytes| write(to, to_addr, &bytes))
                {
                    Ok(()) => 0,
                    Err(_) => -(Errno::EFAULT as i32),
                }
            },
        )?;
    }
    linker.define_unknown_imports_as_traps(module)?;
    Ok(linker.instantiate(store, module)?)
}

fn check(label: &str, result: i32) -> Result<i32> {
    ensure!(result >= 0, "{label} returned {result}");
    Ok(result)
}

fn run(kernel_path: &Path, image: &[u8], guest_path: &Path) -> Result<usize> {
    let mut config = Config::new();
    config
        .wasm_threads(true)
        .shared_memory(true)
        .wasm_exceptions(true);
    let engine = Engine::new(&config)?;
    let kernel_module = Module::from_file(&engine, kernel_path)?;
    let guest_module = Module::from_file(&engine, guest_path)?;
    let kernel_mem = SharedMemory::new(&engine, wasm_memory(&kernel_module)?)?;
    let guest_type = wasm_memory(&guest_module)?;
    ensure!(
        guest_type.is_shared() && !guest_type.is_64(),
        "smoke runner needs a wasm32 shared-memory guest"
    );
    let guest_mem = SharedMemory::new(&engine, guest_type)?;
    let initial = guest_mem.data().len();
    let control = initial.max(process_memory::FALLBACK_BRK_BASE as usize);
    let channel = control + process_memory::MAIN_CHANNEL_PRIMARY_PAGE as usize * PAGE_BYTES;
    let heap_base = channel + MIN_CHANNEL_SIZE.div_ceil(PAGE_BYTES) * PAGE_BYTES;
    // The single smoke process can satisfy its tiny CRT allocation with an
    // already backed heap. A host supporting arbitrary guests must implement
    // memory growth and retirement for the whole engine address space.
    guest_mem.grow(((heap_base - initial) / PAGE_BYTES + 16) as u64)?;
    let channel = channel as u64;
    let mut store = Store::new(
        &engine,
        KernelHost {
            memory: kernel_mem.clone(),
            guest: guest_mem.clone(),
            image: image.to_vec(),
            process: 0,
            clock_start: Instant::now(),
        },
    );
    let kernel = link_kernel(&engine, &kernel_module, &mut store)?;
    let abi = kernel
        .get_typed_func::<(), u32>(&mut store, "__abi_version")?
        .call(&mut store, ())?;
    ensure!(
        abi == ABI_VERSION,
        "kernel ABI {abi} differs from runner ABI {ABI_VERSION}"
    );
    let manifest_len = kernel
        .get_typed_func::<(), u32>(&mut store, "kernel_host_adapter_manifest_len")?
        .call(&mut store, ())?;
    ensure!(
        manifest_len == u32::from(HOST_ADAPTER_MANIFEST_SIZE),
        "unexpected kernel host manifest size {manifest_len}"
    );
    let manifest_ptr = kernel
        .get_typed_func::<(), u32>(&mut store, "kernel_host_adapter_manifest_ptr")?
        .call(&mut store, ())?;
    let manifest = read(&kernel_mem, u64::from(manifest_ptr), manifest_len as usize)?;
    ensure!(
        u32_at(&manifest, 0) == HOST_ADAPTER_MANIFEST_MAGIC,
        "wrong kernel host manifest magic"
    );
    let adapter = u32_at(
        &manifest,
        core::mem::offset_of!(HostAdapterManifest, required_host_adapter_version),
    );
    ensure!(
        adapter == HOST_ADAPTER_VERSION,
        "kernel host ABI {adapter} differs from runner ABI {HOST_ADAPTER_VERSION}"
    );
    let load = kernel.get_typed_func::<(u32, u32), i32>(&mut store, "kernel_rootfs_load_image")?;
    let length = image.len() as u64;
    check(
        "load image",
        load.call(&mut store, (length as u32, (length >> 32) as u32))?,
    )?;
    let enable = kernel.get_typed_func::<i32, i32>(&mut store, "kernel_set_rootfs_enabled")?;
    check("enable rootfs", enable.call(&mut store, 1)?)?;
    let create = kernel.get_typed_func::<(), i32>(&mut store, "kernel_create_process")?;
    let pid = check("create process", create.call(&mut store, ())?)? as u32;
    store.data_mut().process = pid;
    let set_channel =
        kernel.get_typed_func::<(u32, u64), i32>(&mut store, "kernel_set_main_channel_addr")?;
    check(
        "register channel",
        set_channel.call(&mut store, (pid, channel))?,
    )?;
    for (label, address) in [
        ("kernel_set_brk_base", heap_base),
        ("kernel_set_mmap_base", heap_base),
        ("kernel_set_max_addr", guest_mem.data().len()),
    ] {
        let configure = kernel.get_typed_func::<(u32, u32), i32>(&mut store, label)?;
        check(
            label,
            configure.call(&mut store, (pid, address.try_into()?))?,
        )?;
    }
    let scratch = kernel
        .get_typed_func::<u32, u32>(&mut store, "kernel_alloc_scratch")?
        .call(&mut store, MIN_CHANNEL_SIZE as u32)?;
    ensure!(scratch != 0, "failed to allocate kernel channel scratch");

    let guest_engine = engine.clone();
    let guest_memory = guest_mem.clone();
    let (guest_done, guest_result) = std::sync::mpsc::channel();
    let guest_thread = thread::spawn(move || {
        let result = run_guest(&guest_engine, &guest_module, guest_memory, channel);
        let _ = guest_done.send(result);
    });
    let bind = kernel.get_typed_func::<(u32, u32), i32>(&mut store, "kernel_set_current_tid")?;
    let raw =
        kernel.get_typed_func::<(u32, u32, u32, i64), i32>(&mut store, "kernel_handle_channel")?;
    let guest_io =
        kernel.get_typed_func::<(u32, u32, u32, i64), i32>(&mut store, "kernel_handle_guest_io")?;
    let record = kernel
        .get_typed_func::<(u32, u32, u32), i32>(&mut store, "kernel_handle_channel_record")?;
    let drain = kernel
        .get_typed_func::<(u32, u32, u32), i32>(&mut store, "kernel_drain_wait_completions")?;
    let next = kernel.get_typed_func::<(), i64>(&mut store, "kernel_wait_next_timeout_ns")?;
    let exit = kernel.get_typed_func::<u32, i32>(&mut store, "kernel_get_process_exit_status")?;
    let deadline = Instant::now() + LIMIT;
    let mut parked = 0;
    let mut calls = Vec::new();
    loop {
        while atomic_status(&guest_mem, channel).load(Ordering::Acquire)
            != ChannelStatus::Pending as u32
        {
            if let Ok(result) = guest_result.try_recv() {
                result?;
                bail!("guest returned before publishing exit_group");
            }
            ensure!(Instant::now() < deadline, "guest did not publish a syscall");
            let _ = guest_mem.atomic_wait32(
                channel,
                ChannelStatus::Idle as u32,
                Some(Duration::from_millis(10)),
            )?;
        }
        let mut request = vec![0; MIN_CHANNEL_SIZE];
        request[SYSCALL_OFFSET..].copy_from_slice(&read(
            &guest_mem,
            channel + SYSCALL_OFFSET as u64,
            MIN_CHANNEL_SIZE - SYSCALL_OFFSET,
        )?);
        let number = u32_at(&request, SYSCALL_OFFSET);
        let flags = u32_at(&request, REQUEST_FLAGS_OFFSET);
        let via_guest_io = number == Syscall::Read as u32;
        if flags & REQUEST_FLAG_OPAQUE_RECORD == 0 && !via_guest_io {
            stage_raw_request(&guest_mem, scratch, number, &mut request)?;
        }
        write(&kernel_mem, u64::from(scratch), &request)?;
        check("bind task", bind.call(&mut store, (pid, pid))?)?;
        if flags & REQUEST_FLAG_OPAQUE_RECORD != 0 {
            record.call(&mut store, (scratch, MIN_CHANNEL_SIZE as u32, pid))?;
        } else if via_guest_io {
            guest_io.call(&mut store, (scratch, MIN_CHANNEL_SIZE as u32, pid, 0))?;
        } else {
            raw.call(&mut store, (scratch, MIN_CHANNEL_SIZE as u32, pid, 0))?;
        }
        let result = read(&kernel_mem, u64::from(scratch), MIN_CHANNEL_SIZE)?;
        let mut value = i64_at(&result, RETURN_OFFSET);
        let mut errno = u32_at(&result, ERRNO_OFFSET);
        if errno == wait::PARKED_ERRNO {
            parked += 1;
            let generation = value as u64;
            loop {
                let found = check(
                    "drain wait",
                    drain.call(&mut store, (scratch, wait::RECORD_BYTES as u32, 1))?,
                )?;
                if found != 0 {
                    let completion = read(&kernel_mem, u64::from(scratch), wait::RECORD_BYTES)?;
                    ensure!(
                        i64_at(&completion, wait::GENERATION_OFFSET) as u64 == generation
                            && u32_at(&completion, wait::PID_OFFSET) == pid
                            && u32_at(&completion, wait::TID_OFFSET) == pid,
                        "completion did not match the parked request"
                    );
                    ensure!(
                        u32_at(&completion, wait::FLAGS_OFFSET) == 0,
                        "unsupported wait completion flags"
                    );
                    let returned =
                        i32::from_le_bytes(completion[wait::VALUE_OFFSET..][..4].try_into()?);
                    (value, errno) = if returned < 0 {
                        (-1, returned.unsigned_abs())
                    } else {
                        (i64::from(returned), 0)
                    };
                    break;
                }
                let remaining = next.call(&mut store, ())?;
                ensure!(
                    remaining >= 0 && Instant::now() < deadline,
                    "guest wait has no reachable deadline"
                );
                thread::sleep(
                    Duration::from_nanos(remaining as u64)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
        }
        if flags & REQUEST_FLAG_OPAQUE_RECORD != 0 {
            write(
                &guest_mem,
                channel + DATA_OFFSET as u64,
                &result[DATA_OFFSET..],
            )?;
        }
        write(
            &guest_mem,
            channel + RETURN_OFFSET as u64,
            &value.to_le_bytes(),
        )?;
        write(
            &guest_mem,
            channel + ERRNO_OFFSET as u64,
            &errno.to_le_bytes(),
        )?;
        calls.push((number, value, errno));
        let exiting = number == extended_syscalls::SYS_EXIT_GROUP;
        let status = if exiting {
            ChannelStatus::Teardown
        } else {
            ChannelStatus::Complete
        };
        atomic_status(&guest_mem, channel).store(status as u32, Ordering::Release);
        guest_mem.atomic_notify(channel, 1)?;
        if exiting {
            let status = exit.call(&mut store, pid)?;
            ensure!(
                status == 0,
                "smoke guest exited with status {status}; syscall number, result, errno: {calls:?}"
            );
            let result = guest_result
                .recv_timeout(LIMIT)
                .context("guest did not unwind after exit_group")?;
            match result {
                Err(error)
                    if error.downcast_ref::<wasmtime::Trap>()
                        == Some(&wasmtime::Trap::UnreachableCodeReached) => {}
                Err(error) => return Err(error),
                Ok(()) => bail!("guest returned after exit_group"),
            }
            guest_thread
                .join()
                .map_err(|_| anyhow::anyhow!("guest thread panicked"))?;
            return Ok(parked);
        }
    }
}

fn u32_at(bytes: &[u8], offset: usize) -> u32 {
    u32::from_le_bytes(bytes[offset..][..4].try_into().unwrap())
}

fn i64_at(bytes: &[u8], offset: usize) -> i64 {
    i64::from_le_bytes(bytes[offset..][..8].try_into().unwrap())
}

fn stage_raw_request(
    memory: &SharedMemory,
    scratch: u32,
    number: u32,
    request: &mut [u8],
) -> Result<()> {
    if number == Syscall::Open as u32 || number == Syscall::Openat as u32 {
        let argument = usize::from(number == Syscall::Openat as u32);
        let slot = ARGS_OFFSET + argument * ARG_SIZE;
        let addr = i64_at(request, slot) as u64;
        let len = memory
            .data()
            .len()
            .saturating_sub(addr as usize)
            .min(DATA_SIZE);
        let bytes = read(memory, addr, len)?;
        let end = bytes
            .iter()
            .position(|&byte| byte == 0)
            .context("unterminated guest path")?;
        request[DATA_OFFSET..=DATA_OFFSET + end].copy_from_slice(&bytes[..=end]);
        let ptr = i64::from(scratch) + DATA_OFFSET as i64;
        request[slot..slot + ARG_SIZE].copy_from_slice(&ptr.to_le_bytes());
    }
    Ok(())
}

fn run_guest(engine: &Engine, module: &Module, memory: SharedMemory, channel: u64) -> Result<()> {
    let mut store = Store::new(engine, ());
    let mut linker = Linker::new(engine);
    linker.define(&mut store, "env", "memory", memory)?;
    let base = Global::new(
        &mut store,
        GlobalType::new(ValType::I32, Mutability::Var),
        Val::I32(channel.try_into()?),
    )?;
    linker.define(&mut store, "env", "__channel_base", base)?;
    for name in [
        "kernel_get_argc",
        "kernel_environ_count",
        "kernel_get_secure_exec",
        "kernel_is_fork_child",
    ] {
        linker.func_wrap("kernel", name, || -> i32 { 0 })?;
    }
    use wasm_posix_shared::program_extensions::stat_cache_v1;
    linker.func_wrap(
        stat_cache_v1::MODULE,
        stat_cache_v1::IMPORT,
        |_path: i32, _output: i32, _request: i32| -> i32 { 0 },
    )?;
    linker.define_unknown_imports_as_traps(module)?;
    let instance = linker.instantiate(&mut store, module)?;
    let start = instance.get_typed_func::<(), ()>(&mut store, "_start")?;
    Ok(start.call(&mut store, ())?)
}
