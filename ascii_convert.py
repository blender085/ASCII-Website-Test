#!/usr/bin/env python3
# ascii_convert.py
# Usage: python3 ascii_convert.py input_path output_path

import sys
from ascii_magic import AsciiArt

def main():
    if len(sys.argv) < 3:
        print("Usage: ascii_convert.py <input_path> <output_path>", file=sys.stderr)
        return 2
    in_path = sys.argv[1]
    out_path = sys.argv[2]

    try:
        # You can tune parameters here (columns, font, etc.)
        art = AsciiArt.from_image(in_path)
        # produce an image file (png)
        art.to_image_file(out_path)
        return 0
    except Exception as e:
        print("Error converting image to ASCII:", str(e), file=sys.stderr)
        return 1

if __name__ == "__main__":
    sys.exit(main())
