# ClearWrite — Free Writing Tools

A fast, privacy-first suite of writing tools. Everything runs **entirely in the
browser** — no server, no accounts, no text ever leaves the user's device.

## Tools

| Tool | What it does |
| --- | --- |
| **Paraphraser** | Rewrites text in four modes (Standard, Formal, Simple, Concise) with every edit highlighted for review |
| **Plagiarism Checker** | Compares a document against a pasted source, highlights matching runs of 5+ words in both texts, and scores overall similarity |
| **AI Detector** | Stylometric estimate of AI-likelihood from five signals: sentence rhythm (burstiness), vocabulary variety, stock AI phrasing, repeated openers, and voice/texture — with a per-signal breakdown |
| **Writing Improver** | Hemingway-style feedback: Flesch reading ease, grade level, and inline color-coded highlights for long sentences, passive voice, filler words and clichés |

## Design notes

- **Responsive**: two-pane workspaces collapse to stacked layout under 900px; the tab bar becomes a full-width segmented control on mobile.
- **Dark/light theme** with a toggle, persisted in `localStorage`, defaulting to the system preference.
- **Keyboard-friendly**: `Ctrl+Enter` runs the active tool; a skip-link, ARIA roles and live regions are included.
- **Zero build step**: plain HTML/CSS/JS. Open `index.html` or serve the folder with any static host.

## Run locally

```bash
cd clearwrite
python3 -m http.server 8080
# open http://localhost:8080
```

## Honest-tool policy

The AI detector reports an *estimate* with an explicit disclaimer — no detector is
proof. The paraphraser is a writing aid that highlights all of its edits; it is not
designed or tuned to evade AI-content detectors.
