---
name: screenshot-reader
description: Give any text-only LLM the ability to "see" screenshots. Use after EVERY computer_screenshot or chrome_screenshot when the model cannot read image attachments — run the reader on the saved image to get a text transcript plus element coordinates, then act on what is visible instead of guessing. Triggers on "what do you see", "read the screenshot", "describe the screen", blind-model screenshot handling, and any UI verification step after a screenshot was saved.
---

# Screenshot Reader

Convert any screenshot into text + coordinates so a text-only model can drive
`computer_*` / `chrome_*` tools without blind mistakes.

## When to use

- After every `computer_screenshot` / `chrome_screenshot` when the model reports
  `this model does not support image input`.
- Before any click, drag, or keyboard action that depends on what is visible.
- For UI verification rounds where the evidence is a saved PNG/JPG.

## How to use

```powershell
# Markdown report (transcript + coordinate map)
python C:\VectorHQ\screenshot-reader\reader.py <image-path>

# Machine-readable JSON
python C:\VectorHQ\screenshot-reader\reader.py <image-path> --json
```

Wrapper (same output, friendlier invocation):

```powershell
& C:\VectorHQ\worktree-proof-workflow\skills\screenshot-reader\read-shot.ps1 <image-path>
```

## Reading the output

1. **Transcript** — every visible text element, top-to-bottom, left-to-right.
2. **Coordinate map** — `(x,y) w×h "text"` per element in image pixels.

## Acting on it (click math)

- Element center = `(x + w/2, y + h/2)`.
- Full-screen captures: image pixels == screen pixels — pass the center
  directly to `computer_mouse_click`.
- Window/scaled captures: multiply by the display scale factor if clicks land
  off-target.
- For `chrome_click`: coordinates confirm element order/visibility; prefer the
  CSS selector, use coordinates only as a cross-check.

## Rules

1. Never claim you saw an image — say "read via screenshot-reader".
2. If the transcript is empty, the region may be image-only (charts/icons):
   try `--backend rapidocr` (install: `pip install rapidocr_onnxruntime`).
3. Backends auto-detect: rapidocr → windows (built-in, zero install) → tesseract.
4. Redact sensitive values from any quoted output before reporting.
5. If the image path does not exist, report the error; do not guess content.