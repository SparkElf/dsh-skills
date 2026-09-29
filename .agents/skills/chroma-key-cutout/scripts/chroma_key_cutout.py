#!/usr/bin/env python3
"""Remove chroma-key backgrounds from raster images and write alpha PNGs."""

from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

import numpy as np
from PIL import Image, ImageFilter


def parse_color(value: str) -> tuple[int, int, int]:
    raw = value.strip()
    if raw.startswith("#"):
        raw = raw[1:]
    if "," in raw:
        parts = [int(p.strip()) for p in raw.split(",")]
        if len(parts) != 3:
            raise argparse.ArgumentTypeError("color must have three channels")
        return tuple(parts)  # type: ignore[return-value]
    if len(raw) != 6:
        raise argparse.ArgumentTypeError("hex color must be RRGGBB")
    return tuple(int(raw[i : i + 2], 16) for i in (0, 2, 4))  # type: ignore[return-value]


def default_output(input_path: Path) -> Path:
    return input_path.with_name(f"{input_path.stem}-cutout.png")


def default_preview(output_path: Path) -> Path:
    return output_path.with_name(f"{output_path.stem}-preview-dark.png")


def sample_key(rgb: np.ndarray) -> np.ndarray:
    border = np.concatenate([rgb[0], rgb[-1], rgb[:, 0], rgb[:, -1]], axis=0)
    green = border[
        (border[:, 1] > 120)
        & (border[:, 1] > border[:, 0] * 1.35 + 20)
        & (border[:, 1] > border[:, 2] * 1.35 + 15)
    ]
    if len(green) == 0:
        return np.array([0, 255, 0], dtype=np.int16)
    return np.median(green, axis=0).astype(np.int16)


def dilate(mask: np.ndarray, iterations: int) -> np.ndarray:
    out = mask.copy()
    for _ in range(iterations):
        p = np.pad(out, ((1, 1), (1, 1)), constant_values=False)
        out = (
            p[1:-1, 1:-1]
            | p[:-2, 1:-1]
            | p[2:, 1:-1]
            | p[1:-1, :-2]
            | p[1:-1, 2:]
            | p[:-2, :-2]
            | p[:-2, 2:]
            | p[2:, :-2]
            | p[2:, 2:]
        )
    return out


