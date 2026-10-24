"""Builds the One (by AWS Distribution) logo system as clean SVGs.

Run from tools/brand:  python build_logo.py ../../docs/brand/logo/svg
then:                  node render.mjs ../../docs/brand/logo/svg   (PNGs)

The symbol is a thick ring (the O) with a 1 folded through it: the 1's top
tucks under the ring, its foot runs over the ring and folds along the
bottom-left edge. Coordinates: symbol box 1000x1000, centre (500, 500), y-down.
Text is Outfit (SIL OFL), converted to outlines.
"""
import math, os, sys
from shapely.geometry import Point, Polygon, box
from shapely.ops import unary_union
from shapely import affinity
from fontTools.ttLib import TTFont
from fontTools.varLib import instancer
from fontTools.pens.svgPathPen import SVGPathPen
from fontTools.pens.transformPen import TransformPen
from fontTools.pens.boundsPen import BoundsPen

HERE = os.path.dirname(os.path.abspath(__file__))

# ---- palette (AWS Distribution) --------------------------------------------------
INDIGO = "#342571"        # AWS indigo: wordmark on light, flat ring on light
ORANGE = "#EB6713"        # AWS orange: the 1
RING_ON_DARK = "#6A57E8"  # flat ring on dark (indigo is too dark to read there)
NIGHT = "#120E24"         # dark background
WHITE = "#FFFFFF"
TAG_ON_LIGHT = "#5B4F8F"  # "by ... Distribution"
TAG_ON_DARK = "#C9C3E6"

# ---- symbol geometry ---------------------------------------------------------------
C = 500
R = 470                   # ring outer radius
r = R * 0.58              # ring inner radius
STEM = (-0.05, 0.25)      # stem x-range, in units of R from the centre
FLAG_FROM = (0.08, -0.47)
FLAG_TO = (-0.30, -0.15)
FLAG_W = 0.19             # flag thickness, units of R
TAIL_END = 120            # degrees (y-down, 90 = bottom) where the fold ends
GAP = 0.04 * R            # knock-out gap used by the one-colour versions

def _p(ux, uy):
    return (C + ux * R, C + uy * R)

def symbol_shapes():
    disk_R = Point(C, C).buffer(R, 256)
    disk_r = Point(C, C).buffer(r, 256)
    ring = disk_R.difference(disk_r)
    x0, x1 = (C + STEM[0] * R, C + STEM[1] * R)
    stem = box(x0, C - R, x1, C + R).intersection(disk_R)
    (fx0, fy0), (fx1, fy1) = _p(*FLAG_FROM), _p(*FLAG_TO)
    from shapely.geometry import LineString
    flag = LineString([(fx0, fy0), (fx1, fy1)]).buffer(FLAG_W * R / 2, 64)
    # the fold: a tapering band along the outer bottom-left edge
    a0 = math.degrees(math.atan2(math.sqrt(R * R - (STEM[0] * R) ** 2), STEM[0] * R))
    outer, inner = [], []
    steps = 48
    for i in range(steps + 1):
        a = a0 + (TAIL_END - a0) * i / steps
        rad = math.radians(a)
        outer.append((C + R * math.cos(rad), C + R * math.sin(rad)))
        t = i / steps
        ri = r + (R - r) * (t ** 0.55)       # inner edge rises to meet the outer edge
        inner.append((C + ri * math.cos(rad), C + ri * math.sin(rad)))
    tail = Polygon(outer + inner[::-1]).buffer(0)
    one = unary_union([stem, flag, tail]).intersection(disk_R)
    # layering: the ring passes over the 1 at the top, the 1 passes over the ring below
    upper = box(0, 0, 1000, C)
    lower = box(0, C, 1000, 1000)
    one_vis = one.difference(ring.intersection(upper))
    ring_vis = ring.difference(one.intersection(lower))
    fold_line = LineString(inner)           # crease between foot and fold
    return dict(ring=ring, ring_vis=ring_vis, one=one, one_vis=one_vis,
                stem=stem, tail=tail, upper=upper, lower=lower,
                disk_r=disk_r, fold_line=fold_line)

def d_of(geom):
    out = []
    for p in getattr(geom, "geoms", [geom]):
        if p.is_empty:
            continue
        for ring in [p.exterior, *p.interiors]:
            pts = list(ring.simplify(0.15).coords)[:-1]
            out.append("M" + "L".join(f"{x:.1f} {y:.1f}" for x, y in pts) + "Z")
    return "".join(out)

