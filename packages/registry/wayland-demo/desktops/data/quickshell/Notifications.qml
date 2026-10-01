import QtQuick
import Quickshell
import Quickshell.Wayland
import Quickshell.Services.Notifications

// The notification daemon (mako's place): this process owns
// org.freedesktop.Notifications on the session bus and shows each
// notification as a card in the top-right corner until it expires.
Scope {
  id: root

  required property Theme theme

  NotificationServer {
    id: server
    onNotification: notification => {
      notification.tracked = true
      console.info("NOTIFICATION id=" + notification.id + " summary=" + notification.summary)
    }
  }

  PanelWindow {
    WlrLayershell.namespace: "notifications"
    WlrLayershell.layer: WlrLayer.Overlay
    anchors { top: true; right: true }
    margins { top: 44; right: 12 }
    exclusionMode: ExclusionMode.Ignore
    visible: server.trackedNotifications.values.length > 0
    implicitWidth: 380
    implicitHeight: Math.max(1, cards.implicitHeight)
    color: "transparent"

    Column {
      id: cards
      width: parent.width
      spacing: 8

      Repeater {
        model: server.trackedNotifications
        delegate: Rectangle {
          required property Notification modelData
          width: cards.width
          height: body.implicitHeight + 20
          color: root.theme.background
          border.color: root.theme.accent
          border.width: 2

          Column {
            id: body
            x: 12
            y: 10
            width: parent.width - 24
            spacing: 4
            Text { width: parent.width; text: modelData.summary; color: root.theme.foreground; font.pixelSize: 16; font.bold: true; wrapMode: Text.Wrap }
            Text { width: parent.width; text: modelData.body; visible: text.length > 0; color: root.theme.muted; font.pixelSize: 14; wrapMode: Text.Wrap }
          }

          Timer {
            interval: modelData.expireTimeout > 0 ? modelData.expireTimeout : 5000
            running: true
            onTriggered: modelData.expire()
          }

          MouseArea { anchors.fill: parent; onClicked: modelData.dismiss() }
        }
      }
    }
  }
}
