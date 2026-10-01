import QtQuick
import Quickshell
import Quickshell.Hyprland

// The Omarchy shell: one Quickshell process owns the wallpaper, the bar, the
// launcher and menu, the notification server, the on-screen display, the lock
// screen and the idle monitor. The compositor's keybinds reach it through
// hyprland-global-shortcuts (`global, quickshell:<name>`).
ShellRoot {
  Theme { id: theme }
  Wallpaper { theme: theme }
  Bar { theme: theme; onMenuRequested: launcher.toggleMenu() }
  Launcher { id: launcher; theme: theme }
  Notifications { theme: theme }
  Osd { id: osd; theme: theme }
  LockScreen { id: lock; theme: theme }

  GlobalShortcut { appid: "quickshell"; name: "launcher"; onPressed: launcher.toggleApps() }
  GlobalShortcut { appid: "quickshell"; name: "menu"; onPressed: launcher.toggleMenu() }
  GlobalShortcut { appid: "quickshell"; name: "lock"; onPressed: lock.engage() }

  Connections {
    target: theme
    function onSwitched(name) { osd.show("Theme", theme.title) }
  }

  Component.onCompleted: console.info("SHELL_READY")
}
