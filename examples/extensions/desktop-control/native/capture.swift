import Foundation
import ScreenCaptureKit
import CoreGraphics
import ImageIO
import CoreVideo
import CoreMedia
import CoreImage
import UniformTypeIdentifiers

struct CaptureFailure: Error { let code: String; let message: String }
func fail(_ code: String, _ message: String) throws -> Never { throw CaptureFailure(code: code, message: message) }
func emit(_ value: [String: Any]) {
    if let data = try? JSONSerialization.data(withJSONObject: value) {
        FileHandle.standardOutput.write(data); FileHandle.standardOutput.write(Data([10]))
    }
}
func windowBounds(_ id: CGWindowID, _ pid: pid_t) throws -> CGRect {
    guard let list = CGWindowListCopyWindowInfo([.optionIncludingWindow], id) as? [[String: Any]],
          let info = list.first, (info[kCGWindowOwnerPID as String] as? NSNumber)?.int32Value == pid,
          let bounds = info[kCGWindowBounds as String] as? [String: Any],
          let rect = CGRect(dictionaryRepresentation: bounds as CFDictionary), rect.width > 0, rect.height > 0 else {
        try fail("window_changed", "The selected window closed or changed owner; select it again.")
    }
    return rect
}
func usable(_ image: CGImage) -> Bool {
    // A small whole-image sample detects black/transparent captures, not their cause.
    let size = 64
    var bytes = [UInt8](repeating: 0, count: size * size * 4)
    return bytes.withUnsafeMutableBytes { buffer in
        guard let ctx = CGContext(data: buffer.baseAddress, width: size, height: size, bitsPerComponent: 8,
                                  bytesPerRow: size * 4, space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue) else { return false }
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: size, height: size))
        let p = buffer.bindMemory(to: UInt8.self)
        var lo: UInt8 = 255; var hi: UInt8 = 0
        for i in stride(from: 0, to: p.count, by: 4) where p[i+3] > 8 {
            lo = min(lo, p[i], p[i+1], p[i+2]); hi = max(hi, p[i], p[i+1], p[i+2])
        }
        return hi > 4 && Int(hi) - Int(lo) > 4
    }
}
final class FrameSink: NSObject, SCStreamOutput, @unchecked Sendable {
    private let lock = NSLock()
    private var latest: CGImage?
    func image() -> CGImage? { lock.lock(); defer { lock.unlock() }; return latest }
    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, sampleBuffer.isValid,
              let attachments = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
              let status = attachments.first?[.status] as? Int, status == SCFrameStatus.complete.rawValue,
              let pixels = CMSampleBufferGetImageBuffer(sampleBuffer),
              let image = CIContext(options: [.cacheIntermediates: false]).createCGImage(CIImage(cvPixelBuffer: pixels), from: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels))), usable(image) else { return }
        lock.lock(); latest = image; lock.unlock()
    }
}
func streamFrame(filter: SCContentFilter, configuration: SCStreamConfiguration) async throws -> CGImage {
    let stream = SCStream(filter: filter, configuration: configuration, delegate: nil)
    let sink = FrameSink()
    try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: DispatchQueue(label: "ashub.capture.frame"))
    try await stream.startCapture()
    do {
        // Refresh the same exact window filter once; never broaden to a display.
        try await stream.updateContentFilter(filter)
        for _ in 0..<20 {
            try await Task.sleep(nanoseconds: 100_000_000)
            if let image = sink.image() { try await stream.stopCapture(); return image }
        }
        try fail("empty_capture", "ScreenCaptureKit returned no nonblank frame, including after a same-window stream refresh. Check that WeChat is visibly rendering; its cause cannot be determined from this capture alone.")
    } catch { try? await stream.stopCapture(); throw error }
}
@main struct Capture {
    static func main() async {
        do {
            let args = CommandLine.arguments
            guard args.count == 3, let pid = Int32(args[1]), pid > 0, let id = UInt32(args[2]), id > 0 else {
                try fail("invalid_target", "Expected a positive process ID and window ID.")
            }
            guard CGPreflightScreenCaptureAccess() else {
                try fail("permission_denied", "Screen Recording permission is missing for the process running this plugin. Grant it in macOS settings and restart asHub.")
            }
            let before = try windowBounds(id, pid)
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: false)
            guard let window = content.windows.first(where: { $0.windowID == id && $0.owningApplication?.processID == pid }) else {
                try fail("window_unavailable", "ScreenCaptureKit cannot find the selected window. Restore its visible main window and try again.")
            }
            guard window.isOnScreen else { try fail("window_hidden", "Restore the selected window before capturing it; this capture path does not move or unhide windows.") }
            guard window.frame == before else { try fail("window_changed", "The window moved or resized before capture; capture it again.") }
            let filter = SCContentFilter(desktopIndependentWindow: window)
            let config = SCStreamConfiguration()
            let scale = min(1.0, 1568.0 / max(before.width, before.height))
            config.width = max(1, Int((before.width * scale).rounded()))
            config.height = max(1, Int((before.height * scale).rounded()))
            config.captureResolution = .best
            config.ignoreGlobalClipSingleWindow = true
            config.pixelFormat = kCVPixelFormatType_32BGRA
            config.showsCursor = false
            if #available(macOS 14.2, *) { config.includeChildWindows = true }
            config.ignoreShadowsSingleWindow = true
            config.shouldBeOpaque = false
            var image: CGImage
            var backend = "ScreenCaptureKit/window"
            let sample = try await SCScreenshotManager.captureSampleBuffer(contentFilter: filter, configuration: config)
            guard let pixels = CMSampleBufferGetImageBuffer(sample),
                  let captured = CIContext(options: [.cacheIntermediates: false]).createCGImage(CIImage(cvPixelBuffer: pixels), from: CGRect(x: 0, y: 0, width: CVPixelBufferGetWidth(pixels), height: CVPixelBufferGetHeight(pixels))) else {
                try fail("invalid_image", "ScreenCaptureKit returned no usable image buffer.")
            }
            image = captured
            if !usable(image) {
                guard let display = content.displays.first(where: { $0.frame.contains(before) }) else {
                    try fail("empty_capture", "The window capture is blank and the window is not contained in one display. Place it fully on one display before retrying.")
                }
                // Include ONLY this window, never a whole-display fallback. Crop in display-local points.
                let displayFilter = SCContentFilter(display: display, including: [window])
                config.sourceRect = CGRect(x: before.minX - display.frame.minX, y: before.minY - display.frame.minY, width: before.width, height: before.height)
                config.ignoreShadowsDisplay = true
                config.minimumFrameInterval = CMTime(value: 1, timescale: 10)
                image = try await streamFrame(filter: displayFilter, configuration: config)
                backend = "ScreenCaptureKit/display-window"
            }
            guard try windowBounds(id, pid) == before else { try fail("window_changed", "The window moved, resized or changed owner during capture; discard this frame.") }
            guard image.width == config.width && image.height == config.height else {
                try fail("invalid_geometry", "ScreenCaptureKit returned image \(image.width)x\(image.height), expected \(config.width)x\(config.height); no coordinate input is allowed.")
            }
            guard usable(image) else { try fail("empty_capture", "The selected window returned a blank, black or transparent image. This is a capture failure, not an OCR layout error; its cause is not yet determined.") }
            let data = NSMutableData()
            guard let destination = CGImageDestinationCreateWithData(data, UTType.png.identifier as CFString, 1, nil) else {
                try fail("encode_failed", "Could not encode the captured window.")
            }
            CGImageDestinationAddImage(destination, image, nil)
            guard CGImageDestinationFinalize(destination) else { try fail("encode_failed", "Could not encode the captured window.") }
            emit(["png": (data as Data).base64EncodedString(), "screenshot": ["window_id": id, "pid": pid, "width": image.width, "height": image.height,
                  "scale": Double(image.width) / before.width, "backend": backend]])
        } catch let error as CaptureFailure {
            emit(["error": error.code, "message": error.message]); exit(1)
        } catch {
            let e = error as NSError
            // Numeric framework diagnostics only; do not expose window titles or other app content.
            emit(["error": "capture_failed", "message": "ScreenCaptureKit failed (\(e.domain) \(e.code)). Check window visibility and Screen Recording permission; no image was accepted."]); exit(1)
        }
    }
}
