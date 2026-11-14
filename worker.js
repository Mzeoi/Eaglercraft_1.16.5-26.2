const REPO = "Mzeoi/Eaglercraft_1.16.5-26.2";
const BRANCH = "main";

function contentType(path) {
  const ext = path.split(".").pop().toLowerCase();
  const types = {
    html: "text/html; charset=utf-8",
    htm: "text/html; charset=utf-8",
    js: "application/javascript; charset=utf-8",
    mjs: "application/javascript; charset=utf-8",
    css: "text/css; charset=utf-8",
    json: "application/json; charset=utf-8",
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    webp: "image/webp",
    woff: "font/woff",
    woff2: "font/woff2",
    ttf: "font/ttf",
    otf: "font/otf",
    wasm: "application/wasm",
    txt: "text/plain; charset=utf-8",
    md: "text/plain; charset=utf-8",
    mp3: "audio/mpeg",
    ogg: "audio/ogg",
    wav: "audio/wav",
    mp4: "video/mp4",
    webm: "video/webm",
    zip: "application/zip",
    pdf: "application/pdf",
    map: "application/json; charset=utf-8",
    epk: "application/octet-stream",
    dat: "application/octet-stream",
    bin: "application/octet-stream",
  };
  return types[ext] || "application/octet-stream";
}

// Sanitize: drop empty segments and block path traversal (".." / ".")
function sanitizePath(path) {
  return path
    .split("/")
    .filter((seg) => seg && seg !== "." && seg !== "..")
    .join("/");
}

// Percent-encode each path segment so special characters / non-ASCII names work
function encodePath(path) {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg))
    .join("/");
}

async function dirListing(dirPath) {
  const apiResp = await fetch(
    "https://api.github.com/repos/" + REPO + "/contents/" + encodePath(dirPath) + "?ref=" + BRANCH,
    { headers: { "User-Agent": "cloudflare-worker", "Accept": "application/vnd.github.v3+json" } }
  );

  if (apiResp.ok) {
    const data = await apiResp.json();
    if (Array.isArray(data)) {
      const items = data
        .map((item) => {
          const href = "/" + encodePath(item.path);
          const icon = item.type === "dir" ? "[DIR]" : "[FILE]";
          return "  <li>" + icon + ' <a href="' + href + '">' + item.name + "</a></li>";
        })
        .join("\n");

      const parent = dirPath
        ? '  <li>[DIR] <a href="/' + encodePath(dirPath.split("/").slice(0, -1).join("/")) + '">../</a></li>\n'
        : "";

      return new Response(
        "<!DOCTYPE html>\n<html><head><meta charset=\"utf-8\"><title>/" + dirPath + "</title></head>\n" +
          "<body>\n<h1>/" + dirPath + "</h1>\n<ul>\n" + parent + items + "\n</ul>\n</body></html>",
        { headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }
  }

  return null;
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const rawPath = decodeURIComponent(url.pathname.slice(1));
    const path = sanitizePath(rawPath);
    // Decide directory-vs-file from the RAW path so a trailing slash is preserved
    // (otherwise "/dir/" would be sanitized to "/dir" and redirect to itself forever)
    const isDirRequest = rawPath === "" || rawPath.endsWith("/");

    // JSON API: list files of a repo directory through this route
    // e.g. /__api/list  or  /__api/list?dir=resource_packs
    if (path === "__api/list") {
      const dir = sanitizePath(url.searchParams.get("dir") || "");
      const apiResp = await fetch(
        "https://api.github.com/repos/" + REPO + "/contents/" + encodePath(dir) + "?ref=" + BRANCH,
        { headers: { "User-Agent": "cloudflare-worker", "Accept": "application/vnd.github.v3+json" } }
      );
      const jsonHeaders = {
        "Content-Type": "application/json; charset=utf-8",
        "Access-Control-Allow-Origin": "*",
        "Cache-Control": "no-store",
      };
      if (apiResp.ok) {
        const data = await apiResp.json();
        const items = Array.isArray(data)
          ? data.map((d) => ({ name: d.name, path: d.path, type: d.type, size: d.size }))
          : [];
        return new Response(JSON.stringify({ repo: REPO, branch: BRANCH, dir, items }), {
          status: 200,
          headers: jsonHeaders,
        });
      }
      return new Response(JSON.stringify({ error: "github_api", status: apiResp.status }), {
        status: 502,
        headers: jsonHeaders,
      });
    }

    // Root or ends with / = directory listing
    if (isDirRequest) {
      const dirPath = path;
      // Root: serve the site index page from the repo when present
      if (dirPath === "") {
        const idx = await fetch("https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/index.html");
        if (idx.ok) {
          return new Response(idx.body, {
            status: 200,
            headers: {
              "Content-Type": "text/html; charset=utf-8",
              "Access-Control-Allow-Origin": "*",
              "Cache-Control": "no-store",
            },
          });
        }
      }
      const listing = await dirListing(dirPath);
      if (listing) return listing;

      return new Response(
        "<!DOCTYPE html>\n<html><body><h1>GitHub API rate limited</h1><p>Try again later.</p></body></html>",
        { status: 503, headers: { "Content-Type": "text/html; charset=utf-8" } }
      );
    }

    // File request - try raw.githubusercontent.com first
    const rawUrl = "https://raw.githubusercontent.com/" + REPO + "/" + BRANCH + "/" + encodePath(path);
    const rawResp = await fetch(rawUrl);

    if (rawResp.ok) {
      const headers = new Headers();
      headers.set("Content-Type", contentType(path));
      headers.set("Cache-Control", "public, max-age=60, s-maxage=60");
      headers.set("Access-Control-Allow-Origin", "*");
      return new Response(rawResp.body, { status: 200, headers });
    }

    // File not found - maybe it's a directory, try listing
    const listing = await dirListing(path);
    if (listing) {
      // Redirect to path with trailing slash
      return Response.redirect(url.origin + "/" + encodePath(path) + "/", 302);
    }

    return new Response("Not found: " + path, { status: 404 });
  },
};
