#!/usr/bin/env python3
"""
ascii_convert.py

Usage (called by worker):
  python ascii_convert.py <input_path> <output_path> [--enhance 1|0] [--fullcolor 1|0]
                           [--char CHAR] [--max-bytes N]

This script:
 - converts an input image to an ASCII-art image using `ascii_magic.AsciiArt`
 - then ensures the final output is <= max_bytes (default 800*1024) by applying lossless and
   lossy recompression strategies. It prefers to keep PNG if possible, and will fall back
   to high-quality JPEG only if necessary.
 - prints short progress/log messages to stdout/stderr for the worker to capture.
"""

import argparse
import sys
import os
import tempfile
import io
from ascii_magic import AsciiArt
from PIL import Image, ImageFile

# Allow PIL to load truncated images sometimes
ImageFile.LOAD_TRUNCATED_IMAGES = True

DEFAULT_MAX_BYTES = 1024 * 1024  # 800 KB


def str_to_bool_like(v):
    if v is None:
        return False
    s = str(v).lower()
    return s in ("1", "true", "yes", "y", "t")


def safe_open_image(path):
    try:
        return Image.open(path)
    except Exception as e:
        raise RuntimeError(f"unable to open image '{path}': {e}")


def compress_image_keep_png(img: Image.Image, max_bytes: int):
    """
    Try lossless/near-lossless strategies to keep PNG under max_bytes:
    1) Save PNG with optimize=True
    2) Quantize to 256 colors and save optimize
    3) Quantize more aggressively (128, 64) if needed
    Returns bytes or None if couldn't get below limit with PNG.
    """
    attempts = []

    # 1) try optimized PNG
    buf = io.BytesIO()
    try:
        img.save(buf, format="PNG", optimize=True)
        b = buf.getvalue()
        attempts.append(("png-optimize", len(b), b))
        if len(b) <= max_bytes:
            return b, "png-optimize"
    except Exception:
        # some images won't accept optimize; ignore
        pass

    # 2) quantize to 256 colors
    for colors in (256, 128, 64, 32, 16):
        try:
            q = img.convert("RGBA").quantize(colors=colors, method=Image.MEDIANCUT)
            buf = io.BytesIO()
            q.save(buf, format="PNG", optimize=True)
            b = buf.getvalue()
            attempts.append((f"png-quant-{colors}", len(b), b))
            if len(b) <= max_bytes:
                return b, f"png-quant-{colors}"
        except Exception:
            continue

    # none worked; return best (smallest) attempt
    if attempts:
        best = min(attempts, key=lambda t: t[1])
        return best[2], best[0]
    return None, None


def compress_image_to_jpeg(img: Image.Image, max_bytes: int):
    """
    Convert to JPEG and progressively lower quality until <= max_bytes or quality floor reached.
    Returns bytes and a tag describing the quality used.
    """
    # JPEG can't handle alpha: paste onto white background
    if img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info):
        bg = Image.new("RGB", img.size, (255, 255, 255))
        alpha = img.convert("RGBA").split()[-1]
        bg.paste(img.convert("RGBA"), mask=alpha)
        work_img = bg
    else:
        work_img = img.convert("RGB")

    # try saving as JPEG with high quality first
    for quality in (95, 90, 85, 80, 75, 70):
        buf = io.BytesIO()
        try:
            work_img.save(buf, format="JPEG", quality=quality, optimize=True, progressive=True)
            b = buf.getvalue()
        except Exception:
            # fallback: save without optimize
            buf = io.BytesIO()
            work_img.save(buf, format="JPEG", quality=quality, progressive=True)
            b = buf.getvalue()

        if len(b) <= max_bytes:
            return b, f"jpeg-q{quality}"
        # else continue lowering quality

    # couldn't reach target; return smallest produced
    # we'll return the last produced b (quality=50)
    return b, "jpeg-q50"


def ensure_under_max_bytes(path: str, max_bytes: int):
    """
    Attempts to make the file at `path` <= max_bytes. It modifies the file in-place.
    Returns tuple (success_bool, method_str, final_size)
    """
    try:
        img = safe_open_image(path)
    except Exception as e:
        return False, f"open_failed:{e}", None

    # First try PNG-preserving strategies (lossless / palette)
    png_bytes, png_method = compress_image_keep_png(img, max_bytes)
    if png_bytes is not None and len(png_bytes) <= max_bytes:
        with open(path, "wb") as f:
            f.write(png_bytes)
        return True, png_method, len(png_bytes)

    # If png_bytes exists but still > max_bytes, keep it as candidate
    candidate = (png_bytes, png_method) if png_bytes is not None else (None, None)

    # Try JPEG fallback
    jpeg_bytes, jpeg_method = compress_image_to_jpeg(img, max_bytes)
    if jpeg_bytes is not None and len(jpeg_bytes) <= max_bytes:
        # write JPEG to path, but keep extension as given by caller (worker expects output_path)
        # Overwrite the path with JPEG bytes regardless of extension; worker / client reads bytes.
        with open(path, "wb") as f:
            f.write(jpeg_bytes)
        return True, jpeg_method, len(jpeg_bytes)

    # Neither approach brought it under max_bytes. Choose the smallest candidate among attempts.
    candidates = []
    if candidate[0] is not None:
        candidates.append((candidate[0], candidate[1]))
    if jpeg_bytes is not None:
        candidates.append((jpeg_bytes, jpeg_method))

    if candidates:
        best_bytes, best_method = min(candidates, key=lambda t: len(t[0]))
        with open(path, "wb") as f:
            f.write(best_bytes)
        return False, f"best-effort-{best_method}", len(best_bytes)

    return False, "no_attempts", None


