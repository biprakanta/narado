/**
 * The admin console's look: the page shell (header, account menu, side navigation), its
 * styles in narado's brand (dark and light), and the small pieces its sections are built
 * from. Server-rendered HTML with a little script for menus, dialogs, copying and toasts;
 * every action is still a plain form post, so it works without the script.
 */
const { esc } = require('./pages');

/** 16px line icons (stroke = currentColor). */
const ICON = (() => {
  const svg = (d, extra = '') => `<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"${extra}>${d}</svg>`;
  return {
    overview: svg('<rect x="3" y="3" width="7" height="9" rx="1.5"/><rect x="14" y="3" width="7" height="5" rx="1.5"/><rect x="14" y="12" width="7" height="9" rx="1.5"/><rect x="3" y="16" width="7" height="5" rx="1.5"/>'),
    signin: svg('<path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z"/><path d="M9 12l2 2 4-4"/>'),
    admins: svg('<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c.6-3.4 3.3-5.5 6.5-5.5s5.9 2.1 6.5 5.5"/><path d="M16 4.6a3.5 3.5 0 0 1 0 6.8M18.5 14.8c1.6.8 2.7 2.5 3 5.2"/>'),
    connectors: svg('<circle cx="6" cy="5.5" r="2.5"/><circle cx="6" cy="18.5" r="2.5"/><circle cx="18" cy="8.5" r="2.5"/><path d="M6 8v8M18 11c0 4-6 3-11.2 5.7"/>'),
    secrets: svg('<rect x="4" y="10.5" width="16" height="10.5" rx="2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/><circle cx="12" cy="15.5" r="1.3"/>'),
    desktop: svg('<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 20h8M12 16v4"/>'),
    computers: svg('<rect x="4" y="5" width="16" height="10" rx="1.5"/><path d="M2 19h20"/>'),
    lock: svg('<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>'),
    copy: svg('<rect x="9" y="9" width="11" height="11" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h8"/>'),
    check: svg('<path d="M5 12.5l4.5 4.5L19 7.5"/>'),
    plus: svg('<path d="M12 5v14M5 12h14"/>'),
    alert: svg('<path d="M12 3.5l9.5 16.5h-19z"/><path d="M12 10v4.5M12 17.5v.01"/>'),
    info: svg('<circle cx="12" cy="12" r="9"/><path d="M12 11v5.5M12 7.5v.01"/>'),
    external: svg('<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>'),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>'),
    chevron: svg('<path d="M6 9l6 6 6-6"/>'),
    arrow: svg('<path d="M5 12h14M13 6l6 6-6 6"/>'),
    signout: svg('<path d="M15 4h3a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-3"/><path d="M10 17l-5-5 5-5M5 12h11"/>'),
    trash: svg('<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>'),
    x: svg('<path d="M6 6l12 12M18 6L6 18"/>')
  };
})();

