#[test]
fn dispatcher_does_not_cast_narrowed_scalar_aliases_as_pointers() {
    let source = include_str!("../src/wasm_api.rs");
    let start = source
        .find("fn dispatch_channel_syscall(")
        .expect("dispatcher start");
    let end = source[start..]
        .find("\n// ---------------------------------------------------------------------------\n// SysV IPC kernel exports")
        .expect("dispatcher end");
    let dispatcher = &source[start..start + end];

    for alias in ["a1", "a2", "a3", "a4", "a5", "a6"] {
        for suffix in [" as *const", " as *mut", " as usize", " as u32 as usize"] {
            let forbidden = format!("{alias}{suffix}");
            assert!(
                !dispatcher.contains(&forbidden),
                "channel pointer bypasses checked conversion via `{forbidden}`"
            );
        }
    }

    for index in 0..6 {
        for suffix in [" as *const", " as *mut", " as usize"] {
            let forbidden = format!("args[{index}]{suffix}");
            assert!(
                !dispatcher.contains(&forbidden),
                "raw channel pointer bypasses checked conversion via `{forbidden}`"
            );
        }
        let forbidden = format!("usize::try_from(args[{index}])");
        assert!(
            !dispatcher.contains(&forbidden),
            "signed pointer conversion bypasses bit-preserving helper via `{forbidden}`"
        );
    }

    assert!(
        dispatcher.contains("checked_channel_pointer(args[$index])"),
        "dispatcher must retain the checked raw-pointer conversion gate"
    );
}

#[test]
fn message_exports_never_borrow_a_guest_address_as_kernel_memory() {
    // `msg` used to be a kernel-scratch pointer, so this pinned the
    // zero-length guard that kept `slice::from_raw_parts` off a null base. It
    // is a GUEST address now: the kernel reads and writes the caller's
    // `msghdr`, iovec table and CMSG chain through the cross-memory
    // primitives, which bound every range against the target process's own
    // memory. Borrowing one of those addresses as a raw slice would read or
    // write the KERNEL's address space at a caller-chosen offset, so what has
    // to be pinned now is that neither export does it.
    let source = include_str!("../src/wasm_api.rs");
    for (name, start_marker, end_marker) in [
        (
            "kernel_sendmsg",
            "pub extern \"C\" fn kernel_sendmsg(",
            "\n/// recvmsg",
        ),
        (
            "kernel_recvmsg",
            "pub extern \"C\" fn kernel_recvmsg(",
            "\n/// wait4 —",
        ),
    ] {
        let start = source.find(start_marker).expect("export start");
        let end = source[start..].find(end_marker).expect("export end");
        let body = &source[start..start + end];
        assert!(
            !body.contains("from_raw_parts"),
            "{name} must not borrow a guest address as kernel memory"
        );
        assert!(
            body.contains("crate::msghdr::read_msghdr("),
            "{name} must decode the caller's msghdr through the shared reader"
        );
    }
}

