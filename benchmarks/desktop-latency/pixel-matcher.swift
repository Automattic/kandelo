import Foundation
import CoreGraphics

// Shared by the native recorder and offline controls. Coordinates describe the
// captured window raster, never the user's complete desktop or a guest buffer.
struct PixelTemplatePoint: Codable {
  let x: Int
  let y: Int
  let rgb: [Int]
}
struct PixelTemplate: Codable {
  let width: Int
  let height: Int
  let points: [PixelTemplatePoint]

  func validate() throws {
    guard (1...128).contains(width), (1...128).contains(height), (6...256).contains(points.count)
    else { throw PixelMatcherError.invalid("template bounds") }
    var seen = Set<Int>()
    for point in points {
      guard (0..<width).contains(point.x), (0..<height).contains(point.y),
        point.rgb.count == 3, point.rgb.allSatisfy({ (0...255).contains($0) }),
        seen.insert(point.y * width + point.x).inserted
      else { throw PixelMatcherError.invalid("template point") }
    }
  }
}
struct PixelCandidate: Codable {
  let id: String
  let x: Int
  let y: Int
  let template: PixelTemplate?
}
struct PixelMatcherConfiguration: Codable {
  let tag: String
  let template: PixelTemplate
  let candidates: [PixelCandidate]
  let searchRadius: Int
  let maxChannelError: Int
  let maxMeanError: Double

  func validate() throws {
    guard !tag.isEmpty, tag.utf8.count <= 128,
      (1...128).contains(candidates.count), (0...2).contains(searchRadius),
      (0...64).contains(maxChannelError), maxMeanError.isFinite,
      maxMeanError >= 0, maxMeanError <= Double(maxChannelError)
    else { throw PixelMatcherError.invalid("configuration bounds or work budget") }
    try template.validate()
    var totalPoints = 0
    for candidate in candidates {
      let selected = candidate.template ?? template
      try selected.validate()
      totalPoints += selected.points.count
    }
    guard totalPoints * (2 * searchRadius + 1) * (2 * searchRadius + 1) <= 131_072
    else { throw PixelMatcherError.invalid("configuration work budget") }
    var ids = Set<String>()
    var positions = Set<String>()
    for candidate in candidates {
      guard !candidate.id.isEmpty, candidate.id.utf8.count <= 128,
        (0...2048).contains(candidate.x), (0...2048).contains(candidate.y),
        ids.insert(candidate.id).inserted,
        positions.insert("\(candidate.x),\(candidate.y)").inserted
      else { throw PixelMatcherError.invalid("duplicate or invalid candidate") }
    }
  }
}
enum PixelMatcherError: Error, CustomStringConvertible {
  case invalid(String)
  var description: String {
    switch self { case .invalid(let detail): return "pixel matcher: \(detail)" }
  }
}
struct PixelMatch: Codable {
  let id: String
  let x: Int
  let y: Int
  let meanError: Double
  let maxError: Int
}
struct PixelMatchResult: Codable {
  let tag: String
  let state: String
  let matches: [PixelMatch]
  let pointComparisons: Int

