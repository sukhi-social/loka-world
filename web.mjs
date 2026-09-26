// ページと request の小さな道具。玄関(koe/genkan.jl)と同じ、淡い紙の色。

export function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const STYLE = `
  :root { color-scheme: light; }
  body { font: 16px/1.7 system-ui, sans-serif; max-width: 40rem; margin: 3rem auto;
         padding: 0 1rem 4rem; color: #4a3f37; background: #fbf6ee; }
  h1 { font-weight: normal; font-size: 1.2rem; letter-spacing: .02em; }
  h2 { font-weight: normal; font-size: 1rem; color: #8a7c6d; margin-top: 2rem; }
  a { color: #9a5b3f; }
  ul { padding-left: 1.2rem; }
  li { margin: .2rem 0; }
  pre { background: #fff; border: 1px solid #eee3d5; border-radius: 8px; padding: .8rem;
        overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
  code { background: #fff; border: 1px solid #eee3d5; border-radius: 4px; padding: .1rem .3rem; }
  form { margin: .6rem 0; }
  input[type=password], input[type=text] { font: inherit; padding: .4rem .5rem;
        border: 1px solid #e0d4c4; border-radius: 6px; background: #fff; width: 100%; box-sizing: border-box; }
  button { font: inherit; padding: .4rem .9rem; border: 1px solid #e0d4c4; border-radius: 6px;
        background: #fff; color: #4a3f37; cursor: pointer; }
  .muted { color: #a99a89; font-size: .88rem; }
  .card { background: #fff; border: 1px solid #eee3d5; border-radius: 10px; padding: 1rem 1.2rem; margin: 1rem 0; }
`;

export function page(status, title, body, extraHeaders = []) {
  const html = `<!doctype html><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · world</title><style>${STYLE}</style>
<body><h1>${escapeHtml(title)}</h1>${body}`;
  return {
    status,
    headers: [["content-type", "text/html; charset=utf-8"], ...extraHeaders],
    body,
    raw: html,
  };
}

export function sendHtml(res, pageObj, extraHeaders = []) {
  res.writeHead(pageObj.status, { ...Object.fromEntries([...pageObj.headers, ...extraHeaders]) });
  res.end(pageObj.raw);
}

export function sendJson(res, status, payload, extraHeaders = {}) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
    ...extraHeaders,
  });
  res.end(body);
}

export function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function readBody(req, limit = 256 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("body が大きすぎます"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("error", reject);
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

export function isHttps(req) {
  const proto = (req.headers["x-forwarded-proto"] ?? "").split(",")[0].trim();
  return proto === "https";
}

export function originOf(req) {
  if (process.env.WORLD_PUBLIC_ORIGIN) return process.env.WORLD_PUBLIC_ORIGIN.replace(/\/+$/, "");
  const host = req.headers["x-forwarded-host"] ?? req.headers.host ?? "localhost";
  const proto = isHttps(req) ? "https" : "http";
  return `${proto}://${host}`;
}