def symbol_svg(style, tone, uid):
    """style: hero | flat | mono.  tone: light | dark (background it sits on).
    Returns (defs, body) in the 1000x1000 symbol box."""
    s = SYM
    if style == "mono":
        c = INDIGO if tone == "light" else WHITE
        ring_part = s["ring_vis"].difference(s["one"].intersection(s["lower"]).buffer(GAP))
        one_part = s["one_vis"].difference(s["ring"].intersection(s["upper"]).buffer(GAP))
        return "", f'<path fill="{c}" d="{d_of(unary_union([ring_part, one_part]))}"/>'
    if style == "flat":
        ring_c = INDIGO if tone == "light" else RING_ON_DARK
        crease = s["fold_line"].buffer(GAP * 0.35).intersection(s["one_vis"])
        return "", (f'<path fill="{ring_c}" d="{d_of(s["ring_vis"])}"/>'
                    f'<path fill="{ORANGE}" d="{d_of(s["one_vis"])}"/>'
                    f'<path fill="#B9440A" d="{d_of(crease)}"/>')
    # hero: glossy
    if tone == "light":
        ring_stops = [("0", "#7A68F2"), ("0.45", "#4634B8"), ("1", "#241760")]
    else:
        ring_stops = [("0", "#8672FF"), ("0.45", "#5640D6"), ("1", "#2A1C7A")]
    st = lambda stops: "".join(f'<stop offset="{o}" stop-color="{c}"/>' for o, c in stops)
    defs = (
        f'<linearGradient id="{uid}r" x1="150" y1="80" x2="850" y2="930" gradientUnits="userSpaceOnUse">{st(ring_stops)}</linearGradient>'
        f'<radialGradient id="{uid}h" cx="430" cy="170" r="430" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#FFFFFF" stop-opacity="0.38"/><stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></radialGradient>'
        f'<linearGradient id="{uid}o" x1="560" y1="230" x2="520" y2="960" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#FFB547"/><stop offset="0.5" stop-color="#F57A1C"/><stop offset="1" stop-color="#D9520B"/></linearGradient>'
        f'<linearGradient id="{uid}t" x1="300" y1="900" x2="500" y2="780" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#A93C08"/><stop offset="1" stop-color="#E5600F"/></linearGradient>'
        f'<linearGradient id="{uid}s" x1="0" y1="{C - r:.0f}" x2="0" y2="{C - r + 80:.0f}" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#1A0F45" stop-opacity="0.32"/><stop offset="1" stop-color="#1A0F45" stop-opacity="0"/></linearGradient>'
        f'<linearGradient id="{uid}g" x1="{C + STEM[0] * R:.0f}" y1="0" x2="{C + STEM[1] * R:.0f}" y2="0" gradientUnits="userSpaceOnUse">'
        f'<stop offset="0" stop-color="#FFFFFF" stop-opacity="0"/><stop offset="0.62" stop-color="#FFFFFF" stop-opacity="0.28"/>'
        f'<stop offset="1" stop-color="#FFFFFF" stop-opacity="0"/></linearGradient>'
    )
    tail_vis = s["tail"].intersection(s["one_vis"])
    shade_top = s["one_vis"]
    sheen = s["stem"].intersection(s["one_vis"]).difference(s["tail"].buffer(2))
    ring_highlight = s["ring_vis"]
    body = (f'<path fill="url(#{uid}r)" d="{d_of(s["ring_vis"])}"/>'
            f'<path fill="url(#{uid}h)" d="{d_of(ring_highlight)}"/>'
            f'<path fill="url(#{uid}o)" d="{d_of(s["one_vis"])}"/>'
            f'<path fill="url(#{uid}t)" d="{d_of(tail_vis)}"/>'
            f'<path fill="url(#{uid}s)" d="{d_of(shade_top)}"/>'
            f'<path fill="url(#{uid}g)" d="{d_of(sheen)}"/>')
    return defs, body

SYM = symbol_shapes()

# ---- text -----------------------------------------------------------------------------
def font(w):
    fp = os.path.join(HERE, f"Outfit-{w}.ttf")
    if not os.path.exists(fp):
        instancer.instantiateVariableFont(TTFont(os.path.join(HERE, "Outfit.ttf")), {"wght": w}).save(fp)
    f = TTFont(fp)
    return f.getGlyphSet(), f.getBestCmap()

