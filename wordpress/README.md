# AI File Tools — WordPress site setup guide

This folder contains **`ai-file-tools/`**, a complete WordPress plugin that turns
any WordPress site into a free file-tools site (like a self-hosted iLovePDF +
TinyPNG + passport-photo maker), with **zero running cost**: every tool runs in
the visitor's browser, so your server never processes or stores a single file.

## What you get

| Tool | Shortcode |
|---|---|
| All-tools landing grid | `[aft_all_tools]` |
| Image Compressor & Resizer (exact target size — shrink **or grow**) | `[aft_image_compress]` |
| Image Cropper (incl. passport 35×45 preset) | `[aft_image_crop]` |
| Image Sharpener & Enhancer | `[aft_image_sharpen]` |
| Image Converter (JPG/PNG/WebP, HEIC in, batch + ZIP) | `[aft_image_convert]` |
| Image → PDF | `[aft_image_to_pdf]` |
| PDF → Images | `[aft_pdf_to_image]` |
| PDF Compressor (presets or exact target size) | `[aft_pdf_compress]` |
| PDF Merge | `[aft_pdf_merge]` |
| PDF Split / Extract | `[aft_pdf_split]` |
| PDF Rotate | `[aft_pdf_rotate]` |
| **AI Passport Photo Maker** (best-of-5 picker, background removal, print sheet) | `[aft_passport_photo]` |

## Install (5 minutes)

1. **Build the ZIP** (or just copy the folder):

   ```bash
   cd wordpress && ./build-zip.sh        # produces ai-file-tools.zip
   ```

2. In WordPress admin: **Plugins → Add New → Upload Plugin** → choose
   `ai-file-tools.zip` → **Activate**.

3. On activation the plugin auto-creates a landing page at **`/tools/`** and a
   child page per tool. Done — visit `/tools/` on your site.

4. Optional: **AI File Tools** in the admin sidebar lets you re-create pages,
   pick an accent color, and copy shortcodes to place tools on any page you
   design yourself (Gutenberg, Elementor, etc. — a shortcode block works
   everywhere).

## Which theme should I use?

Any. The plugin is deliberately theme-agnostic — all CSS/JS is namespaced
(`aft-`) and enqueued the standard WordPress way, so it won't clash with other
plugins either. Good free, fast, plugin-friendly themes:

- **Astra** — very light, works with all page builders
- **GeneratePress** — extremely fast, clean defaults
- **Kadence** — nice header/footer builder
- **Twenty Twenty-Four** — WordPress default, block-native

Install one of those, set your logo/menu, and the tool pages will inherit the
theme's fonts and layout automatically.

## How the "AI" parts work (and what they cost: nothing)

- **Passport photo**: [MediaPipe](https://developers.google.com/mediapipe)
  face detection + selfie segmentation run **in the browser via WebAssembly**
  (loaded from the jsDelivr CDN on first use). The tool scores each of the 4–5
  uploaded photos on face detectability, framing and sharpness (variance of
  Laplacian), picks the best, cuts the person out, drops in a plain
  white/blue/gray background, and crops to official passport geometry
  (crown ~10% from top, head ≈ 62–72% of frame depending on preset). It also
  generates a 4×6" print sheet with cutting guides.
- **Compress to exact size**: binary-search on JPEG quality (then progressive
  downscale), and if the result lands *under* the requested size, the file is
  padded with harmless trailing bytes — so it hits the exact size portals
  demand, whether that means shrinking or growing.
- **PDF work**: `pdf-lib` (merge/split/rotate — lossless), `pdf.js` (render),
  `jsPDF` (rebuild) — all client-side.

No API keys. No usage quotas. No files ever touch your server.

## Notes & limits

- Password-protected PDFs are rejected with a friendly message.
- The PDF *compressor* re-renders pages as images (that's what makes large
  size cuts possible), so selectable text becomes flattened, like a scan.
  Merge/split/rotate are lossless and keep text selectable.
- Vendor libraries load from jsDelivr on first use of each tool. If you want a
  fully self-hosted setup, download the pinned files listed in
  `ai-file-tools.php` into the plugin and change the URLs in `AFT_CFG`.
- Passport photos follow common official geometry but acceptance is always at
  the authority's discretion — the UI says so too.
