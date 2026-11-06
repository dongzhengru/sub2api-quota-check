import AppKit
import Foundation

let output = CommandLine.arguments[1]
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: 1024, pixelsHigh: 1024,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let background = NSBezierPath(roundedRect: NSRect(x: 52, y: 52, width: 920, height: 920), xRadius: 210, yRadius: 210)
NSGradient(starting: NSColor(calibratedRed: 0.07, green: 0.72, blue: 0.53, alpha: 1),
    ending: NSColor(calibratedRed: 0.03, green: 0.39, blue: 0.36, alpha: 1))!.draw(in: background, angle: -65)
let track = NSBezierPath()
track.appendArc(withCenter: NSPoint(x: 512, y: 535), radius: 264, startAngle: -35, endAngle: 215, clockwise: false)
track.lineWidth = 66
track.lineCapStyle = .round
NSColor.white.withAlphaComponent(0.18).setStroke()
track.stroke()
let progress = NSBezierPath()
progress.appendArc(withCenter: NSPoint(x: 512, y: 535), radius: 264, startAngle: 215, endAngle: 48, clockwise: true)
progress.lineWidth = 66
progress.lineCapStyle = .round
NSColor.white.setStroke()
progress.stroke()
let needle = NSBezierPath()
needle.move(to: NSPoint(x: 512, y: 535))
needle.line(to: NSPoint(x: 632, y: 662))
needle.lineWidth = 42
needle.lineCapStyle = .round
needle.stroke()
NSColor.white.setFill()
NSBezierPath(ovalIn: NSRect(x: 478, y: 501, width: 68, height: 68)).fill()
let label = "QUOTA" as NSString
let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 76, weight: .semibold),
    .foregroundColor: NSColor.white.withAlphaComponent(0.95), .kern: 12]
let width = label.size(withAttributes: attributes).width
label.draw(at: NSPoint(x: (1024 - width) / 2, y: 240), withAttributes: attributes)
NSGraphicsContext.restoreGraphicsState()
try bitmap.representation(using: .png, properties: [:])!.write(to: URL(fileURLWithPath: output))