def text(txt, w, size, x=0.0, tracking=0.0):
    """(path d, advance) for txt at `size` units per em, baseline y=0, starting at x."""
    gs, cmap = font(w)
    s = size / 1000
    pen = SVGPathPen(gs)
    for ch in txt:
        g = gs[cmap[ord(ch)]]
        g.draw(TransformPen(pen, (s, 0, 0, -s, x, 0)))
        x += g.width * s + tracking * s
    return pen.getCommands(), x

def ink_bounds(txt, w, size):
    gs, cmap = font(w)
    bp = BoundsPen(gs); x = 0; s = size / 1000
    for ch in txt:
        g = gs[cmap[ord(ch)]]
        g.draw(TransformPen(bp, (s, 0, 0, -s, x, 0))); x += g.width * s
    return bp.bounds

CAP = 1000 * 703 / 1000   # Outfit cap height per 1000 em
ONE_SIZE = 1000           # "One" at 1000 units/em -> cap height 703

# ---- the company signature: "by AWS DiSTRiBUTiON" in the company logo's own lettering ------
# Drawn at cap height 1000, baseline y=0 (y-down). Roles: ink (indigo / white on dark),
# accent (AWS orange), tag (the word "by").

def aws_mark(dx):
    """Geometric redraw of the AWS letters: A and W from the logo's measured strokes (each
    V of the W is an indigo down-stroke and an orange up-stroke, the first orange tucking
    under the second indigo), S from Outfit. Placed at x=dx, baseline y=0.
    Returns (indigo d, orange d, width)."""
    SL, WA, A_TOP, A_R = 0.3475, 205, -50, 806
    apex_l, apex_r = SL * (1000 - A_TOP), A_R - SL * (1000 - A_TOP)
    outer = Polygon([(0, 1000), (apex_l, A_TOP), (apex_r, A_TOP), (A_R, 1000)])
    il = lambda y: WA + SL * (1000 - y)
    ir = lambda y: A_R - WA - SL * (1000 - y)
    t = (A_R - 2 * WA) / (2 * SL)
    counter = Polygon([(il(1000), 1000), (il(1000 - t), 1000 - t), (ir(1000), 1000)])
    A = outer.difference(counter.difference(box(-10, 600, A_R + 10, 752)))
    SW, WW, TIP = 0.33, 200, 1068
    def v(vx):
        top, k = SW * TIP, WW / (2 * SW)
        down = Polygon([(vx - top, 0), (vx - top + WW, 0), (vx + SW * k, TIP - k), (vx, TIP)])
        up = Polygon([(vx, TIP), (vx + top, 0), (vx + top - WW, 0), (vx - SW * k, TIP - k)])
        return down, up
    v1 = 728 + SW * TIP
    v2 = v1 + 392
    d1, u1 = v(v1)
    d2, u2 = v(v2)
    d2_right = lambda y: (v2 - SW * TIP + WW) + SW * y
    u1 = u1.intersection(Polygon([(-5000, -100), (d2_right(-100), -100), (d2_right(1200), 1200), (-5000, 1200)]))
    d1, u1, d2 = d1.difference(u1), u1.difference(d2), d2.difference(u2)
    gs, cmap = font(DIST_W)
    g = gs[cmap[ord("S")]]
    k, cond = 1000 / 703, 0.86
    s_x = v2 + SW * TIP + 70
    pen = SVGPathPen(gs)
    g.draw(TransformPen(pen, (k * cond, 0, 0, -k, dx + s_x - 18 * k * cond, 0)))
    width = s_x + (g.width - 36) * k * cond
    place = lambda geom: affinity.translate(geom, dx, -1000)     # cap top 0 -> baseline 0
    return d_of(place(unary_union([A, d1, d2]))) + pen.getCommands(), d_of(place(unary_union([u1, u2]))), width

# "DiSTRiBUTiON" as in the company logo: letter boxes measured from the logo (x from the D,
# cap height 1000), colours per letter, square-dotted i's (stem below the cap line, dot above it).
DIST = [("D", 0, 732, "accent"), ("i", 821, 1017, ("ink", "accent")), ("S", 1107, 1696, "ink"),
        ("T", 1732, 2321, "ink"), ("R", 2411, 3018, "ink"), ("i", 3107, 3339, ("accent", "ink")),
        ("B", 3482, 4036, "ink"), ("U", 4107, 4804, "ink"), ("T", 4875, 5464, "ink"),
        ("i", 5571, 5767, ("ink", "accent")), ("O", 5857, 6696, "ink"), ("N", 6839, 7589, "ink")]
