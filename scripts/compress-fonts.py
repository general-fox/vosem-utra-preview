"""Losslessly package the original Lato fonts as WOFF2 (no subsetting).

Requires fonttools[woff]. Run from any directory with Python 3.
The original TTFs and their SIL OFL license must remain in assets/.
"""

from pathlib import Path

from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import compress


ASSETS = Path(__file__).resolve().parents[1] / "assets"
NAMES = ("Lato-Regular", "Lato-Medium", "Lato-Italic")


def normalized_table(font, tag):
    data = bytearray(font.reader[tag])
    if tag == "head":
        # WOFF2 rewrites the checksum and records lossless compression in bit 11.
        data[8:12] = b"\0" * 4
        data[16:18] = (int.from_bytes(data[16:18], "big") & ~(1 << 11)).to_bytes(2, "big")
    return data


def main():
    original_total = compressed_total = 0
    for name in NAMES:
        source = ASSETS / f"{name}.ttf"
        destination = source.with_suffix(".woff2")
        # No glyph/table transforms, no glyph removal and no metadata changes.
        # FontTools omits the original empty digital-signature placeholder.
        compress(source, destination, transform_tables=set())
        with TTFont(source) as original, TTFont(destination) as packed:
            original_tags = set(original.reader.keys())
            if "DSIG" in original_tags and "DSIG" not in packed.reader:
                assert original.reader["DSIG"] == bytes.fromhex("0000000100000000"), name
                original_tags.remove("DSIG")
            assert original_tags == set(packed.reader.keys()), name
            for tag in original_tags:
                assert normalized_table(original, tag) == normalized_table(packed, tag), (name, tag)
            assert original.getBestCmap() == packed.getBestCmap(), name
            assert original["hmtx"].metrics == packed["hmtx"].metrics, name
        before, after = source.stat().st_size, destination.stat().st_size
        original_total += before
        compressed_total += after
        print(f"{name}: {before:,} -> {after:,} bytes; tables and character map verified")
    print(f"Total: {original_total:,} -> {compressed_total:,} bytes ({1 - compressed_total / original_total:.1%} smaller)")


if __name__ == "__main__":
    main()