const STYLE = `
@font-face{font-family:"Space Grotesk";font-style:normal;font-weight:700;font-display:swap;src:url(/auth/assets/space-grotesk-700.woff2) format("woff2")}
@font-face{font-family:Inter;font-style:normal;font-weight:400;font-display:swap;src:url(/auth/assets/inter-400.woff2) format("woff2")}
@font-face{font-family:Inter;font-style:normal;font-weight:600;font-display:swap;src:url(/auth/assets/inter-600.woff2) format("woff2")}
:root{color-scheme:dark;
  --bg:#15101C;--top:#130E19;--card:#1E1727;--card2:#272030;--input:#17121F;--line:#30273B;--line2:#44384F;
  --text:#EFE7DC;--heading:#FDEED2;--muted:#A79CAE;--faint:#7A6F84;
  --accent:#FB9B1A;--accent-ink:#1B1205;--accent-soft:rgba(251,155,26,.12);--link:#F6B85C;
  --ok:#6FD08A;--ok-soft:rgba(111,208,138,.12);--warn:#F5B454;--warn-soft:rgba(245,180,84,.12);--err:#FF8F85;--err-soft:rgba(255,143,133,.12);
  --shadow:0 1px 2px rgba(0,0,0,.25),0 8px 24px rgba(0,0,0,.18);--pop:0 12px 40px rgba(0,0,0,.45);--ring:0 0 0 3px rgba(251,155,26,.35)}
@media (prefers-color-scheme:light){:root{color-scheme:light;
  --bg:#F6F3EE;--top:#FFFFFF;--card:#FFFFFF;--card2:#F4EFE8;--input:#FFFFFF;--line:#E6DED3;--line2:#D3C8BA;
  --text:#2A2233;--heading:#1C1524;--muted:#645A6E;--faint:#8C8296;
  --accent:#EE8C0C;--accent-ink:#1B1205;--accent-soft:rgba(238,140,12,.12);--link:#A85A00;
  --ok:#1D8048;--ok-soft:#E4F3E9;--warn:#9A5B00;--warn-soft:#FCF0DC;--err:#B3261E;--err-soft:#FBE7E5;
  --shadow:0 1px 2px rgba(28,21,36,.06),0 4px 14px rgba(28,21,36,.05);--pop:0 12px 40px rgba(28,21,36,.18);--ring:0 0 0 3px rgba(238,140,12,.3)}}
*{box-sizing:border-box}
html{scroll-padding-top:76px}
body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-font-smoothing:antialiased}
a{color:var(--link);text-underline-offset:2px}
.ic{width:16px;height:16px;flex-shrink:0}
:focus-visible{outline:none;box-shadow:var(--ring);border-radius:8px}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0)}
.mono,code{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
code{font-size:12px;background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:1px 6px;overflow-wrap:anywhere}

/* header */
.top{position:sticky;top:0;z-index:20;height:56px;display:flex;align-items:center;gap:12px;padding:0 20px;background:var(--top);border-bottom:1px solid var(--line)}
.brand{display:flex;align-items:center;gap:8px;color:var(--heading);text-decoration:none;font:700 17px "Space Grotesk",Inter,sans-serif}
.brand img{width:22px;height:22px}
.top .sep{width:1px;height:20px;background:var(--line2)}
.top .crumb{color:var(--muted);font-weight:600;font-size:13.5px}
.chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;border:1px solid var(--line2);border-radius:999px;padding:2px 9px;color:var(--muted);white-space:nowrap}
.chip.accent{border-color:transparent;background:var(--accent-soft);color:var(--accent)}
.top .grow{flex:1}
.top .host{color:var(--faint);font-size:12.5px}
.menu{position:relative}
.menu>summary{list-style:none;display:flex;align-items:center;gap:8px;cursor:pointer;padding:4px 8px 4px 4px;border-radius:999px;border:1px solid transparent;color:var(--text);font-weight:600;font-size:13px}
.menu>summary::-webkit-details-marker{display:none}
.menu>summary:hover,.menu[open]>summary{background:var(--card2);border-color:var(--line)}
.menu .pop{position:absolute;right:0;top:calc(100% + 6px);min-width:240px;background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--pop);padding:6px;z-index:30}
.menu .who{padding:10px 10px 8px;border-bottom:1px solid var(--line);margin-bottom:4px}
.menu .who strong{display:block}.menu .who span{color:var(--muted);font-size:12.5px}
.menu .item{display:flex;align-items:center;gap:10px;width:100%;padding:8px 10px;border-radius:8px;color:var(--text);text-decoration:none;background:none;border:0;font:inherit;cursor:pointer;text-align:left}
.menu .item:hover{background:var(--card2)}
.av{width:28px;height:28px;border-radius:50%;display:inline-flex;align-items:center;justify-content:center;background:var(--accent-soft);color:var(--accent);font-weight:600;font-size:12px;flex-shrink:0;text-transform:uppercase}

/* layout */
.layout{display:grid;grid-template-columns:232px minmax(0,1fr);gap:40px;max-width:1180px;margin:0 auto;padding:28px 24px 96px}
nav.side{position:sticky;top:84px;align-self:start;display:flex;flex-direction:column;gap:2px}
nav.side .label{font-size:11px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);padding:0 10px 8px}
nav.side a{display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:8px;color:var(--muted);text-decoration:none;font-weight:600;font-size:13.5px;position:relative}
nav.side a:hover{background:var(--card2);color:var(--text)}
nav.side a[aria-current=true]{background:var(--card);color:var(--heading);box-shadow:inset 0 0 0 1px var(--line)}
nav.side a[aria-current=true]::before{content:"";position:absolute;left:-1px;top:8px;bottom:8px;width:3px;border-radius:3px;background:var(--accent)}
nav.side .meta{margin-left:auto;font-size:11.5px;font-weight:600;color:var(--faint)}
nav.side .dot{margin-left:auto;width:7px;height:7px;border-radius:50%;background:var(--warn)}
main{min-width:0;max-width:880px}
.page-head{margin-bottom:24px}
.page-head h1{margin:0;font:700 26px/1.2 "Space Grotesk",Inter,sans-serif;color:var(--heading);letter-spacing:-.2px}
.page-head p{margin:6px 0 0;color:var(--muted)}
@media (max-width:860px){
  .layout{grid-template-columns:1fr;gap:16px;padding:16px 16px 80px}
  nav.side{position:sticky;top:56px;z-index:10;flex-direction:row;overflow-x:auto;background:var(--bg);margin:0 -16px;padding:8px 16px;border-bottom:1px solid var(--line);scrollbar-width:none}
  nav.side .label,nav.side .meta,nav.side .dot{display:none}
  nav.side a{white-space:nowrap}
  nav.side a[aria-current=true]::before{display:none}
  .top .host,.top .crumb,.top .sep{display:none}
  html{scroll-padding-top:116px}
}

/* sections */
section{margin-bottom:44px}
.sec-head{display:flex;align-items:flex-end;gap:16px;margin-bottom:14px}
.sec-head .t{flex:1;min-width:0}
.sec-head h2{margin:0;font:700 18px/1.3 "Space Grotesk",Inter,sans-serif;color:var(--heading)}
.sec-head p{margin:4px 0 0;color:var(--muted)}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;box-shadow:var(--shadow)}
.card .body{padding:18px 20px}
.card .foot{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:12px 20px;border-top:1px solid var(--line);background:var(--card2);border-radius:0 0 12px 12px}
.card .foot .hint{color:var(--muted);font-size:12.5px;margin-right:auto}
.card-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line)}
.card-head .t{flex:1;min-width:0}
.card-head strong{display:block;font-size:14.5px}
.card-head span.sub{color:var(--muted);font-size:12.5px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;display:block}

/* forms */
label.f{display:block;margin:0 0 14px}
label.f>span{display:block;font-size:12.5px;font-weight:600;color:var(--text);margin-bottom:6px}
label.f .help{display:block;font-weight:400;color:var(--muted);font-size:12px;margin-top:5px}
input[type=text],input[type=password],input[type=url],input[type=email],textarea,select{width:100%;height:36px;padding:0 11px;border-radius:8px;border:1px solid var(--line2);background:var(--input);color:var(--text);font:inherit;transition:border-color .12s,box-shadow .12s}
textarea{height:auto;padding:8px 11px;resize:vertical}
input::placeholder,textarea::placeholder{color:var(--faint)}
input:hover,textarea:hover,select:hover{border-color:var(--faint)}
input:focus,textarea:focus,select:focus{outline:none;border-color:var(--accent);box-shadow:var(--ring)}
input:disabled,textarea:disabled,select:disabled{opacity:.55;cursor:not-allowed}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:0 14px}
textarea.mono{font-size:12px}
fieldset{border:0;padding:0;margin:0;min-width:0}
.ro{display:grid;grid-template-columns:200px minmax(0,1fr);gap:12px;padding:11px 0;border-top:1px solid var(--line);align-items:center}
.ro:first-child{border-top:0;padding-top:0}
.ro .k{color:var(--muted);font-size:13px}
.ro .v{display:flex;align-items:center;gap:10px;min-width:0}
.ro .v .val{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
.ro .faint,.faint{color:var(--faint)}
.env{display:inline-flex;align-items:center;gap:5px;margin-left:auto;font-size:11.5px;font-weight:600;color:var(--muted);background:var(--card2);border:1px solid var(--line);border-radius:6px;padding:2px 7px;white-space:nowrap}
.env .ic{width:12px;height:12px}
@media (max-width:600px){.ro{grid-template-columns:1fr;gap:4px}}
.copy{display:flex;align-items:center;gap:6px;border:1px solid var(--line);background:var(--input);border-radius:8px;padding:4px 4px 4px 11px;min-width:0;max-width:100%}
.copy .val{flex:1;min-width:0;overflow-x:auto;white-space:nowrap;font-size:12.5px;scrollbar-width:thin}
.choices{display:grid;gap:8px}
.choice{display:flex;gap:12px;align-items:flex-start;border:1px solid var(--line2);border-radius:10px;padding:12px 14px;cursor:pointer;background:var(--input)}
.choice:hover{border-color:var(--faint)}
.choice:has(input:checked){border-color:var(--accent);background:var(--accent-soft)}
.choice input{margin-top:3px;accent-color:var(--accent)}
.choice strong{display:block;font-size:13.5px}
.choice span{color:var(--muted);font-size:12.5px}
.types{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;margin-bottom:16px}
.types .choice{align-items:center}

/* buttons */
.btn,button.btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:34px;padding:0 14px;border-radius:8px;border:1px solid transparent;cursor:pointer;font:600 13.5px Inter,ui-sans-serif,system-ui,sans-serif;text-decoration:none;white-space:nowrap;transition:background .12s,border-color .12s,filter .12s;color:var(--accent-ink);background:var(--accent)}
.btn:hover{filter:brightness(1.06)}
.btn.secondary{background:var(--card);color:var(--text);border-color:var(--line2)}
.btn.secondary:hover{background:var(--card2);filter:none}
.btn.ghost{background:transparent;color:var(--muted)}
.btn.ghost:hover{background:var(--card2);color:var(--text);filter:none}
.btn.danger{background:transparent;color:var(--err);border-color:var(--line2)}
.btn.danger:hover{background:var(--err-soft);border-color:var(--err);filter:none}
.btn.danger-solid{background:var(--err);color:#fff}
.btn.sm{height:28px;padding:0 10px;font-size:12.5px}
.btn.icon{width:28px;padding:0}
.btn[disabled]{opacity:.5;cursor:not-allowed;filter:none}
.btn.busy{pointer-events:none;opacity:.8}
.btn.busy::after{content:"";width:12px;height:12px;border-radius:50%;border:2px solid currentColor;border-right-color:transparent;animation:spin .7s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

/* status */
.pill{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;border-radius:999px;padding:2px 9px;background:var(--card2);color:var(--muted);white-space:nowrap}
.pill::before{content:"";width:6px;height:6px;border-radius:50%;background:currentColor}
.pill.ok{color:var(--ok);background:var(--ok-soft)}
.pill.warn{color:var(--warn);background:var(--warn-soft)}
.pill.err{color:var(--err);background:var(--err-soft)}
.alert{display:flex;gap:10px;align-items:flex-start;border:1px solid var(--line);border-radius:10px;padding:12px 14px;margin:0 0 20px;background:var(--card)}
.alert .ic{margin-top:2px}
.alert.err{border-color:color-mix(in srgb,var(--err) 40%,transparent);background:var(--err-soft);color:var(--text)}
.alert.err .ic{color:var(--err)}
.alert.ok{border-color:color-mix(in srgb,var(--ok) 40%,transparent);background:var(--ok-soft)}
.alert.ok .ic{color:var(--ok)}
.alert.info .ic{color:var(--accent)}
.tiles{display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:12px}
.tile{display:block;padding:14px 16px;text-decoration:none;color:inherit;transition:border-color .12s}
.tile:hover{border-color:var(--line2)}
.tile .k{display:flex;align-items:center;gap:7px;color:var(--muted);font-size:12.5px;font-weight:600}
.tile .v{font:700 20px/1.2 "Space Grotesk",Inter,sans-serif;color:var(--heading);margin:8px 0 6px}
.tile .s{color:var(--muted);font-size:12.5px}
.tile{min-height:112px}
.attention{margin-top:12px}
#overview{margin-bottom:36px}
.attention .row-a{display:flex;align-items:center;gap:10px;padding:10px 16px;border-top:1px solid var(--line)}
.attention .row-a:first-child{border-top:0}
.attention .row-a .ic{color:var(--warn)}
.attention .row-a .grow{flex:1}

/* setup steps */
.steps{list-style:none;margin:0;padding:0}
.steps li{display:flex;gap:14px;padding:14px 20px;border-top:1px solid var(--line);align-items:flex-start}
.steps li:first-child{border-top:0}
.steps .n{width:26px;height:26px;border-radius:50%;border:1.5px solid var(--line2);display:flex;align-items:center;justify-content:center;font-weight:600;font-size:12.5px;color:var(--muted);flex-shrink:0}
.steps li.done .n{background:var(--ok);border-color:var(--ok);color:#fff}
.steps li.now .n{border-color:var(--accent);color:var(--accent)}
.steps .t{flex:1}.steps .t strong{display:block}.steps .t span{color:var(--muted);font-size:13px}

/* connector cards */
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:14px}
.conn{display:flex;flex-direction:column}
.conn .card-head{border-bottom:0;padding-bottom:6px}
.conn-desc{margin:0;padding:0 20px 16px;color:var(--muted);font-size:13px;flex:1}
.conn .foot{padding:12px 20px}
.logo{width:40px;height:40px;border-radius:10px;display:flex;align-items:center;justify-content:center;flex-shrink:0;border:1px solid var(--line)}
.logo svg{width:22px;height:22px}
.logo.github{background:#F3F1F5;color:#1F2328}
.logo.gitlab{background:#2B2133}
.logo.vault{background:#000}
.logo.aws{background:#232F3E}.logo.aws svg{width:28px}
.logo.gcp{background:#F3F1F5}
.logo.azure{background:#0078D4}
.logo.sm{width:30px;height:30px;border-radius:8px}.logo.sm svg{width:17px;height:17px}.logo.sm.aws svg{width:22px}

/* lists and tables */
.list .li{display:flex;align-items:center;gap:12px;padding:12px 20px;border-top:1px solid var(--line)}
.list .li:first-child{border-top:0}
.list .li .grow{flex:1;min-width:0}
.list .li .sub{color:var(--muted);font-size:12.5px}
.tbl-wrap{overflow-x:auto}
table.tbl{width:100%;border-collapse:collapse;font-size:13px}
.tbl th{text-align:left;font-size:11.5px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--faint);padding:10px 20px;border-bottom:1px solid var(--line);white-space:nowrap}
.tbl td{padding:12px 20px;border-top:1px solid var(--line);vertical-align:middle}
.tbl tr:first-child td{border-top:0}
.tbl td.r,.tbl th.r{text-align:right}
.tbl .sub{color:var(--muted);font-size:12.5px}
.empty{text-align:center;padding:36px 24px}
.empty .ei{width:44px;height:44px;margin:0 auto 12px;border-radius:12px;background:var(--card2);border:1px solid var(--line);display:flex;align-items:center;justify-content:center;color:var(--muted)}
.empty .ei .ic{width:20px;height:20px}
.empty strong{display:block;font-size:14.5px;color:var(--heading)}
.empty p{margin:4px auto 16px;max-width:440px;color:var(--muted);font-size:13px}
.empty.compact{padding:20px}

/* dialogs */
dialog{background:var(--card);color:var(--text);border:1px solid var(--line);border-radius:14px;padding:0;width:min(580px,calc(100% - 32px));max-height:calc(100vh - 64px);box-shadow:var(--pop)}
dialog::backdrop{background:rgba(10,6,14,.55);backdrop-filter:blur(2px)}
.dlg-head{display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--line);position:sticky;top:0;background:var(--card);z-index:1}
.dlg-head h3{margin:0;font:700 16px "Space Grotesk",Inter,sans-serif;color:var(--heading);flex:1}
.dlg-body{padding:18px 20px 20px}
.dlg-body h4{margin:22px 0 4px;font-size:13.5px;color:var(--heading)}
.dlg-body h4:first-child{margin-top:0}
.dlg-body .note{color:var(--muted);font-size:12.5px;margin:4px 0 12px}
.dlg-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:6px}
.dlg-actions .left{margin-right:auto}
.note{color:var(--muted);font-size:12.5px}
dialog.confirm{width:min(440px,calc(100% - 32px))}
dialog.confirm .dlg-body p{margin:0 0 18px;color:var(--muted)}

/* toast */
.toast{position:fixed;right:20px;top:72px;z-index:40;display:flex;gap:10px;align-items:center;background:var(--card);border:1px solid var(--line);border-left:3px solid var(--ok);border-radius:10px;padding:11px 14px;box-shadow:var(--pop);animation:in .2s ease-out}
.toast .ic{color:var(--ok)}
.toast.hide{opacity:0;transform:translateY(-6px);transition:all .25s}
@keyframes in{from{opacity:0;transform:translateY(-6px)}}

/* centred pages (messages, restart) */
.center{min-height:calc(100vh - 56px);display:flex;align-items:center;justify-content:center;padding:24px}
.center .card{max-width:480px;width:100%;text-align:center;padding:32px 28px}
.center h1{margin:0 0 6px;font:700 20px "Space Grotesk",Inter,sans-serif;color:var(--heading)}
.center p{margin:0 0 18px;color:var(--muted)}
.loader{width:28px;height:28px;margin:0 auto 16px;border-radius:50%;border:3px solid var(--line2);border-top-color:var(--accent);animation:spin .8s linear infinite}
@media (prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
`;