def border_connected(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    visited = np.zeros((h, w), dtype=bool)
    stack: list[tuple[int, int]] = []

    for x in range(w):
        if mask[0, x]:
            stack.append((x, 0))
        if mask[h - 1, x]:
            stack.append((x, h - 1))
    for y in range(h):
        if mask[y, 0]:
            stack.append((0, y))
        if mask[y, w - 1]:
            stack.append((w - 1, y))

    while stack:
        x, y = stack.pop()
        if visited[y, x] or not mask[y, x]:
            continue

        xl = x
        while xl > 0 and mask[y, xl - 1] and not visited[y, xl - 1]:
            xl -= 1
        xr = x
        while xr + 1 < w and mask[y, xr + 1] and not visited[y, xr + 1]:
            xr += 1

        visited[y, xl : xr + 1] = True

        for ny in (y - 1, y + 1):
            if ny < 0 or ny >= h:
                continue
            i = xl
            while i <= xr:
                while i <= xr and (visited[ny, i] or not mask[ny, i]):
                    i += 1
                if i <= xr:
                    stack.append((i, ny))
                    while i <= xr and mask[ny, i] and not visited[ny, i]:
                        i += 1

    return visited


def render_preview(image: Image.Image, out_path: Path, color: tuple[int, int, int]) -> None:
    rgba = image.convert("RGBA")
    bg = Image.new("RGBA", rgba.size, (*color, 255))
    bg.alpha_composite(rgba)
    bg.convert("RGB").save(out_path)


def count_values(values: Iterable[int], target: int) -> int:
    return sum(1 for value in values if value == target)


def cutout(args: argparse.Namespace) -> None:
    input_path = Path(args.input).expanduser().resolve()
    output_path = Path(args.output).expanduser().resolve() if args.output else default_output(input_path)
    preview_path = Path(args.preview).expanduser().resolve() if args.preview else default_preview(output_path)

    img = Image.open(input_path).convert("RGBA")
    arr = np.array(img)
    rgb = arr[:, :, :3].astype(np.int16)
    key = np.array(args.key_color if args.key_color else sample_key(rgb), dtype=np.int16)

    r, g, b = rgb[:, :, 0], rgb[:, :, 1], rgb[:, :, 2]
    dist = np.abs(rgb - key).sum(axis=2)

    keyish = (
        (g > args.min_green)
        & (r < args.max_rb)
        & (b < args.max_rb)
        & (g - r > args.green_margin)
        & (g - b > args.green_margin - 10)
    )
    keyish |= (
        (dist < args.soft_high)
        & (g > args.min_green - 20)
        & (g - r > args.green_margin - 20)
        & (g - b > args.green_margin - 25)
    )

    strong = keyish & (
        (dist < args.transparent_threshold)
        | ((r < args.max_rb // 2) & (b < args.max_rb // 2) & (g > args.min_green + 25))
    )

    active = border_connected(keyish) if args.mode == "connected" else keyish
    strong_active = strong & active

    alpha = np.full(rgb.shape[:2], 255, dtype=np.uint8)
    soft = np.clip((dist.astype(np.float32) - args.transparent_threshold) / (args.soft_high - args.transparent_threshold), 0, 1)
    alpha[active] = (soft[active] * 255).astype(np.uint8)
    alpha[strong_active] = 0

    if args.blur > 0:
        alpha = np.array(Image.fromarray(alpha, "L").filter(ImageFilter.GaussianBlur(radius=args.blur)))
        alpha[~active] = 255
        alpha[strong_active] = 0

    edge_zone = dilate(active, args.despill_radius)
    out_arr = arr.copy()
    rr = out_arr[:, :, 0].astype(np.float32)
    gg = out_arr[:, :, 1].astype(np.float32)
    bb = out_arr[:, :, 2].astype(np.float32)
    spill = (
        edge_zone
        & (gg > rr + 18)
        & (gg > bb + 14)
        & (rr < 190)
        & (bb < 190)
    )
    limit = np.maximum(rr, bb) * args.despill_strength + 12
    out_arr[:, :, 1] = np.where(spill, np.minimum(gg, limit), gg).clip(0, 255).astype(np.uint8)
    out_arr[:, :, 3] = alpha

    output_path.parent.mkdir(parents=True, exist_ok=True)
    preview_path.parent.mkdir(parents=True, exist_ok=True)
    output_image = Image.fromarray(out_arr, "RGBA")
    output_image.save(output_path)
    render_preview(output_image, preview_path, args.preview_background)

    alpha_img = output_image.getchannel("A")
    corners = (
        alpha_img.getpixel((0, 0)),
        alpha_img.getpixel((output_image.width - 1, 0)),
        alpha_img.getpixel((0, output_image.height - 1)),
        alpha_img.getpixel((output_image.width - 1, output_image.height - 1)),
    )
    alpha_values = alpha_img.getdata()
    transparent = count_values(alpha_values, 0)
    partial = sum(1 for value in alpha_img.getdata() if 0 < value < 255)

    print(f"wrote {output_path}")
    print(f"preview {preview_path}")
    print(f"key #{int(key[0]):02x}{int(key[1]):02x}{int(key[2]):02x}")
    print(f"mode {args.mode}")
    print(f"corner_alpha {corners}")
    print(f"alpha_extrema {alpha_img.getextrema()}")
    print(f"transparent_pixels {transparent}/{output_image.width * output_image.height}")
    print(f"partial_pixels {partial}/{output_image.width * output_image.height}")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(description="Remove green-screen/chroma-key background and save RGBA PNG.")
    parser.add_argument("--input", required=True, help="Source raster image path.")
    parser.add_argument("--output", help="Output transparent PNG path. Defaults to <input-stem>-cutout.png.")
    parser.add_argument("--preview", help="Dark preview path. Defaults to <output-stem>-preview-dark.png.")
    parser.add_argument("--mode", choices=("strict", "connected"), default="strict")
    parser.add_argument("--key-color", type=parse_color, help="Key color as #RRGGBB or R,G,B. Defaults to green border median.")
    parser.add_argument("--preview-background", type=parse_color, default=(34, 38, 46), help="Preview RGB color.")
    parser.add_argument("--min-green", type=int, default=145)
    parser.add_argument("--max-rb", type=int, default=95)
    parser.add_argument("--green-margin", type=int, default=95)
    parser.add_argument("--transparent-threshold", type=int, default=35)
    parser.add_argument("--soft-high", type=int, default=130)
    parser.add_argument("--blur", type=float, default=0.28)
    parser.add_argument("--despill-radius", type=int, default=2)
    parser.add_argument("--despill-strength", type=float, default=0.78)
    return parser


def main() -> None:
    args = build_parser().parse_args()
    cutout(args)


if __name__ == "__main__":
    main()
