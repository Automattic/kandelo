/*
 * Minimal <linux/apm_bios.h> for old KDrive Linux console code.
 *
 * Kandelo does not expose an APM device. These definitions let portable
 * Linux-console programs compile; opening /dev/apm_bios simply fails with
 * ENOENT at runtime.
 */
#ifndef _LINUX_APM_BIOS_H
#define _LINUX_APM_BIOS_H 1

typedef unsigned short apm_event_t;

#define APM_SYS_STANDBY       0x0001
#define APM_USER_STANDBY      0x0002
#define APM_SYS_SUSPEND       0x0003
#define APM_USER_SUSPEND      0x0004
#define APM_CRITICAL_SUSPEND  0x0005
#define APM_NORMAL_RESUME     0x0006
#define APM_CRITICAL_RESUME   0x0007
#define APM_STANDBY_RESUME    0x0008

#define APM_IOC_STANDBY 0x4101
#define APM_IOC_SUSPEND 0x4102

#endif /* _LINUX_APM_BIOS_H */
