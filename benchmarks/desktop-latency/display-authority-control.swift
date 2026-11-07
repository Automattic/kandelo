import Foundation
import CoreGraphics
@main struct Controls {
 static func rejects(_ body:() throws->Void){do{try body();fatalError("authority accepted invalid fixture")}catch{}}
 static func main() throws {
  let display=CGRect(x:-1440,y:100,width:1440,height:900),window=CGRect(x:-1400,y:150,width:900,height:600)
  let crop=try ownedDisplaySourceRect(display:display,window:window)
  precondition(crop==CGRect(x:40,y:50,width:900,height:600))
  rejects{_=try ownedDisplaySourceRect(display:display,window:window.offsetBy(dx:700,dy:0))}
  rejects{_=try ownedDisplaySourceRect(display:display,window:CGRect(x:0,y:0,width:0,height:1))}
  let target=DisplayWindowRecord(id:42,owner:123,bounds:window,alpha:1,onScreen:true)
  try validateOwnedDisplayWindows(expected:target,current:target,above:[])
  let outside=DisplayWindowRecord(id:43,owner:999,bounds:CGRect(x:20,y:20,width:20,height:20),alpha:1,onScreen:true)
  try validateOwnedDisplayWindows(expected:target,current:target,above:[outside])
  let overlay=DisplayWindowRecord(id:43,owner:123,bounds:window.insetBy(dx:10,dy:10),alpha:0.01,onScreen:true)
  rejects{try validateOwnedDisplayWindows(expected:target,current:target,above:[overlay])}
  let moved=DisplayWindowRecord(id:42,owner:123,bounds:window.offsetBy(dx:1,dy:0),alpha:1,onScreen:true)
  rejects{try validateOwnedDisplayWindows(expected:target,current:moved,above:[])}
  let hidden=DisplayWindowRecord(id:42,owner:123,bounds:window,alpha:1,onScreen:false)
  rejects{try validateOwnedDisplayWindows(expected:target,current:hidden,above:[])}
  let replacement=DisplayWindowRecord(id:42,owner:124,bounds:window,alpha:1,onScreen:true)
  rejects{try validateOwnedDisplayWindows(expected:target,current:replacement,above:[])}
  let reused=DisplayWindowRecord(id:44,owner:123,bounds:window,alpha:1,onScreen:true)
  rejects{try validateOwnedDisplayWindows(expected:target,current:reused,above:[])}
  let translucent=DisplayWindowRecord(id:42,owner:123,bounds:window,alpha:0.99,onScreen:true)
  rejects{try validateOwnedDisplayWindows(expected:target,current:translucent,above:[])}
  let invisibleOverlay=DisplayWindowRecord(id:43,owner:999,bounds:window,alpha:0,onScreen:true)
  try validateOwnedDisplayWindows(expected:target,current:target,above:[invisibleOverlay])
  let invalidOverlay=DisplayWindowRecord(id:43,owner:999,bounds:window,alpha:Double.nan,onScreen:true)
  rejects{try validateOwnedDisplayWindows(expected:target,current:target,above:[invalidOverlay])}
  // ROI policy permits overlap metadata, never a replacement owned identity.
  try validateOwnedDisplayWindows(expected:target,current:target,above:[overlay],responseROI:true)
  rejects{try validateOwnedDisplayWindows(expected:target,current:replacement,above:[overlay],responseROI:true)}
  var snapshots=[[String:Any]]()
  rejects{try validateOwnedDisplaySnapshot(expected:target,current:target,above:[overlay],diagnostic:{snapshots.append($0)})}
  precondition(snapshots.count==1 && (snapshots[0]["expected"] as? [String:Any])?["id"] as? UInt32 == 42)
  _=try JSONSerialization.data(withJSONObject:snapshots)
  rejects{try validateOwnedDisplaySnapshot(expected:target,current:nil,above:nil,diagnostic:{snapshots.append($0)})}
  precondition(snapshots.count==2 && snapshots[1]["inventoryComplete"] as? Bool == false)
  _=try JSONSerialization.data(withJSONObject:snapshots)
  let invalidBounds=DisplayWindowRecord(id:43,owner:123,bounds:CGRect(x:Double.nan,y:0,width:1,height:1),alpha:1,onScreen:true)
  rejects{try validateOwnedDisplayWindows(expected:target,current:target,above:[invalidBounds],responseROI:true)}
  try requireRecorderMatcherPolicy(responseROI:false,decision:false)
  try requireRecorderMatcherPolicy(responseROI:true,decision:true)
  rejects{try requireRecorderMatcherPolicy(responseROI:true,decision:false)}
  rejects{try requireRecorderMatcherPolicy(responseROI:false,decision:true)}
  print("Display crop/overlay/replacement/visibility authority controls passed; model fixtures only, no screen access or capture started.")
 }
}