DIST_W = 620              # Outfit weight whose stem matches the logo's (~0.2 x cap height)
I_STEM_TOP, I_DOT = -890, (-1211, -961)
SIG_W = 500               # Outfit weight for "by"
SIG_EM = 1000 / 0.703     # em size that gives cap height 1000
SIG_TOP = I_DOT[0]        # the i dots rise above the capitals

def signature():
    """Returns ({role: [path d]}, width) for 'by AWS DiSTRiBUTiON', starting at x=0."""
    gs, cmap = font(SIG_W)
    s = SIG_EM / 1000
    parts = {"ink": [], "accent": [], "tag": []}
    bl = BoundsPen(gs); gs[cmap[ord("b")]].draw(bl)
    x = -bl.bounds[0] * s
    for ch in "by":
        pen = SVGPathPen(gs); g = gs[cmap[ord(ch)]]
        g.draw(TransformPen(pen, (s, 0, 0, -s, x, 0)))
        parts["tag"].append(pen.getCommands())
        x += g.width * s
    space = gs[cmap[ord(" ")]].width * s
    x += space
    ind, ora, aw = aws_mark(x)
    parts["ink"].append(ind); parts["accent"].append(ora)
    x += aw + space
    dgs, dcmap = font(DIST_W)
    for ch, x0, x1, role in DIST:
        if ch == "i":
            stem_role, dot_role = role
            parts[stem_role].append(f"M{x + x0:.1f} 0H{x + x1:.1f}V{I_STEM_TOP}H{x + x0:.1f}Z")
            parts[dot_role].append(f"M{x + x0:.1f} {I_DOT[1]}H{x + x1:.1f}V{I_DOT[0]}H{x + x0:.1f}Z")
            continue
        g = dgs[dcmap[ord(ch)]]
        bp = BoundsPen(dgs); g.draw(bp)
        gx0, _, gx1, _ = bp.bounds
        sx = (x1 - x0) / (gx1 - gx0)          # fit the glyph's ink to the measured box
        pen = SVGPathPen(dgs)
        g.draw(TransformPen(pen, (sx, 0, 0, -SIG_EM / 1000, x + x0 - gx0 * sx, 0)))
        parts[role].append(pen.getCommands())
    x += DIST[-1][2]
    return parts, x

def text_block(tone, style, tag_size=None):
    """'One' + the AWS Distribution signature, left aligned at x=0, 'One' baseline y=0.
    `tag_size`: signature cap height in units (default: as wide as 'One').
    Returns (svg, width, top, bottom)."""
    mono = style == "mono"
    ink = INDIGO if tone == "light" else WHITE
    colours = {"ink": ink, "accent": ink if mono else ORANGE,
               "tag": ink if mono else (TAG_ON_LIGHT if tone == "light" else TAG_ON_DARK)}
    one_l = ink_bounds("One", 800, ONE_SIZE)[0]
    d_one, _ = text("One", 800, ONE_SIZE, -one_l)
    one_w = ink_bounds("One", 800, ONE_SIZE)[2] - one_l
    parts, sig_w = signature()
    cap = tag_size or one_w * 1000 / sig_w
    k = cap / 1000
    y = 150 + (-SIG_TOP) * k                 # signature baseline
    body = []
    for role, items in parts.items():
        body.append(f'<path fill="{colours[role]}" d="{"".join(items)}"/>')
    svg = (f'<path fill="{ink}" d="{d_one}"/>'
           f'<g transform="translate(0 {y:.1f}) scale({k:.5f})">{"".join(body)}</g>')
    desc = ink_bounds("y", SIG_W, SIG_EM)[3]    # depth of the y in "by" (y-down bounds)
    return svg, max(one_w, sig_w * k), -CAP - 12, y + (desc + 20) * k

# ---- documents -------------------------------------------------------------------------
def svg_doc(w, h, defs, body, title):
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w:.0f} {h:.0f}" '
            f'width="{w:.0f}" height="{h:.0f}" role="img" aria-label="{title}">'
            f'<title>{title}</title><defs>{defs}</defs>{body}</svg>\n')

