/**
 * Thin wrapper around Colyseus.js client.
 * Uses the Colyseus JS SDK from CDN (matching existing Three.js CDN pattern).
 */

let _client = null;

async function getClient() {
  if (_client) return _client;
  const mod = await import("https://cdn.jsdelivr.net/npm/colyseus.js@0.15.25/dist/colyseus.js/+esm");
  const protocol = location.protocol === "https:" ? "wss:" : "ws:";
  _client = new mod.Client(`${protocol}//${location.host}`);
  return _client;
}

/**
 * Connect to a GameRoom with the given role preference (legacy joinOrCreate).
 * @param {"fps"|"rts"} role - Desired role
 * @returns {Promise<import("colyseus.js").Room>} Colyseus room instance
 */
export async function connectToGame(role) {
  const client = await getClient();
  const room = await client.joinOrCreate("game", { role });
  return room;
}

/**
 * Create a new room with a given role and optional room name.
 * @param {"fps"|"rts"} role
 * @param {string} [roomName]
 * @returns {Promise<import("colyseus.js").Room>}
 */
export async function createRoom(role, roomName) {
  const client = await getClient();
  const room = await client.create("game", { role, roomName });
  return room;
}

/**
 * Join an existing room by its ID.
 * @param {string} roomId
 * @param {"fps"|"rts"} role
 * @returns {Promise<import("colyseus.js").Room>}
 */
export async function joinRoom(roomId, role) {
  const client = await getClient();
  const room = await client.joinById(roomId, { role });
  return room;
}

/**
 * Get list of available rooms (for lobby display).
 * @returns {Promise<Array>} Array of room listing objects
 */
export async function getAvailableRooms() {
  const client = await getClient();
  const rooms = await client.getAvailableRooms("game");
  return rooms;
}
