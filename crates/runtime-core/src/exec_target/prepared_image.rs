use super::*;
use crate::program_preparation::{PreparationPlan, PreparationReceipt};
use wasm_posix_shared::flags::{O_ACCMODE, O_RDONLY, O_WRONLY};
use wasm_posix_shared::mode::{S_IFMT, S_IFREG};

pub(crate) fn bind_prepared_image(
    proc: &mut Process,
    locks: &mut AdvisoryLockManager,
    host: &mut dyn HostIO,
    owner_pid: u32,
    token: u32,
    image: OpenFileDescRef,
    plan: &PreparationPlan,
    receipt: &PreparationReceipt,
) -> Result<(), Errno> {
    bind_with_inspection(proc, locks, host, owner_pid, token, image, plan, receipt, None)
}

pub(crate) fn bind_prepared_image_inspected(
    proc: &mut Process, locks: &mut AdvisoryLockManager, host: &mut dyn HostIO,
    owner_pid: u32, token: u32, image: OpenFileDescRef, plan: &PreparationPlan,
    receipt: &PreparationReceipt, inspection: &kandelo_program_policy::Inspection,
) -> Result<(), Errno> {
    bind_with_inspection(proc, locks, host, owner_pid, token, image, plan, receipt, Some(inspection))
}

fn bind_with_inspection(
    proc: &mut Process, locks: &mut AdvisoryLockManager, host: &mut dyn HostIO,
    owner_pid: u32, token: u32, image: OpenFileDescRef, plan: &PreparationPlan,
    receipt: &PreparationReceipt, inspection: Option<&kandelo_program_policy::Inspection>,
) -> Result<(), Errno> {
    let target = proc.prepared_exec_targets.get(token)?;
    owner_matches_ledger_pid(target.owner(), owner_pid)?;
    if proc.pid != owner_pid {
        return Err(Errno::ESRCH);
    }
    if let PreparedExecOwner::Process { caller_tid, .. } = target.owner() {
        target
            .owner()
            .validate_process(proc.pid, caller_tid, proc.exec_generation)?;
        if !proc.is_live_explicit_tid(caller_tid) {
            return Err(Errno::ESRCH);
        }
    }
    let source_handle = retained_host_handle(proc, target)?;
    if crate::executable_backing::is_executable_handle(source_handle) {
        return Err(Errno::ENOTSUP);
    }
    plan.verify_source(target.observed_bytes()?)?;
    revalidate(proc, host, target)?;
    let binding = crate::executable_backing::SourceBinding::from_observed(
        target.stat(),
        target.observed_bytes()?,
    )?;
    let image_ofd = proc.ofd_table.get(image.0).ok_or(Errno::EBADF)?;
    if image_ofd.file_type != FileType::Regular
        || image_ofd.is_path_only()
        || image_ofd.status_flags() & O_ACCMODE == O_WRONLY
        || crate::executable_backing::is_executable_handle(image_ofd.host_handle)
    {
        return Err(Errno::EBADF);
    }
    let image_handle = image_ofd.host_handle;
    if image_handle < 0 && !is_kernel_fs_file_handle(image_handle) {
        return Err(Errno::EBADF);
    }
    let image_stat = target_fstat(host, image_handle)?;
    if image_stat.st_mode & S_IFMT != S_IFREG {
        return Err(Errno::EACCES);
    }
    if image_handle == source_handle
        || (image_stat.st_ino != 0
            && image_stat.st_dev == target.stat.st_dev
            && image_stat.st_ino == target.stat.st_ino)
    {
        return Err(Errno::EINVAL);
    }
    if image_stat.st_ino == 0 || target.stat.st_ino == 0 {
        return Err(Errno::ENOTSUP);
    }
    if image_stat.st_size > plan.output_limit() {
        return Err(Errno::EFBIG);
    }
    let mut replacement = PreparedExecTarget::new_with_image_length(
        target.owner,
        target.ofd_ref,
        target.ofd_id,
        target.file_id,
        target.stat,
        target.statfs,
        &target.diagnostic_path,
        image_stat.st_size,
    )?;
    let mut offset = 0;
    while offset < replacement.size() {
        let wanted = (64 * 1024).min(replacement.size() - offset);
        let count = target_pread(
            host,
            image_handle,
            &mut replacement.observed_bytes[offset..offset + wanted],
            offset as i64,
        )?;
        if count == 0 || count > wanted {
            return Err(Errno::EIO);
        }
        offset += count;
    }
    if !metadata_matches(&image_stat, &target_fstat(host, image_handle)?) {
        return Err(Errno::ETXTBSY);
    }
    match inspection {
        Some(inspection) => plan.verify_cached_output_inspected(&replacement.observed_bytes, &receipt.encode(), inspection)?,
        None => plan.verify_cached_output(&replacement.observed_bytes, &receipt.encode())?,
    };
    replacement
        .observed_ranges
        .try_reserve_exact(1)
        .map_err(|_| Errno::ENOMEM)?;
    replacement.observed_ranges.push((0, replacement.size()));
    replacement.token = token;
    revalidate(proc, host, target)?;
    let mut description =
        proc.ofd_table
            .prepare(FileType::Regular, O_RDONLY, &replacement.diagnostic_path)?;
    let pair = match crate::executable_backing::create_bound(
        proc,
        replacement.ofd_ref,
        image,
        binding,
        host,
    ) {
        Ok(pair) => pair,
        Err(error) => {
            proc.ofd_table.cancel(description);
            return Err(error);
        }
    };
    let pair_metadata = crate::executable_backing::stat(pair, host)
        .and_then(|stat| Ok((stat, crate::executable_backing::source_generation(pair)?)));
    let (pair_stat, generation) = match pair_metadata {
        Ok(metadata) => metadata,
        Err(error) => {
            proc.ofd_table.cancel(description);
            let _ = crate::executable_backing::release(pair).close_with(host);
            return Err(error);
        }
    };
    description.value_mut().file_id = Some(FileId::Host {
        dev: pair_stat.st_dev,
        ino: pair_stat.st_ino,
    });
    replacement.ofd_id = description.value_mut().ofd_id;
    replacement.backing = PreparedExecBacking::Derived {
        source_generation: generation,
    };
    replacement.ofd_ref = OpenFileDescRef(proc.ofd_table.publish(description, pair));
    let old = core::mem::replace(
        proc.prepared_exec_targets
            .get_mut(token)
            .expect("retained target disappeared during preparation"),
        replacement,
    );
    release_target(proc, locks, host, &old);
    Ok(())
}

#[cfg(test)]
mod tests;
