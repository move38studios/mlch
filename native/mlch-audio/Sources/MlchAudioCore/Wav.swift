import Foundation

/// 16-bit PCM mono WAV, the format the transcription path takes.
public enum Wav {
    public static func encode(_ samples: [Float], rate: Int) -> Data {
        var data = Data(capacity: 44 + samples.count * 2)
        func u32(_ v: UInt32) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        func u16(_ v: UInt16) { withUnsafeBytes(of: v.littleEndian) { data.append(contentsOf: $0) } }
        data.append(contentsOf: Array("RIFF".utf8)); u32(UInt32(36 + samples.count * 2))
        data.append(contentsOf: Array("WAVE".utf8))
        data.append(contentsOf: Array("fmt ".utf8)); u32(16); u16(1); u16(1)
        u32(UInt32(rate)); u32(UInt32(rate * 2)); u16(2); u16(16)
        data.append(contentsOf: Array("data".utf8)); u32(UInt32(samples.count * 2))
        for s in samples {
            let c = max(-1, min(1, s))
            u16(UInt16(bitPattern: Int16(c < 0 ? c * 32768 : c * 32767)))
        }
        return data
    }

    /// Samples of a 16-bit PCM mono WAV written by `encode` (tests and quick checks).
    public static func decode(_ data: Data) -> [Float]? {
        guard data.count >= 44, String(data: data[0..<4], encoding: .ascii) == "RIFF" else { return nil }
        let body = data[44...]
        var out: [Float] = []
        out.reserveCapacity(body.count / 2)
        var i = body.startIndex
        while i + 1 < body.endIndex {
            let v = Int16(bitPattern: UInt16(body[i]) | UInt16(body[i + 1]) << 8)
            out.append(Float(v) / 32768)
            i += 2
        }
        return out
    }
}
