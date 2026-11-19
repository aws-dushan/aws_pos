"""Builds the One POS logo (symbol + "ONE POS", no signature line) from the One logo system.

Run from the project root:  python tools/brand/build_pos_logo.py public/brand

Same symbol, lettering, colours and lockups as One (build_logo.py, copied unchanged from
AWS One/tools/brand); only the wordmark changes: "ONE" in indigo + "POS" in AWS orange.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_logo as bl

WORD_GAP = 0.26  # space between "ONE" and "POS", in ems


def text_block(tone, style, tag_size=None):
    """'ONE POS' alone (no signature line): "ONE" in indigo/white + "POS" in AWS orange, baseline y=0."""
    mono = style == "mono"
    ink = bl.INDIGO if tone == "light" else bl.WHITE
    pos_ink = ink if mono else bl.ORANGE
    size = bl.ONE_SIZE
    one_l = bl.ink_bounds("ONE", 800, size)[0]
    d_one, adv = bl.text("ONE", 800, size, -one_l)
    pos_x = adv + WORD_GAP * size
    pos_l = bl.ink_bounds("POS", 800, size)[0]
    d_pos, _ = bl.text("POS", 800, size, pos_x - pos_l)
    word_w = pos_x + bl.ink_bounds("POS", 800, size)[2] - pos_l
    svg = f'<path fill="{ink}" d="{d_one}"/><path fill="{pos_ink}" d="{d_pos}"/>'
    # Room above and below the words, so the symbol keeps its size next to them (as when the signature sat underneath).
    return svg, word_w, -bl.CAP * 1.3, bl.CAP * 0.3


bl.text_block = text_block
bl.TITLE = "One POS"

if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for tone in ("light", "dark"):
        with open(os.path.join(out, f"one-pos-header-{tone}.svg"), "w", encoding="utf-8") as f:
            f.write(bl.horizontal("hero", tone, pad=0))
        with open(os.path.join(out, f"one-pos-horizontal-{tone}.svg"), "w", encoding="utf-8") as f:
            f.write(bl.horizontal("hero", tone, pad=0))
    print("ok")