#[test]
fn mqueue_zero_length_message_never_constructs_a_null_raw_slice() {
    let source = include_str!("../src/wasm_api.rs");
    let const_slice_start = source
        .find("macro_rules! channel_const_slice")
        .expect("checked channel const-slice helper start");
    let mut_slice_start = source[const_slice_start..]
        .find("macro_rules! channel_mut_slice")
        .map(|offset| const_slice_start + offset)
        .expect("checked channel mut-slice helper start");
    let cstr_start = source[mut_slice_start..]
        .find("macro_rules! channel_cstr_len")
        .map(|offset| mut_slice_start + offset)
        .expect("checked channel mut-slice helper end");
    let const_slice = &source[const_slice_start..mut_slice_start];
    let mut_slice = &source[mut_slice_start..cstr_start];

    for (name, helper, raw_constructor) in [
        ("const", const_slice, "slice::from_raw_parts("),
        ("mut", mut_slice, "slice::from_raw_parts_mut("),
    ] {
        let empty_guard = helper
            .find("if length == 0 {")
            .unwrap_or_else(|| panic!("{name} helper must select a valid empty slice"));
        let empty_slice = helper
            .find("&[]")
            .or_else(|| helper.find("&mut []"))
            .unwrap_or_else(|| panic!("{name} helper must construct a safe empty slice"));
        let raw_slice = helper
            .find(raw_constructor)
            .unwrap_or_else(|| panic!("{name} helper must retain bounded non-empty slices"));
        assert!(
            empty_guard < empty_slice && empty_slice < raw_slice,
            "{name} helper must select its safe empty slice before raw construction"
        );
    }

    let send_start = source
        .find("// SYS_MQ_TIMEDSEND:")
        .expect("mq_timedsend dispatcher start");
    let receive_start = source[send_start..]
        .find("// SYS_MQ_TIMEDRECEIVE:")
        .map(|offset| send_start + offset)
        .expect("mq_timedreceive dispatcher start");
    let receive_end = source[receive_start..]
        .find("// SYS_MQ_NOTIFY:")
        .map(|offset| receive_start + offset)
        .expect("mq_timedreceive dispatcher end");
    let send = &source[send_start..receive_start];
    let receive = &source[receive_start..receive_end];

    // The caller's message buffer is a GUEST address now, not kernel scratch,
    // so what has to be pinned is the ORDER of two checks. The queue's own
    // `mq_msgsize` must be resolved before anything is read or reserved for
    // the caller's bytes: POSIX requires EMSGSIZE for an oversized `msg_len`,
    // and sizing a buffer from `msg_len` first would report ENOMEM instead.
    let send_msgsize = send
        .find("let msgsize = match match pin {")
        .expect("mq_timedsend must resolve the queue's mq_msgsize");
    let send_length_check = send
        .find("if data_len > msgsize {")
        .expect("mq_timedsend must reject an oversized message with EMSGSIZE");
    let send_read = send
        .find("crate::guest_ptr::read_guest_bytes(")
        .expect("mq_timedsend must read the caller's buffer through the cross-memory helper");
    assert!(
        send_msgsize < send_length_check && send_length_check < send_read,
        "mq_timedsend must check msg_len against mq_msgsize before reading caller memory"
    );
    assert!(
        !send.contains("from_raw_parts"),
        "mq_timedsend must not borrow a guest address as kernel memory"
    );

    let receive_empty_guard = receive
        .find("if !result.data.is_empty() {")
        .expect("empty received message must skip destination construction");
    let receive_write = receive
        .find("crate::guest_ptr::write_guest_bytes(")
        .expect("a non-empty received message must be published through the cross-memory helper");
    assert!(
        receive_empty_guard < receive_write,
        "the empty receive guard must precede the cross-memory write"
    );
    assert!(
        !receive.contains("from_raw_parts"),
        "mq_timedreceive must not borrow a guest address as kernel memory"
    );
}

/// Slice out one `pub extern "C" fn` item's text, from its signature to the
/// start of the next such item.
///
/// The boundary is the next item's own signature rather than a neighbouring
/// doc comment's prose: doc comments belong to whichever export happens to sit
/// next in the file, so a delimiter like `"\n/// Remap memory."` silently
/// breaks -- with a confusing "start not found" panic -- the moment that
/// neighbour is renamed or deleted. Deleting the dead `kernel_mremap` export
/// in ABI 44 did exactly that.
fn extern_item_body<'a>(source: &'a str, function: &str) -> &'a str {
    let signature = format!("pub extern \"C\" fn {function}");
    let start = source
        .find(&signature)
        .unwrap_or_else(|| panic!("{function} start"));
    let after = start + signature.len();
    let end = source[after..]
        .find("\npub extern \"C\" fn ")
        .map(|offset| after + offset)
        .unwrap_or(source.len());
    &source[start..end]
}

#[test]
fn nullable_zero_length_dispatch_paths_never_construct_null_raw_slices() {
    let source = include_str!("../src/wasm_api.rs");

    let utimensat = extern_item_body(source, "kernel_utimensat(");
    let path_guard = utimensat
        .find("let path = if path_len == 0 {")
        .expect("zero-length utimensat path guard");
    let empty_slice = utimensat
        .find("&[]")
        .expect("zero-length utimensat path must select a valid empty slice");
    let path_raw_slice = utimensat
        .find("slice::from_raw_parts(path_ptr, path_len as usize)")
        .expect("positive-length utimensat path must retain the bounded slice");
    assert!(path_guard < empty_slice && empty_slice < path_raw_slice);

    for function in ["kernel_getsockname(", "kernel_getpeername("] {
        let body = extern_item_body(source, function);
        let empty_guard = body
            .find("let result = if addrlen == 0 {")
            .unwrap_or_else(|| panic!("{function} zero-length guard"));
        let null_guard = body
            .find("} else if buf_ptr.is_null() {")
            .unwrap_or_else(|| panic!("{function} null positive-length guard"));
        let raw_slice = body
            .find("core::slice::from_raw_parts_mut(buf_ptr, addrlen as usize)")
            .unwrap_or_else(|| panic!("{function} positive-length slice"));
        assert!(empty_guard < null_guard && null_guard < raw_slice);
    }
}
