/*
 * linux/fs.h — build shim for the Qt port.
 *
 * Kandelo has no Linux kernel and vendors no <linux/fs.h>. QtCore
 * includes it from qfilesystemengine_unix.cpp under Q_OS_LINUX for one
 * symbol, FICLONE, and already defines FICLONE itself when the header
 * does not carry it (qfilesystemengine_unix.cpp:68). _IOW comes from
 * <sys/ioctl.h>, which that file includes two lines earlier.
 *
 * The reflink copy is attempted first and falls back to a read/write
 * copy when the ioctl fails, which is what this kernel returns. An empty
 * header is the accurate description: the interface is absent.
 */
#ifndef KANDELO_SHIM_LINUX_FS_H
#define KANDELO_SHIM_LINUX_FS_H
#endif
