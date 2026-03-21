extern crate alloc;

/// Terminal attribute flags (c_lflag)
pub const ECHO: u32 = 0o0010;
pub const ECHOE: u32 = 0o0020;
pub const ECHOK: u32 = 0o0040;
pub const ECHONL: u32 = 0o0100;
pub const ICANON: u32 = 0o0002;
pub const ISIG: u32 = 0o0001;
pub const IEXTEN: u32 = 0o100000;
pub const TOSTOP: u32 = 0o0400;

/// Terminal attribute flags (c_iflag)
pub const ICRNL: u32 = 0o0400;
pub const INLCR: u32 = 0o0100;
pub const IGNCR: u32 = 0o0200;
pub const IXON: u32 = 0o2000;
pub const IXOFF: u32 = 0o10000;
pub const IXANY: u32 = 0o4000;
pub const IMAXBEL: u32 = 0o20000;

/// Terminal attribute flags (c_oflag)
pub const OPOST: u32 = 0o0001;
pub const ONLCR: u32 = 0o0004;

/// Terminal attribute flags (c_cflag)
pub const CS8: u32 = 0o0060;
pub const CREAD: u32 = 0o0200;
pub const HUPCL: u32 = 0o2000;

/// Control character indices
pub const VINTR: usize = 0;
pub const VQUIT: usize = 1;
pub const VERASE: usize = 2;
pub const VKILL: usize = 3;
pub const VEOF: usize = 4;
pub const VTIME: usize = 5;
pub const VMIN: usize = 6;
pub const VSTART: usize = 8;
pub const VSTOP: usize = 9;
pub const VSUSP: usize = 10;
pub const VEOL: usize = 11;
pub const NCCS: usize = 32;

/// tcsetattr action constants
pub const TCSANOW: u32 = 0;
pub const TCSADRAIN: u32 = 1;
pub const TCSAFLUSH: u32 = 2;

/// ioctl commands
pub const TIOCGWINSZ: u32 = 0x5413;
pub const TIOCSWINSZ: u32 = 0x5414;

/// Window size structure
#[repr(C)]
#[derive(Debug, Clone, Copy)]
pub struct WinSize {
    pub ws_row: u16,
    pub ws_col: u16,
    pub ws_xpixel: u16,
    pub ws_ypixel: u16,
}

/// Kernel-internal terminal state (simulated, not affecting actual host I/O).
#[derive(Debug, Clone)]
pub struct TerminalState {
    pub c_iflag: u32,
    pub c_oflag: u32,
    pub c_cflag: u32,
    pub c_lflag: u32,
    pub c_cc: [u8; NCCS],
    pub winsize: WinSize,
    /// Foreground process group ID (for tcgetpgrp/tcsetpgrp via TIOCGPGRP/TIOCSPGRP).
    pub foreground_pgid: i32,
}

impl TerminalState {
    /// Create default terminal state matching a typical Linux terminal.
    pub fn new() -> Self {
        let mut c_cc = [0u8; NCCS];
        c_cc[VINTR] = 0x03;   // Ctrl-C
        c_cc[VQUIT] = 0x1C;   // Ctrl-backslash
        c_cc[VERASE] = 0x7F;  // DEL
        c_cc[VKILL] = 0x15;   // Ctrl-U
        c_cc[VEOF] = 0x04;    // Ctrl-D
        c_cc[VSTART] = 0x11;  // Ctrl-Q
        c_cc[VSTOP] = 0x13;   // Ctrl-S
        c_cc[VSUSP] = 0x1A;   // Ctrl-Z
        c_cc[VMIN] = 1;
        c_cc[VTIME] = 0;

        TerminalState {
            c_iflag: ICRNL | IXON | IXANY | IMAXBEL,
            c_oflag: OPOST | ONLCR,
            c_cflag: CS8 | CREAD | HUPCL,
            c_lflag: ECHO | ECHOE | ECHOK | ICANON | ISIG | IEXTEN,
            c_cc,
            winsize: WinSize {
                ws_row: 24,
                ws_col: 80,
                ws_xpixel: 0,
                ws_ypixel: 0,
            },
            foreground_pgid: 1, // default to PID 1's group
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_terminal_state_defaults() {
        let ts = TerminalState::new();
        assert!(ts.c_lflag & ECHO != 0);
        assert!(ts.c_lflag & ICANON != 0);
        assert!(ts.c_lflag & ISIG != 0);
        assert!(ts.c_iflag & ICRNL != 0);
        assert!(ts.c_oflag & OPOST != 0);
        assert_eq!(ts.c_cc[VINTR], 0x03);
        assert_eq!(ts.c_cc[VEOF], 0x04);
        assert_eq!(ts.winsize.ws_row, 24);
        assert_eq!(ts.winsize.ws_col, 80);
    }
}
