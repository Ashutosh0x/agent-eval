# Design system

Every number in this document was computed or fetched, not asserted. Where a
previous draft was wrong, the correction and the measurement are both kept —
the point of a design system for a compliance product is that its claims are
checkable.

---

## 1. The design problem

Two users, no shared vocabulary, and every comparable tool serves one of them.

| | Evaluation engineer | Model-risk / compliance reviewer |
| --- | --- | --- |
| Job | Run evals, debug failures, spot reward hacking | Establish a run happened as claimed, approve risky actions, produce evidence |
| Mental model | Traces, spans, tool calls, diffs | Controls, provenance, chain of custody, retention |
| Density | Very high — wants everything on screen | Low — one claim at a time, with its basis |
| Environment | Dark, keyboard, second monitor | Light, often printing to PDF, sometimes magnified |
| If ignored | Unusable for real debugging | Rejected in procurement |

Inspect View, Langfuse, Phoenix and Braintrust serve the first column. Vanta
and Drata serve the second. The product thesis is that these are the same
record viewed twice, so the same data must render in two registers with an
honest bridge between them.

---

## 2. Colour

### 2.1 The palette, and the defect measurement found

Six values, no gradients, driven by truth-state.

| Token | Light | Role |
| --- | --- | --- |
| `ink` | `#16202B` | Primary text — document ink, not pure black |
| `paper` | `#F7F8FA` | Light surface — archival stock, deliberately not cream |
| `vault` | `#0E1116` | Dark surface for investigation views |
| `sealed` | `#1F6F4A` | Verified — desaturated, never a celebratory green |
| `broken` | `#A32B2B` | Tamper / verification failure — oxide red |
| `pending` | `#8A6D2F` | Unverified, awaiting approval, expired — ochre |

Contrast against `paper #F7F8FA`, computed per WCAG 2.x relative luminance:

| Token | Ratio | Body text | UI component |
| --- | --- | --- | --- |
| `ink` | 15.49 | AAA | pass |
| `broken` | 6.73 | AA | pass |
| `sealed` | 5.76 | AA | pass |
| `pending` | 4.59 | AA | pass |

The light theme is sound. **The dark theme is not**, and the failure lands on
the single most important state in the product:

| Token on `vault #0E1116` | Ratio | Body text (4.5) | UI component (3.0) |
| --- | --- | --- | --- |
| `paper` | 17.80 | AAA | pass |
| `pending` | 3.88 | **fail** | pass |
| `sealed` | 3.09 | **fail** | pass (barely) |
| `broken` | **2.65** | **fail** | **fail** |

`broken` is the colour that says *this evidence was tampered with*. At 2.65:1
on the dark ground it fails even the relaxed 3:1 threshold for a non-text UI
component. In dark mode, on the product whose entire pitch is tamper-evidence,
the tamper indicator is the least visible thing on screen.

A previous draft of this document claimed the palette was "verified in both
themes". It had not been verified; computing it took a few seconds and found
a defect that would have shipped.

### 2.2 Dark-theme tokens

State colours need separate dark values — the same practice Radix Colors and
Material both follow. Hue preserved, lightness raised until each clears 4.5:1
on `vault`:

| Token | Light | on paper | Dark | on vault |
| --- | --- | --- | --- | --- |
| `sealed` | `#1F6F4A` | 5.76 | `#278D5E` | 4.55 |
| `broken` | `#A32B2B` | 6.73 | `#D15151` | 4.51 |
| `pending` | `#8A6D2F` | 4.59 | `#977733` | 4.50 |

```css
:root {
  --ink:     #16202B;
  --paper:   #F7F8FA;
  --vault:   #0E1116;
  --sealed:  #1F6F4A;
  --broken:  #A32B2B;
  --pending: #8A6D2F;
  --surface: var(--paper);
  --text:    var(--ink);
}

/* State colours are redefined, never reused across themes. */
:root[data-theme='dark'],
:root:not([data-theme='light']) {
  @media (prefers-color-scheme: dark) {
    --surface: var(--vault);
    --text:    var(--paper);
    --sealed:  #278D5E;
    --broken:  #D15151;
    --pending: #977733;
  }
}
```

The interactive accent is `ink` at reduced opacity plus an underline, not a
brand colour. Coloured pixels are reserved for state, so that when a screen is
mostly grey a red seal means something.

**Deliberately avoided:** warm cream with terracotta, near-black with acid
green, and the hairline-broadsheet look. All three are current AI-design
defaults that appear regardless of subject matter.

### 2.3 Colour is never the only signal

WCAG 1.4.1, and simple correctness for an artifact that gets printed in
monochrome. Every state carries **colour + icon + text + shape**:

