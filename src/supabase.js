// Client-side Supabase auth module
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

// These are public (anon) keys — safe to expose in client code
const SUPABASE_URL = window.__SUPABASE_URL || "";
const SUPABASE_ANON_KEY = window.__SUPABASE_ANON_KEY || "";

let supabase = null;

function getClient() {
  if (!supabase && SUPABASE_URL && SUPABASE_ANON_KEY) {
    supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  }
  return supabase;
}

/** Sign up with email + password */
export async function signUp(email, password, displayName) {
  const sb = getClient();
  if (!sb) throw new Error("Supabase not configured");
  const { data, error } = await sb.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) throw error;
  return data;
}

/** Sign in with email + password */
export async function signIn(email, password) {
  const sb = getClient();
  if (!sb) throw new Error("Supabase not configured");
  const { data, error } = await sb.auth.signInWithPassword({ email, password });
  if (error) throw error;
  return data;
}

/** Sign out */
export async function signOut() {
  const sb = getClient();
  if (!sb) return;
  await sb.auth.signOut();
}

/** Get current session (null if not logged in) */
export async function getSession() {
  const sb = getClient();
  if (!sb) return null;
  const { data } = await sb.auth.getSession();
  return data.session;
}

/** Get current user (null if not logged in) */
export async function getUser() {
  const session = await getSession();
  return session?.user || null;
}

/** Get the access token for API calls */
export async function getAccessToken() {
  const session = await getSession();
  return session?.access_token || null;
}

/** Get display name from user metadata */
export function getDisplayName(user) {
  return user?.user_metadata?.display_name || user?.email?.split("@")[0] || "Anonymous";
}

/** Fetch stats for the current user */
export async function getMyStats() {
  const token = await getAccessToken();
  if (!token) return null;
  try {
    const res = await fetch("/api/stats", {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) return null;
    return await res.json();
  } catch { return null; }
}

/** Record game result (called at game end) */
export async function recordGame({ role, won, kills, deaths }) {
  const token = await getAccessToken();
  if (!token) return; // guest, skip
  try {
    await fetch("/api/stats", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ role, won, kills, deaths }),
    });
  } catch (e) {
    console.error("[stats] Failed to record game:", e);
  }
}

/** Check if Supabase is configured */
export function isConfigured() {
  return !!(SUPABASE_URL && SUPABASE_ANON_KEY);
}
