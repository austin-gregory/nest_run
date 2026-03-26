const http = require("http");
const fs = require("fs");
const path = require("path");
const { Server } = require("colyseus");
const { WebSocketTransport } = require("@colyseus/ws-transport");
const { GameRoom } = require("./src/server/GameRoom");
const { ArenaRoom } = require("./src/server/ArenaRoom");
const { createClient } = require("@supabase/supabase-js");

const PORT = process.env.PORT || 8000;
const ROOT = process.cwd();
const DEFAULT_FILE = "index.html";

// ── Supabase (server-side with service role key) ────────────────────────────
const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY || "";

let supabase = null;
if (SUPABASE_URL && SUPABASE_SERVICE_KEY) {
  supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  console.log("[supabase] Connected with service role key");
} else {
  console.log("[supabase] Not configured — stats tracking disabled. Set SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and SUPABASE_ANON_KEY env vars.");
}

// Config snippet injected into HTML pages so client can init Supabase auth
const supabaseConfigScript = SUPABASE_URL && SUPABASE_ANON_KEY
  ? `<script>window.__SUPABASE_URL=${JSON.stringify(SUPABASE_URL)};window.__SUPABASE_ANON_KEY=${JSON.stringify(SUPABASE_ANON_KEY)};</script>`
  : "";

// ── Leaderboard ────────────────────────────────────────────────────────────
const SCORES_FILE = path.join(ROOT, "scores.json");
function loadScores() {
  try { return JSON.parse(fs.readFileSync(SCORES_FILE, "utf8")); } catch { return []; }
}
function saveScores(s) { fs.writeFileSync(SCORES_FILE, JSON.stringify(s), "utf8"); }
let scores = loadScores();
// ──────────────────────────────────────────────────────────────────────────

// ── Supabase auth helper ─────────────────────────────────────────────────
async function getUserFromToken(req) {
  if (!supabase) return null;
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Bearer ")) return null;
  const token = auth.slice(7);
  const { data, error } = await supabase.auth.getUser(token);
  if (error || !data.user) return null;
  return data.user;
}

// Helper to read request body
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", chunk => body += chunk);
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}
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
  ".wav": "audio/wav",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
};

function safeJoin(root, requestedPath) {
  const normalized = path.normalize(requestedPath).replace(/^(\.\.[/\\])+/, "");
  return path.join(root, normalized);
}

