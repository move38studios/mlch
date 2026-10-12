import FluidAudio
import Foundation

/// Parakeet (Ultra, a post-trained v3: 25 European languages) on the Neural
/// Engine through FluidAudio. Models live in `modelsDir`; nothing downloads
/// unless `download` is called.
public actor LocalTranscriber {
    public static let version: AsrModelVersion = .ultra

    private let modelsDir: URL
    private var manager: AsrManager?
    private var loading: Task<AsrManager, Error>?

    public init(modelsDir: URL) {
        self.modelsDir = modelsDir
    }

    /// The folder FluidAudio expects for this model, inside our models folder.
    var repoDir: URL {
        modelsDir.appendingPathComponent(Repo.parakeetUltra.folderName, isDirectory: true)
    }

    public var modelPresent: Bool {
        AsrModels.modelsExist(at: repoDir, version: Self.version)
    }

    public var loaded: Bool { manager != nil }

    public func download(progress: @escaping @Sendable (Double, String) -> Void) async throws {
        try FileManager.default.createDirectory(at: modelsDir, withIntermediateDirectories: true)
        // FluidAudio reports each of the model's parts from 0 to 1 in turn; this makes one overall figure.
        let overall = OverallProgress(parts: 4)
        try await AsrModels.download(to: repoDir, version: Self.version) { update in
            let phase: String
            switch update.phase {
            case .listing: phase = "listing"
            case .downloading: phase = "downloading"
            case .compiling: phase = "compiling"
            }
            progress(overall.update(update.fractionCompleted), phase)
        }
    }

    /// Loads the model once (compiling it on first use takes a while).
    public func warm() async throws {
        _ = try await asr()
    }

    private func asr() async throws -> AsrManager {
        if let manager { return manager }
        if let loading { return try await loading.value }
        guard modelPresent else { throw HelperError("The local model is not downloaded.") }
        let dir = repoDir
        let task = Task { () throws -> AsrManager in
            let models = try await AsrModels.load(from: dir, version: Self.version)
            let manager = AsrManager(config: .default)
            try await manager.loadModels(models)
            return manager
        }
        loading = task
        defer { loading = nil }
        let ready = try await task.value
        manager = ready
        return ready
    }

    /// Text of a WAV file (any rate; resampled to 16 kHz mono).
    public func transcribe(wav url: URL) async throws -> String {
        let samples = try AudioConverter().resampleAudioFile(url)
        return try await transcribe(samples: samples)
    }

    public func transcribe(samples: [Float]) async throws -> String {
        let asr = try await asr()
        // Very short chunks are padded to a second of silence; the model wants at least that.
        var input = samples
        if input.count < Segmenter.rate { input += [Float](repeating: 0, count: Segmenter.rate - input.count) }
        var state = TdtDecoderState.make(decoderLayers: await asr.decoderLayerCount)
        let result = try await asr.transcribe(input, decoderState: &state)
        return result.text.trimmingCharacters(in: .whitespacesAndNewlines)
    }
}

/// Several 0-to-1 progress runs, one after another, as one 0-to-1 figure that never goes back.
final class OverallProgress: @unchecked Sendable {
    private let parts: Int
    private var part = 0
    private var last = 0.0
    private var reported = 0.0
    private let lock = NSLock()

    init(parts: Int) { self.parts = parts }

    func update(_ fraction: Double) -> Double {
        lock.withLock {
            if fraction + 0.2 < last { part = min(parts - 1, part + 1) }
            last = fraction
            reported = max(reported, min(0.99, (Double(part) + fraction) / Double(parts)))
            return reported
        }
    }
}

public struct HelperError: Error, CustomStringConvertible {
    public let description: String
    public init(_ description: String) { self.description = description }
}
