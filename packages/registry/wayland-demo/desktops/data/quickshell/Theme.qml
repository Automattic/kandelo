import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Hyprland

// The live palette: the compositor's current theme, read from its theme.conf,
// refreshed on every `theme>>` event the compositor emits on a switch.
QtObject {
  id: root

  property string title: ""
  property var themes: []
  property color background: "#1a1b26"
  property color bar: "#16161e"
  property color foreground: "#c0caf5"
  property color muted: "#565f89"
  property color accent: "#7aa2f7"
  property color occupied: "#292e42"
  property color wallpaperTop: "#1a1b26"
  property color wallpaperBottom: "#24283b"

  signal switched(string name)

  readonly property string themeDir: Quickshell.env("KANDELO_THEME_DIR") || "/usr/share/kandelo/themes"

  property FileView conf: FileView {
    blockAllReads: true
    printErrors: true
  }

  property Socket query: Socket {
    path: Hyprland.requestSocketPath
    parser: SplitParser {
      onRead: data => root.receive(data)
    }
    onConnectedChanged: if (connected) write("theme\n")
  }

  property Connections events: Connections {
    target: Hyprland
    function onRawEvent(event) {
      if (event.name !== "theme") return
      root.apply(event.data)
      root.switched(event.data)
    }
  }

  function receive(data) {
    const reply = JSON.parse(data)
    root.themes = reply.themes
    root.apply(reply.name)
  }

  function apply(themeName) {
    conf.path = themeDir + "/" + themeName + "/theme.conf"
    const values = {}
    let heading = themeName
    for (const line of conf.text().split("\n")) {
      const text = line.trim()
      if (text.startsWith("#")) {
        if (heading === themeName) heading = text.slice(1).trim()
        continue
      }
      const eq = text.indexOf("=")
      if (eq < 0) continue
      values[text.slice(0, eq).trim()] = text.slice(eq + 1).trim()
    }
    const color = (key, fallback) => key in values ? "#" + values[key].replace(/^0x/, "") : fallback
    background = color("background", background)
    bar = color("bar", bar)
    foreground = color("foreground", foreground)
    muted = color("muted", muted)
    accent = color("accent", accent)
    occupied = color("occupied", occupied)
    wallpaperTop = color("wallpaper_top", wallpaperTop)
    wallpaperBottom = color("wallpaper_bottom", wallpaperBottom)
    title = heading
    console.info("SHELL_THEME name=" + themeName)
  }

  Component.onCompleted: query.connected = true
}
