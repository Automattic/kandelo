import Foundation
import CoreGraphics

struct DisplayWindowRecord {
  let id: CGWindowID
  let owner: pid_t
  let bounds: CGRect
  let alpha: Double
  let onScreen: Bool
}
enum DisplayAuthorityError: Error, CustomStringConvertible {
  case invalid(String)
  var description: String { switch self {case .invalid(let s):return "display authority: \(s)"} }
}
func ownedDisplaySourceRect(display: CGRect, window: CGRect) throws -> CGRect {
  for r in [display,window] {
    guard [r.minX,r.minY,r.width,r.height].allSatisfy({$0.isFinite}),r.width>0,r.height>0 else {
      throw DisplayAuthorityError.invalid("non-finite or empty capture bounds")
    }
  }
  guard display.contains(window) else {throw DisplayAuthorityError.invalid("window crosses display boundary")}
  let source=window.offsetBy(dx: -display.minX,dy: -display.minY)
  guard CGRect(origin:.zero,size:display.size).contains(source) else {
    throw DisplayAuthorityError.invalid("crop exceeds selected display")
  }
  return source
}
func validateOwnedDisplayWindows(expected: DisplayWindowRecord, current: DisplayWindowRecord,
  above: [DisplayWindowRecord]) throws {
  guard expected.id == current.id,expected.owner == current.owner,current.onScreen,
    current.alpha == 1,current.bounds == expected.bounds else {
    throw DisplayAuthorityError.invalid("owned window owner, visibility or geometry changed")
  }
  guard above.count <= 10000 else {throw DisplayAuthorityError.invalid("window inventory capacity")}
  for other in above {
    guard other.alpha.isFinite,other.alpha>=0,other.alpha<=1 else {throw DisplayAuthorityError.invalid("invalid overlay alpha")}
    if other.onScreen && other.alpha>0 && !other.bounds.intersection(expected.bounds).isEmpty {
      // Same-browser popovers are still occlusions. Owner equality and app
      // foreground state cannot prove that the target content is unobscured.
      throw DisplayAuthorityError.invalid("overlay \(other.id) intersects owned capture rectangle")
    }
  }
}
final class OwnedDisplayCaptureAuthority: @unchecked Sendable {
  let expected: DisplayWindowRecord
  init(id:CGWindowID,owner:pid_t,bounds:CGRect){expected=DisplayWindowRecord(id:id,owner:owner,bounds:bounds,alpha:1,onScreen:true)}
  private func records(_ options:CGWindowListOption)->[DisplayWindowRecord]? {
    guard let raw=CGWindowListCopyWindowInfo(options,expected.id) as? [[String:Any]],raw.count<=10000 else{return nil}
    var result=[DisplayWindowRecord]()
    for entry in raw {
      guard let id=entry[kCGWindowNumber as String] as? UInt32,
        let owner=entry[kCGWindowOwnerPID as String] as? Int32,
        let dictionary=entry[kCGWindowBounds as String] as? NSDictionary,
        let bounds=CGRect(dictionaryRepresentation:dictionary),
        let alpha=entry[kCGWindowAlpha as String] as? Double,
        let onScreen=entry[kCGWindowIsOnscreen as String] as? Bool else {return nil}
      result.append(DisplayWindowRecord(id:id,owner:owner,bounds:bounds,alpha:alpha,onScreen:onScreen))
    }
    return result
  }
  func check() throws {
    guard let current=records(.optionIncludingWindow)?.first(where:{$0.id==expected.id}),
      let above=records([.optionOnScreenAboveWindow,.excludeDesktopElements]) else {
      throw DisplayAuthorityError.invalid("missing owned window or overlay inventory")
    }
    try validateOwnedDisplayWindows(expected:expected,current:current,above:above)
  }
}
