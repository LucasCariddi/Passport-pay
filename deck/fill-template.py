"""Fill the official HackMeridian template with the Passport Pay pitch.

Keeps every template shape, image, font and color; replaces guidance text,
adds a few visuals in the right-hand area and speaker notes.
"""
import copy
import sys
from pathlib import Path

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.shapes import MSO_SHAPE
from pptx.enum.text import PP_ALIGN, MSO_ANCHOR
from pptx.oxml.ns import qn
from pptx.util import Inches, Pt

SRC, OUT = sys.argv[1], sys.argv[2]
# 800x800 square crop (face and torso); also served to the web deck as /media/team-lucas.jpg
PHOTO = Path(__file__).resolve().parent.parent / "design/hackmeridian-template/team-lucas.jpg"

BLACK = RGBColor(0x0F, 0x0F, 0x0F)
YELLOW = RGBColor(0xFD, 0xDA, 0x24)
PAPER = RGBColor(0xF7, 0xF6, 0xF2)
TEXT = RGBColor(0x2A, 0x2A, 0x2A)
GREY = RGBColor(0x5C, 0x5C, 0x5C)
STAMP = RGBColor(0xC2, 0x3A, 0x1A)
MONO = "JetBrains Mono"
SANS = "Inter Tight"
HEAD = "Instrument Sans"

TX = "https://stellar.expert/explorer/testnet/tx/"
CAP_TX = "bab36b82ed02d39b364348e9e485b5192acbbc67aad73036ba925df93795de15"
SITE = "https://passport-pay-stellar.vercel.app"


def shape(slide, sid):
    for sh in slide.shapes:
        if sh.shape_id == sid:
            return sh
    raise KeyError(sid)


def set_paras(sh, texts):
    """Replace paragraph texts, keeping the first run's formatting of each paragraph."""
    tf = sh.text_frame
    paras = list(tf.paragraphs)
    while len(paras) < len(texts):
        new = copy.deepcopy(paras[-1]._p)
        paras[-1]._p.addnext(new)
        paras = list(tf.paragraphs)
    for p, t in zip(paras, texts):
        runs = p.runs
        if not runs:
            p.text = t
            continue
        runs[0].text = t
        for r in runs[1:]:
            r._r.getparent().remove(r._r)
    for p in paras[len(texts):]:
        p._p.getparent().remove(p._p)


def set_think(sh, label, answer):
    """The 'Think' box: bold label run + answer run, no emoji."""
    p = sh.text_frame.paragraphs[0]
    runs = p.runs
    label_run = next((r for r in runs if "Think" in r.text), runs[0])
    others = [r for r in runs if r is not label_run]
    label_run.text = label + " "
    if others:
        others[0].text = answer
        for r in others[1:]:
            r._r.getparent().remove(r._r)
    else:
        r = copy.deepcopy(label_run._r)
        label_run._r.addnext(r)
        p.runs[1].text = answer
        p.runs[1].font.bold = False


def textbox(slide, x, y, w, h, lines, size=14, font=MONO, color=GREY, bold=False,
            align=PP_ALIGN.LEFT, link=None):
    tb = slide.shapes.add_textbox(Inches(x), Inches(y), Inches(w), Inches(h))
    tf = tb.text_frame
    tf.word_wrap = True
    for i, line in enumerate(lines):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = align
        r = p.add_run()
        r.text = line
        r.font.size = Pt(size)
        r.font.name = font
        r.font.bold = bold
        r.font.color.rgb = color
        if link:
            r.hyperlink.address = link
    return tb


def notes(slide, text):
    slide.notes_slide.notes_text_frame.text = text


prs = Presentation(SRC)
s1, s2, s3, s4, s5 = prs.slides

