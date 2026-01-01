const Database = require('better-sqlite3');
const path = require('path');

// Initialize database
const db = new Database(path.join(__dirname, 'playlist-creator.db'));

// Enable foreign keys
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    email TEXT PRIMARY KEY,
    password TEXT NOT NULL,
    platform TEXT,
    user_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS connected_platforms (
    email TEXT PRIMARY KEY,
    spotify INTEGER DEFAULT 0,
    apple INTEGER DEFAULT 0,
    FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS tokens (
    user_id TEXT PRIMARY KEY,
    access_token TEXT NOT NULL,
    refresh_token TEXT,
    developer_token TEXT,
    platform TEXT,
    email TEXT,
    authorized_at TEXT,
    updated_at TEXT
  );

  CREATE TABLE IF NOT EXISTS password_reset_tokens (
    email TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    FOREIGN KEY (email) REFERENCES users(email) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS artist_recommendations_cache (
    user_id TEXT PRIMARY KEY,
    artists_json TEXT NOT NULL,
    cached_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
  CREATE INDEX IF NOT EXISTS idx_tokens_email ON tokens(email);
  CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON password_reset_tokens(token);
  CREATE INDEX IF NOT EXISTS idx_artist_cache_expires ON artist_recommendations_cache(expires_at);
`);

// Database migrations
function migrateDatabase() {
  console.log('Running database migrations...');

  // Check if user_music_token and storefront columns exist
  const tableInfo = db.prepare("PRAGMA table_info(tokens)").all();
  const hasUserMusicToken = tableInfo.some(col => col.name === 'user_music_token');
  const hasStorefront = tableInfo.some(col => col.name === 'storefront');

  if (!hasUserMusicToken) {
    console.log('Adding user_music_token column to tokens table...');
    db.exec('ALTER TABLE tokens ADD COLUMN user_music_token TEXT');
    console.log('✓ Added user_music_token column');
  }

  if (!hasStorefront) {
    console.log('Adding storefront column to tokens table...');
    db.exec('ALTER TABLE tokens ADD COLUMN storefront TEXT');
    console.log('✓ Added storefront column');
  }

  if (hasUserMusicToken && hasStorefront) {
    console.log('✓ Database schema is up to date');
  }
}

// Run migrations on startup
migrateDatabase();

// User operations
const userOps = {
  // Get user by email
  getByEmail: db.prepare(`
    SELECT u.*, cp.spotify, cp.apple
    FROM users u
    LEFT JOIN connected_platforms cp ON u.email = cp.email
    WHERE u.email = ?
  `),

  // Create new user
  create: db.prepare(`
    INSERT INTO users (email, password, platform, user_id, created_at)
    VALUES (?, ?, ?, ?, ?)
  `),

  // Update user
  update: db.prepare(`
    UPDATE users
    SET password = ?, platform = ?, user_id = ?, updated_at = ?
    WHERE email = ?
  `),

  // Update userId
  updateUserId: db.prepare(`
    UPDATE users SET user_id = ?, updated_at = ? WHERE email = ?
  `),

  // Delete user
  delete: db.prepare(`DELETE FROM users WHERE email = ?`),

  // Get all users
  getAll: db.prepare(`
    SELECT u.*, cp.spotify, cp.apple
    FROM users u
    LEFT JOIN connected_platforms cp ON u.email = cp.email
  `)
};

// Connected platforms operations
const platformOps = {
  // Get connected platforms
  get: db.prepare(`SELECT * FROM connected_platforms WHERE email = ?`),

  // Set connected platforms
  set: db.prepare(`
    INSERT INTO connected_platforms (email, spotify, apple)
    VALUES (?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      spotify = excluded.spotify,
      apple = excluded.apple
  `),

  // Update single platform
  updateSpotify: db.prepare(`
    INSERT INTO connected_platforms (email, spotify, apple)
    VALUES (?, ?, 0)
    ON CONFLICT(email) DO UPDATE SET spotify = excluded.spotify
  `),

  updateApple: db.prepare(`
    INSERT INTO connected_platforms (email, spotify, apple)
    VALUES (?, 0, ?)
    ON CONFLICT(email) DO UPDATE SET apple = excluded.apple
  `)
};

// Token operations
const tokenOps = {
  // Get token by userId
  get: db.prepare(`SELECT * FROM tokens WHERE user_id = ?`),

  // Set token
  set: db.prepare(`
    INSERT INTO tokens (user_id, access_token, refresh_token, developer_token, platform, email, authorized_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      access_token = excluded.access_token,
      refresh_token = COALESCE(excluded.refresh_token, refresh_token),
      developer_token = COALESCE(excluded.developer_token, developer_token),
      platform = COALESCE(excluded.platform, platform),
      email = COALESCE(excluded.email, email),
      updated_at = excluded.updated_at
  `),

  // Update access token only
  updateAccessToken: db.prepare(`
    UPDATE tokens SET access_token = ?, updated_at = ? WHERE user_id = ?
  `),

  // Delete token
  delete: db.prepare(`DELETE FROM tokens WHERE user_id = ?`),

  // Get all tokens
  getAll: db.prepare(`SELECT * FROM tokens`)
};

// Password reset token operations
const resetTokenOps = {
  // Create or update reset token
  set: db.prepare(`
    INSERT INTO password_reset_tokens (email, token, expires_at, created_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(email) DO UPDATE SET
      token = excluded.token,
      expires_at = excluded.expires_at,
      created_at = excluded.created_at
  `),

  // Get reset token by token string
  getByToken: db.prepare(`SELECT * FROM password_reset_tokens WHERE token = ?`),

  // Delete reset token
  delete: db.prepare(`DELETE FROM password_reset_tokens WHERE email = ?`),

  // Clean up expired tokens
  deleteExpired: db.prepare(`DELETE FROM password_reset_tokens WHERE expires_at < ?`)
};

// Artist recommendations cache operations
const artistCacheOps = {
  // Get cached artists
  get: db.prepare(`SELECT * FROM artist_recommendations_cache WHERE user_id = ? AND expires_at > ?`),

  // Set cached artists
  set: db.prepare(`
    INSERT INTO artist_recommendations_cache (user_id, artists_json, cached_at, expires_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      artists_json = excluded.artists_json,
      cached_at = excluded.cached_at,
      expires_at = excluded.expires_at
  `),

  // Delete expired cache entries
  deleteExpired: db.prepare(`DELETE FROM artist_recommendations_cache WHERE expires_at < ?`),

  // Delete cache for specific user
  delete: db.prepare(`DELETE FROM artist_recommendations_cache WHERE user_id = ?`)
};

// High-level API
class DatabaseService {
  // Users
  getUser(email) {
    const user = userOps.getByEmail.get(email);
    if (!user) return null;

    return {
      email: user.email,
      password: user.password,
      platform: user.platform,
      userId: user.user_id,
      createdAt: user.created_at,
      connectedPlatforms: {
        spotify: Boolean(user.spotify),
        apple: Boolean(user.apple)
      }
    };
  }

  createUser(email, password, platform, userId = null) {
    const createdAt = new Date().toISOString();

    return db.transaction(() => {
      userOps.create.run(email, password, platform, userId, createdAt);
      platformOps.set.run(email, 0, 0);
    })();
  }

  updateUser(email, data) {
    const updatedAt = new Date().toISOString();
    userOps.update.run(
      data.password,
      data.platform,
      data.userId,
      updatedAt,
      email
    );
  }

  updateUserId(email, userId) {
    const updatedAt = new Date().toISOString();
    userOps.updateUserId.run(userId, updatedAt, email);
  }

  deleteUser(email) {
    userOps.delete.run(email);
  }

  getAllUsers() {
    const users = userOps.getAll.all();
    return users.map(user => ({
      email: user.email,
      password: user.password,
      platform: user.platform,
      userId: user.user_id,
      createdAt: user.created_at,
      connectedPlatforms: {
        spotify: Boolean(user.spotify),
        apple: Boolean(user.apple)
      }
    }));
  }

  // Connected Platforms
  setConnectedPlatform(email, platform, connected) {
    if (platform === 'spotify') {
      platformOps.updateSpotify.run(email, connected ? 1 : 0);
    } else if (platform === 'apple') {
      platformOps.updateApple.run(email, connected ? 1 : 0);
    }
  }

  setConnectedPlatforms(email, spotify, apple) {
    platformOps.set.run(email, spotify ? 1 : 0, apple ? 1 : 0);
  }

  // Tokens
  getToken(userId) {
    const token = tokenOps.get.get(userId);
    if (!token) return null;

    return {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      developer_token: token.developer_token,
      platform: token.platform,
      email: token.email,
      authorized_at: token.authorized_at
    };
  }

  setToken(userId, tokenData) {
    const updatedAt = new Date().toISOString();
    tokenOps.set.run(
      userId,
      tokenData.access_token,
      tokenData.refresh_token || null,
      tokenData.developer_token || null,
      tokenData.platform || null,
      tokenData.email || null,
      tokenData.authorized_at || new Date().toISOString(),
      updatedAt
    );
  }

  updateAccessToken(userId, accessToken) {
    const updatedAt = new Date().toISOString();
    tokenOps.updateAccessToken.run(accessToken, updatedAt, userId);
  }

  deleteToken(userId) {
    tokenOps.delete.run(userId);
  }

  getAllTokens() {
    const tokens = tokenOps.getAll.all();
    const result = {};
    tokens.forEach(token => {
      result[token.user_id] = {
        access_token: token.access_token,
        refresh_token: token.refresh_token,
        developer_token: token.developer_token,
        platform: token.platform,
        email: token.email,
        authorized_at: token.authorized_at
      };
    });
    return result;
  }

  // Password Reset Tokens
  createResetToken(email, token, expiresAt) {
    const createdAt = new Date().toISOString();
    resetTokenOps.set.run(email, token, expiresAt, createdAt);
  }

  getResetToken(token) {
    return resetTokenOps.getByToken.get(token);
  }

  deleteResetToken(email) {
    resetTokenOps.delete.run(email);
  }

  cleanExpiredResetTokens() {
    const now = new Date().toISOString();
    resetTokenOps.deleteExpired.run(now);
  }

  updatePassword(email, newPassword) {
    const updatedAt = new Date().toISOString();
    const user = this.getUser(email);
    if (user) {
      userOps.update.run(newPassword, user.platform, user.userId, updatedAt, email);
    }
  }

  // Artist Recommendations Cache
  getCachedArtists(userId) {
    const now = new Date().toISOString();
    const cached = artistCacheOps.get.get(userId, now);
    if (!cached) return null;

    try {
      return JSON.parse(cached.artists_json);
    } catch (error) {
      console.error('Error parsing cached artists:', error);
      return null;
    }
  }

  setCachedArtists(userId, artists) {
    const now = new Date();
    const cachedAt = now.toISOString();

    // Calculate next 12 AM UTC
    const nextMidnight = new Date(now);
    nextMidnight.setUTCHours(24, 0, 0, 0); // Next midnight UTC
    const expiresAt = nextMidnight.toISOString();

    const artistsJson = JSON.stringify(artists);
    artistCacheOps.set.run(userId, artistsJson, cachedAt, expiresAt);

    console.log(`Cached artists for ${userId}, expires at ${expiresAt}`);
  }

  deleteCachedArtists(userId) {
    artistCacheOps.delete.run(userId);
  }

  cleanExpiredArtistCache() {
    const now = new Date().toISOString();
    artistCacheOps.deleteExpired.run(now);
  }

  // Close database connection
  close() {
    db.close();
  }
}

module.exports = new DatabaseService();
