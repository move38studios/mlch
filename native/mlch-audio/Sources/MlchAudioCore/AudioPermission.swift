import Foundation

/// The "System Audio Recording Only" permission. macOS has no public API to
/// read it, and a process tap without it delivers silence instead of failing,
/// so this asks TCC directly (the private `TCCAccessPreflight`, as Apple's
/// own sample apps for process taps do). It is attributed like the tap: to
/// the app that started this helper.
public enum AudioPermission: String, Sendable {
    case granted, denied, unknown

    private typealias Preflight = @convention(c) (CFString, CFDictionary?) -> Int

    public static func check() -> AudioPermission {
        guard let handle = dlopen("/System/Library/PrivateFrameworks/TCC.framework/Versions/A/TCC", RTLD_NOW),
              let symbol = dlsym(handle, "TCCAccessPreflight") else { return .unknown }
        let preflight = unsafeBitCast(symbol, to: Preflight.self)
        switch preflight("kTCCServiceAudioCapture" as CFString, nil) {
        case 0: return .granted
        case 1: return .denied
        default: return .unknown
        }
    }
}