TITLE = "One by AWS Distribution"
HEADER_TAG = 330          # signature cap height (units) in the app-header lockup
PAD = 140

def horizontal(style, tone, pad=PAD, tag_size=None):
    tb, tw, ttop, tbot = text_block(tone, style, tag_size)
    block_h = tbot - ttop
    sym = block_h * (1.0 if tag_size else 1.18)   # symbol diameter vs text block
    k = sym / (2 * R)
    defs, body = symbol_svg(style, tone, "s")
    H = sym + 2 * pad
    sym_x, sym_y = pad - (C - R) * k, pad - (C - R) * k
    tx = pad + sym + sym * 0.16
    ty = pad + sym / 2 - (ttop + tbot) / 2
    W = tx + tw + pad
    out = (f'<g transform="translate({sym_x:.1f} {sym_y:.1f}) scale({k:.5f})">{body}</g>'
           f'<g transform="translate({tx:.1f} {ty:.1f})">{tb}</g>')
    return svg_doc(W, H, defs, out, TITLE)

def stacked(style, tone, pad=PAD):
    tb, tw, ttop, tbot = text_block(tone, style)
    sym = tw * 0.62
    k = sym / (2 * R)
    defs, body = symbol_svg(style, tone, "s")
    W = tw + 2 * pad
    sym_x = (W - sym) / 2 - (C - R) * k
    sym_y = pad - (C - R) * k
    tx = pad
    ty = pad + sym + sym * 0.20 - ttop
    H = ty + tbot + pad
    out = (f'<g transform="translate({sym_x:.1f} {sym_y:.1f}) scale({k:.5f})">{body}</g>'
           f'<g transform="translate({tx:.1f} {ty:.1f})">{tb}</g>')
    return svg_doc(W, H, defs, out, TITLE)

def symbol_doc(style, tone):
    defs, body = symbol_svg(style, tone, "s")
    return svg_doc(1000, 1000, defs, body, "One")

def app_icon(size, tone, style="hero", fill=0.76):
    bg = WHITE if tone == "light" else NIGHT
    defs, body = symbol_svg(style, tone, "s")
    k = size * fill / (2 * R)
    off = size / 2 - C * k
    out = (f'<rect width="{size}" height="{size}" rx="{size * 0.225:.1f}" fill="{bg}"/>'
           f'<g transform="translate({off:.2f} {off:.2f}) scale({k:.5f})">{body}</g>')
    return svg_doc(size, size, defs, out, "One")

if __name__ == "__main__":
    OUT = sys.argv[1]
    os.makedirs(OUT, exist_ok=True)
    for f in os.listdir(OUT):
        if f.endswith(".svg"):
            os.remove(os.path.join(OUT, f))
    save = lambda n, d: open(os.path.join(OUT, n), "w", encoding="utf-8").write(d)
    variants = [("hero", "light", "light"), ("hero", "dark", "dark"),
                ("flat", "light", "flat-light"), ("flat", "dark", "flat-dark"),
                ("mono", "light", "mono-indigo"), ("mono", "dark", "mono-white")]
    for style, tone, name in variants:
        save(f"one-horizontal-{name}.svg", horizontal(style, tone))
        save(f"one-stacked-{name}.svg", stacked(style, tone))
        save(f"one-symbol-{name}.svg", symbol_doc(style, tone))
        save(f"one-header-{name}.svg", horizontal(style, tone, tag_size=HEADER_TAG))
    save("one-app-icon-light.svg", app_icon(1024, "light"))
    save("one-app-icon-dark.svg", app_icon(1024, "dark"))
    save("favicon.svg", app_icon(64, "light", fill=0.86))
    # tight (unpadded) copies for the web app, if a target folder is given
    if len(sys.argv) > 2:
        WEB = sys.argv[2]
        os.makedirs(WEB, exist_ok=True)
        w = lambda n, d: open(os.path.join(WEB, n), "w", encoding="utf-8").write(d)
        for tone in ("light", "dark"):
            # app header: a larger tagline so "by AWS Distribution" stays readable at ~40 px tall
            w(f"one-header-{tone}.svg", horizontal("hero", tone, pad=0, tag_size=HEADER_TAG))
            w(f"one-horizontal-{tone}.svg", horizontal("hero", tone, pad=0))
    print("ok")
