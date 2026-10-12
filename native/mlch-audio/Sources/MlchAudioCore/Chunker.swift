import Foundation

/// The chunking decision, the same rules as the microphone's (src/lib/voice/recorder.ts):
/// a chunk ends at a pause after at least `minChunkMs`, at a shorter pause once it is long,
/// or at `maxChunkMs` regardless; silence-only stretches are dropped but for a pre-roll.
public struct Chunker: Sendable {
    public enum Decision: Equatable, Sendable { case keep, cut, drop }

    public static let frameMs = 20
    static let minChunkMs = 1_500
    static let pauseMs = 650
    static let longChunkMs = 8_000
    static let shortPauseMs = 250
    static let maxChunkMs = 15_000
    public static let prerollMs = 300
    static let minSpeechMs = 250

    public private(set) var chunkMs = 0
    public private(set) var speechMs = 0
    public private(set) var silenceMs = 0

    public init() {}

    public var hasSpeech: Bool { speechMs >= Self.minSpeechMs }

    public mutating func push(speaking: Bool) -> Decision {
        chunkMs += Self.frameMs
        if speaking {
            speechMs += Self.frameMs
            silenceMs = 0
        } else {
            silenceMs += Self.frameMs
        }
        if !hasSpeech {
            return chunkMs > Self.prerollMs + Self.frameMs && (silenceMs >= 500 || chunkMs >= Self.maxChunkMs) ? .drop : .keep
        }
        if chunkMs >= Self.maxChunkMs { return .cut }
        if silenceMs >= Self.pauseMs && chunkMs >= Self.minChunkMs { return .cut }
        if silenceMs >= Self.shortPauseMs && chunkMs >= Self.longChunkMs { return .cut }
        return .keep
    }

    public mutating func reset(keptMs: Int = 0) {
        chunkMs = keptMs
        speechMs = 0
        silenceMs = keptMs
    }
}

/// 16 kHz mono samples in, finished chunks out. Energy-based speech detection
/// with a slowly tracked noise floor, as in the browser recorder.
public struct Segmenter: Sendable {
    public static let rate = 16_000
    static let frameSize = rate * Chunker.frameMs / 1000

    public struct Chunk: Sendable {
        public let samples: [Float]
        /// Offset of the chunk's first sample from the start of capture, in ms.
        public let startMs: Int
        public let rms: Float
    }

    private var chunker = Chunker()
    private var frames: [[Float]] = []
    private var pending: [Float] = []
    private var noiseFloor: Float = 0.004
    private var framesSeen = 0
    private var chunkStartFrame = 0

    public init() {}

    public mutating func push(_ samples: [Float]) -> [Chunk] {
        pending.append(contentsOf: samples)
        var out: [Chunk] = []
        var offset = 0
        while offset + Self.frameSize <= pending.count {
            if let chunk = frame(Array(pending[offset..<offset + Self.frameSize])) { out.append(chunk) }
            offset += Self.frameSize
        }
        pending.removeFirst(offset)
        return out
    }

    /// What is left, if it has speech in it.
    public mutating func finish() -> Chunk? {
        defer { frames = []; pending = []; chunker.reset() }
        return chunker.hasSpeech ? flush() : nil
    }

    private mutating func frame(_ frame: [Float]) -> Chunk? {
        var sum: Float = 0
        for s in frame { sum += s * s }
        let rms = (sum / Float(frame.count)).squareRoot()
        let speaking = rms > max(0.012, noiseFloor * 3)
        if !speaking { noiseFloor = noiseFloor * 0.98 + rms * 0.02 }
        if frames.isEmpty { chunkStartFrame = framesSeen }
        framesSeen += 1
        frames.append(frame)
        switch chunker.push(speaking: speaking) {
        case .cut:
            return flush()
        case .drop:
            let keep = Int((Double(Chunker.prerollMs) / Double(Chunker.frameMs)).rounded(.up))
            frames = Array(frames.suffix(keep))
            chunker.reset(keptMs: frames.count * Chunker.frameMs)
            chunkStartFrame = framesSeen - frames.count
            return nil
        case .keep:
            return nil
        }
    }

    private mutating func flush() -> Chunk {
        let all = frames.flatMap { $0 }
        frames = []
        chunker.reset()
        var sum: Float = 0
        for s in all { sum += s * s }
        let rms = all.isEmpty ? 0 : (sum / Float(all.count)).squareRoot()
        return Chunk(samples: all, startMs: chunkStartFrame * Chunker.frameMs, rms: rms)
    }
}
