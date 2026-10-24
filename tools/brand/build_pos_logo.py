"""Builds the One POS (by AWS Distribution) logo from the One logo system.

Run from the project root:  python tools/brand/build_pos_logo.py public/brand

Same symbol, lettering, colours and lockups as One (build_logo.py, copied unchanged from
AWS One/tools/brand); only the wordmark changes: "One" in indigo + "POS" in AWS orange.
"""
import os, sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import build_logo as bl

WORD_GAP = 0.26  # space between "One" and "POS", in ems


def text_block(tone, style, tag_size=None):
    """'One POS' + the AWS Distribution signature (see build_logo.text_block)."""
    mono = style == "mono"
    ink = bl.INDIGO if tone == "light" else bl.WHITE
    pos_ink = ink if mono else bl.ORANGE
    colours = {"ink": ink, "accent": ink if mono else bl.ORANGE,
               "tag": ink if mono else (bl.TAG_ON_LIGHT if tone == "light" else bl.TAG_ON_DARK)}
    size = bl.ONE_SIZE
    one_l = bl.ink_bounds("One", 800, size)[0]
    d_one, adv = bl.text("One", 800, size, -one_l)
    pos_x = adv + WORD_GAP * size
    pos_l = bl.ink_bounds("POS", 800, size)[0]
    d_pos, _ = bl.text("POS", 800, size, pos_x - pos_l)
    word_w = pos_x + bl.ink_bounds("POS", 800, size)[2] - pos_l
    parts, sig_w = bl.signature()
    cap = tag_size or word_w * 1000 / sig_w
    k = cap / 1000
    y = 150 + (-bl.SIG_TOP) * k
    body = [f'<path fill="{colours[role]}" d="{"".join(items)}"/>' for role, items in parts.items()]
    svg = (f'<path fill="{ink}" d="{d_one}"/><path fill="{pos_ink}" d="{d_pos}"/>'
           f'<g transform="translate(0 {y:.1f}) scale({k:.5f})">{"".join(body)}</g>')
    desc = bl.ink_bounds("y", bl.SIG_W, bl.SIG_EM)[3]
    return svg, max(word_w, sig_w * k), -bl.CAP - 12, y + (desc + 20) * k


bl.text_block = text_block
bl.TITLE = "One POS by AWS Distribution"

if __name__ == "__main__":
    out = sys.argv[1]
    os.makedirs(out, exist_ok=True)
    for tone in ("light", "dark"):
        with open(os.path.join(out, f"one-pos-header-{tone}.svg"), "w", encoding="utf-8") as f:
            f.write(bl.horizontal("hero", tone, pad=0, tag_size=bl.HEADER_TAG))
        with open(os.path.join(out, f"one-pos-horizontal-{tone}.svg"), "w", encoding="utf-8") as f:
            f.write(bl.horizontal("hero", tone, pad=0))
    print("ok")
