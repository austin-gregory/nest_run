const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 8000;
const ROOT = process.cwd();
const DEFAULT_FILE = "shooter_v2.html";

// ── Leaderboard ────────────────────────────────────────────────────────────
const SCORES_FILE = path.join(ROOT, "scores.json");
function loadScores() {
  try { return JSON.parse(fs.readFileSync(SCORES_FILE, "utf8")); } catch { return []; }
}
function saveScores(s) { fs.writeFileSync(SCORES_FILE, JSON.stringify(s), "utf8"); }
let scores = loadScores();
// ──────────────────────────────────────────────────────────────────────────

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".glb": "model/gltf-binary",
  ".gltf": "model/gltf+json",
};

function safeJoin(root, requestedPath) {
  const normalized = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  return path.join(root, normalized);
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || "/").split("?")[0]);

  // GET /api/leaderboard
  if (req.method === "GET" && urlPath === "/api/leaderboard") {
    send(res, 200, JSON.stringify(scores.slice(0, 3)), "application/json; charset=utf-8");
    return;
  }

  // POST /api/leaderboard
  if (req.method === "POST" && urlPath === "/api/leaderboard") {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => {
      try {
        const { name, kills, time } = JSON.parse(body);
        if (!name || typeof kills !== "number" || typeof time !== "number")
          return send(res, 400, JSON.stringify({ error: "invalid" }), "application/json");
        scores.push({ name: String(name).slice(0, 20), kills, time });
        scores.sort((a, b) => b.kills !== a.kills ? b.kills - a.kills : a.time - b.time);
        scores = scores.slice(0, 20);
        saveScores(scores);
        send(res, 200, JSON.stringify(scores.slice(0, 3)), "application/json; charset=utf-8");
      } catch {
        send(res, 400, JSON.stringify({ error: "bad json" }), "application/json");
      }
    });
    return;
  }

  const relPath = urlPath === "/" ? `/${DEFAULT_FILE}` : urlPath;
  const filePath = safeJoin(ROOT, relPath);

  if (!filePath.startsWith(ROOT)) {
    send(res, 403, "Forbidden");
    return;
  }

  fs.stat(filePath, (statErr, stat) => {
    if (statErr || !stat.isFile()) {
      send(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = MIME[ext] || "application/octet-stream";
    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

server.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/${DEFAULT_FILE}`);
});