const SCRIPT = `
(function(){
  function $(s,r){return (r||document).querySelector(s)}
  function $$(s,r){return Array.prototype.slice.call((r||document).querySelectorAll(s))}
  window.openDlg=function(id){var d=document.getElementById(id);if(d&&d.showModal)d.showModal();};
  $$('dialog').forEach(function(d){d.addEventListener('click',function(e){if(e.target===d)d.close();});});
  // Busy buttons: one submit per click, with a spinner.
  $$('form').forEach(function(f){f.addEventListener('submit',function(e){if(e.defaultPrevented)return;var b=e.submitter||$('button[type=submit]',f);if(b&&b.classList.contains('btn')){setTimeout(function(){b.classList.add('busy');b.setAttribute('aria-busy','true');},0);}});});
  // Confirmations in narado's own dialog instead of the browser's.
  var cd=$('#dlg-confirm');
  $$('[data-confirm]').forEach(function(b){b.addEventListener('click',function(e){
    if(b.dataset.ok){delete b.dataset.ok;return;}
    if(!cd||!cd.showModal)return;
    e.preventDefault();
    $('#dlg-confirm-t').textContent=b.getAttribute('data-confirm-title')||'Are you sure?';
    $('#dlg-confirm-text').textContent=b.getAttribute('data-confirm');
    var ok=$('#dlg-confirm-ok');ok.textContent=b.getAttribute('data-confirm-ok')||'Confirm';
    ok.onclick=function(){cd.close();b.dataset.ok='1';var f=b.form||b.closest('form');if(f&&f.requestSubmit)f.requestSubmit(b);else b.click();};
    cd.showModal();
  });});
  // Copy buttons.
  $$('[data-copy]').forEach(function(b){b.addEventListener('click',function(){var t=b.getAttribute('data-copy');var done=function(){var l=b.querySelector('.lbl');if(l){var was=l.textContent;l.textContent='Copied';setTimeout(function(){l.textContent=was;},1500);}};if(navigator.clipboard)navigator.clipboard.writeText(t).then(done,done);else done();});});
  // Store type picker in "Add a secrets store".
  var addStore=document.getElementById('add-store');
  if(addStore){var pick=function(){var t=(addStore.querySelector('input[name=type]:checked')||{}).value;$$('fieldset[data-type]',addStore).forEach(function(f){var on=f.getAttribute('data-type')===t;f.hidden=!on;f.disabled=!on;});};addStore.addEventListener('change',pick);pick();}
  // Account menu: close on outside click or Escape.
  $$('details.menu').forEach(function(m){document.addEventListener('click',function(e){if(m.open&&!m.contains(e.target))m.open=false;});document.addEventListener('keydown',function(e){if(e.key==='Escape')m.open=false;});});
  // Sign out (narado's sign-out answers with where to go next).
  $$('[data-signout]').forEach(function(b){b.addEventListener('click',function(){fetch('/auth/logout',{method:'POST',credentials:'same-origin'}).then(function(r){return r.json();}).then(function(j){location.href=(j&&j.redirect)||'/auth/login';},function(){location.href='/auth/login';});});});
  // The section in view is marked in the side navigation.
  var links=$$('nav.side a[href^="#"]');
  if(links.length){
    var byId={};links.forEach(function(a){byId[a.getAttribute('href').slice(1)]=a;});
    var secs=$$('main section[id]').filter(function(x){return byId[x.id];});
    var mark=function(){var cur=secs[0];var atEnd=window.innerHeight+window.scrollY>=document.documentElement.scrollHeight-4;
      if(atEnd)cur=secs[secs.length-1];else secs.forEach(function(x){if(x.getBoundingClientRect().top<=140)cur=x;});
      links.forEach(function(a){a.setAttribute('aria-current',String(!!cur&&a===byId[cur.id]));});};
    var queued=false;window.addEventListener('scroll',function(){if(!queued){queued=true;requestAnimationFrame(function(){queued=false;mark();});}},{passive:true});
    mark();
  }
  // Toasts fade by themselves.
  $$('.toast').forEach(function(t){setTimeout(function(){t.classList.add('hide');setTimeout(function(){t.remove();},300);},4500);});
})();
`;

