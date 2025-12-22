const { Pool } = require('pg');

// Database connection pool
let pool;

// Initialize connection pool
function initializePool() {
  if (pool) return pool;

  const connectionString = process.env.DATABASE_URL || process.env.POSTGRES_URL;

  if (!connectionString) {
    console.error('WARNING: No DATABASE_URL or POSTGRES_URL environment variable found.');
    console.error('For local development, you can use SQLite (database.js) or set up a local PostgreSQL database.');
    throw new Error('PostgreSQL connection string not configured');
  }

  pool = new Pool({
    connectionString,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
  });

  pool.on('error', (err) => {
    console.error('Unexpected error on idle PostgreSQL client', err);
  });

  return pool;
}

// Initialize tables
async function initializeTables() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        email TEXT PRIMARY KEY,
        password TEXT NOT NULL,
        platform TEXT,
        user_id TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS connected_platforms (
        email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
        spotify BOOLEAN DEFAULT FALSE,
        apple BOOLEAN DEFAULT FALSE
      );

      CREATE TABLE IF NOT EXISTS tokens (
        user_id TEXT PRIMARY KEY,
        access_token TEXT NOT NULL,
        refresh_token TEXT,
        developer_token TEXT,
        platform TEXT,
        email TEXT,
        authorized_at TIMESTAMP,
        updated_at TIMESTAMP DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
        token TEXT NOT NULL,
        expires_at TIMESTAMP NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS playlists (
        user_id TEXT NOT NULL,
        playlist_id TEXT NOT NULL,
        playlist_data JSONB NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        PRIMARY KEY (user_id, playlist_id)
      );

      CREATE TABLE IF NOT EXISTS artist_history (
        user_id TEXT NOT NULL,
        artist_name TEXT NOT NULL,
        artist_id TEXT,
        first_seen TIMESTAMP NOT NULL DEFAULT NOW(),
        last_seen TIMESTAMP NOT NULL DEFAULT NOW(),
        play_count INTEGER DEFAULT 1,
        PRIMARY KEY (user_id, artist_name)
      );

      CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
      CREATE INDEX IF NOT EXISTS idx_tokens_email ON tokens(email);
      CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON password_reset_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
      CREATE INDEX IF NOT EXISTS idx_playlists_updated_at ON playlists(updated_at);
      CREATE INDEX IF NOT EXISTS idx_artist_history_user_id ON artist_history(user_id);
    `);
    console.log('PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}

// High-level API
class DatabaseService {
  async initialize() {
    pool = initializePool();
    await initializeTables();
  }

  // Users
  async getUser(email) {
    const result = await pool.query(`
      SELECT u.email, u.password, u.platform, u.user_id as "userId",
             u.created_at as "createdAt", u.updated_at as "updatedAt",
             COALESCE(cp.spotify, false) as spotify,
             COALESCE(cp.apple, false) as apple
      FROM users u
      LEFT JOIN connected_platforms cp ON u.email = cp.email
      WHERE u.email = $1
    `, [email]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      email: row.email,
      password: row.password,
      platform: row.platform,
      userId: row.userId,
      createdAt: row.createdAt,
      connectedPlatforms: {
        spotify: row.spotify,
        apple: row.apple
      }
    };
  }

  async createUser(email, password, platform, userId = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      await client.query(`
        INSERT INTO users (email, password, platform, user_id, created_at)
        VALUES ($1, $2, $3, $4, NOW())
      `, [email, password, platform, userId]);

      await client.query(`
        INSERT INTO connected_platforms (email, spotify, apple)
        VALUES ($1, false, false)
      `, [email]);

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  async updateUser(email, data) {
    await pool.query(`
      UPDATE users
      SET password = $1, platform = $2, user_id = $3, updated_at = NOW()
      WHERE email = $4
    `, [data.password, data.platform, data.userId, email]);
  }

  async updateUserId(email, userId) {
    await pool.query(`
      UPDATE users SET user_id = $1, updated_at = NOW() WHERE email = $2
    `, [userId, email]);
  }

  async deleteUser(email) {
    await pool.query(`DELETE FROM users WHERE email = $1`, [email]);
  }

  async getAllUsers() {
    const result = await pool.query(`
      SELECT u.email, u.password, u.platform, u.user_id as "userId",
             u.created_at as "createdAt",
             COALESCE(cp.spotify, false) as spotify,
             COALESCE(cp.apple, false) as apple
      FROM users u
      LEFT JOIN connected_platforms cp ON u.email = cp.email
    `);

    return result.rows.map(row => ({
      email: row.email,
      password: row.password,
      platform: row.platform,
      userId: row.userId,
      createdAt: row.createdAt,
      connectedPlatforms: {
        spotify: row.spotify,
        apple: row.apple
      }
    }));
  }

  // Connected Platforms
  async setConnectedPlatform(email, platform, connected) {
    const column = platform === 'spotify' ? 'spotify' : 'apple';
    await pool.query(`
      INSERT INTO connected_platforms (email, ${column})
      VALUES ($1, $2)
      ON CONFLICT (email) DO UPDATE SET ${column} = $2
    `, [email, connected]);
  }

  async setConnectedPlatforms(email, spotify, apple) {
    await pool.query(`
      INSERT INTO connected_platforms (email, spotify, apple)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET
        spotify = $2,
        apple = $3
    `, [email, spotify, apple]);
  }

  // Tokens
  async getToken(userId) {
    const result = await pool.query(`
      SELECT user_id, access_token, refresh_token, developer_token,
             platform, email, authorized_at
      FROM tokens
      WHERE user_id = $1
    `, [userId]);

    if (result.rows.length === 0) return null;

    const row = result.rows[0];
    return {
      access_token: row.access_token,
      refresh_token: row.refresh_token,
      developer_token: row.developer_token,
      platform: row.platform,
      email: row.email,
      authorized_at: row.authorized_at
    };
  }

  async setToken(userId, tokenData) {
    await pool.query(`
      INSERT INTO tokens (user_id, access_token, refresh_token, developer_token,
                         platform, email, authorized_at, updated_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
      ON CONFLICT (user_id) DO UPDATE SET
        access_token = $2,
        refresh_token = COALESCE($3, tokens.refresh_token),
        developer_token = COALESCE($4, tokens.developer_token),
        platform = COALESCE($5, tokens.platform),
        email = COALESCE($6, tokens.email),
        updated_at = NOW()
    `, [
      userId,
      tokenData.access_token,
      tokenData.refresh_token || null,
      tokenData.developer_token || null,
      tokenData.platform || null,
      tokenData.email || null,
      tokenData.authorized_at || new Date().toISOString()
    ]);
  }

  async updateAccessToken(userId, accessToken) {
    await pool.query(`
      UPDATE tokens SET access_token = $1, updated_at = NOW() WHERE user_id = $2
    `, [accessToken, userId]);
  }

  async deleteToken(userId) {
    await pool.query(`DELETE FROM tokens WHERE user_id = $1`, [userId]);
  }

  async getAllTokens() {
    const result = await pool.query(`
      SELECT user_id, access_token, refresh_token, developer_token,
             platform, email, authorized_at
      FROM tokens
    `);

    const tokens = {};
    result.rows.forEach(row => {
      tokens[row.user_id] = {
        access_token: row.access_token,
        refresh_token: row.refresh_token,
        developer_token: row.developer_token,
        platform: row.platform,
        email: row.email,
        authorized_at: row.authorized_at
      };
    });
    return tokens;
  }

  // Password Reset Tokens
  async createResetToken(email, token, expiresAt) {
    await pool.query(`
      INSERT INTO password_reset_tokens (email, token, expires_at, created_at)
      VALUES ($1, $2, $3, NOW())
      ON CONFLICT (email) DO UPDATE SET
        token = $2,
        expires_at = $3,
        created_at = NOW()
    `, [email, token, expiresAt]);
  }

  async getResetToken(token) {
    const result = await pool.query(`
      SELECT * FROM password_reset_tokens WHERE token = $1
    `, [token]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async deleteResetToken(email) {
    await pool.query(`DELETE FROM password_reset_tokens WHERE email = $1`, [email]);
  }

  async cleanExpiredResetTokens() {
    await pool.query(`DELETE FROM password_reset_tokens WHERE expires_at < NOW()`);
  }

  async updatePassword(email, newPassword) {
    await pool.query(`
      UPDATE users SET password = $1, updated_at = NOW() WHERE email = $2
    `, [newPassword, email]);
  }

  // Playlists
  async getUserPlaylists(userId) {
    const result = await pool.query(`
      SELECT playlist_id, playlist_data, created_at, updated_at
      FROM playlists
      WHERE user_id = $1
      ORDER BY updated_at DESC
    `, [userId]);

    return result.rows.map(row => ({
      playlistId: row.playlist_id,
      ...row.playlist_data,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    }));
  }

  async getPlaylist(userId, playlistId) {
    const result = await pool.query(`
      SELECT playlist_data, created_at, updated_at
      FROM playlists
      WHERE user_id = $1 AND playlist_id = $2
    `, [userId, playlistId]);

    if (result.rows.length === 0) return null;

    return {
      playlistId,
      ...result.rows[0].playlist_data,
      createdAt: result.rows[0].created_at,
      updatedAt: result.rows[0].updated_at
    };
  }

  async savePlaylist(userId, playlistId, playlistData) {
    await pool.query(`
      INSERT INTO playlists (user_id, playlist_id, playlist_data, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (user_id, playlist_id) DO UPDATE SET
        playlist_data = $3,
        updated_at = NOW()
    `, [userId, playlistId, JSON.stringify(playlistData)]);
  }

  async deletePlaylist(userId, playlistId) {
    await pool.query(`
      DELETE FROM playlists WHERE user_id = $1 AND playlist_id = $2
    `, [userId, playlistId]);
  }

  async getAllPlaylists() {
    const result = await pool.query(`
      SELECT user_id, playlist_id, playlist_data, created_at, updated_at
      FROM playlists
      ORDER BY user_id, updated_at DESC
    `);

    const playlistsByUser = {};
    result.rows.forEach(row => {
      if (!playlistsByUser[row.user_id]) {
        playlistsByUser[row.user_id] = [];
      }
      playlistsByUser[row.user_id].push({
        playlistId: row.playlist_id,
        ...row.playlist_data,
        createdAt: row.created_at,
        updatedAt: row.updated_at
      });
    });

    return playlistsByUser;
  }

  // Artist History
  async trackArtists(userId, artistNames) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      for (const artistName of artistNames) {
        await client.query(`
          INSERT INTO artist_history (user_id, artist_name, last_seen, play_count)
          VALUES ($1, $2, NOW(), 1)
          ON CONFLICT (user_id, artist_name)
          DO UPDATE SET
            last_seen = NOW(),
            play_count = artist_history.play_count + 1
        `, [userId, artistName]);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getArtistHistory(userId) {
    const result = await pool.query(`
      SELECT artist_name as "artistName", artist_id as "artistId",
             first_seen as "firstSeen", last_seen as "lastSeen", play_count as "playCount"
      FROM artist_history
      WHERE user_id = $1
      ORDER BY last_seen DESC
    `, [userId]);
    return result.rows;
  }

  // Close pool
  async close() {
    if (pool) {
      await pool.end();
      pool = null;
    }
  }
}

module.exports = new DatabaseService();