| State | Colour | Mark | Word | Shape |
| --- | --- | --- | --- | --- |
| Sealed | `sealed` | `stamp` | "Verified" | solid ring |
| Pending | `pending` | `circle-dashed` | "Unverified" | dashed ring |
| Broken | `broken` | `unlink` | "Chain broken" | ring with a visible gap |
| Unverifiable | `ink` 60% | `circle-help` | "Cannot verify" | no ring |

Print stylesheet: verify all four remain distinguishable in greyscale. The
shape column exists for exactly that.

---

## 3. Type

One superfamily, three cuts, mapped to the three registers of the product.

| Cut | Used for | Why |
| --- | --- | --- |
| **IBM Plex Sans** | Interface | Institutional, engineered provenance, good at small sizes |
| **IBM Plex Mono** | Every identifier — hashes, digests, step IDs, image tags, seeds, token counts | Anything read aloud, compared character by character, or pasted |
| **IBM Plex Serif** | Evidence bundles and printed output only | The serif signals "this is the record"; it appears nowhere in the live UI |

OFL licensed and **self-hosted**. A data-residency buyer will ask whether the
app calls a third-party font CDN, and "no" is a much better answer than an
explanation.

Scale: 12 / 13 / 15 / 18 / 24 / 32. Hard floor at 12px.
`font-variant-numeric: tabular-nums` wherever numbers align — every table,
every metric, every token count.

---

## 4. The seal

The one place to spend boldness. Everything else stays quiet.

Every verifiable artifact carries a `<Seal>` with exactly four states. It is
**not a badge**. Clicking it runs verification client-side through the
independent verifier path (`verifyInclusion` / `verifyConsistency` /
`verifySignature`) and shows the arithmetic:

- the Merkle inclusion proof, node by node
- the signing key id
- the reconstructed root, next to the expected root
- for a broken chain, **the specific entry where the break occurs**

A seal that shows a conclusion is a badge. A seal that shows its working is
evidence. The distinction is the product.

---

## 5. Icons

### 5.1 Lucide — verified against the registry

MIT, tree-shakeable, the set shadcn/ui assumes. **Current version: 1.37.0.**

Lucide v1 renamed a large number of icons to a noun-first convention. Names
from older documentation will silently fail. Checked against
`lucide-icons/lucide@main`:

| Name | Exists | Note |
| --- | --- | --- |
| `gavel` | **yes** | A previous draft said this was unavailable and suggested commissioning it. It is in the set. |
| `play-circle` | **no** | Renamed. Use `circle-play`. |
| `check-circle` | **no** | Renamed. Use `circle-check`. |
| `alert-circle` | **no** | Renamed. Use `circle-alert`. |
| `fingerprint` | **no** | Not present under that name. |
| `stamp`, `scale`, `shield-check`, `file-badge`, `link`, `unlink`, `archive`, `terminal`, `eye`, `box`, `file-lock`, `lock-keyhole`, `shield-alert`, `square-check`, `badge-check`, `file-check` | yes | |

Verify any icon name before shipping it:

```bash
curl -sI https://raw.githubusercontent.com/lucide-icons/lucide/main/icons/<name>.svg
```

### 5.2 Mapping

| Concept | Icon |
| --- | --- |
| Run | `circle-play` |
| Trajectory step | `chevron-right` |
| Tool call | `terminal` |
| Observation | `eye` |
| Evidence bundle | `file-badge` |
| Retention | `archive` |
| Approval queue | `gavel` |
| Sandbox | `box` |
| Policy | `shield-check` |
| Chain intact | `link` |
| Chain broken | `unlink` |
| Held-out split | `file-lock` |

**Seal states get custom marks.** The one element that is uniquely yours
should not be a stock shield glyph.

### 5.3 Rules

- Icons never carry meaning alone (§2.3).
- Decorative icons get `aria-hidden="true"`; meaningful ones get an accessible
  name.
- One family only. Mixing icon sets is the fastest way to make a product look
  assembled rather than designed.

### 5.4 Brand marks — a trademark surface, not an asset folder

For the integrations page, **Simple Icons** is the right default: ~3,400
brands, single monochrome path plus official hex, CC0 files, and per-icon
`guidelines` and `license` metadata. Alternatives with colour variants: svgl
(MIT), theSVG (larger, newer).

The caveat matters more here than in most products: **CC0 covers the icon
files, not the trademarks they depict.** Simple Icons exposes a per-icon
`guidelines` field precisely because brand usage terms are separate from file
licensing.

For a compliance product sold to risk-averse buyers, treat the integrations
page as a trademark surface:

