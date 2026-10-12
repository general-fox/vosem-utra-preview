"""Build unhinted Vosem Sans webfonts from the retained Lato originals.

Requires fonttools[woff]. Run from any directory with Python 3.
The original TTFs, WOFF2s and SIL OFL license remain in assets/.
Use --originals to reproduce the historical, lossless Lato WOFF2 packages.
"""

import argparse
from pathlib import Path

from fontTools.pens.recordingPen import RecordingPen
from fontTools.ttLib import TTFont
from fontTools.ttLib.woff2 import WOFF2FlavorData, compress


ASSETS = Path(__file__).resolve().parents[1] / "assets"
NAMES = ("Lato-Regular", "Lato-Medium", "Lato-Italic")
HINT_TABLES = ("fpgm", "prep", "cvt ", "cvar", "hdmx", "VDMX")


def normalized_table(font, tag):
    data = bytearray(font.reader[tag])
    if tag == "head":
        # WOFF2 rewrites the checksum and records lossless compression in bit 11.
        data[8:12] = b"\0" * 4
        data[16:18] = (int.from_bytes(data[16:18], "big") & ~(1 << 11)).to_bytes(2, "big")
    return data


def package_originals():
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


def rename_derivative(font, style):
    # Lato is a Reserved Font Name under the retained SIL OFL license.
    values = {
        1: "Vosem Sans Medium" if style == "Medium" else "Vosem Sans",
        3: f"VosemSans-{style};1.000;unhinted-web",
        4: f"Vosem Sans {style}",
        5: "Version 1.000; unhinted derivative of Lato 3.100",
        6: f"VosemSans-{style}",
        16: "Vosem Sans",
        17: style,
    }
    for record in font["name"].names:
        if record.nameID in values:
            record.string = values[record.nameID].encode(record.getEncoding())
    # Typographic names keep all three styles in the same family.
    for name_id in (16, 17):
        font["name"].setName(values[name_id], name_id, 3, 1, 0x409)
    font["head"].fontRevision = 1.0


def remove_hints(font):
    font["glyf"].removeHinting()
    for tag in (*HINT_TABLES, "DSIG"):
        if tag in font:
            del font[tag]
    profile = font["maxp"]
    profile.maxZones = 1
    for field in ("maxTwilightPoints", "maxStorage", "maxFunctionDefs",
                  "maxInstructionDefs", "maxStackElements", "maxSizeOfInstructions"):
        setattr(profile, field, 0)
    # Smooth outlines at every size, without requesting grid fitting.
    font["gasp"].gaspRange = {65535: 0x000A}
    font["head"].flags &= ~0x0018  # No integer-ppem or hinted-advance requirement.


def verify_derivative(source, destination, style):
    with TTFont(source) as original, TTFont(destination) as packed:
        assert original.getGlyphOrder() == packed.getGlyphOrder(), style
        assert original.getBestCmap() == packed.getBestCmap(), style
        assert original["hmtx"].metrics == packed["hmtx"].metrics, style
        # All shaping, vertical metrics, character coverage and font styling stay intact.
        for tag in ("cmap", "hmtx", "hhea", "OS/2", "GDEF", "GPOS", "GSUB", "post"):
            assert original.reader[tag] == packed.reader[tag], (style, tag)
        assert original["head"].unitsPerEm == packed["head"].unitsPerEm, style
        for name in original.getGlyphOrder():
            before, after = RecordingPen(), RecordingPen()
            original["glyf"][name].draw(before, original["glyf"])
            packed["glyf"][name].draw(after, packed["glyf"])
            assert before.value == after.value, (style, name, "outline")
            glyph = packed["glyf"][name]
            assert not hasattr(glyph, "program") or not glyph.program.getBytecode(), (style, name, "hint")
        assert not any(tag in packed for tag in HINT_TABLES), style
        assert packed["name"].getDebugName(16) == "Vosem Sans", style
        for name_id in (0, 7, 8, 9, 11, 12, 13, 14):
            original_records = [(n.platformID, n.platEncID, n.langID, n.toUnicode())
                                for n in original["name"].names if n.nameID == name_id]
            packed_records = [(n.platformID, n.platEncID, n.langID, n.toUnicode())
                              for n in packed["name"].names if n.nameID == name_id]
            assert original_records == packed_records, (style, name_id, "attribution")


def package_derivatives():
    for name in NAMES:
        style = name.removeprefix("Lato-")
        source = ASSETS / f"{name}.ttf"
        destination = ASSETS / f"VosemSans-{style}.woff2"
        with TTFont(source, recalcBBoxes=False, recalcTimestamp=False) as font:
            remove_hints(font)
            rename_derivative(font, style)
            font.flavor = "woff2"
            font.flavorData = WOFF2FlavorData(transformedTables=set())
            font.save(destination)
        verify_derivative(source, destination, style)
        print(f"{destination.name}: {destination.stat().st_size:,} bytes; "
              "all outlines, metrics, cmap, shaping and attribution verified; no hints")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--originals", action="store_true", help="Rebuild historical lossless Lato WOFF2 files")
    args = parser.parse_args()
    package_originals() if args.originals else package_derivatives()