const initials = (name) =>
  String(name || '?')
    .replace(/@.*/, '')
    .split(/[\s._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join('') || '?';

/**
 * A page in the admin console.
 * @param nav   [{ id, label, icon, meta, attention }] for the side navigation, or null
 * @param who   { name, email, setup, local } of the person using it, or null
 * @param host  narado's address, shown in the header
 */
const page = ({ title, who = null, host = '', nav = null, body, script = '', toast = '' }) => `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · narado</title><link rel="icon" type="image/svg+xml" href="/auth/assets/narado-favicon.svg?v=2"><link rel="alternate icon" href="/auth/assets/favicon.ico?v=2">
<style>${STYLE}</style></head><body>
<header class="top">
<a class="brand" href="/" title="Open narado"><img src="/auth/assets/narado-favicon.svg?v=2" alt="">narado</a><span class="sep"></span><span class="crumb">Admin console</span>${who && who.setup ? '<span class="chip accent">Setup</span>' : ''}
<span class="grow"></span>${host ? `<span class="host" title="narado's address">${esc(host)}</span>` : ''}
${who && !who.setup && !who.local ? `<details class="menu"><summary aria-label="Account"><span class="av">${esc(initials(who.name || who.email))}</span><span>${esc(who.name || who.email)}</span>${ICON.chevron}</summary>
<div class="pop" role="menu"><div class="who"><strong>${esc(who.name || '')}</strong><span>${esc(who.email || '')}</span></div>
<a class="item" role="menuitem" href="/">${ICON.arrow}Open narado</a><button type="button" class="item" role="menuitem" data-signout>${ICON.signout}Sign out</button></div></details>` : who && who.setup ? '<span class="chip">Setup session</span>' : ''}
</header>
${nav ? `<div class="layout"><nav class="side" aria-label="Admin sections"><div class="label">Settings</div>${nav
      .map((n) => `<a href="#${n.id}" aria-current="false">${ICON[n.icon] || ''}<span>${esc(n.label)}</span>${n.attention ? `<span class="dot" title="${esc(n.attention)}"></span>` : n.meta != null ? `<span class="meta">${esc(n.meta)}</span>` : ''}</a>`)
      .join('')}</nav><main>${body}</main></div>` : body}
${toast ? `<div class="toast" role="status">${ICON.check}<span>${esc(toast)}</span></div>` : ''}
<dialog id="dlg-confirm" class="confirm" aria-labelledby="dlg-confirm-t"><div class="dlg-head"><h3 id="dlg-confirm-t">Are you sure?</h3></div><div class="dlg-body"><p id="dlg-confirm-text"></p><div class="dlg-actions"><button type="button" class="btn secondary" onclick="this.closest('dialog').close()">Cancel</button><button type="button" class="btn danger-solid" id="dlg-confirm-ok">Confirm</button></div></div></dialog>
<script>${SCRIPT}${script}</script></body></html>`;

/** A centred message (errors, refusals, redirects). */
const messagePage = ({ title, heading, text, action = '', who = null, loader = false, script = '' }) =>
  page({ title, who, body: `<div class="center"><div class="card">${loader ? '<div class="loader" aria-hidden="true"></div>' : ''}<h1>${esc(heading)}</h1><p>${text}</p>${action}</div></div>`, script });

/** A setting: an input, or (set in the server environment) its value, read-only. Secrets are never echoed. */
const field = ({ name, label, value, source, secret = false, placeholder = '', help = '', type = 'text' }) => {
  if (source === 'env') {
    const shown = secret ? (value ? '<span class="val mono">••••••••</span>' : '<span class="val faint">Not set</span>') : value ? `<span class="val mono" title="${esc(value)}">${esc(value)}</span>` : '<span class="val faint">Not set</span>';
    return `<div class="ro"><div class="k">${esc(label)}</div><div class="v">${shown}${envBadge(name)}</div></div>`;
  }
  const ph = secret && value ? '•••••••• (kept; type to replace)' : placeholder;
  return `<label class="f"><span>${esc(label)}</span><input type="${secret ? 'password' : type}" name="${esc(name)}" value="${esc(secret ? '' : value || '')}" placeholder="${esc(ph)}" autocomplete="off">${help ? `<span class="help">${help}</span>` : ''}</label>`;
};

const envBadge = (name) => `<span class="env" title="${esc(name)} is set in the server environment; change it there and restart narado">${ICON.lock}Environment</span>`;

/** A value to copy (callback URLs and the like), never broken mid-word. */
const copyField = (value, label = 'Copy') => `<div class="copy"><span class="val mono">${esc(value)}</span><button type="button" class="btn ghost sm" data-copy="${esc(value)}">${ICON.copy}<span class="lbl">${esc(label)}</span></button></div>`;

const sectionHead = (title, lead, actions = '') => `<div class="sec-head"><div class="t"><h2>${esc(title)}</h2>${lead ? `<p>${lead}</p>` : ''}</div>${actions}</div>`;

const emptyState = ({ icon, title, text, action = '', compact = false }) => `<div class="empty${compact ? ' compact' : ''}"><div class="ei">${ICON[icon] || ''}</div><strong>${esc(title)}</strong><p>${text}</p>${action}</div>`;

const dialog = (id, title, logo, inner) => `<dialog id="${id}" aria-labelledby="${id}-t"><div class="dlg-head">${logo || ''}<h3 id="${id}-t">${esc(title)}</h3><form method="dialog"><button class="btn ghost icon sm" aria-label="Close">${ICON.x}</button></form></div><div class="dlg-body">${inner}</div></dialog>`;

/** A button that asks first, in narado's own dialog (and still asks without script). */
const confirmAttrs = (text, { title = 'Are you sure?', ok = 'Confirm' } = {}) => ` data-confirm="${esc(text)}" data-confirm-title="${esc(title)}" data-confirm-ok="${esc(ok)}"`;

module.exports = { ICON, page, messagePage, field, envBadge, copyField, sectionHead, emptyState, dialog, confirmAttrs, initials };