# 1. Cover
title = shape(s1, 87)
set_paras(title, ["PASSPORT PAY", "Give your agent money. Not the power to drain it."])
p0, p1 = title.text_frame.paragraphs
base = p0.runs[0].font.size or Pt(120)
p0.runs[0].font.size = Pt(int(base.pt * 0.82))
p1.runs[0].font.size = Pt(34)
p1.runs[0].font.color.rgb = RGBColor(0xFF, 0xFF, 0xFF)
p1.runs[0].font.name = SANS
p1.runs[0].font.bold = False
textbox(s1, 1.0, 6.75, 12.0, 0.45, ["GENESIS · STELLAR UNLOCKED + COMPOSED · passport-pay-stellar.vercel.app"],
        size=15, color=YELLOW)
notes(s1, "Hi, this is Passport Pay. AI agents are starting to spend real money, and today the "
          "only thing standing between a hijacked agent and your wallet is hope. We fixed that on Stellar.")

# 2. The Solution
set_paras(shape(s2, 112), ["The rules live in the agent's smart account."])
set_paras(shape(s2, 113), [
    "Agents pay APIs over x402, each with a ZK passport credential, one per agent, anti-Sybil by nullifier.",
    "Every payment is checked: payee, cap, revocation.",
    "A hijacked agent can sign. Stellar still says no.",
])
set_think(shape(s2, 114), "Why it wins:", "it works even when the agent itself is compromised.")
stamp = s2.shapes.add_shape(MSO_SHAPE.OVAL, Inches(14.45), Inches(3.95), Inches(4.3), Inches(4.3))
stamp.rotation = -12
stamp.fill.solid()
stamp.fill.fore_color.rgb = PAPER
stamp.line.color.rgb = STAMP
stamp.line.width = Pt(6)
tf = stamp.text_frame
tf.vertical_anchor = MSO_ANCHOR.MIDDLE
for i, (txt, size, font, bold) in enumerate([
    ("STELLAR TESTNET", 12, MONO, True),
    ("REJECTED", 30, HEAD, True),
    ("CapExceeded #6", 15, MONO, True),
    ("tx bab36b82…de15", 12, MONO, False),
]):
    p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = txt
    r.font.size, r.font.name, r.font.bold = Pt(size), font, bold
    r.font.color.rgb = STAMP
    if i == 3:
        r.hyperlink.address = TX + CAP_TX
textbox(s2, 13.9, 8.85, 5.4, 0.5, ["Real FAILED tx on testnet · watch the demo"], size=11,
        link=SITE + "/presentacion", align=PP_ALIGN.CENTER)
notes(s2, "Here's our real agent. It read a page with a hidden instruction to pay an attacker. It "
          "obeyed and signed. Stellar rejected it, because the rules are enforced by the agent's own "
          "contract account. x402 says how an agent pays. Passport Pay decides who can pay, whom, and "
          "how much, without trusting anyone.")

# 3. PMF
set_paras(shape(s3, 134), ["Agents with wallets ship now. Injection is the risk."])
set_paras(shape(s3, 135), [
    "Owners: babysit every payment, or trust a bypassable cap.",
    "Sellers: no free tier for agents without bot farms.",
    "Stellar: x402 and MPP are live; bounded authority is missing.",
])
set_think(shape(s3, 136), "Why care:", "one injected page can drain an agent's wallet.")
notes(s3, "Every team building agents that pay hits the same wall: you can't hand an agent a budget "
          "without handing it the keys. And sellers can't trust who's on the other side. Passport Pay "
          "gives owners a hard limit and sellers a payer that brings its own controls.")

# 4. Technical Workflow
tw = shape(s4, 155)
set_paras(tw, ["WORKFLOW"])
set_paras(shape(s4, 156), ["Prove. Bind. Enforce. Official x402 facilitator."])
set_paras(shape(s4, 157), [
    "Prove: ZK passport in the browser, verified on BN254.",
    "Bind: the factory deploys the agent's account in one tx.",
    "Enforce: __check_auth on every USDC transfer.",
])
set_think(shape(s4, 158), "Why it works:", "live on testnet, 40+ contract tests, public demo.")
flow = [("OWNER", "ZK passport in the browser"), ("PASSPORTFACTORY", "verify proof + deploy account"),
        ("PASSPORTACCOUNT", "__check_auth on every payment"), ("X402 API", "USDC settles, or the ledger refuses")]
