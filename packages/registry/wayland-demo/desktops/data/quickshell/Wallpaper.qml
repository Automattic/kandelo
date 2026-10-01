import QtQuick
import Quickshell
import Quickshell.Wayland

// The background layer: the theme's gradient behind every window, with the
// key hints over it.
PanelWindow {
  required property Theme theme

  WlrLayershell.namespace: "wallpaper"
  WlrLayershell.layer: WlrLayer.Background
  anchors { top: true; bottom: true; left: true; right: true }
  exclusionMode: ExclusionMode.Ignore
  color: theme.wallpaperTop

  Rectangle {
    anchors.fill: parent
    gradient: Gradient {
      GradientStop { position: 0.0; color: theme.wallpaperTop }
      GradientStop { position: 1.0; color: theme.wallpaperBottom }
    }
  }

  Column {
    anchors.left: parent.left
    anchors.bottom: parent.bottom
    anchors.margins: 48
    spacing: 8
    Text { text: "Kandelo"; color: theme.foreground; font.pixelSize: 40; opacity: 0.6 }
    Text { text: "CTRL+Space  launcher   ·   CTRL+ALT+Space  menu   ·   CTRL+Return  terminal"; color: theme.muted; font.pixelSize: 16 }
    Text { text: "CTRL+SHIFT+Space  next theme   ·   CTRL+Escape  lock"; color: theme.muted; font.pixelSize: 16 }
  }
}
