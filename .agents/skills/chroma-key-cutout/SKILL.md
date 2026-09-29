---
name: chroma-key-cutout
description: Use when the user asks to remove green-screen or chroma-key backgrounds from local raster images, create transparent PNG cutouts, validate alpha edges, or batch-repeat the same keying workflow for UI/game/art assets.
---

# Chroma Key Cutout

## Overview

Creates alpha PNG cutouts from green-screen assets with deterministic local processing. Prefer this over model image editing when the source already has a removable chroma-key background.

## Workflow

1. Inspect source with `file` and, if useful, `view_image`.
2. Sample border color or pass an explicit key color.
3. Run `scripts/chroma_key_cutout.py`.
4. Inspect the dark preview for holes, green fringe, and accidental removal.
5. Verify the PNG is `RGBA`, corner alpha is `0`, and alpha extrema include `(0, 255)`.

## Mode Choice

- Use default `--mode strict` when green-screen pixels may appear inside holes, such as an outlined heart or transparent UI center.
- Use `--mode connected` when foreground art contains exact green areas that must survive and only the outer background should disappear.
- Pass `--key-color '#00ff00'` only when automatic border sampling chooses the wrong color.

## Commands

Single image:

```bash
python3 /root/projects/.agents/skills/chroma-key-cutout/scripts/chroma_key_cutout.py \
  --input "/root/projects/source.png"
```

Explicit output:

```bash
python3 /root/projects/.agents/skills/chroma-key-cutout/scripts/chroma_key_cutout.py \
  --input "/root/projects/source.png" \
  --output "/root/projects/source-cutout.png" \
  --preview "/root/projects/source-cutout-preview-dark.png"
```

Preserve non-border exact-green foreground:

```bash
python3 /root/projects/.agents/skills/chroma-key-cutout/scripts/chroma_key_cutout.py \
  --input "/root/projects/source.png" \
  --mode connected
```

## Quality Rules

- Never overwrite a source file.
- Save transparent output beside the source unless the user gives a destination.
- Always make a dark preview for visual QA.
- If text or fine black edges show green spill, rerun with a stricter key color or reduce `--soft-high`.
- If foreground gets deleted, switch to `--mode connected` or narrow `--max-rb`.
- If enclosed green holes remain, switch back to `--mode strict`.

## Dependencies

Requires Python3 plus `Pillow` and `numpy`.