y = 3.95
for i, (k, v) in enumerate(flow):
    box = s4.shapes.add_shape(MSO_SHAPE.ROUNDED_RECTANGLE, Inches(14.2), Inches(y), Inches(4.8), Inches(0.86))
    box.fill.solid()
    box.fill.fore_color.rgb = BLACK if i != 2 else YELLOW
    box.line.fill.background()
    tf = box.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    for j, (txt, size, font, bold) in enumerate([(k, 12, MONO, True), (v, 13, SANS, False)]):
        p = tf.paragraphs[0] if j == 0 else tf.add_paragraph()
        p.alignment = PP_ALIGN.CENTER
        r = p.add_run()
        r.text = txt
        r.font.size, r.font.name, r.font.bold = Pt(size), font, bold
        r.font.color.rgb = YELLOW if i != 2 else BLACK
    if i < len(flow) - 1:
        textbox(s4, 16.35, y + 0.82, 0.5, 0.3, ["▼"], size=12, color=TEXT, align=PP_ALIGN.CENTER)
    y += 1.14
notes(s4, "Three steps. Prove, bind, enforce. The key is that enforcement runs inside __check_auth, so "
          "the official facilitator rejects at simulation and the ledger rejects if anyone skips it. "
          "Prior work is declared: the ZK passport comes from open-stellar-passport, and Open Stellar had "
          "the marketplace with checks in the backend. Here we moved them onchain.")

# 5. The Team (only Lucas Cariddi)
set_paras(shape(s5, 178), ["Rooted in the Stellar community in Buenos Aires."])
set_paras(shape(s5, 179), [
    "Lucas Cariddi · Marketing and growth",
    "Stellar Ambassador, Stellar events in Buenos Aires.",
    "Crypto and AI (Compoze Labs, Bitget). UTN FRBA.",
])
set_think(shape(s5, 180), "Why us:", "we live in the Stellar community.")
# Team photo in the template's circle: yellow ring (the old initials oval) with the photo clipped
# to an ellipse on top. The "LC" initials stay only while there is no photo file.
AX, AY, AD, RING = 15.1, 3.9, 2.9, 0.09
avatar = s5.shapes.add_shape(MSO_SHAPE.OVAL, Inches(AX), Inches(AY), Inches(AD), Inches(AD))
avatar.fill.solid()
avatar.fill.fore_color.rgb = YELLOW
avatar.line.fill.background()
if PHOTO.exists():
    pic = s5.shapes.add_picture(str(PHOTO), Inches(AX + RING), Inches(AY + RING),
                                Inches(AD - 2 * RING), Inches(AD - 2 * RING))
    pic.name = "Lucas Cariddi"
    pic._element.nvPicPr.cNvPr.set("descr", "Lucas Cariddi")
    pic._element.spPr.find(qn("a:prstGeom")).set("prst", "ellipse")
else:
    tf = avatar.text_frame
    tf.vertical_anchor = MSO_ANCHOR.MIDDLE
    p = tf.paragraphs[0]
    p.alignment = PP_ALIGN.CENTER
    r = p.add_run()
    r.text = "LC"
    r.font.size, r.font.name, r.font.bold = Pt(64), HEAD, True
    r.font.color.rgb = BLACK
textbox(s5, 1.0, 9.0, 18.0, 0.5,
        ["Engineering on the shoulders of Bitcoindefi's open-stellar-passport and Open Stellar  ·  "
         "passport-pay-stellar.vercel.app  ·  github.com/LucasCariddi/passport-pay"], size=12, link=SITE)
notes(s5, "I'm Lucas, I run marketing and growth, and I'm a Stellar Ambassador in Buenos Aires. We built "
          "this because every agent team we talk to hits the same wall. Try it yourself: the link is on "
          "screen. Thanks.")

prs.save(OUT)
print("saved", OUT)
