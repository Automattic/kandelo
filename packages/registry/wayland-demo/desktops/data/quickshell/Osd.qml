import QtQuick
import Quickshell
import Quickshell.Wayland

// The on-screen display (SwayOSD's place): a short-lived pill above the
// bottom edge naming what just changed, such as the theme.
PanelWindow {
  id: osd

  required property Theme theme
  property string label: ""
  property string value: ""

  function show(newLabel, newValue) {
    label = newLabel
    value = newValue
    timer.restart()
    console.info("OSD " + newLabel + "=" + newValue)
  }

  WlrLayershell.namespace: "osd"
  WlrLayershell.layer: WlrLayer.Overlay
  anchors { bottom: true }
  margins { bottom: 96 }
  exclusionMode: ExclusionMode.Ignore
  visible: timer.running
  implicitWidth: 380
  implicitHeight: 48
  color: theme.bar

  Timer {
    id: timer
    interval: 1800
  }

  Text {
    anchors.centerIn: parent
    text: osd.label + "   " + osd.value
    color: osd.theme.foreground
    font.pixelSize: 18
  }
}
