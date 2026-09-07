# Self-hosted fonts

The CSP on `dao.kekbull.com` is `font-src 'self'`, and the design brief requires
fonts to be self-hosted. These are subset to Latin-1 plus the punctuation this
UI actually emits, converted to WOFF, and served from this directory.

They exist because the stylesheet previously named only system families:

```
--disp: "Arial Narrow", "Helvetica Neue Condensed", Impact, "Franklin Gothic Condensed", sans-serif
--body: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif
```

None of those exist on Linux, and none exist on Android either, which is where
most holders arrive from a Telegram link. Every heading and paragraph fell back
to the generic sans and the condensed display face never appeared at all.

| file | face | role |
|---|---|---|
| `disp-400.woff` | Liberation Sans Narrow Regular | headings (`--disp`) |
| `disp-700.woff` | Liberation Sans Narrow Bold | headings, bold |
| `body-400.woff` | Fira Sans Regular | body copy (`--body`) |
| `body-600.woff` | Fira Sans SemiBold | `strong` |
| `mono-400.woff` | Fira Mono Regular | figures, labels, addresses (`--mono`) |

Liberation Sans Narrow is metric-compatible with Arial Narrow, which is what
the stylesheet asked for first. It renders the designer's stated intent on
platforms that do not ship Arial.

## Licences

Both families are SIL Open Font License 1.1, which permits redistribution and
web embedding.

- **Liberation Sans Narrow** - Digitized data copyright (c) 2010 Google
  Corporation with Reserved Font Name Arimo, Tinos and Cousine. Copyright (c)
  2012 Red Hat, Inc. with Reserved Font Name Liberation. SIL OFL 1.1.
- **Fira Sans, Fira Mono** - Digitized data copyright 2012-2016, The Mozilla
  Foundation and Telefonica S.A. SIL OFL 1.1.

Subsetting and format conversion are permitted under the OFL. The Reserved Font
Names are unchanged: these files keep the original family names internally and
are not renamed derivatives.

## Regenerating

Requires `fonttools`. Add `brotli` to emit `.woff2` instead, which is roughly
30% smaller; WOFF was used here only because brotli was not installed.

```
pyftsubset <src.ttf> --unicodes="U+0020-007E,U+00A0-00FF,U+00B7,U+2013-2014,\
U+2018-201A,U+201C-201E,U+2022,U+2026,U+2030,U+2039,U+203A,U+20AC,U+2192,\
U+00A7,U+00D7" --output-file=<out.woff> --flavor=woff \
--layout-features=kern,liga --desubroutinize --no-hinting
```
