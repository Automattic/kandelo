import AppKit
import CoreGraphics
import CoreMedia
import CoreVideo
import Darwin
import Foundation
import ScreenCaptureKit

func nativeMs() -> Double {
  var scale = mach_timebase_info_data_t()
  mach_timebase_info(&scale)
  return Double(mach_absolute_time()) * Double(scale.numer) / Double(scale.denom) / 1_000_000
}
func ticksMs(_ ticks: UInt64) -> Double {
  var scale = mach_timebase_info_data_t()
  mach_timebase_info(&scale)
  return Double(ticks) * Double(scale.numer) / Double(scale.denom) / 1_000_000
}
final class Observer: NSObject, SCStreamOutput, SCStreamDelegate, @unchecked Sendable {
  var observedApplication: NSRunningApplication?
  private let lock = NSLock()
  private var continuation: CheckedContinuation<Void, Never>?
  private var ended = false
  private var count = 0
  private var matcher: PixelMatcher?
  private var snapshotRequests = [String]()
  private var snapshotIds = Set<String>()

  func command(_ line: String) throws {
    if line.hasPrefix("pixels ") {
      let id = String(line.dropFirst(7))
      lock.lock()
      let valid = !id.isEmpty && id.utf8.count <= 128 && snapshotRequests.count < 4 &&
        snapshotIds.count < 16 && !snapshotIds.contains(id)
      if valid { snapshotRequests.append(id); snapshotIds.insert(id) }
      lock.unlock()
      guard valid else { throw PixelMatcherError.invalid("snapshot identity or capacity") }
    } else if line.hasPrefix("matcher ") {
      guard line.utf8.count <= 262_144 else {
        throw PixelMatcherError.invalid("configuration capacity")
      }
      let configuration = try JSONDecoder().decode(PixelMatcherConfiguration.self,
        from: Data(line.dropFirst(8).utf8))
      let configured = try PixelMatcher(configuration)
      lock.lock(); matcher = configured; lock.unlock()
      emit(["kind": "matcher-configured", "tag": configuration.tag])
    } else if line == "matcher-clear" {
      lock.lock(); matcher = nil; lock.unlock()
      emit(["kind": "matcher-cleared"])
    } else {
      throw PixelMatcherError.invalid("unknown recorder command")
    }
  }
  func emit(_ value: [String: Any]) {
    lock.lock()
    defer { lock.unlock() }
    do {
      var bytes = try JSONSerialization.data(withJSONObject: value, options: [.sortedKeys])
      bytes.append(10)
      try FileHandle.standardOutput.write(contentsOf: bytes)
    } catch {
      FileHandle.standardError.write(Data("native recorder output error: \(error)\n".utf8))
      exit(2)
    }
  }
  func finish() {
    lock.lock()
    ended = true
    let c = continuation
    continuation = nil
    lock.unlock()
    c?.resume()
  }
  func waitUntilStop() async {
    await withCheckedContinuation { c in
      lock.lock()
      if ended {
        lock.unlock()
        c.resume()
      } else {
        continuation = c
        lock.unlock()
      }
    }
  }
  func stream(_ stream: SCStream, didStopWithError error: Error) {
    emit(["kind": "error", "error": String(describing: error)])
    finish()
  }
  func stream(
    _ stream: SCStream, didOutputSampleBuffer buffer: CMSampleBuffer, of type: SCStreamOutputType
  ) {
    guard type == .screen else { return }
    let received = nativeMs()
    guard
      let attachments = CMSampleBufferGetSampleAttachmentsArray(buffer, createIfNecessary: false)
        as? [[SCStreamFrameInfo: Any]], let info = attachments.first,
      let status = info[.status] as? Int
    else {
      emit(["kind": "error", "error": "missing frame status"])
      finish()
      return
    }
    guard status == SCFrameStatus.complete.rawValue else {
      emit(["kind": "sample-status", "status": status, "receivedMs": received])
      return
    }
    guard let pixels = CMSampleBufferGetImageBuffer(buffer),
      let displayed = info[.displayTime] as? UInt64
    else {
      emit(["kind": "error", "error": "missing frame pixel buffer or display time"])
      finish()
      return
    }
    guard CVPixelBufferGetPixelFormatType(pixels) == kCVPixelFormatType_32BGRA else {
      emit(["kind": "error", "error": "unexpected capture format"])
      finish()
      return
    }
    guard CVPixelBufferLockBaseAddress(pixels, .readOnly) == kCVReturnSuccess else {
      emit(["kind": "error", "error": "capture pixel buffer lock failed"])
      finish()
      return
    }
    defer {
      if CVPixelBufferUnlockBaseAddress(pixels, .readOnly) != kCVReturnSuccess {
        emit(["kind": "error", "error": "capture pixel buffer unlock failed"])
        finish()
      }
    }
    guard let base = CVPixelBufferGetBaseAddress(pixels) else {
      emit(["kind": "error", "error": "capture pixel buffer has no base address"])
      finish()
      return
    }
    let width = CVPixelBufferGetWidth(pixels)
    let height = CVPixelBufferGetHeight(pixels)
    let stride = CVPixelBufferGetBytesPerRow(pixels)
    guard (1...2048).contains(width), (1...2048).contains(height),
      stride >= width * 4, stride <= 2048 * 4 + 4096,
      CVPixelBufferGetDataSize(pixels) >= stride * height
    else {
      emit(["kind": "error", "error": "capture pixel buffer geometry is invalid"])
      finish()
      return
    }
    let p = base.advanced(by: (height / 2) * stride + (width / 2) * 4).assumingMemoryBound(
      to: UInt8.self)
    count += 1
    if count > 20_000 {
      emit(["kind": "error", "error": "native recorder capacity exhausted"])
      finish()
      return
    }
    var frame: [String: Any] = [
      "kind": "frame", "index": count, "displayMs": ticksMs(displayed), "receivedMs": received,
      "ptsMs": CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(buffer)) * 1000,
      "width": width, "height": height, "rgb": [p[2], p[1], p[0]],
      "active": observedApplication?.isActive ?? false,
      "scaleFactor": info[.scaleFactor] ?? NSNull(),
      "contentScale": info[.contentScale] ?? NSNull(),
    ]
    lock.lock()
    let currentMatcher = matcher
    let snapshots = snapshotRequests
    snapshotRequests.removeAll(keepingCapacity: true)
    lock.unlock()
    if let currentMatcher {
      do {
        let begin = nativeMs()
        let bytes = UnsafeBufferPointer(start: base.assumingMemoryBound(to: UInt8.self),
          count: stride * height)
        frame["pixelMatch"] = try currentMatcher.match(bgra: bytes,
          width: width, height: height, stride: stride).dictionary
        frame["matcherMs"] = nativeMs() - begin
      } catch {
        emit(["kind": "error", "error": String(describing: error)])
        finish()
        return
      }
    }
    emit(frame)
    if !snapshots.isEmpty {
      // Calibration only: at most sixteen explicitly requested owned-window
      // rasters per process. Timed runs emit scalar matches, not image bytes.
      var packed = Data(capacity: width * height * 4)
      for y in 0..<height {
        packed.append(base.advanced(by: y * stride).assumingMemoryBound(to: UInt8.self),
          count: width * 4)
      }
      let encoded = packed.base64EncodedString()
      for id in snapshots {
        emit(["kind": "pixels", "id": id, "index": count,
          "displayMs": ticksMs(displayed), "receivedMs": received,
          "width": width, "height": height, "stride": width * 4, "bgra": encoded,
          "active": observedApplication?.isActive ?? false])
      }
    }
  }
}
@main struct Capture {
  @MainActor static func main() async {
    do {
      let session = CGSessionCopyCurrentDictionary() as? [String: Any] ?? [:]
      guard session[kCGSessionOnConsoleKey as String] as? Bool == true else {
        throw NSError(
          domain: "recorder", code: 5,
          userInfo: [
            NSLocalizedDescriptionKey: "No active console session for visible-display measurement"
          ])
      }
      guard session["CGSSessionScreenIsLocked"] as? Bool != true else {
        throw NSError(
          domain: "recorder", code: 6,
          userInfo: [
            NSLocalizedDescriptionKey:
              "Screen is locked; unlock this Mac before visible-display measurement"
          ])
      }
      guard CGPreflightScreenCaptureAccess() else {
        throw NSError(
          domain: "recorder", code: 1,
          userInfo: [NSLocalizedDescriptionKey: "Screen-recording access is not authorized"])
      }
      if CommandLine.arguments.count == 2 && CommandLine.arguments[1] == "--preflight" {
        FileHandle.standardOutput.write(
          Data(
            "{\"kind\":\"preflight\",\"authorized\":true,\"unlocked\":true,\"onConsole\":true}\n"
              .utf8))
        return
      }
      guard CommandLine.arguments.count == 3 || CommandLine.arguments.count == 4 else {
        throw NSError(
          domain: "recorder", code: 1,
          userInfo: [
            NSLocalizedDescriptionKey:
              "Owned window title, browser process family and optional capture width required"
          ])
      }
      _ = NSApplication.shared
      NSApplication.shared.setActivationPolicy(.prohibited)
      let title = CommandLine.arguments[1]
      let owners = Set(CommandLine.arguments[2].split(separator: ",").compactMap { Int32($0) })
      guard !owners.isEmpty else { throw NSError(domain: "recorder", code: 3) }
      let content = try await SCShareableContent.excludingDesktopWindows(
        true, onScreenWindowsOnly: true)
      let owned = content.windows.filter {
        owners.contains($0.owningApplication?.processID ?? -1) && $0.frame.width > 100
          && $0.frame.height > 100
      }
      let titled = owned.filter { $0.title?.contains(title) == true }
      let matches = titled.isEmpty ? owned : titled
      guard matches.count == 1, let window = matches.first else {
        throw NSError(
          domain: "recorder", code: 2,
          userInfo: [NSLocalizedDescriptionKey: "Expected one owned window; found \(matches.count)"]
        )
      }
      guard
        let application = NSRunningApplication(
          processIdentifier: window.owningApplication!.processID)
      else { throw NSError(domain: "recorder", code: 4) }
      let hiddenBefore = application.isHidden
      let unhidden = application.unhide()
      let activated = application.activate(options: [.activateAllWindows])
      let displays = NSScreen.screens.map { screen -> [String: Any] in
        let id =
          (screen.deviceDescription[NSDeviceDescriptionKey("NSScreenNumber")] as? NSNumber)?
          .uint32Value ?? 0
        let bounds = CGDisplayBounds(id)
        return [
          "displayId": id, "maxHz": screen.maximumFramesPerSecond,
          "nominalModeHz": CGDisplayCopyDisplayMode(id)?.refreshRate ?? 0,
          "bounds": [bounds.origin.x, bounds.origin.y, bounds.width, bounds.height],
          "intersectsWindow": bounds.intersects(window.frame),
        ]
      }
      let observer = Observer()
      let config = SCStreamConfiguration()
      observer.observedApplication = application
      let requestedWidth = CommandLine.arguments.count == 4 ? CommandLine.arguments[3] : "512"
      let width = requestedWidth == "points" ? Int(window.frame.width.rounded()) : Int(requestedWidth) ?? 0
      guard (128...2048).contains(width) else {
        throw PixelMatcherError.invalid("capture width must be 128 through 2048")
      }
      config.width = width
      config.height = max(128, Int(Double(width) * window.frame.height / window.frame.width))
      guard config.height <= 2048 else { throw PixelMatcherError.invalid("capture height") }
      config.pixelFormat = kCVPixelFormatType_32BGRA
      // Browser screenshots and calibration colors are sRGB. The default
      // follows the display gamut and cannot be compared as raw RGB bytes.
      config.colorSpaceName = CGColorSpace.sRGB
      config.minimumFrameInterval = CMTime(value: 1, timescale: 120)
      config.queueDepth = 3
      config.showsCursor = false
      config.capturesAudio = false
      let stream = SCStream(
        filter: SCContentFilter(desktopIndependentWindow: window), configuration: config,
        delegate: observer)
      try stream.addStreamOutput(
        observer, type: .screen,
        sampleHandlerQueue: DispatchQueue(label: "owned-window-frame-samples"))
      try await stream.startCapture()
      observer.emit([
        "kind": "ready", "windowId": window.windowID, "width": window.frame.width,
        "height": window.frame.height, "nativeMs": nativeMs(), "requestedHz": 120,
        "ownerPid": window.owningApplication?.processID ?? -1,
        "titleMatched": window.title?.contains(title) == true, "activated": activated,
        "unhidden": unhidden, "hiddenBefore": hiddenBefore, "hiddenAfter": application.isHidden,
        "active": application.isActive, "displays": displays,
        "captureColorSpace": "sRGB",
        "windowBounds": [
          window.frame.origin.x, window.frame.origin.y, window.frame.width, window.frame.height,
        ],
      ])
      Thread.detachNewThread {
        while let line = readLine() {
          if line == "stop" {
            observer.finish()
            return
          }
          if line.hasPrefix("ping ") {
            observer.emit(["kind": "pong", "id": String(line.dropFirst(5)), "nativeMs": nativeMs()])
          } else {
            do { try observer.command(line) }
            catch {
              observer.emit(["kind": "error", "error": String(describing: error)])
              observer.finish()
              return
            }
          }
        }
        observer.finish()
      }
      await observer.waitUntilStop()
      try await stream.stopCapture()
      observer.emit(["kind": "stopped", "nativeMs": nativeMs()])
    } catch {
      FileHandle.standardError.write(Data("native recorder failure: \(error)\n".utf8))
      exit(1)
    }
  }
}
