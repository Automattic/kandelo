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
fn sendmsg_zero_length_null_iovec_never_constructs_a_raw_slice() {
    let source = include_str!("../src/wasm_api.rs");
    let start = source
        .find("pub extern \"C\" fn kernel_sendmsg(")
        .expect("kernel_sendmsg start");
    let end = source[start..]
        .find("\n/// recvmsg")
        .expect("kernel_sendmsg end");
    let sendmsg = &source[start..start + end];

    let empty_guard = sendmsg
        .find("let buf = if len == 0 {\n        &[]")
        .expect("zero-length iovec must select a valid empty slice");
    let raw_slice = sendmsg
        .find("slice::from_raw_parts(base as *const u8, len)")
        .expect("positive-length iovec must retain the bounded slice");
    assert!(
        empty_guard < raw_slice,
        "the zero-length guard must precede raw-slice construction"
    );
}

#[test]
fn mqueue_zero_length_message_never_constructs_a_null_raw_slice() {
    let source = include_str!("../src/wasm_api.rs");
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

    let send_empty_guard = send
        .find("let data = if data_len == 0 {\n                &[]")
        .expect("zero-length message must select a valid empty slice");
    let send_raw_slice = send
        .find("core::slice::from_raw_parts(channel_const_ptr!(1, u8), data_len)")
        .expect("positive-length message must retain the bounded slice");
    assert!(
        send_empty_guard < send_raw_slice,
        "the zero-length send guard must precede raw-slice construction"
    );

    let receive_empty_guard = receive
        .find("if !result.data.is_empty() {")
        .expect("empty received message must skip destination construction");
    let receive_raw_slice = receive
        .find("core::slice::from_raw_parts_mut(")
        .expect("non-empty received message must retain the bounded slice");
    assert!(
        receive_empty_guard < receive_raw_slice,
        "the empty receive guard must precede raw-slice construction"
    );
}

#[test]
fn nullable_zero_length_dispatch_paths_never_construct_null_raw_slices() {
    let source = include_str!("../src/wasm_api.rs");

    let utimensat_start = source
        .find("pub extern \"C\" fn kernel_utimensat(")
        .expect("kernel_utimensat start");
    let utimensat_end = source[utimensat_start..]
        .find("\n/// Remap memory.")
        .map(|offset| utimensat_start + offset)
        .expect("kernel_utimensat end");
    let utimensat = &source[utimensat_start..utimensat_end];
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

    for (function, next_marker) in [
        ("kernel_getsockname(", "\n/// getpeername"),
        ("kernel_getpeername(", "\n/// Resolve a hostname"),
    ] {
        let start = source
            .find(&format!("pub extern \"C\" fn {function}"))
            .unwrap_or_else(|| panic!("{function} start"));
        let end = source[start..]
            .find(next_marker)
            .map(|offset| start + offset)
            .unwrap_or_else(|| panic!("{function} end"));
        let body = &source[start..end];
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
