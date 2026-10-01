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
    implicitHeight: 34
    color: "#16161e"
    Text {
      anchors.centerIn: parent
      color: "#c0caf5"
      text: "KANDELO   " + Qt.formatDateTime(clock.date, "yyyy-MM-dd   hh:mm:ss")
    }
  }
}
