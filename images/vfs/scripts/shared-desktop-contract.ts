/** Compatible executable closure for the temporary trusted desktop preview. */
export const SHARED_DESKTOP_PROGRAMS = [
  '/usr/bin/sway', '/usr/bin/swaybar', '/usr/bin/swaybg', '/usr/bin/swaymsg', '/usr/bin/swaynag',
  '/usr/bin/foot', '/bin/sh', '/bin/coreutils',
] as const;

/** The normal image-owned login/syslog chain joins the same trusted group. */
export const SHARED_DESKTOP_LOGIN_PROGRAMS = ['/bin/login', '/usr/sbin/syslogd'] as const;

/** Separate compatible closure for the opt-in Cage/Foot experiment. */
export const SHARED_CAGE_DESKTOP_PROGRAMS = [
  '/usr/bin/cage', '/usr/bin/foot', '/bin/sh', '/bin/coreutils',
] as const;
export const SHARED_FREECIV_PROGRAMS = [
  '/usr/libexec/freeciv/client.wasm', '/usr/libexec/freeciv/server.wasm',
] as const;
export const SHARED_SCUMMVM_PROGRAMS = [
  '/usr/libexec/scummvm-static', '/usr/bin/curl', '/usr/bin/unzip',
  '/bin/grep', '/bin/sed',
] as const;
export type SharedDesktopProfile = 'sway' | 'cage';

export function sharedDesktopPrograms(profile: SharedDesktopProfile, includeFreeciv: boolean, includeScummvm = false): readonly string[] {
  if ((profile !== 'sway' && profile !== 'cage') || typeof includeFreeciv !== 'boolean' || typeof includeScummvm !== 'boolean') {
    throw Error('Unsupported trusted desktop selection');
  }
  return [...(profile === 'cage' ? SHARED_CAGE_DESKTOP_PROGRAMS : SHARED_DESKTOP_PROGRAMS),
    ...(includeFreeciv ? SHARED_FREECIV_PROGRAMS : []),
    ...(includeScummvm ? SHARED_SCUMMVM_PROGRAMS : [])];
}