function send(res, status, body, type = "text/plain; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}

const httpServer = http.createServer(async (req, res) => {
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

  // GET /api/stats — get current user's stats
  if (req.method === "GET" && urlPath === "/api/stats") {
    try {
      const user = await getUserFromToken(req);
      if (!user) return send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json");

      const { data, error } = await supabase
        .from("player_stats")
        .select("*")
        .eq("user_id", user.id)
        .single();

      if (error && error.code === "PGRST116") {
        // No row yet — return zeroed stats
        return send(res, 200, JSON.stringify({
          display_name: user.user_metadata?.display_name || user.email?.split("@")[0] || "Anonymous",
          shooter_wins: 0, commander_wins: 0,
          total_kills: 0, total_deaths: 0, games_played: 0,
        }), "application/json");
      }
      if (error) return send(res, 500, JSON.stringify({ error: error.message }), "application/json");

      send(res, 200, JSON.stringify(data), "application/json");
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e.message }), "application/json");
    }
    return;
  }

  // POST /api/stats — record a game result
  if (req.method === "POST" && urlPath === "/api/stats") {
    try {
      const user = await getUserFromToken(req);
      if (!user) return send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json");

      const body = await readBody(req);
      const { role, won, kills, deaths } = JSON.parse(body);

      if (!["fps", "rts"].includes(role) || typeof won !== "boolean")
        return send(res, 400, JSON.stringify({ error: "invalid" }), "application/json");

      const displayName = user.user_metadata?.display_name || user.email?.split("@")[0] || "Anonymous";

      // Upsert: create row if it doesn't exist, then increment
      const { data: existing } = await supabase
        .from("player_stats")
        .select("*")
        .eq("user_id", user.id)
        .single();

      if (!existing) {
        // First game — insert
        const { error } = await supabase.from("player_stats").insert({
          user_id: user.id,
          display_name: displayName,
          shooter_wins: role === "fps" && won ? 1 : 0,
          commander_wins: role === "rts" && won ? 1 : 0,
          total_kills: kills || 0,
          total_deaths: deaths || 0,
          games_played: 1,
        });
        if (error) return send(res, 500, JSON.stringify({ error: error.message }), "application/json");
      } else {
        // Update existing stats
        const updates = {
          games_played: existing.games_played + 1,
          total_kills: existing.total_kills + (kills || 0),
          total_deaths: existing.total_deaths + (deaths || 0),
          display_name: displayName,
          updated_at: new Date().toISOString(),
        };
        if (role === "fps" && won) updates.shooter_wins = existing.shooter_wins + 1;
        if (role === "rts" && won) updates.commander_wins = existing.commander_wins + 1;

        const { error } = await supabase
          .from("player_stats")
          .update(updates)
          .eq("user_id", user.id);
        if (error) return send(res, 500, JSON.stringify({ error: error.message }), "application/json");
      }

      send(res, 200, JSON.stringify({ ok: true }), "application/json");
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e.message }), "application/json");
    }
    return;
  }

  // GET /api/customization — get current user's character customization
  if (req.method === "GET" && urlPath === "/api/customization") {
    try {
      const user = await getUserFromToken(req);
      if (!user) return send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json");

      const { data, error } = await supabase
        .from("player_customization")
        .select("*")
        .eq("user_id", user.id)
        .single();

      if (error && error.code === "PGRST116") {
        return send(res, 200, JSON.stringify({
          base_color: "#00cc44", head_color: null, torso_color: null, arms_color: null, legs_color: null,
        }), "application/json");
      }
      if (error) return send(res, 500, JSON.stringify({ error: error.message }), "application/json");
      send(res, 200, JSON.stringify(data), "application/json");
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e.message }), "application/json");
    }
    return;
  }

  // PUT /api/customization — save character customization
  if (req.method === "PUT" && urlPath === "/api/customization") {
    try {
      const user = await getUserFromToken(req);
      if (!user) return send(res, 401, JSON.stringify({ error: "unauthorized" }), "application/json");

      const body = await readBody(req);
      const { base_color, head_color, torso_color, arms_color, legs_color } = JSON.parse(body);

      const hexRe = /^#[0-9a-fA-F]{6}$/;
      if (!base_color || !hexRe.test(base_color))
        return send(res, 400, JSON.stringify({ error: "invalid base_color" }), "application/json");
      for (const c of [head_color, torso_color, arms_color, legs_color]) {
        if (c !== null && !hexRe.test(c))
          return send(res, 400, JSON.stringify({ error: "invalid zone color" }), "application/json");
      }

      const row = {
        user_id: user.id,
        base_color,
        head_color: head_color || null,
        torso_color: torso_color || null,
        arms_color: arms_color || null,
        legs_color: legs_color || null,
        updated_at: new Date().toISOString(),
      };

      const { error } = await supabase
        .from("player_customization")
        .upsert(row, { onConflict: "user_id" });

      if (error) return send(res, 500, JSON.stringify({ error: error.message }), "application/json");
      send(res, 200, JSON.stringify({ ok: true }), "application/json");
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e.message }), "application/json");
    }
    return;
  }

  // GET /api/customization/:userId — get any user's customization (public)
  if (req.method === "GET" && urlPath.startsWith("/api/customization/")) {
    try {
      const userId = urlPath.split("/api/customization/")[1];
      if (!userId) return send(res, 400, JSON.stringify({ error: "missing userId" }), "application/json");

      const { data, error } = await supabase
        .from("player_customization")
        .select("*")
        .eq("user_id", userId)
        .single();

      if (error && error.code === "PGRST116") {
        return send(res, 200, JSON.stringify({ base_color: null }), "application/json");
      }
      if (error) return send(res, 500, JSON.stringify({ error: error.message }), "application/json");
      send(res, 200, JSON.stringify(data), "application/json");
    } catch (e) {
      send(res, 500, JSON.stringify({ error: e.message }), "application/json");
    }
    return;
  }

  // ── Static files (inject Supabase config into HTML) ───────────────────
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

    // Inject Supabase config into HTML files
    if (ext === ".html" && supabaseConfigScript) {
      fs.readFile(filePath, "utf8", (readErr, html) => {
        if (readErr) { send(res, 500, "Error reading file"); return; }
        // Inject right after <head>
        const injected = html.replace("<head>", `<head>\n  ${supabaseConfigScript}`);
        res.writeHead(200, { "Content-Type": contentType });
        res.end(injected);
      });
      return;
    }

    res.writeHead(200, { "Content-Type": contentType });
    fs.createReadStream(filePath).pipe(res);
  });
});

// ── Colyseus ─────────────────────────────────────────────────────────────
const gameServer = new Server({
  transport: new WebSocketTransport({ server: httpServer }),
});

gameServer.define("game", GameRoom).enableRealtimeListing();
gameServer.define("arena", ArenaRoom).enableRealtimeListing();
// ──────────────────────────────────────────────────────────────────────────

httpServer.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}/${DEFAULT_FILE}`);
  console.log(`Colyseus game room registered.`);
});