  var dictionary: [String: Any] {
    ["tag": tag, "state": state, "pointComparisons": pointComparisons,
     "matches": matches.map { ["id": $0.id, "x": $0.x, "y": $0.y,
       "meanError": $0.meanError, "maxError": $0.maxError] as [String: Any] }]
  }
}
struct PixelMatcher {
  let configuration: PixelMatcherConfiguration
  init(_ configuration: PixelMatcherConfiguration) throws {
    try configuration.validate()
    self.configuration = configuration
  }
  func match(bgra: UnsafeBufferPointer<UInt8>, width: Int, height: Int, stride: Int) throws
    -> PixelMatchResult
  {
    guard (1...2048).contains(width), (1...2048).contains(height),
      stride >= width * 4, stride <= 2048 * 4 + 4096,
      bgra.count >= stride * height
    else { throw PixelMatcherError.invalid("raster bounds") }
    let c = configuration
    var matches = [PixelMatch]()
    var comparisons = 0
    for candidate in c.candidates {
      let radius = c.searchRadius
      let template = candidate.template ?? c.template
      guard candidate.x >= radius, candidate.y >= radius,
        candidate.x + template.width + radius <= width,
        candidate.y + template.height + radius <= height
      else { throw PixelMatcherError.invalid("candidate outside captured window") }
      var best: PixelMatch?
      for dy in -radius...radius {
        for dx in -radius...radius {
          var total = 0
          var largest = 0
          for point in template.points {
            let at = (candidate.y + dy + point.y) * stride + (candidate.x + dx + point.x) * 4
            let r = abs(Int(bgra[at + 2]) - point.rgb[0])
            let g = abs(Int(bgra[at + 1]) - point.rgb[1])
            let b = abs(Int(bgra[at]) - point.rgb[2])
            largest = max(largest, max(r, max(g, b)))
            total += r + g + b
            comparisons += 1
          }
          let mean = Double(total) / Double(3 * template.points.count)
          if largest <= c.maxChannelError && mean <= c.maxMeanError &&
              (best == nil || mean < best!.meanError) {
            best = PixelMatch(id: candidate.id, x: candidate.x + dx, y: candidate.y + dy,
              meanError: mean, maxError: largest)
          }
        }
      }
      if let best { matches.append(best) }
    }
    return PixelMatchResult(tag: c.tag,
      state: matches.isEmpty ? "unmatched" : matches.count == 1 ? "matched" : "ambiguous",
      matches: matches, pointComparisons: comparisons)
  }
}

