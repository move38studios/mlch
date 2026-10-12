// swift-tools-version: 6.0
// mlch's native helper: local transcription (Parakeet via FluidAudio) and
// system audio capture (Core Audio process tap). Talks JSON lines over stdio;
// electron/lib/audio-helper.cjs starts it.
import PackageDescription

let package = Package(
    name: "mlch-audio",
    platforms: [.macOS("14.2")],
    products: [.executable(name: "mlch-audio", targets: ["mlch-audio"])],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.7"),
    ],
    targets: [
        .target(name: "MlchAudioCore", dependencies: [.product(name: "FluidAudio", package: "FluidAudio")]),
        .executableTarget(name: "mlch-audio", dependencies: ["MlchAudioCore"]),
        .testTarget(name: "MlchAudioCoreTests", dependencies: ["MlchAudioCore"]),
    ]
)