def main():
    parser = argparse.ArgumentParser(description="Convert image to ASCII-art and compress under a limit.")
    parser.add_argument("input", help="Input image path")
    parser.add_argument("output", help="Output image path (will be overwritten)")
    parser.add_argument("--enhance", dest="enhance", default="1",
                        help="Enhance image? 1/0 or true/false (default 1)")
    parser.add_argument("--fullcolor", dest="fullcolor", default="1",
                        help="Full color ascii? 1/0 or true/false (default 1)")
    parser.add_argument("--char", dest="char", default=None,
                        help="Optional single character or string to use for ascii rendering")
    parser.add_argument("--max-bytes", dest="max_bytes", type=int, default=DEFAULT_MAX_BYTES,
                        help=f"Maximum allowed bytes for final output (default {DEFAULT_MAX_BYTES})")
    args = parser.parse_args()

    input_path = args.input
    output_path = args.output
    enhance = str_to_bool_like(args.enhance)
    fullcolor = str_to_bool_like(args.fullcolor)
    char = args.char if args.char not in ("", None) else None
    max_bytes = int(args.max_bytes)

    # Basic input checks
    if not os.path.exists(input_path):
        print(f"ERROR: input file does not exist: {input_path}", file=sys.stderr)
        sys.exit(2)

    # Create a temporary output file first (so we can recompress and atomically move)
    tmp_fd, tmp_out = tempfile.mkstemp(prefix="ascii_out_", suffix=os.path.splitext(output_path)[1] or ".png")
    os.close(tmp_fd)
    try:
        # Run ascii conversion
        try:
            # ascii_magic API: AsciiArt.from_image(input_path).to_image_file(output_path, enhance_image=..., full_color=..., char=...)
            art = AsciiArt.from_image(input_path)
            # to_image_file will write to the tmp_out path
            art.to_image_file(
                tmp_out,
                enhance_image=enhance,
                full_color=fullcolor,
                char=char
            )
            print(f"[ascii] conversion done -> {tmp_out}", file=sys.stderr)
        except Exception as e:
            # Fail early if ascii conversion fails
            print(f"ERROR: ascii conversion failed: {e}", file=sys.stderr)
            # cleanup tmp
            try:
                os.remove(tmp_out)
            except Exception:
                pass
            sys.exit(3)

        # Now ensure output <= max_bytes
        try:
            final_size = os.path.getsize(tmp_out)
        except Exception as e:
            print(f"ERROR: cannot stat tmp output: {e}", file=sys.stderr)
            os.remove(tmp_out)
            sys.exit(4)

        if final_size <= max_bytes:
            # already under limit; move to final output
            os.replace(tmp_out, output_path)
            print(f"[ok] output within limit ({final_size} bytes). Saved -> {output_path}", file=sys.stderr)
            sys.exit(0)
        else:
            print(f"[compress] output {final_size} bytes > max {max_bytes}, attempting compression...", file=sys.stderr)

        success, method, final_size = ensure_under_max_bytes(tmp_out, max_bytes)
        if final_size is None:
            print(f"ERROR: compression pipeline failed, no output produced", file=sys.stderr)
            try:
                os.remove(tmp_out)
            except Exception:
                pass
            sys.exit(5)

        # move final to output_path
        os.replace(tmp_out, output_path)
        if success:
            print(f"[ok] compressed to {final_size} bytes using {method}. Saved -> {output_path}", file=sys.stderr)
            sys.exit(0)
        else:
            print(f"[warn] best-effort compressed to {final_size} bytes using {method} (still > max). Saved -> {output_path}", file=sys.stderr)
            # even if still > max, we return success=0 so worker streams what we have (worker expects image stream)
            sys.exit(0)

    except Exception as e:
        # unexpected error - ensure tmp cleaned
        try:
            if os.path.exists(tmp_out):
                os.remove(tmp_out)
        except Exception:
            pass
        print(f"ERROR: unexpected failure: {e}", file=sys.stderr)
        sys.exit(6)


if __name__ == "__main__":
    main()
