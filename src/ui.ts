// One look for every page bind.ws serves: the landing, the relay page, the
// invite page. Paper, ink, thick borders, hard shadows, a handwritten
// display face. Pages import the shell and drop their markup into it.

export const FONTS = `<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Pangolin&family=Instrument+Sans:ital,wght@0,400;0,500;0,600;1,400&family=DM+Mono:wght@400;500&display=swap" rel="stylesheet">`;

export const FAVICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect x="2" y="2" width="28" height="28" rx="8" fill="#f2d16b" stroke="#1c1b18" stroke-width="2.5"/><circle cx="16" cy="16" r="5" fill="#1c1b18"/><circle cx="16" cy="16" r="10" fill="none" stroke="#2f6b45" stroke-width="2.5" stroke-dasharray="6 5"/></svg>`;

export const BASE_CSS = `
:root {
  --paper: #fffdf9; --head: #faf9f6; --ink: #1c1b18; --ink-2: #625e56; --ink-3: #9c968c; --line: #e2ddd3; --line-2: #cfc8bb;
  --forest: #2f6b45; --forest-2: #3f8a5b; --forest-soft: #dfeae2; --moss: #b9cfae; --sun: #f2d16b; --red: #b8442f; --red-soft: #f8e8e4;
  --id-2: #c9a227; --id-3: #7ba7c7;
  --mint: #d9efe1; --butter: #fbeec1; --peach: #fadad0; --sky: #d7e6f6; --lilac: #e7def4;
  --display: "Pangolin", "Instrument Sans", cursive; --sans: "Instrument Sans", system-ui, sans-serif; --mono: "DM Mono", ui-monospace, monospace;
}
* { box-sizing: border-box; }
html { background-color: #f8f4ec; }
body { margin: 0; color: var(--ink); font: 15px/1.5 var(--sans); -webkit-font-smoothing: antialiased; min-height: 100vh;
  background-image: radial-gradient(40rem 22rem at -5% 0%, rgba(215,230,246,.8), transparent 60%), radial-gradient(36rem 20rem at 105% 20%, rgba(250,218,208,.8), transparent 60%), radial-gradient(44rem 26rem at 50% 110%, rgba(217,239,225,.9), transparent 60%); }
main { max-width: 64rem; margin: 0 auto; padding: 2.5rem 1.5rem 4rem; }
a { color: inherit; }
.mono { font-family: var(--mono); font-size: .86em; }
.hidden { display: none !important; }
.muted, .dim { color: var(--ink-3); }
.note { font-size: 13px; color: var(--ink-2); }
.row { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; }
h1 { margin: 0; font: 400 5.6rem/1 var(--display); letter-spacing: -.02em; color: var(--ink); text-shadow: 3px 3px 0 var(--sun), 6px 6px 0 var(--forest); display: inline-block; cursor: default; user-select: none; -webkit-user-select: none; transition: transform .18s cubic-bezier(.34,1.56,.64,1), text-shadow .18s ease; word-break: break-all; }
h1:hover { transform: translate(-3px, -3px) rotate(-3deg); text-shadow: 5px 5px 0 var(--sun), 10px 10px 0 var(--forest); }
h1:active { transform: translate(2px, 2px) rotate(1deg); text-shadow: 1px 1px 0 var(--sun), 2px 2px 0 var(--forest); transition-duration: .06s; }
h1 em { font-style: normal; color: var(--forest); }
h2 { margin: 0 0 .5rem; font: 400 2.4rem/1 var(--display); letter-spacing: -.01em; }
h2::after { content: ""; display: block; width: 3.2rem; height: 6px; margin-top: .45rem; background: var(--ink); border-radius: 3px; transform: rotate(-2deg); }
h3 { margin: 0 0 .5rem; font: 600 .95rem var(--sans); }
p.lead { margin: 0 0 1.1rem; color: var(--ink-2); }
section, .card { position: relative; background: var(--paper); border: 2px solid var(--ink); border-radius: 18px; box-shadow: 6px 6px 0 var(--ink); padding: 1.3rem 1.5rem 1.5rem; margin: 2.2rem 0; }
.btn { font: 600 14px var(--sans); padding: .45rem .85rem; border: 2px solid var(--ink); background: var(--paper); color: var(--ink); cursor: pointer; border-radius: 999px; box-shadow: 2px 2px 0 var(--ink); text-decoration: none; display: inline-block; }
.btn:active { transform: translate(2px, 2px); box-shadow: none; }
.btn.pri { background: var(--forest); color: #fff; }
.btn.danger { color: var(--red); }
.btn:disabled, .ib:disabled { opacity: .5; cursor: default; }
.btn svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; vertical-align: -3px; margin-right: .2rem; }
.ib { display: inline-grid; place-items: center; width: 30px; height: 30px; padding: 0; border: 2px solid var(--ink); border-radius: 999px; background: var(--paper); color: var(--ink); cursor: pointer; box-shadow: 2px 2px 0 var(--ink); vertical-align: middle; }
.ib svg { width: 15px; height: 15px; fill: none; stroke: currentColor; stroke-width: 3; stroke-linecap: round; stroke-linejoin: round; }
.ib:hover { background: var(--sun); }
.ib:active { transform: translate(2px, 2px); box-shadow: none; }
.ib.pri { background: var(--forest); color: #fff; }
.ib.danger { color: var(--red); }
.ib.danger:hover { background: var(--red-soft); }
.ib + .ib { margin-left: .3rem; }
input.txt, select.txt, textarea, .sats { font: 15px var(--sans); width: 100%; outline: none; color: var(--ink); border: 2px solid var(--ink); border-radius: 10px; background: var(--paper); padding: .4rem .6rem; }
input.txt:focus, select.txt:focus, textarea:focus, .sats:focus-within { box-shadow: 0 0 0 3px var(--moss); }
input.txt.num { width: 6rem; text-align: right; }
input.txt.mono { font-family: var(--mono); font-size: 13px; }
textarea { resize: vertical; min-height: 4rem; }
/* WebKit keeps its own chrome on selects unless appearance is reset; draw the chevron ourselves. */
select.txt { -webkit-appearance: none; appearance: none; padding-right: 1.9rem; cursor: pointer;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24' fill='none' stroke='%231c1b18' stroke-width='3' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat; background-position: right .55rem center; background-size: 14px; }
code.pill { font: 500 14px var(--mono); color: var(--ink); background: var(--paper); border: 2px solid var(--ink); border-radius: 10px; padding: .3rem .6rem; box-shadow: 2px 2px 0 var(--ink); }
.av { display: inline-block; width: 20px; height: 20px; border-radius: 50%; vertical-align: -5px; margin-right: .45rem; background: conic-gradient(from var(--h, 0deg), var(--forest), var(--id-2), var(--id-3), var(--forest)); flex: 0 0 auto; }
.chip { display: inline-block; padding: .1rem .55rem; border-radius: 999px; font: 700 11px var(--sans); letter-spacing: .05em; text-transform: uppercase; border: 2px solid var(--ink); background: var(--sun); margin-right: .3rem; }
footer.pg { display: flex; align-items: center; gap: 1rem; margin-top: 3rem; color: var(--ink-3); font-size: 13px; }
footer.pg p { margin: 0; } footer.pg a { font-family: var(--mono); font-size: 12px; text-decoration: none; color: var(--ink-3); } footer.pg a::before { content: "-> "; color: var(--forest); } footer.pg a:hover { color: var(--ink); }
#toast { position: fixed; left: 50%; bottom: 1.5rem; transform: translate(-50%, 1rem); background: var(--ink); color: var(--paper); padding: .6rem 1rem; border-radius: 999px; font-size: .9rem; opacity: 0; transition: .25s; pointer-events: none; max-width: 90vw; border: 2px solid var(--paper); box-shadow: 2px 2px 0 var(--ink); }
#toast.show { opacity: 1; transform: translate(-50%, 0); }
@media (max-width: 52rem) { h1 { font-size: 4rem; } }
`;

// page wraps a body in the shared shell.
export function page(title: string, body: string, extraCSS = "", head = ""): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHTML(title)}</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
${head}
${FONTS}
<style>${BASE_CSS}${extraCSS}</style>
</head><body>${body}<div id="toast"></div></body></html>`;
}

export function escapeHTML(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
