import Foundation
import Testing
@testable import MlchAudioCore

/// A tone (speech-like level) or silence, 16 kHz.
func audio(ms: Int, level: Float) -> [Float] {
    (0..<(Segmenter.rate * ms / 1000)).map { i in level * sin(Float(i) * 0.3) }
}

@Test func chunkerCutsAtPauseAfterMinimum() {
    var chunker = Chunker()
    var decisions: [Chunker.Decision] = []
    for _ in 0..<100 { decisions.append(chunker.push(speaking: true)) }  // 2 s of speech
    for _ in 0..<40 { decisions.append(chunker.push(speaking: false)) }  // 0.8 s pause
    #expect(decisions.contains(.cut))
    #expect(!decisions.prefix(100).contains(.cut))
}

@Test func chunkerDropsSilence() {
    var chunker = Chunker()
    var decisions: [Chunker.Decision] = []
    for _ in 0..<50 { decisions.append(chunker.push(speaking: false)) }
    #expect(decisions.contains(.drop))
    #expect(!decisions.contains(.cut))
}

@Test func chunkerCutsAtMaximum() {
    var chunker = Chunker()
    var cut = false
    for _ in 0..<(15_000 / Chunker.frameMs) { if chunker.push(speaking: true) == .cut { cut = true } }
    #expect(cut)
}

@Test func segmenterFindsSpeechBetweenSilences() {
    var segmenter = Segmenter()
    var chunks: [Segmenter.Chunk] = []
    chunks += segmenter.push(audio(ms: 1000, level: 0))
    chunks += segmenter.push(audio(ms: 2000, level: 0.3))
    chunks += segmenter.push(audio(ms: 1000, level: 0))
    chunks += segmenter.push(audio(ms: 1800, level: 0.3))
    if let last = segmenter.finish() { chunks.append(last) }
    #expect(chunks.count == 2)
    // The first chunk starts within the pre-roll before the speech at 1 s.
    #expect(chunks[0].startMs >= 600 && chunks[0].startMs <= 1000)
    #expect(chunks.allSatisfy { $0.rms > 0.1 })
}

@Test func segmenterIgnoresSilenceOnly() {
    var segmenter = Segmenter()
    #expect(segmenter.push(audio(ms: 5000, level: 0.001)).isEmpty)
    #expect(segmenter.finish() == nil)
}

@Test func wavRoundTrips() {
    let samples = audio(ms: 100, level: 0.5)
    let data = Wav.encode(samples, rate: 16_000)
    #expect(data.count == 44 + samples.count * 2)
    let back = Wav.decode(data)!
    #expect(back.count == samples.count)
    #expect(zip(back, samples).allSatisfy { abs($0 - $1) < 0.001 })
}

@Test func targetParsing() throws {
    #expect(try Helper.target(nil) == .all)
    #expect(try Helper.target("all") == .all)
    #expect(try Helper.target("us.zoom.xos") == .bundleId("us.zoom.xos"))
    #expect(try Helper.target(123) == .pid(123))
    #expect(throws: HelperError.self) { try Helper.target("; rm -rf") }
}

@Test func unknownCommandSaysWhatIsKnown() async {
    let box = Box()
    let helper = Helper(modelsDir: FileManager.default.temporaryDirectory.appendingPathComponent("mlch-test-models"), chunkRoot: FileManager.default.temporaryDirectory) { box.add($0) }
    await helper.handle(line: #"{"id": 7, "cmd": "dance"}"#)
    await helper.handle(line: #"{"id": 8, "cmd": "status"}"#)
    let replies = box.items
    #expect(replies[0]["ok"] as? Bool == false)
    #expect((replies[0]["error"] as? String)?.contains("Known:") == true)
    #expect(replies[1]["ok"] as? Bool == true)
    #expect((replies[1]["result"] as? [String: Any])?["model"] as? String == "missing")
}

final class Box: @unchecked Sendable {
    private let lock = NSLock()
    private var stored: [[String: Any]] = []
    func add(_ item: [String: Any]) { lock.withLock { stored.append(item) } }
    var items: [[String: Any]] { lock.withLock { stored } }
}
