import QtQuick
import Quickshell
import Quickshell.Wayland
import Quickshell.Hyprland

// The status bar: the Omarchy glyph (opens the menu), the workspaces, the
// clock, and the focused window's title, all from the compositor's Hyprland
// IPC.
PanelWindow {
  id: bar

  required property Theme theme
  signal menuRequested()

  readonly property int persistentWorkspaces: 5

  WlrLayershell.namespace: "bar"
  WlrLayershell.layer: WlrLayer.Top
  anchors { top: true; left: true; right: true }
  implicitHeight: 32
  color: theme.bar

  SystemClock {
    id: clock
    precision: SystemClock.Seconds
  }

  Row {
    anchors.left: parent.left
    anchors.verticalCenter: parent.verticalCenter

    Item {
      width: 36
      height: bar.height
      Text { anchors.centerIn: parent; text: "◆"; color: bar.theme.accent; font.pixelSize: 16 }
      MouseArea { anchors.fill: parent; onClicked: bar.menuRequested() }
    }

    Repeater {
      model: bar.persistentWorkspaces
      delegate: Item {
        required property int index
        readonly property int wsId: index + 1
        readonly property bool occupied: Hyprland.workspaces.values.some(ws => ws.id === wsId)
        readonly property bool focused: (Hyprland.focusedWorkspace?.id ?? 1) === wsId
        width: 28
        height: bar.height
        Text {
          anchors.centerIn: parent
          text: wsId
          font.pixelSize: 16
          color: focused ? bar.theme.accent : (occupied ? bar.theme.foreground : bar.theme.muted)
        }
        MouseArea { anchors.fill: parent; onClicked: Hyprland.dispatch("workspace " + wsId) }
      }
    }
  }

  Text {
    anchors.centerIn: parent
    text: Qt.formatDateTime(clock.date, "hh:mm:ss")
    color: bar.theme.foreground
    font.pixelSize: 16
  }

  Text {
    anchors.right: parent.right
    anchors.rightMargin: 12
    anchors.verticalCenter: parent.verticalCenter
    width: Math.min(implicitWidth, 640)
    elide: Text.ElideRight
    text: Hyprland.activeToplevel?.title ?? ""
    color: bar.theme.foreground
    font.pixelSize: 16
  }

  Connections {
    target: Hyprland
    function onFocusedWorkspaceChanged() {
      console.info("BAR_WORKSPACE active=" + (Hyprland.focusedWorkspace?.id ?? 0))
    }
    function onActiveToplevelChanged() {
      console.info("BAR_WINDOW title=" + (Hyprland.activeToplevel?.title ?? ""))
    }
  }
}
