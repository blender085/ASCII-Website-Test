# ascii_convert.py
import sys
import argparse
from ascii_magic import AsciiArt

def main():
    p = argparse.ArgumentParser()
    p.add_argument('input_path')
    p.add_argument('output_path')
    p.add_argument('--enhance', dest='enhance', default='1')
    p.add_argument('--fullcolor', dest='fullcolor', default='1')
    p.add_argument('--char', dest='char', default=None)
    args = p.parse_args()

    enhance = args.enhance == '1'
    fullcolor = args.fullcolor == '1'
    char = args.char if args.char not in (None, 'None', '') else None

    # Call ascii_magic per your API (adjust options to match library)
    art = AsciiArt.from_image(args.input_path)
    # ascii_magic may accept parameters; this wrapper simply uses defaults and writes PNG
    # If ascii_magic supports those options directly, pass them.
    # For now, we call to_image_file and assume it respects the defaults.
    art.to_image_file(args.output_path, enhance_image=enhance, full_color=fullcolor, char=char)

if __name__ == '__main__':
    main()
