import QtQuick
import Quickshell
import Quickshell.Io
import Quickshell.Wayland

// The lock screen (hyprlock's place) and the idle monitor (hypridle's):
// ext-session-lock blanks the output and takes the input; the password is
// checked by `login -c`, the image's own credential check, and the session
// unlocks only when it says yes.
Scope {
  id: root

  required property Theme theme
  readonly property string user: Quickshell.env("USER")
  readonly property string login: Quickshell.env("KANDELO_LOGIN") || "/usr/bin/login"
  property string password: ""
  property string message: ""

  function engage() {
    if (lock.locked) return
    password = ""
    message = ""
    lock.locked = true
    console.info("LOCK_ENGAGED")
  }

  function verify() {
    if (verifier.running || password.length === 0) return
    verifier.running = true
  }

  WlSessionLock {
    id: lock

    WlSessionLockSurface {
      color: root.theme.background

      SystemClock {
        id: clock
        precision: SystemClock.Minutes
      }

      Column {
        anchors.centerIn: parent
        spacing: 16

        Text { anchors.horizontalCenter: parent.horizontalCenter; text: Qt.formatDateTime(clock.date, "hh:mm"); color: root.theme.foreground; font.pixelSize: 72 }
        Text { anchors.horizontalCenter: parent.horizontalCenter; text: root.user; color: root.theme.muted; font.pixelSize: 20 }

        Rectangle {
          anchors.horizontalCenter: parent.horizontalCenter
          width: 320
          height: 44
          color: root.theme.occupied
          border.color: root.theme.accent
          border.width: 2
          Text {
            anchors.centerIn: parent
            text: root.password.length > 0 ? "•".repeat(root.password.length) : "password"
            color: root.password.length > 0 ? root.theme.foreground : root.theme.muted
            font.pixelSize: 20
          }
        }

        Text { anchors.horizontalCenter: parent.horizontalCenter; text: root.message; color: root.theme.accent; font.pixelSize: 16 }
      }

      Item {
        anchors.fill: parent
        focus: true
        Keys.onPressed: event => {
          event.accepted = true
          if (event.key === Qt.Key_Return || event.key === Qt.Key_Enter) { root.verify(); return }
          if (event.key === Qt.Key_Backspace) { root.password = root.password.slice(0, -1); return }
          if (event.key === Qt.Key_Escape) { root.password = ""; return }
          if (event.text.length === 0 || event.text < " ") return
          root.password += event.text
        }
      }
    }
  }

  Process {
    id: verifier
    command: [root.login, "-c", root.user]
    stdinEnabled: true
    onStarted: write(root.password + "\n")
    onExited: (exitCode, exitStatus) => {
      const ok = exitCode === 0
      console.info("LOCK_ATTEMPT ok=" + (ok ? 1 : 0))
      root.password = ""
      if (!ok) { root.message = "Wrong password"; return }
      lock.locked = false
    }
  }

  IdleMonitor {
    timeout: 600
    onIsIdleChanged: if (isIdle) root.engage()
  }
}
