# Find Bar Plus (a better Ctrl+F)

**English** | [繁體中文](README.zh-TW.md)

Replaces the browser's `Ctrl/Cmd+F` with an in-page find bar: match case, whole
word, regex, **multi-word (colored)** search, a match counter, **scrollbar tick
marks**, **search history**, and **click-anchor navigation**.

Highlights use the **CSS Custom Highlight API** — the page DOM is never changed,
so no site layout breaks. Everything runs locally; it talks to no server.

## Load (unpacked)

1. Chrome → `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked** → pick this `better-find/` folder

## Basics

| Key | Action |
|---|---|
| `Cmd/Ctrl+F` | Open the find bar (native find is suppressed) |
| `Enter` / `Shift+Enter` | Next / previous match |
| `Cmd/Ctrl+G`, `F3` (bar open) | Next (`Shift` = previous) |
| `↑` / `↓` (in the input) | Recall search history (last 20) |
| `Esc` (in the input) | Close and clear highlights |

Bar layout: `[input] 3/128 │ Aa ab (.*) ●● │ ⌃ ⌄ ✕`

- **Aa** match case, **ab** whole word, **(.\*)** regex, **●●** multi-word mode (below)
- The four toggles are remembered (across tabs)
- Selected page text prefills the search on open
- Current match is orange, the rest yellow (one color per term in multi-word mode)

## Multi-word colored mode (the **●●** toggle)

When it's **off** (default), behavior is unchanged: a space is a literal space,
you search exactly what you type.

When **on**:

| Input | Meaning |
|---|---|
| `bridge tunnel` | two terms: `bridge`, `tunnel`, each highlighted in its own color |
| `"speed limit" bypass` | two terms: the phrase `speed limit` (with the space) + `bypass` |
| `"a b" "c d"` | two phrases |

- **Space = separates terms; `"double quotes"` = keep a spaced phrase as one term** (like Google search)
- The match-case / whole-word toggles apply to every term
- Next / previous walks **all** terms' matches in document order
- Hover the counter to see **each term's count** (spot a 0-match term at a glance)
- **Mutually exclusive** with regex mode (turning one on turns the other off). To
  search several words in one color in normal mode, use regex `bridge|tunnel`

## Scrollbar tick marks

- A thin rail on the right edge draws a mark for every match (in multi-word mode
  each mark takes **its term's color**); the current match is a bold orange mark
- **Click a mark to jump straight to that match**
- Limits: only the main (top) frame's matches get marks; matches inside inner
  scroll containers / iframes are not marked, but **their count and highlight
  still work**; matches inside `<option>` rows have no layout box, so no mark

## Click-anchor navigation

- **Click anywhere** on the page, then press **Next / Previous** — it starts
  **from where you clicked**, not from the top
- `Enter` = first match at/after the click; `Shift+Enter` = last match before it;
  after that it steps normally until you click again
- Clicks inside iframes are supported too (coordinated via the background worker)

## Search history

- Press `↑` / `↓` in the input to recall the last 20 searches (kept across tabs)
- Recorded when: you navigate with Enter, click Next/Previous, or close the bar
  with a query in it — not on every keystroke

## iframe search

Text inside iframes **is** searched. Each frame searches and highlights its own
document; the top frame's bar aggregates the total, and Next/Previous walks
across frames in order. `Cmd/Ctrl+F` also opens the bar when focus is in an iframe.

## `<select>` lists (e.g. NDS Web Viewer)

`<option>` rows inside an **open** list box (`multiple` or `size>1` `<select>`,
such as NDS Web Viewer's Attribute Highlighting list) **are** searchable; the
current match's row is **tinted orange** (the CSS Highlight API can't paint
inside `<option>`, so a background color stands in). A collapsed dropdown is not
searched (its options aren't rendered).

## Honest limitations

- `chrome://` pages, Chrome Web Store, the **PDF viewer**: extensions can't run
  there → those pages fall back to native find (a nice fallback)
- Frames from other extensions and sandboxed edge cases are not searched
- **Canvas-rendered text** (Google Docs, Figma): not in the DOM, can't be found
- Whitespace is matched literally — `a b` does not match `a\nb`
- Scrolling to a match inside a **cross-origin** iframe scrolls that iframe; the
  outer page may not always scroll to reveal it (a browser security limit);
  count and highlight are unaffected
- Native find is still reachable from the menu: Edit → Find

## Version

0.3.2 — multi-word colored search, scrollbar ticks, search history,
click-anchor navigation, iframe search, `<option>` list support.
