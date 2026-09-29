export function escapeHtml(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

const PAGE_STYLE = `
:root {
  --bg: #f3f4f6;
  --card: #ffffff;
  --ink: #1b242c;
  --muted: #5c6b76;
  --line: #e2e6ea;
  --line-strong: #cfd6dc;
  --accent: #0f6b5c;
  --soft: #e7f2ef;
  --danger: #8f2d2d;
  --danger-bg: #fdecec;
  --radius: 12px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  color: var(--ink);
  background: var(--bg);
  font: 15px/1.5 "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Noto Sans SC", sans-serif;
}
button, input, select, textarea { font: inherit; color: inherit; }
.app { display: grid; grid-template-columns: 216px minmax(0, 1fr); min-height: 100vh; }
.side { background: var(--card); border-right: 1px solid var(--line); padding: 22px 14px; }
.side .brand { display: block; margin: 0 8px 18px; }
.side nav { display: flex; flex-direction: column; gap: 4px; }
.side a.item { display: block; text-decoration: none; color: inherit; padding: 8px 10px; border-radius: 8px; }
.side a.item.active { background: var(--soft); color: var(--accent); font-weight: 600; }
.main { padding: 24px 28px 72px; min-width: 0; }
.main-inner { max-width: 980px; }
.top { display: flex; align-items: center; justify-content: flex-end; gap: 16px; margin-bottom: 20px; }
.brand { font-weight: 600; font-size: 20px; letter-spacing: -0.03em; text-decoration: none; color: inherit; }
.tag { margin: 0; color: var(--muted); flex: 1; }
.session { display: flex; align-items: center; gap: 8px; color: var(--muted); }
.role { background: var(--soft); color: var(--accent); border-radius: 999px; padding: 2px 8px; font-size: 12px; }
button.ghost, button.primary { border-radius: 8px; cursor: pointer; }
button.ghost { background: var(--card); border: 1px solid var(--line-strong); padding: 6px 12px; }
button.primary { background: var(--accent); color: #fff; border: 0; padding: 10px 16px; }
h1 { font-size: 22px; font-weight: 600; margin: 0; }
h2 { font-size: 16px; font-weight: 600; margin: 0 0 4px; }
.lead { color: var(--muted); margin: 6px 0 0; }
.block { margin-top: 32px; }
.banner { background: var(--danger-bg); color: var(--danger); border-radius: 10px; padding: 10px 12px; margin: 12px 0; }
.note-warn { background: #fff6e8; color: #8a5a00; border-radius: 10px; padding: 10px 12px; margin: 8px 0; }
.fields label.is-off { display: none; }
.toolbar { display: flex; align-items: flex-end; gap: 20px; margin: 16px 0 4px; }
.namebar { display: flex; flex-direction: column; gap: 6px; width: min(360px, 100%); }
.namebar span, .region-pick span, .net span, .psum, .net-head p { color: var(--muted); font-size: 13px; }
input, select {
  background: #fff;
  border: 1px solid var(--line-strong);
  border-radius: 8px;
  padding: 8px 10px;
}
input:focus, select:focus { outline: 2px solid #b7ddd4; border-color: var(--accent); }
.panel { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 16px; margin: 14px 0 8px; }
.fields { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px; margin: 12px 0; }
.fields label, .panel label { display: flex; flex-direction: column; gap: 6px; font-size: 13px; color: var(--muted); }
.fields input, .fields select, .fields textarea, .panel input, .panel select, .panel textarea { width: 100%; }
.fields textarea { min-height: 96px; font: inherit; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 8px; }
.fields .wide { grid-column: 1 / -1; }
.id-line { display: flex; align-items: stretch; min-width: 0; }
.id-prefix { display: flex; align-items: center; padding: 0 10px; background: #f3f4f6; border: 1px solid var(--line-strong); border-right: 0; border-radius: 8px 0 0 8px; color: var(--ink); white-space: nowrap; }
.id-line input { flex: 1; min-width: 0; width: auto; border-radius: 0 8px 8px 0; }
.zone-group { display: flex; flex-wrap: wrap; gap: 8px 14px; margin: 8px 0 12px; }
.zone-group span { width: 100%; }
.zone-group label { display: flex; align-items: center; gap: 6px; }
.zone-group.is-off { display: none; }
.cloud {
  background: var(--card);
  border: 1px solid var(--line);
  border-left: 3px solid #8aa0a8;
  border-radius: var(--radius);
  padding: 16px;
  margin: 12px 0;
}
.cloud[data-platform="aws"] { border-left: 3px solid #e0a106; }
.cloud[data-platform="azure"] { border-left: 3px solid #3b82c4; }
.cloud[data-platform="aliyun"] { border-left: 3px solid #e07a3d; }
.cloud-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; }
.platform-pick { display: flex; align-items: center; gap: 8px; font-weight: 600; font-size: 16px; }
.region-pick { display: flex; align-items: center; gap: 8px; }
.group-title { margin: 14px 0 8px; font-size: 12px; font-weight: 600; color: var(--muted); }
.products { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.product { display: flex; flex-direction: column; border: 1px solid var(--line); border-radius: 10px; padding: 10px; background: #fbfcfd; }
.product label { display: grid; grid-template-columns: auto 1fr; column-gap: 8px; align-items: start; cursor: pointer; }
.product input[type="checkbox"] { margin-top: 3px; }
.ptitle { font-weight: 600; }
.psum { grid-column: 2; }
.product label { margin-bottom: 8px; }
.product select, .product textarea { width: 100%; margin-top: 8px; }
.product textarea, .config-cell textarea { min-height: 72px; padding: 8px 10px; border: 1px solid var(--line-strong); border-radius: 8px; resize: vertical; background: #fff; }
.product .config-edit { display: flex; flex-direction: column; gap: 6px; margin-top: 8px; cursor: default; }
.product .config-edit.is-off { display: none; }
.product .count-edit { align-items: flex-start; }
.product .count-edit input { width: 96px; }
.config-cell { white-space: normal; min-width: 240px; }
.config-cell form { display: flex; flex-direction: column; gap: 6px; align-items: flex-start; }
.config-text { margin: 0; white-space: pre-wrap; }
.product.is-off { opacity: 0.55; }
.product.is-off label { cursor: default; }
.net-head { margin: 16px 0 8px; }
.net-head strong { font-weight: 600; }
.net-head p { margin: 2px 0 0; }
.nets { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: 10px; }
.net { display: flex; flex-direction: column; gap: 6px; }
.net input { width: 100%; }
.actions { display: flex; align-items: center; gap: 12px; }
.actions-end {
  margin-top: 16px;
  padding: 10px 12px;
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 12px;
}
.actions p { margin: 0; color: var(--muted); }
.table-wrap { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); overflow: auto; margin-top: 10px; }
table { width: max-content; min-width: 100%; border-collapse: collapse; font-size: 13px; }
th, td { text-align: left; padding: 10px 12px; border-bottom: 1px solid var(--line); vertical-align: top; white-space: nowrap; }
.saved { list-style: none; margin: 10px 0 0; padding: 0; display: grid; gap: 8px; }
.saved li { background: var(--card); border: 1px solid var(--line); border-radius: var(--radius); padding: 12px 14px; }
.saved-top { display: flex; flex-wrap: wrap; gap: 8px 14px; align-items: baseline; }
.saved a { color: var(--accent); }
.saved-top span, .saved-net, .empty-note { color: var(--muted); }
.saved p { margin: 4px 0 0; }
.saved-net { font-size: 13px; }
.audit h3 { margin: 18px 0 6px; font-size: 16px; }
.audit h4 { margin: 12px 0 0; font-size: 13px; font-weight: 600; }
.code { margin: 8px 0 16px; padding: 12px 14px; overflow: auto; background: #132028; color: #e7eef2; border-radius: 10px; font: 12px/1.5 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; white-space: pre; }
.code .tok-key { color: #8fd0c6; }
.code .tok-str { color: #f0d39a; }
.code .tok-ref { color: #9dccff; }
.code .tok-num { color: #f3b07a; }
.code .tok-lit { color: #d7b4f2; }
.code .tok-pun { color: #8ea4b0; }
th { font-size: 12px; color: var(--muted); font-weight: 600; background: #fafbfc; }
tr:last-child td { border-bottom: 0; }
td.empty { color: var(--muted); }
.gate { min-height: 100vh; display: grid; place-items: center; padding: 24px; }
.gate-card {
  width: min(400px, 100%);
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 16px;
  padding: 28px 24px;
}
.gate-card .brand { display: block; margin-bottom: 8px; }
.gate-card h1 { margin-bottom: 4px; }
.gate-card label { display: flex; flex-direction: column; gap: 6px; margin: 12px 0; }
.gate-card input, .gate-card button { width: 100%; }
.gate-card button { margin-top: 8px; }
@media (max-width: 800px) {
  .app { grid-template-columns: 1fr; }
  .side { border-right: 0; border-bottom: 1px solid var(--line); padding: 14px; }
  .side .brand { margin: 0 0 10px; }
  .side nav { flex-direction: row; overflow: auto; }
  .main { padding: 16px; }
  .products, .nets, .fields { grid-template-columns: 1fr; }
  .cloud-head, .top, .toolbar, .actions { flex-direction: column; align-items: flex-start; }
  .namebar, .namebar input, .actions, .actions button { width: 100%; max-width: none; }
  .tag { flex: none; }
}
`;

const NAV = [
  ["/", "编排"],
  ["/platforms", "云平台"],
  ["/credentials", "鉴权"],
  ["/services", "云资源"],
  ["/regions", "区域"],
];

export function appFrame(options: { username: string; role: string; csrf: string; active: string; main: string }): string {
  const nav = NAV.map(
    ([href, label]) => `<a class="item${href === options.active ? " active" : ""}" href="${href}">${label}</a>`,
  ).join("");
  return renderPage(
    "novtf",
    `<div class="app">
<aside class="side"><a class="brand" href="/">novtf</a><nav>${nav}</nav></aside>
<div class="main"><div class="main-inner">
<header class="top"><div class="session"><span>${escapeHtml(options.username)}</span><span class="role">${escapeHtml(options.role)}</span>
<form method="post" action="/logout"><input type="hidden" name="csrf" value="${escapeHtml(options.csrf)}"><button class="ghost" type="submit">退出</button></form>
</div></header>
${options.main}
</div></div>
</div>`,
  );
}

export function renderPage(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
${body}
</body>
</html>`;
}
