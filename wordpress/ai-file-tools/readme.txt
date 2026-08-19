=== AI File Tools — Image, PDF & Passport Photo Suite ===
Contributors: mhcircle
Tags: image compressor, pdf compressor, passport photo, image converter, pdf merge
Requires at least: 5.8
Tested up to: 6.6
Requires PHP: 7.2
Stable tag: 1.0.0
License: GPLv2 or later
License URI: https://www.gnu.org/licenses/gpl-2.0.html

Free, unlimited, in-browser file tools: image & PDF compressors (with exact target size — shrink OR grow), crop, sharpen, converters, image↔PDF, merge/split/rotate, and an AI passport-photo maker.

== Description ==

Every tool runs 100% in the visitor's browser. Files are never uploaded to your
server, which means:

* Zero processing cost, at any traffic level
* No file size limits imposed by your hosting
* Complete privacy for your visitors' documents

**Tools included**

* Image Compressor & Resizer — quality mode, or hit an *exact* file size
  (shrink or grow — perfect for portals that demand "between 20 KB and 1 MB")
* Image Cropper — free crop plus presets incl. passport 35×45
* Image Sharpener & Enhancer — unsharp mask, brightness, contrast, saturation
* Image Converter — JPG ↔ PNG ↔ WebP, HEIC → JPG, batch + ZIP download
* Image → PDF — many images into one PDF, A4/Letter/fit
* PDF → Images — every page to JPG/PNG
* PDF Compressor — presets or exact target size (shrink or grow)
* PDF Merge, Split/Extract, Rotate
* **AI Passport Photo Maker** — upload 4–5 casual photos; on-device AI
  (MediaPipe) finds the face in each, scores sharpness and framing, picks the
  best shot, removes the background (white/light blue/gray), and crops to
  official geometry (India/UK/EU 35×45, US 2×2", China 33×48, square).
  Includes a printable 4×6" sheet with cutting guides.

**Theme & plugin compatibility**

This is a plugin, not a theme — it works with any properly coded theme
(Astra, GeneratePress, Kadence, OceanWP, Twenty Twenty-Four, …) and alongside
any other plugins. All styles and scripts are namespaced (`aft-`), enqueued via
the standard WordPress APIs, and only loaded on pages that actually contain a
tool shortcode.

== Installation ==

1. Upload the `ai-file-tools` folder to `/wp-content/plugins/`, or upload the
   ZIP via Plugins → Add New → Upload Plugin.
2. Activate it. Tool pages are created automatically under `/tools/`.
3. Optional: go to **AI File Tools** in the admin menu to re-create pages,
   change the accent color, or copy individual shortcodes.

== Frequently Asked Questions ==

= Does this use my server to process files? =
No. Everything runs in the visitor's browser using canvas, pdf-lib, pdf.js,
jsPDF and MediaPipe (loaded from the jsDelivr CDN on first use).

= How can a compressor *increase* a file's size? =
Some upload portals enforce a minimum size. In "exact target size" mode the
tool compresses to just under your target, then pads the file with harmless
trailing bytes so it lands exactly on the size you asked for. The file stays
a perfectly valid JPG/PDF.

= Is the passport photo guaranteed to be accepted? =
It follows common official geometry (head ≈ 70–80% of frame, plain light
background), but requirements vary by country and photos are ultimately
accepted at the authority's discretion. Always check your authority's rules.

== Changelog ==

= 1.0.0 =
* Initial release: 11 tools + landing grid + admin page.
