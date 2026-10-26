# Passport Pay: Claude Design source

Designed in Claude Design (a private Design canvas owned by the author). The artboards here are
the visual source of truth for the site. Implement them faithfully, replacing every
`[PLACEHOLDER]` with real data from real runs.

| Artboard | Route |
|---|---|
| `project/Main.dc.html` | `/` landing |
| `project/App.dc.html` | `/app` web app |
| `project/Notes.dc.html` | `/notas` speaker view |
| `project/Slide-1.dc.html`, `Slide-2`, `Slide-3` | `/presentacion` (title, the moment, how it works). The other slides follow these three layouts |

`.dc.html` is the Claude Design component format: the markup inside `<x-dc>` is plain HTML with
inline styles, `<sc-for list="{{items}}" as="x">` is a loop over the arrays returned by
`renderVals()` in the script block, and `{{x.y}}` is a lookup. Translate it to the site's real
stack (static HTML for the landing and deck, React for `/app`).

## Concept: customs for agents

The agent crosses a border with its passport. Every payment is a crossing: the smart account
either stamps it through or rejects it. **The REJECTED stamp is the hero moment.** It always
carries the real error name and the real tx hash, linked to stellar.expert.

Signature elements:
- **Passport card**: deep green cover, gold type, a machine-readable zone (MRZ) strip in mono
  (`P<STELLAR<<AGENT<...<<CAP<0.05USDC<<`).
- **Stamp**: a circle with a 3 to 8 px vermilion border, rotated about -12 to -14deg, with mono
  microtype + a heavy display word (REJECTED) + the error + the short hash.
- **Ledger tables**: real transactions with SUCCESS and FAILED pills.

## Tokens

| Token | Light | Use |
|---|---|---|
| `--ground` | `#F3F5F0` | page background |
| `--surface` | `#FFFFFF` | cards, tables |
| `--ink` | `#0C1A13` | text, dark sections (`#0C1A13` is also the dark ground) |
| `--ink-2` | `#33443A` | body copy on light |
| `--muted` | `#4A5A51` | labels (passes AA on ground and surface) |
| `--line` | `#CFD8D0` | borders; `#E1E7E2` for inner rules; `#B9C6BC` for outlines |
| `--passport` | `#12372A` | primary buttons, header, passport cover |
| `--gold` | `#E6D3A3` | type on passport green; `#F5ECD3` for headings there, `#BFAF86` for labels |
| `--ok` | `#0B6B5C` | links, eyebrows, approved; pill `#E2F0EA` / `#0B4D43` |
| `--stamp` | `#C23A1A` on light, `#FF6A3D` on dark | rejected; pill `#FBE4DC` / `#9A2A10`; dark text accent `#FF8A64`, quote `#FFD2C2` |
| dark surfaces | `#1B2A22`, `#13241B`, borders `#2A3D33` | inside dark sections |
| dark text | `#EAF0EA`, secondary `#B8C6BC`, tertiary `#8FA396` | |

Dark mode for the site: dark sections already exist (incident, fire test, speaker view). For a
full dark theme, map ground to `#0C1A13`, surface to `#13241B`, ink to `#EAF0EA`, keep passport
green and stamp `#FF6A3D`.

## Type

Google Fonts, `display=swap`:
- **Bricolage Grotesque** 700/800: display and headings, tight tracking (-0.02 to -0.04em),
  line-height ~1.
- **Public Sans** 400 to 700: body and UI.
- **IBM Plex Mono** 400 to 600: hashes, addresses, MRZ, eyebrows (uppercase, +0.14em), prices.

Scale (web): h1 `clamp(44px, 6vw, 84px)`, h2 `clamp(32px, 4vw, 52px)`, body 17 to 20 px,
labels 12 to 13 px. Slides (1920x1080): h1 132, h2 96 to 112, body 30 to 36, mono 20 to 26.

## Layout and components

- Max width 1240 (site) / 1320 (app), 24 px gutters, sections 96 px vertical.
- Fluid: `flex-wrap` rows with `flex-basis`, grids `repeat(auto-fit, minmax(260px, 1fr))`.
  Phone at 375 px: everything stacks, no horizontal scroll; tables scroll inside their box.
- Buttons: pill (999 px radius), min-height 44 to 52, primary = passport green, secondary =
  1.5 px outline, danger = stamp. Cards: 12 to 18 px radius, 1 px line border, no shadows except
  the passport card.
- Icons: inline stroke SVG only. No emoji, no gradients, no left-border cards.

## Copy

All English, product voice, short sentences, no em dashes. Lead with the pain ("Give your agent
money. Not the power to drain it."), then the incident, then the mechanism. Be explicit about
what is onchain and what the seller checks.
