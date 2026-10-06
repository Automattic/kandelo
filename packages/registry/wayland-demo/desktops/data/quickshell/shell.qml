import Quickshell
import QtQuick

ShellRoot {
  SystemClock {
    id: clock
    precision: SystemClock.Seconds
  }
  PanelWindow {
    anchors {
      bottom: true
      left: true
      right: true
    }
    implicitHeight: 30
    color: "#1a1b26"
    Text {
      anchors.centerIn: parent
      color: "#c0caf5"
      text: "Quickshell — " + Qt.formatDateTime(clock.date, "hh:mm:ss")
    }
  }
}
