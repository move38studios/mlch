import AVFoundation
import AudioToolbox
import CoreAudio
import Foundation

/// The Mac's sound output (everything, or some apps) through a Core Audio
/// process tap (macOS 14.2+), resampled to 16 kHz mono and cut into chunks at
/// pauses. Needs the "System Audio Recording Only" permission; without it the
/// tap delivers silence, which shows as a level of zero.
public final class ProcessTap: @unchecked Sendable {
    public enum Target: Sendable, Equatable {
        case all
        case bundleId(String)
        case pid(pid_t)
    }

    private let target: Target
    private let onChunk: @Sendable (Segmenter.Chunk) -> Void
    private let onLevel: @Sendable (Float) -> Void
    private let queue = DispatchQueue(label: "app.mlch.audio.tap")

    private var tapID = AudioObjectID(kAudioObjectUnknown)
    private var aggregateID = AudioObjectID(kAudioObjectUnknown)
    private var procID: AudioDeviceIOProcID?
    private var converter: AVAudioConverter?
    private var inputFormat: AVAudioFormat?
    private let outputFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(Segmenter.rate), channels: 1, interleaved: false)!
    private var segmenter = Segmenter()
    private var levelPeak: Float = 0
    private var levelSamples = 0

    public init(target: Target, onChunk: @escaping @Sendable (Segmenter.Chunk) -> Void, onLevel: @escaping @Sendable (Float) -> Void = { _ in }) {
        self.target = target
        self.onChunk = onChunk
        self.onLevel = onLevel
    }

    deinit { teardown() }

    public func start() throws {
        let description: CATapDescription
        switch target {
        case .all:
            description = CATapDescription(stereoGlobalTapButExcludeProcesses: [])
        case .bundleId(let bundleId):
            let ids = try Self.processObjects(matching: bundleId)
            guard !ids.isEmpty else { throw HelperError("No running app with bundle id \(bundleId) is playing sound.") }
            description = CATapDescription(stereoMixdownOfProcesses: ids)
        case .pid(let pid):
            let id = try Self.processObject(pid: pid)
            description = CATapDescription(stereoMixdownOfProcesses: [id])
        }
        description.uuid = UUID()
        description.name = "mlch"
        description.isPrivate = true
        description.muteBehavior = .unmuted

        var tap = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateProcessTap(description, &tap), "create the process tap")
        tapID = tap

        var format = AudioStreamBasicDescription()
        try Self.get(tapID, kAudioTapPropertyFormat, &format, "read the tap format")
        guard let input = AVAudioFormat(streamDescription: &format) else { throw HelperError("Unsupported tap format.") }
        inputFormat = input
        converter = AVAudioConverter(from: input, to: outputFormat)
        converter?.downmix = true

        let outputUID = try Self.defaultOutputUID()
        let aggregate: [String: Any] = [
            kAudioAggregateDeviceNameKey: "mlch tap",
            kAudioAggregateDeviceUIDKey: UUID().uuidString,
            kAudioAggregateDeviceMainSubDeviceKey: outputUID,
            kAudioAggregateDeviceIsPrivateKey: true,
            kAudioAggregateDeviceIsStackedKey: false,
            kAudioAggregateDeviceTapAutoStartKey: true,
            kAudioAggregateDeviceSubDeviceListKey: [[kAudioSubDeviceUIDKey: outputUID]],
            kAudioAggregateDeviceTapListKey: [[kAudioSubTapDriftCompensationKey: true, kAudioSubTapUIDKey: description.uuid.uuidString]],
        ]
        var device = AudioObjectID(kAudioObjectUnknown)
        try check(AudioHardwareCreateAggregateDevice(aggregate as CFDictionary, &device), "create the capture device")
        aggregateID = device

        var proc: AudioDeviceIOProcID?
        try check(AudioDeviceCreateIOProcIDWithBlock(&proc, aggregateID, queue) { [weak self] _, inputData, _, _, _ in
            self?.receive(inputData)
        }, "attach to the capture device")
        procID = proc
        try check(AudioDeviceStart(aggregateID, procID), "start capturing")
    }

    /// Stops capturing; returns the last chunk if it has speech.
    public func stop() -> Segmenter.Chunk? {
        teardown()
        return queue.sync { segmenter.finish() }
    }

    private func teardown() {
        if aggregateID != kAudioObjectUnknown {
            if let procID {
                AudioDeviceStop(aggregateID, procID)
                AudioDeviceDestroyIOProcID(aggregateID, procID)
            }
            AudioHardwareDestroyAggregateDevice(aggregateID)
            aggregateID = AudioObjectID(kAudioObjectUnknown)
            procID = nil
        }
        if tapID != kAudioObjectUnknown {
            AudioHardwareDestroyProcessTap(tapID)
            tapID = AudioObjectID(kAudioObjectUnknown)
        }
    }

    private func receive(_ data: UnsafePointer<AudioBufferList>) {
        guard let inputFormat, let converter,
              let buffer = AVAudioPCMBuffer(pcmFormat: inputFormat, bufferListNoCopy: data, deallocator: nil),
              buffer.frameLength > 0 else { return }
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * outputFormat.sampleRate / inputFormat.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }
        var consumed = false
        var error: NSError?
        converter.convert(to: out, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        guard error == nil, let channel = out.floatChannelData?[0] else { return }
        let samples = Array(UnsafeBufferPointer(start: channel, count: Int(out.frameLength)))
        for s in samples { levelPeak = max(levelPeak, abs(s)) }
        levelSamples += samples.count
        if levelSamples >= Segmenter.rate {
            onLevel(levelPeak)
            levelPeak = 0
            levelSamples = 0
        }
        for chunk in segmenter.push(samples) { onChunk(chunk) }
    }

    // MARK: - Core Audio lookups

    static func processObject(pid: pid_t) throws -> AudioObjectID {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyTranslatePIDToProcessObject, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var pid = pid
        var object = AudioObjectID(kAudioObjectUnknown)
        var size = UInt32(MemoryLayout<AudioObjectID>.size)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, UInt32(MemoryLayout<pid_t>.size), &pid, &size, &object), "find process \(pid)")
        guard object != kAudioObjectUnknown else { throw HelperError("Process \(pid) has no audio.") }
        return object
    }

    /// Audio processes whose bundle id is `bundleId` or starts with it (helpers: com.google.Chrome.helper).
    static func processObjects(matching bundleId: String) throws -> [AudioObjectID] {
        var address = AudioObjectPropertyAddress(mSelector: kAudioHardwarePropertyProcessObjectList, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size: UInt32 = 0
        try check(AudioObjectGetPropertyDataSize(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size), "list audio processes")
        var ids = [AudioObjectID](repeating: 0, count: Int(size) / MemoryLayout<AudioObjectID>.size)
        try check(AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &address, 0, nil, &size, &ids), "list audio processes")
        return ids.filter { id in
            guard let bundle = try? stringProperty(id, kAudioProcessPropertyBundleID) else { return false }
            return bundle == bundleId || bundle.hasPrefix(bundleId + ".")
        }
    }

    static func defaultOutputUID() throws -> String {
        var device = AudioObjectID(kAudioObjectUnknown)
        try get(AudioObjectID(kAudioObjectSystemObject), kAudioHardwarePropertyDefaultSystemOutputDevice, &device, "find the sound output")
        return try stringProperty(device, kAudioDevicePropertyDeviceUID)
    }

    static func stringProperty(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector) throws -> String {
        var value: Unmanaged<CFString>?
        try get(object, selector, &value, "read a device name")
        guard let value else { throw HelperError("Empty property.") }
        return value.takeRetainedValue() as String
    }

    static func get<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ value: inout T, _ what: String) throws {
        var address = AudioObjectPropertyAddress(mSelector: selector, mScope: kAudioObjectPropertyScopeGlobal, mElement: kAudioObjectPropertyElementMain)
        var size = UInt32(MemoryLayout<T>.size)
        try check(AudioObjectGetPropertyData(object, &address, 0, nil, &size, &value), what)
    }
}

func check(_ status: OSStatus, _ what: String) throws {
    guard status == noErr else { throw HelperError("Could not \(what) (OSStatus \(status)).") }
}
