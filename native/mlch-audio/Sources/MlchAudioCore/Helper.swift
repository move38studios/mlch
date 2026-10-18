import Foundation

/// The helper's protocol, one JSON object per line each way.
///
/// In:  {"id": 1, "cmd": "status" | "download-model" | "warm" | "transcribe" | "media-info" | "frames" | "extract-audio" | "tap-start" | "tap-stop" | "shutdown", ...}
/// Out: {"id": 1, "ok": true, "result": {...}} or {"id": 1, "ok": false, "error": "..."}
/// Events (no id): {"event": "model-progress", "fraction": 0.4, "phase": "downloading"}
///                 {"event": "chunk", "session": "...", "path": "/tmp/.../0001.wav", "at": <epoch ms>, "durationMs": 2400, "rms": 0.05}
///                 {"event": "tap-level", "session": "...", "peak": 0.3}
///                 {"event": "tap-ended", "session": "...", "error": "..."}
public final class Helper: @unchecked Sendable {
    public typealias Output = @Sendable ([String: Any]) -> Void

    private let output: Output
    private let transcriber: LocalTranscriber
    private let chunkRoot: URL
    private let lock = NSLock()
    private var taps: [String: ProcessTap] = [:]
    private var downloading: Task<Void, Error>?
    public private(set) var shuttingDown = false

    public init(modelsDir: URL, chunkRoot: URL, output: @escaping Output) {
        self.transcriber = LocalTranscriber(modelsDir: modelsDir)
        self.chunkRoot = chunkRoot
        self.output = output
    }

