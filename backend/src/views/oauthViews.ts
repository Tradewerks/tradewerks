const escapeHtml = (v: unknown): string =>
    String(v ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");

const page = (title: string, body: string): string => `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { font-family: system-ui, sans-serif; background:#0f172a; color:#e2e8f0;
           display:flex; min-height:100vh; align-items:center; justify-content:center; margin:0; }
    .card { background:#1e293b; padding:2rem; border-radius:12px; width:340px;
            box-shadow:0 10px 30px rgba(0,0,0,.4); }
    h1 { font-size:1.15rem; margin:0 0 1rem; }
    p { color:#94a3b8; font-size:.9rem; line-height:1.4; }
    label { display:block; font-size:.8rem; margin:.75rem 0 .25rem; color:#cbd5e1; }
    input { width:100%; box-sizing:border-box; padding:.55rem; border-radius:8px;
            border:1px solid #334155; background:#0f172a; color:#e2e8f0; }
    .row { display:flex; gap:.5rem; margin-top:1.25rem; }
    button { flex:1; padding:.6rem; border:0; border-radius:8px; font-weight:600; cursor:pointer; }
    .allow { background:#2563eb; color:#fff; }
    .deny  { background:#334155; color:#e2e8f0; }
    .err   { background:#7f1d1d; color:#fecaca; padding:.5rem .75rem;
             border-radius:8px; font-size:.85rem; margin-bottom:1rem; }
    strong { color:#fff; }
  </style>
</head>
<body><div class="card">${body}</div></body>
</html>`;

export const renderError = (message: string): string =>
    page("Authorization Error", `
      <h1>Authorization Error</h1>
      <p>${escapeHtml(message)}</p>
    `);

export const renderConsentPage = (params: {
    client: { name: string };
    client_id: string;
    redirect_uri: string;
    state?: string;
    code_challenge?: string;
    code_challenge_method?: string;
    error?: string;
}): string => {
    const hidden = (name: string, value?: string) =>
        value ? `<input type="hidden" name="${name}" value="${escapeHtml(value)}" />` : "";

    return page("Authorize Access", `
      <h1>Authorize <strong>${escapeHtml(params.client.name)}</strong></h1>
      <p><strong>${escapeHtml(params.client.name)}</strong> wants to access your EpicIT-Dispatch
         account. Sign in to allow it.</p>
      ${params.error ? `<div class="err">${escapeHtml(params.error)}</div>` : ""}
      <form method="POST" action="/oauth/authorize/decision">
        ${hidden("client_id", params.client_id)}
        ${hidden("redirect_uri", params.redirect_uri)}
        ${hidden("state", params.state)}
        ${hidden("code_challenge", params.code_challenge)}
        ${hidden("code_challenge_method", params.code_challenge_method)}
        <label>Email</label>
        <input type="email" name="email" required autocomplete="username" />
        <label>Password</label>
        <input type="password" name="password" required autocomplete="current-password" />
        <!-- Allow comes first in the DOM because pressing Enter submits with the first
             submit button; row-reverse keeps Deny visually on the left. -->
        <div class="row" style="flex-direction:row-reverse">
          <button class="allow" type="submit" name="action" value="allow">Allow</button>
          <button class="deny"  type="submit" name="action" value="deny">Deny</button>
        </div>
      </form>
    `);
};
