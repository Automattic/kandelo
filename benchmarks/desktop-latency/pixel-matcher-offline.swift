import Foundation

private struct PixelRequest: Decodable {
  let configuration: PixelMatcherConfiguration
  let width: Int
  let height: Int
  let stride: Int
  let bgra: String
}
@main struct OfflinePixelMatcher {
  static func main() {
    do {
      while let line = readLine() {
        guard line.utf8.count <= 24_000_000 else {
          throw PixelMatcherError.invalid("offline request capacity")
        }
        let request = try JSONDecoder().decode(PixelRequest.self, from: Data(line.utf8))
        guard (1...2048).contains(request.width), (1...2048).contains(request.height),
          request.stride >= request.width * 4, request.stride <= 2048 * 4 + 4096,
          let bytes = Data(base64Encoded: request.bgra),
          bytes.count == request.stride * request.height
        else { throw PixelMatcherError.invalid("offline raster size") }
        let matcher = try PixelMatcher(request.configuration)
        let result = try bytes.withUnsafeBytes { raw in
          try matcher.match(bgra: raw.bindMemory(to: UInt8.self), width: request.width,
            height: request.height, stride: request.stride)
        }
        var encoded = try JSONEncoder().encode(result)
        encoded.append(10)
        try FileHandle.standardOutput.write(contentsOf: encoded)
      }
    } catch {
      FileHandle.standardError.write(Data("offline matcher failure: \(error)\n".utf8))
      exit(2)
    }
  }
}
