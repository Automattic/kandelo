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

    assert!(
        send.contains("let data = channel_const_slice!(1, data_len);"),
        "mq_timedsend must use the checked slice helper with its actual length"
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
