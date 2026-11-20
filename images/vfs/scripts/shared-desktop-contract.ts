/** Compatible executable closure for the temporary trusted desktop preview. */
export const SHARED_DESKTOP_PROGRAMS = [
  '/usr/bin/sway', '/usr/bin/swaybar', '/usr/bin/swaybg', '/usr/bin/swaymsg', '/usr/bin/swaynag',
  '/usr/bin/foot', '/bin/sh', '/bin/coreutils',
] as const;

/** The normal image-owned login/syslog chain joins the same trusted group. */
export const SHARED_DESKTOP_LOGIN_PROGRAMS = ['/bin/login', '/usr/sbin/syslogd'] as const;
