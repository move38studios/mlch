import Foundation
import MlchAudioCore

// mlch-audio [--models <dir>] [--chunks <dir>]
// JSON lines on stdin/stdout; see Helper.swift for the protocol.

func argument(_ name: String) -> String? {
    let args = CommandLine.arguments
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
}

let support = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first!
let modelsDir = URL(fileURLWithPath: argument("--models") ?? support.appendingPathComponent("mlch/models").path, isDirectory: true)
let chunkRoot = URL(fileURLWithPath: argument("--chunks") ?? FileManager.default.temporaryDirectory.appendingPathComponent("mlch-audio").path, isDirectory: true)

let writeLock = NSLock()
let helper = Helper(modelsDir: modelsDir, chunkRoot: chunkRoot) { message in
    guard JSONSerialization.isValidJSONObject(message),
          var data = try? JSONSerialization.data(withJSONObject: message, options: [.withoutEscapingSlashes]) else {
        log("unencodable message dropped")
        return
    }
    data.append(0x0A)
    writeLock.withLock { FileHandle.standardOutput.write(data) }
}

log("ready (models: \(modelsDir.path))")

// Requests run concurrently (a transcription does not wait for a download);
// stdin closing means main has gone, so stop.
let reader = Thread {
    while let line = readLine(strippingNewline: true) {
        if line.trimmingCharacters(in: .whitespaces).isEmpty { continue }
        Task {
            await helper.handle(line: line)
            if helper.shuttingDown { exit(0) }
        }
    }
    helper.stopAll()
    exit(0)
}
reader.start()
dispatchMain()
