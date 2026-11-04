import Foundation

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
    guard (1...64).contains(width), (1...64).contains(height), (6...256).contains(points.count)
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
