import AVFoundation
import CoreGraphics
import Foundation
import ImageIO
import UniformTypeIdentifiers

/// Videos read with AVFoundation, so mlch needs no ffmpeg: what a file holds,
/// pictures from it in order, and its sound as m4a (whole, or a part of it).
enum Media {
    /// Length, picture size and whether there is sound.
    static func info(_ path: String) async throws -> [String: Any] {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        let duration = try await asset.load(.duration).seconds
        let video = try await asset.loadTracks(withMediaType: .video).first
        let audio = try await asset.loadTracks(withMediaType: .audio)
        var result: [String: Any] = ["duration": duration.isFinite ? duration : 0, "audio": !audio.isEmpty, "video": video != nil]
        if let video {
            let size = try await video.load(.naturalSize).applying(try await video.load(.preferredTransform))
            result["width"] = Int(abs(size.width))
            result["height"] = Int(abs(size.height))
        }
        return result
    }

    /// `count` pictures spread evenly through the video, as JPEGs in `outDir` (each side at most `maxSide`).
    static func frames(_ path: String, count: Int, maxSide: Int, outDir: URL) async throws -> [String: Any] {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        guard try await asset.loadTracks(withMediaType: .video).first != nil else { throw HelperError("There is no picture in this file.") }
        let duration = try await asset.load(.duration).seconds
        guard duration.isFinite, duration > 0 else { throw HelperError("This video has no length that can be read.") }
        try FileManager.default.createDirectory(at: outDir, withIntermediateDirectories: true)
        let generator = AVAssetImageGenerator(asset: asset)
        generator.appliesPreferredTrackTransform = true
        generator.maximumSize = CGSize(width: maxSide, height: maxSide)
        // Near enough is fine, and much faster than exact frames.
        let tolerance = CMTime(seconds: min(1, duration / Double(max(count, 1)) / 4), preferredTimescale: 600)
        generator.requestedTimeToleranceBefore = tolerance
        generator.requestedTimeToleranceAfter = tolerance
        var frames: [[String: Any]] = []
        let total = max(1, min(count, 60))
        for index in 0..<total {
            let seconds = duration * (Double(index) + 0.5) / Double(total)
            guard let (image, actual) = try? await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600)) else { continue }
            let file = outDir.appendingPathComponent(String(format: "%03d.jpg", index))
            guard let destination = CGImageDestinationCreateWithURL(file as CFURL, UTType.jpeg.identifier as CFString, 1, nil) else { continue }
            CGImageDestinationAddImage(destination, image, [kCGImageDestinationLossyCompressionQuality: 0.8] as CFDictionary)
            guard CGImageDestinationFinalize(destination) else { continue }
            frames.append(["path": file.path, "at": actual.seconds])
        }
        if frames.isEmpty { throw HelperError("No pictures could be taken from this video.") }
        return ["duration": duration, "frames": frames]
    }

    /// The sound as m4a in `out`, from `start` seconds for `length` seconds (whole when absent).
    static func extractAudio(_ path: String, out: URL, start: Double?, length: Double?) async throws -> [String: Any] {
        let asset = AVURLAsset(url: URL(fileURLWithPath: path))
        guard try await !asset.loadTracks(withMediaType: .audio).isEmpty else { throw HelperError("There is no sound in this file.") }
        guard let session = AVAssetExportSession(asset: asset, presetName: AVAssetExportPresetAppleM4A) else {
            throw HelperError("The sound of this file can't be taken out.")
        }
        try? FileManager.default.removeItem(at: out)
        session.outputURL = out
        session.outputFileType = .m4a
        if let start {
            let from = CMTime(seconds: start, preferredTimescale: 600)
            let duration = length.map { CMTime(seconds: $0, preferredTimescale: 600) } ?? .positiveInfinity
            session.timeRange = CMTimeRange(start: from, duration: duration)
        }
        let box = SessionBox(session)
        await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
            box.session.exportAsynchronously { done.resume() }
        }
        guard session.status == .completed else {
            throw HelperError("Taking out the sound failed: \(session.error?.localizedDescription ?? "unknown")")
        }
        let size = (try? FileManager.default.attributesOfItem(atPath: out.path)[.size] as? Int) ?? 0
        return ["path": out.path, "bytes": size]
    }
}

/// AVAssetExportSession isn't Sendable; it is only touched from one place at a time here.
private final class SessionBox: @unchecked Sendable {
    let session: AVAssetExportSession
    init(_ session: AVAssetExportSession) { self.session = session }
}