// Complete response-ROI proof is deliberately separate from sparse recognition.
// A learned foreground point set cannot prove background/old-position erasure.
struct DecisionRegion: Codable {
  let x: Int
  let y: Int
  let width: Int
  let height: Int
  let rgb: String
}
struct DecisionState: Codable { let id: String; let regions: [DecisionRegion] }
struct DecisionConfiguration: Codable {
  let schema: String
  let session: String
  let trial: String
  let challenge: String
  let tag: String
  let states: [DecisionState]
  let searchRadius: Int
  let maxChannelError: Int
  let maxMeanError: Double
}
struct DecisionMatch: Codable {
  let id: String
  let dx: Int
  let dy: Int
  let meanError: Double
  let maxError: Int
}
struct DecisionResult: Codable {
  let schema: String
  let session: String
  let trial: String
  let challenge: String
  let tag: String
  let state: String
  let matches: [DecisionMatch]
  let requiredPixels: Int
  let pointComparisons: Int
  var dictionary: [String: Any] {
    ["schema":schema,"session":session,"trial":trial,"challenge":challenge,"tag":tag,
      "state":state,"requiredPixels":requiredPixels,"pointComparisons":pointComparisons,
      "matches":matches.map{["id":$0.id,"dx":$0.dx,"dy":$0.dy,
        "meanError":$0.meanError,"maxError":$0.maxError] as [String:Any]}]
  }
}
struct DecisionMatcher {
  private struct Region { let spec: DecisionRegion; let rgb: [UInt8] }
  private struct State { let id: String; let regions: [Region] }
  let configuration: DecisionConfiguration
  private let states: [State]
  private let pixels: Int
  init(_ c: DecisionConfiguration) throws {
    guard c.schema == "complete-response-roi/v1", !c.session.isEmpty,c.session.utf8.count<=128,
      !c.trial.isEmpty,c.trial.utf8.count<=128,!c.tag.isEmpty,c.tag.utf8.count<=128,
      c.challenge.utf8.count==32,c.challenge.utf8.allSatisfy({(48...57).contains($0)||(97...102).contains($0)}),
      (0...1).contains(c.searchRadius),(0...64).contains(c.maxChannelError),
      c.maxMeanError.isFinite,c.maxMeanError>=0,c.maxMeanError<=Double(c.maxChannelError),
      c.states.count==2,Set(c.states.map{$0.id})==Set(["predecessor","response"])
    else {throw PixelMatcherError.invalid("decision identity or bounds")}
    var parsed=[State](), count=0
    var geometry: [String]?
    for state in c.states {
      guard (1...8).contains(state.regions.count) else {throw PixelMatcherError.invalid("decision region count")}
      var regions=[Region](), rects=[CGRect](), shape=[String](), statePixels=0
      for r in state.regions {
        guard (0...2048).contains(r.x),(0...2048).contains(r.y),
          (1...128).contains(r.width),(1...128).contains(r.height),
          let data=Data(base64Encoded:r.rgb),data.count==r.width*r.height*3
        else {throw PixelMatcherError.invalid("incomplete decision region")}
        let rect=CGRect(x:r.x,y:r.y,width:r.width,height:r.height)
        guard rects.allSatisfy({$0.intersection(rect).isEmpty}) else {throw PixelMatcherError.invalid("overlapping decision regions")}
        rects.append(rect);shape.append("\(r.x),\(r.y),\(r.width),\(r.height)")
        statePixels+=r.width*r.height;regions.append(Region(spec:r,rgb:Array(data)))
      }
      if let geometry {guard geometry==shape else {throw PixelMatcherError.invalid("decision coverage differs by state")}}
      else {geometry=shape;count=statePixels}
      parsed.append(State(id:state.id,regions:regions))
    }
    // Keep the existing native matching work ceiling. We may refuse an ROI;
    // silently subsampling it would turn a complete proof back into recognition.
    guard count*2*(2*c.searchRadius+1)*(2*c.searchRadius+1)<=131_072 else {
      throw PixelMatcherError.invalid("decision comparison budget")
    }
    configuration=c;states=parsed;pixels=count
  }
  func match(bgra:UnsafeBufferPointer<UInt8>,width:Int,height:Int,stride:Int)throws->DecisionResult {
    guard (1...2048).contains(width),(1...2048).contains(height),stride>=width*4,
      stride<=width*4+4096,bgra.count==stride*height else {throw PixelMatcherError.invalid("decision raster bounds")}
    let c=configuration
    var matches=[DecisionMatch](),comparisons=0
    for state in states {
      var best:DecisionMatch?
      for dy in -c.searchRadius...c.searchRadius {for dx in -c.searchRadius...c.searchRadius {
        var total=0,largest=0
        for region in state.regions {
          let r=region.spec
          guard r.x+dx>=0,r.y+dy>=0,r.x+dx+r.width<=width,r.y+dy+r.height<=height else {
            throw PixelMatcherError.invalid("decision ROI outside raster")
          }
          for y in 0..<r.height {for x in 0..<r.width {
            let p=(r.y+dy+y)*stride+(r.x+dx+x)*4,q=(y*r.width+x)*3
            let er=abs(Int(bgra[p+2])-Int(region.rgb[q]))
            let eg=abs(Int(bgra[p+1])-Int(region.rgb[q+1]))
            let eb=abs(Int(bgra[p])-Int(region.rgb[q+2]))
            total+=er+eg+eb;largest=max(largest,max(er,max(eg,eb)));comparisons+=1
          }}
        }
        let mean=Double(total)/Double(pixels*3)
        if largest<=c.maxChannelError && mean<=c.maxMeanError && (best==nil || mean<best!.meanError) {
          best=DecisionMatch(id:state.id,dx:dx,dy:dy,meanError:mean,maxError:largest)
        }
      }}
      if let best {matches.append(best)}
    }
    return DecisionResult(schema:c.schema,session:c.session,trial:c.trial,challenge:c.challenge,tag:c.tag,
      state:matches.isEmpty ? "unmatched" : matches.count==1 ? "matched" : "ambiguous",
      matches:matches,requiredPixels:pixels,pointComparisons:comparisons)
  }
}