    /// One request line. Replies (and events) go to `output`.
    public func handle(line: String) async {
        guard let data = line.data(using: .utf8),
              let message = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
            output(["ok": false, "error": "Not a JSON object."])
            return
        }
        let id = message["id"]
        do {
            let result = try await perform(message)
            output(["id": id ?? NSNull(), "ok": true, "result": result])
        } catch {
            output(["id": id ?? NSNull(), "ok": false, "error": "\(error)"])
        }
    }

    func perform(_ message: [String: Any]) async throws -> [String: Any] {
        switch message["cmd"] as? String {
        case "status":
            let tapping = lock.withLock { Array(taps.keys) }
            return [
                "model": await transcriber.modelPresent ? "present" : "missing",
                "loaded": await transcriber.loaded,
                "downloading": lock.withLock { downloading != nil },
                "sessions": tapping,
                "audioCapture": AudioPermission.check().rawValue,
                "osSupportsTap": ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 14, minorVersion: 2, patchVersion: 0)),
            ]
        case "download-model":
            let task: Task<Void, Error> = lock.withLock {
                if let downloading { return downloading }
                let output = self.output
                let task = Task { [transcriber] in
                    try await transcriber.download { fraction, phase in
                        output(["event": "model-progress", "fraction": fraction, "phase": phase])
                    }
                }
                downloading = task
                return task
            }
            defer { lock.withLock { downloading = nil } }
            try await task.value
            return ["model": "present"]
        case "warm":
            let started = Date()
            try await transcriber.warm()
            return ["ms": Int(Date().timeIntervalSince(started) * 1000)]
        case "transcribe":
            guard let path = message["path"] as? String, path.hasPrefix("/") else { throw HelperError("transcribe needs an absolute path.") }
            let started = Date()
            let text = try await transcriber.transcribe(wav: URL(fileURLWithPath: path))
            return ["text": text, "ms": Int(Date().timeIntervalSince(started) * 1000)]
        case "media-info":
            return try await Media.info(try Self.absolute(message["path"]))
        case "frames":
            let path = try Self.absolute(message["path"])
            let out = try Self.absolute(message["out"])
            return try await Media.frames(path, count: message["count"] as? Int ?? 8, maxSide: message["maxSide"] as? Int ?? 768, outDir: URL(fileURLWithPath: out, isDirectory: true))
        case "extract-audio":
            let path = try Self.absolute(message["path"])
            let out = try Self.absolute(message["out"])
            return try await Media.extractAudio(path, out: URL(fileURLWithPath: out), start: message["start"] as? Double ?? (message["start"] as? Int).map(Double.init), length: message["length"] as? Double ?? (message["length"] as? Int).map(Double.init))
        case "tap-start":
            return try startTap(message)
        case "tap-stop":
            guard let session = message["session"] as? String else { throw HelperError("tap-stop needs a session.") }
            return ["flushed": stopTap(session)]
        case "shutdown":
            shuttingDown = true
            stopAll()
            return [:]
        default:
            throw HelperError("Unknown command. Known: status, download-model, warm, transcribe, media-info, frames, extract-audio, tap-start, tap-stop, shutdown.")
        }
    }

    static func absolute(_ value: Any?) throws -> String {
        guard let path = value as? String, path.hasPrefix("/") else { throw HelperError("Give an absolute path.") }
        return path
    }

    static let noPermission = "mlch can't hear the Mac's sound. Turn on mlch in System Settings > Privacy & Security > Screen & System Audio Recording, under System Audio Recording Only."

    static func target(_ value: Any?) throws -> ProcessTap.Target {
        if value == nil || (value as? String) == "all" { return .all }
        if let pid = value as? Int { return .pid(pid_t(pid)) }
        if let bundle = value as? String, bundle.range(of: #"^[A-Za-z0-9.-]{3,200}$"#, options: .regularExpression) != nil { return .bundleId(bundle) }
        throw HelperError("target is \"all\", a bundle id (us.zoom.xos) or a process id.")
    }

    private func startTap(_ message: [String: Any]) throws -> [String: Any] {
        let target = try Self.target(message["target"])
        // Denied means the tap would only ever hear silence. Unknown goes ahead: starting it asks.
        if AudioPermission.check() == .denied { throw HelperError(Self.noPermission) }
        let session = (message["session"] as? String).flatMap { $0.range(of: #"^[\w-]{1,64}$"#, options: .regularExpression) != nil ? $0 : nil } ?? UUID().uuidString
        let dir = chunkRoot.appendingPathComponent(session, isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        let startedAt = Date().timeIntervalSince1970 * 1000
        let output = self.output
        let counter = Counter()
        let emit: @Sendable (Segmenter.Chunk) -> Void = { chunk in
            let file = dir.appendingPathComponent(String(format: "%05d.wav", counter.next()))
            do {
                try Wav.encode(chunk.samples, rate: Segmenter.rate).write(to: file)
                output([
                    "event": "chunk", "session": session, "path": file.path,
                    "at": Int(startedAt) + chunk.startMs,
                    "durationMs": chunk.samples.count * 1000 / Segmenter.rate,
                    "rms": Double(chunk.rms),
                ])
            } catch {
                log("chunk write failed: \(error)")
            }
        }
        let tap = ProcessTap(target: target, onChunk: emit, onLevel: { peak in
            output(["event": "tap-level", "session": session, "peak": Double(peak)])
        })
        try tap.start()
        lock.withLock { taps[session] = tap }
        return ["session": session, "dir": dir.path]
    }

    /// Ends every capture (sending what is left of each).
    public func stopAll() {
        for session in lock.withLock({ Array(taps.keys) }) { _ = stopTap(session) }
    }

    private func stopTap(_ session: String) -> Bool {
        guard let tap = lock.withLock({ taps.removeValue(forKey: session) }) else { return false }
        guard let last = tap.stop() else { return false }
        // Same path as a chunk cut at a pause.
        let dir = chunkRoot.appendingPathComponent(session, isDirectory: true)
        let file = dir.appendingPathComponent("last-\(UUID().uuidString.prefix(8)).wav")
        guard (try? Wav.encode(last.samples, rate: Segmenter.rate).write(to: file)) != nil else { return false }
        output(["event": "chunk", "session": session, "path": file.path, "at": Int(Date().timeIntervalSince1970 * 1000) - last.samples.count * 1000 / Segmenter.rate,
                "durationMs": last.samples.count * 1000 / Segmenter.rate, "rms": Double(last.rms)])
        return true
    }
}

final class Counter: @unchecked Sendable {
    private var value = 0
    private let lock = NSLock()
    func next() -> Int { lock.withLock { value += 1; return value } }
}

/// Diagnostics go to stderr; main copies them into desktop.log.
public func log(_ message: String) {
    FileHandle.standardError.write(Data("[mlch-audio] \(message)\n".utf8))
}