- use a mark only to identify a genuine, working integration
- follow the owner's brand guidelines where published
- never imply endorsement or certification
- keep an internal record of which marks are used and on what basis

A "Trusted by" wall of logos you have no permission for is exactly what a
procurement reviewer notices.

---

## 6. The honest-mapping rule, carried into the UI

The evidence layer refuses to claim compliance it does not have: mappings
carry `satisfies` / `supports` / `exceeds`, and anything that is not
`satisfies` must have a caveat — enforced by a test.

The UI must not launder that away.

- **No green tick column.** A checkmark matrix would quietly destroy the main
  differentiator by rendering "exceeds" and "satisfies" identically.
- Strength renders as a **word**, not a colour or a glyph.
- The caveat renders **inline** and cannot be collapsed away — including on
  the print stylesheet.
- `exceeds` gets a visually distinct treatment from `satisfies`, so nobody
  reads "stronger than required" as "required and met".

This is a design constraint with teeth. The temptation to ship a tidy
green-tick compliance matrix will be constant, and it is the one change that
would make the product dishonest.

---

## 7. Component stack

| Concern | Choice | Rationale |
| --- | --- | --- |
| Primitives | shadcn/ui on Radix | Copy-into-repo, so every component is auditable — no third-party runtime in a product whose pitch is provenance |
| A11y-critical widgets | React Aria where Radix falls short | Most thoroughly tested for keyboard and screen reader |
| Data grid | TanStack Table | Headless |
| Virtualization | TanStack Virtual | Non-negotiable for transcripts and audit logs |
| Charts | Recharts | Sufficient for reward distributions and drift |
| Code / JSON | CodeMirror 6 | Lighter than Monaco, better a11y, good Rego and JSON modes |
| Forms | react-hook-form + Zod | Zod schemas already exist server-side; share them |
| Data | TanStack Query | Cache, retry, background refresh |
| Hashes | custom `<Digest>` | Middle-ellipsis truncation, copy-on-click, full value in the DOM for screen readers — never truncate silently |

---

## 8. Accessibility is a procurement gate

For a product sold to EU financial institutions, health bodies and public
sector, this blocks the sale rather than sitting in a backlog.

- The **European Accessibility Act** (Directive (EU) 2019/882) became
  enforceable **28 June 2025**, and reaches B2B software where employees are
  the end users.
- The harmonised standard is **EN 301 549**. The current legally recognised
  version is **v3.2.1** (March 2021), which incorporates **WCAG 2.1 AA**.
- **v4.1.1**, incorporating **WCAG 2.2 AA**, is expected to be cited in the
  Official Journal around **October–November 2026**. Conformance with it will
  then create the presumption of conformity with the EAA.
- The European Commission rejects accessibility overlay widgets as a
  compliance route. There is no product to buy instead.

**Target WCAG 2.2 AA now**, not 2.1, so the v4.1.1 citation does not force a
re-audit weeks after it lands. The 2.2 additions that will actually bite this
UI: focus appearance, target size, dragging alternatives (the graph view), and
consistent help.

Commitments:

- Full keyboard operation of the trajectory viewer — moving between steps,
  expanding tool output — with a focus indicator that survives dark mode.
- Contrast ≥ 4.5:1 text and ≥ 3:1 UI components, **verified by computation in
  both themes**, in CI. §2.1 is what happens without this.
- `prefers-reduced-motion` respected; the graph view must not animate layout
  by default.
- EN 301 549 covers electronic documents, so the exported evidence PDF needs
  **tagged structure, a document title, and reading order**. An untagged PDF
  fails the standard even when the web app passes.
- Produce a VPAT / Accessibility Conformance Report early — enterprise buyers
  request it during security review, and writing it surfaces gaps while they
  are cheap.
- Wire `axe-core` into Playwright in CI. Given this repo previously shipped
  tests asserting `expect(true).toBe(true)`, checks that assert against real
  rendered DOM are worth more here than usual.

---

## Sources

- [Lucide](https://lucide.dev) — icon names verified against `lucide-icons/lucide@main`, v1.37.0
- [Simple Icons](https://simpleicons.org) — CC0 files, per-icon trademark metadata
- [WCAG 2.2](https://www.w3.org/TR/WCAG22/)
- [EN 301 549 (Wikipedia)](https://en.wikipedia.org/wiki/EN_301_549) and [v4.1.1 timeline](https://www.axall.digital/insights/en301549-version-4-1-1-what-changes-and-when-it-applies)
- [European Accessibility Act guidance](https://www.levelaccess.com/blog/eu-accessibility-requirements-and-eaa-compliance/)
- Contrast ratios computed with the WCAG 2.x relative-luminance formula; the script is in §2.1's method and reproducible in ten lines.
