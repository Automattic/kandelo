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
    }
    margins {
      bottom: 14
    }
    implicitWidth: 380
    implicitHeight: 44
    color: "#1a1b26"
    Text {
      anchors.centerIn: parent
      color: "#7dcfff"
      text: "[ island ]   " + Qt.formatDateTime(clock.date, "hh:mm:ss")
    }
  }
}
