import QtQuick
import Quickshell
import Quickshell.Wayland
import Quickshell.Hyprland

// The launcher (Walker's place): the image's .desktop entries filtered as
// the visitor types, launched through the compositor's `dispatch exec`. The
// menu form lists Apps and Theme, the way the Omarchy menu does.
PanelWindow {
  id: launcher

  required property Theme theme
  property bool open: false
  property bool menu: false
  property string level: "apps"
  property string filter: ""
  property int selected: 0

  readonly property var apps: DesktopEntries.applications.values
    .filter(entry => !entry.noDisplay)
    .sort((a, b) => a.name.localeCompare(b.name))
  readonly property var entries: {
    if (level === "root") return [
      { name: "Apps", kind: "root", target: "apps" },
      { name: "Theme", kind: "root", target: "themes" },
    ]
    if (level === "themes") return theme.themes.map(name => ({ name: name, kind: "theme" }))
    const query = filter.toLowerCase()
    return apps
      .filter(entry => entry.name.toLowerCase().includes(query))
      .map(entry => ({ name: entry.name, kind: "app", exec: entry.execString }))
  }

  visible: open
  WlrLayershell.namespace: "launcher"
  WlrLayershell.layer: WlrLayer.Overlay
  WlrLayershell.keyboardFocus: WlrKeyboardFocus.Exclusive
  implicitWidth: 640
  implicitHeight: 400
  color: theme.background

  function toggleApps() {
    if (open) close()
    else show("apps", false)
  }

  function toggleMenu() {
    if (open) close()
    else show("root", true)
  }

  function show(startLevel, asMenu) {
    menu = asMenu
    open = true
    enter(startLevel)
    keys.forceActiveFocus()
  }

  function enter(newLevel) {
    level = newLevel
    filter = ""
    selected = 0
    console.info("LAUNCHER_LEVEL " + newLevel)
    console.info("LAUNCHER_READY n=" + entries.length)
  }

  function close() {
    open = false
    console.info("LAUNCHER_EXIT")
  }

  function activate() {
    const entry = entries[selected]
    if (!entry) return
    if (entry.kind === "root") { enter(entry.target); return }
    if (entry.kind === "theme") {
      console.info("LAUNCHER_THEME name=" + entry.name)
      Hyprland.dispatch("theme " + entry.name)
      close()
      return
    }
    console.info("LAUNCHER_EXEC cmd=" + entry.exec)
    Hyprland.dispatch("exec " + entry.exec)
    close()
  }

  function back() {
    if (menu && level !== "root") { enter("root"); return }
    close()
  }

  function setFilter(value) {
    filter = value
    selected = 0
    if (level === "apps") console.info("LAUNCHER_FILTER q=" + filter + " n=" + entries.length)
  }

  Item {
    id: keys
    anchors.fill: parent
    focus: true

    Keys.onPressed: event => {
      event.accepted = true
      if (event.key === Qt.Key_Escape) { launcher.back(); return }
      if (event.key === Qt.Key_Down) { launcher.selected = Math.min(launcher.selected + 1, launcher.entries.length - 1); return }
      if (event.key === Qt.Key_Up) { launcher.selected = Math.max(launcher.selected - 1, 0); return }
      if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { launcher.activate(); return }
      if (event.key === Qt.Key_Backspace) { launcher.setFilter(launcher.filter.slice(0, -1)); return }
      if (launcher.level !== "apps" || event.text.length === 0 || event.text < " ") return
      launcher.setFilter(launcher.filter + event.text)
    }

    Column {
      anchors.fill: parent
      anchors.margins: 16
      spacing: 6

      Text {
        width: parent.width
        text: launcher.level === "apps" ? "› " + launcher.filter
            : launcher.level === "themes" ? "Theme" : "Omarchy"
        color: launcher.theme.accent
        font.pixelSize: 20
      }

      Repeater {
        model: launcher.entries.slice(0, 12)
        delegate: Rectangle {
          required property var modelData
          required property int index
          width: parent.width
          height: 26
          color: index === launcher.selected ? launcher.theme.occupied : "transparent"
          Text {
            anchors.verticalCenter: parent.verticalCenter
            x: 8
            text: modelData.name
            color: index === launcher.selected ? launcher.theme.foreground : launcher.theme.muted
            font.pixelSize: 16
          }
        }
      }
    }
  }
}
