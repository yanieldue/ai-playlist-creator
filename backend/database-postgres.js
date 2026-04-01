const { Pool } = require('pg');

// Returns next Sunday at 3:00 AM UTC
function getNextSunday3AM() {
  const now = new Date();
  const day = now.getUTCDay(); // 0 = Sunday
  const daysUntilSunday = day === 0 ? 7 : 7 - day;
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntilSunday);
  next.setUTCHours(3, 0, 0, 0);
  return next;
}

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
        plan TEXT DEFAULT 'free',
        weekly_generations INTEGER DEFAULT 0,
        weekly_reset_at TIMESTAMP,
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

      CREATE TABLE IF NOT EXISTS artist_recommendations_cache (
        user_id TEXT PRIMARY KEY,
        artists_json JSONB NOT NULL,
        cached_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL
      );

      CREATE TABLE IF NOT EXISTS trending_artists_cache (
        user_id TEXT PRIMARY KEY,
        genres_data JSONB NOT NULL,
        cached_at TIMESTAMP NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMP NOT NULL
      );

      CREATE TABLE IF NOT EXISTS soundcharts_cache (
        cache_key TEXT PRIMARY KEY,
        data TEXT NOT NULL,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_soundcharts_cache_created ON soundcharts_cache(created_at);

      CREATE TABLE IF NOT EXISTS song_details (
        uuid TEXT PRIMARY KEY,
        name TEXT,
        artist_name TEXT,
        artist_uuid TEXT,
        isrc TEXT,
        release_date TEXT,
        energy REAL,
        valence REAL,
        danceability REAL,
        tempo REAL,
        loudness REAL,
        acousticness REAL,
        instrumentalness REAL,
        speechiness REAL,
        liveness REAL,
        key_signature SMALLINT,
        mode SMALLINT,
        time_signature SMALLINT,
        moods TEXT[],
        themes TEXT[],
        genres TEXT[],
        subgenres TEXT[],
        fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_song_details_isrc ON song_details(isrc);
      CREATE INDEX IF NOT EXISTS idx_song_details_artist_uuid ON song_details(artist_uuid);

      CREATE TABLE IF NOT EXISTS artist_details (
        uuid TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        name_lower TEXT NOT NULL,
        career_stage TEXT,
        spotify_id TEXT,
        spotify_popularity SMALLINT,
        spotify_genres TEXT[],
        sc_genres TEXT[],
        sc_subgenres TEXT[],
        fetched_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_artist_details_name_lower ON artist_details(name_lower);

      CREATE TABLE IF NOT EXISTS artist_catalogs (
        artist_uuid TEXT PRIMARY KEY,
        artist_name TEXT NOT NULL,
        genre TEXT,
        song_count INTEGER,
        latest_song_uuid TEXT,
        cached_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE TABLE IF NOT EXISTS artist_songs (
        id SERIAL PRIMARY KEY,
        artist_uuid TEXT NOT NULL REFERENCES artist_catalogs(artist_uuid) ON DELETE CASCADE,
        song_uuid TEXT,
        song_name TEXT NOT NULL,
        isrc TEXT,
        release_date TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_artist_songs_artist_uuid ON artist_songs(artist_uuid);
      CREATE INDEX IF NOT EXISTS idx_artist_songs_isrc ON artist_songs(isrc);
      CREATE INDEX IF NOT EXISTS idx_artist_songs_song_uuid ON artist_songs(song_uuid);
      ALTER TABLE artist_songs ADD COLUMN IF NOT EXISTS song_uuid TEXT;
      DO $$ BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint WHERE conname = 'artist_songs_song_uuid_key'
        ) THEN
          DELETE FROM artist_songs a USING artist_songs b
            WHERE a.id > b.id AND a.song_uuid IS NOT DISTINCT FROM b.song_uuid AND a.song_uuid IS NOT NULL;
          ALTER TABLE artist_songs ADD CONSTRAINT artist_songs_song_uuid_key UNIQUE (song_uuid);
        END IF;
      END $$;
      CREATE INDEX IF NOT EXISTS idx_artist_catalogs_genre ON artist_catalogs(genre);

      CREATE TABLE IF NOT EXISTS platform_user_ids (
        email TEXT PRIMARY KEY REFERENCES users(email) ON DELETE CASCADE,
        spotify_user_id TEXT,
        apple_music_user_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);
      CREATE INDEX IF NOT EXISTS idx_tokens_email ON tokens(email);
      CREATE INDEX IF NOT EXISTS idx_reset_tokens_token ON password_reset_tokens(token);
      CREATE INDEX IF NOT EXISTS idx_playlists_user_id ON playlists(user_id);
      CREATE INDEX IF NOT EXISTS idx_playlists_updated_at ON playlists(updated_at);
      CREATE INDEX IF NOT EXISTS idx_artist_history_user_id ON artist_history(user_id);
      CREATE INDEX IF NOT EXISTS idx_artist_cache_expires ON artist_recommendations_cache(expires_at);
    `);
    console.log('PostgreSQL tables initialized');
  } finally {
    client.release();
  }
}

// Database migrations
async function migrateDatabase() {
  const client = await pool.connect();
  try {
    console.log('Running PostgreSQL database migrations...');

    // Add user_music_token and storefront columns if they don't exist
    await client.query(`
      ALTER TABLE tokens
      ADD COLUMN IF NOT EXISTS user_music_token TEXT,
      ADD COLUMN IF NOT EXISTS storefront TEXT
    `);

    // Add plan and weekly generation columns to users table if they don't exist
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS plan TEXT DEFAULT 'free',
      ADD COLUMN IF NOT EXISTS weekly_generations INTEGER DEFAULT 0,
      ADD COLUMN IF NOT EXISTS weekly_reset_at TIMESTAMP
    `);

    // Add Stripe columns
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT,
      ADD COLUMN IF NOT EXISTS stripe_subscription_id TEXT,
      ADD COLUMN IF NOT EXISTS subscription_status TEXT,
      ADD COLUMN IF NOT EXISTS subscription_ends_at TIMESTAMP
    `);

    // Add product tour completed column
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS product_tour_completed BOOLEAN DEFAULT FALSE
    `);

    // Add user settings columns
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS allow_explicit BOOLEAN DEFAULT TRUE,
      ADD COLUMN IF NOT EXISTS dark_mode BOOLEAN DEFAULT FALSE
    `);

    // Add trial tracking column
    await client.query(`
      ALTER TABLE users
      ADD COLUMN IF NOT EXISTS trial_used BOOLEAN DEFAULT FALSE
    `);

    console.log('✓ PostgreSQL migrations complete');
  } catch (error) {
    console.error('Error running migrations:', error);
  } finally {
    client.release();
  }
}

// High-level API
class DatabaseService {
  async initialize() {
    pool = initializePool();
    await initializeTables();
    await migrateDatabase();
  }

  // Users
  async getUser(email) {
    const result = await pool.query(`
      SELECT u.email, u.password, u.platform, u.user_id as "userId",
             u.plan, u.weekly_generations as "weeklyGenerations",
             u.weekly_reset_at as "weeklyResetAt",
             u.stripe_customer_id as "stripeCustomerId",
             u.stripe_subscription_id as "stripeSubscriptionId",
             u.subscription_status as "subscriptionStatus",
             u.product_tour_completed as "productTourCompleted",
             u.allow_explicit as "allowExplicit",
             u.dark_mode as "darkMode",
             u.trial_used as "trialUsed",
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
      plan: row.plan || 'free',
      weeklyGenerations: row.weeklyGenerations || 0,
      weeklyResetAt: row.weeklyResetAt || null,
      stripeCustomerId: row.stripeCustomerId || null,
      stripeSubscriptionId: row.stripeSubscriptionId || null,
      subscriptionStatus: row.subscriptionStatus || null,
      productTourCompleted: row.productTourCompleted || false,
      allowExplicit: row.allowExplicit !== false, // default true
      darkMode: row.darkMode || false,
      trialUsed: row.trialUsed || false,
      createdAt: row.createdAt,
      connectedPlatforms: {
        spotify: row.spotify,
        apple: row.apple
      }
    };
  }

  async incrementWeeklyGenerations(email) {
    await pool.query(
      `UPDATE users SET weekly_generations = weekly_generations + 1 WHERE email = $1`,
      [email]
    );
  }

  async resetWeeklyGenerations(email) {
    await pool.query(
      `UPDATE users SET weekly_generations = 1, weekly_reset_at = NOW() WHERE email = $1`,
      [email]
    );
  }

  async markTrialUsed(email) {
    await pool.query(
      `UPDATE users SET trial_used = TRUE, updated_at = NOW() WHERE email = $1`,
      [email]
    );
  }

  async updateStripeCustomer(email, stripeCustomerId) {
    await pool.query(
      `UPDATE users SET stripe_customer_id = $1, updated_at = NOW() WHERE email = $2`,
      [stripeCustomerId, email]
    );
  }

  async updateSubscription(email, { subscriptionId, status, endsAt, plan }) {
    await pool.query(
      `UPDATE users SET stripe_subscription_id = $1, subscription_status = $2, subscription_ends_at = $3, plan = $4, updated_at = NOW() WHERE email = $5`,
      [subscriptionId || null, status || null, endsAt || null, plan || 'free', email]
    );
  }

  async getUserByStripeCustomerId(stripeCustomerId) {
    const result = await pool.query(
      `SELECT email, plan, stripe_customer_id as "stripeCustomerId", stripe_subscription_id as "stripeSubscriptionId" FROM users WHERE stripe_customer_id = $1`,
      [stripeCustomerId]
    );
    if (result.rows.length === 0) return null;
    return result.rows[0];
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

  async updateEmail(oldEmail, newEmail) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        'UPDATE users SET email = $1, updated_at = NOW() WHERE email = $2',
        [newEmail, oldEmail]
      );
      await client.query(
        'UPDATE connected_platforms SET email = $1 WHERE email = $2',
        [newEmail, oldEmail]
      );
      await client.query(
        'UPDATE platform_user_ids SET email = $1 WHERE email = $2',
        [newEmail, oldEmail]
      );
      await client.query(
        'UPDATE tokens SET email = $1 WHERE email = $2',
        [newEmail, oldEmail]
      );
      await client.query(
        'UPDATE playlists SET user_id = $1 WHERE user_id = $2',
        [newEmail, oldEmail]
      );
      await client.query(
        'UPDATE artist_history SET user_id = $1 WHERE user_id = $2',
        [newEmail, oldEmail]
      );
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
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

  async updatePlatforms(email, platforms) {
    await pool.query(`
      INSERT INTO connected_platforms (email, spotify, apple)
      VALUES ($1, $2, $3)
      ON CONFLICT (email) DO UPDATE SET
        spotify = $2,
        apple = $3
    `, [email, platforms.spotify, platforms.apple]);
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
      // Use playlist_data.updatedAt (only set when tracks are actually added),
      // not row.updated_at which changes on every internal save (e.g. nextUpdate advancement)
      updatedAt: row.playlist_data.updatedAt || null
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
      updatedAt: result.rows[0].playlist_data.updatedAt || null
    };
  }

  async savePlaylist(userId, playlistId, playlistData) {
    // Serialize immediately so concurrent saves don't race on a shared object reference
    const serialized = JSON.stringify(playlistData);
    await pool.query(`
      INSERT INTO playlists (user_id, playlist_id, playlist_data, created_at, updated_at)
      VALUES ($1, $2, $3, NOW(), NOW())
      ON CONFLICT (user_id, playlist_id) DO UPDATE SET
        playlist_data = $3,
        updated_at = NOW()
    `, [userId, playlistId, serialized]);
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
        updatedAt: row.playlist_data.updatedAt || null
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

  // Artist Recommendations Cache
  async getCachedArtists(userId) {
    try {
      const result = await pool.query(`
        SELECT artists_json
        FROM artist_recommendations_cache
        WHERE user_id = $1 AND expires_at > NOW()
      `, [userId]);

      if (result.rows.length === 0) return null;

      return result.rows[0].artists_json;
    } catch (error) {
      console.error('Error getting cached artists:', error);
      return null;
    }
  }

  async getStaleCachedArtists(userId) {
    try {
      const result = await pool.query(`
        SELECT artists_json
        FROM artist_recommendations_cache
        WHERE user_id = $1
      `, [userId]);

      if (result.rows.length === 0) return null;

      return result.rows[0].artists_json;
    } catch (error) {
      console.error('Error getting stale cached artists:', error);
      return null;
    }
  }

  async setCachedArtists(userId, artists) {
    try {
      // Cache for 7 days to survive SoundCharts quota resets
      const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);

      await pool.query(`
        INSERT INTO artist_recommendations_cache (user_id, artists_json, cached_at, expires_at)
        VALUES ($1, $2, NOW(), $3)
        ON CONFLICT (user_id) DO UPDATE SET
          artists_json = EXCLUDED.artists_json,
          cached_at = EXCLUDED.cached_at,
          expires_at = EXCLUDED.expires_at
      `, [userId, JSON.stringify(artists), expires]);

      console.log(`Cached artists for ${userId}, expires at ${expires.toISOString()}`);
    } catch (error) {
      console.error('Error setting cached artists:', error);
      throw error;
    }
  }

  async deleteCachedArtists(userId) {
    try {
      await pool.query(`
        DELETE FROM artist_recommendations_cache
        WHERE user_id = $1
      `, [userId]);
    } catch (error) {
      console.error('Error deleting cached artists:', error);
      throw error;
    }
  }

  async cleanExpiredArtistCache() {
    try {
      const result = await pool.query(`
        DELETE FROM artist_recommendations_cache
        WHERE expires_at < NOW()
      `);
      return result.rowCount;
    } catch (error) {
      console.error('Error cleaning expired artist cache:', error);
      throw error;
    }
  }

  async getCachedTrendingArtists(userId) {
    try {
      const result = await pool.query(`
        SELECT genres_data
        FROM trending_artists_cache
        WHERE user_id = $1 AND expires_at > NOW()
      `, [userId]);
      if (result.rows.length === 0) return null;
      return result.rows[0].genres_data;
    } catch (error) {
      console.error('Error getting cached trending artists:', error);
      return null;
    }
  }

  async setCachedTrendingArtists(userId, genresData) {
    try {
      const expires = getNextSunday3AM();
      await pool.query(`
        INSERT INTO trending_artists_cache (user_id, genres_data, cached_at, expires_at)
        VALUES ($1, $2, NOW(), $3)
        ON CONFLICT (user_id) DO UPDATE SET
          genres_data = EXCLUDED.genres_data,
          cached_at = EXCLUDED.cached_at,
          expires_at = EXCLUDED.expires_at
      `, [userId, JSON.stringify(genresData), expires]);
      console.log(`Cached trending artists for ${userId}, expires at ${expires.toISOString()}`);
    } catch (error) {
      console.error('Error setting cached trending artists:', error);
      throw error;
    }
  }

  async deleteCachedTrendingArtists(userId) {
    try {
      await pool.query(`DELETE FROM trending_artists_cache WHERE user_id = $1`, [userId]);
    } catch (error) {
      console.error('Error deleting cached trending artists:', error);
    }
  }

  async getCachedSC(key) {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const result = await pool.query(
        `SELECT data FROM soundcharts_cache WHERE cache_key = $1 AND created_at > $2`,
        [key, sevenDaysAgo]
      );
      if (result.rows.length === 0) return undefined;
      return JSON.parse(result.rows[0].data);
    } catch (error) {
      console.error('Error getting SC DB cache:', error);
      return undefined;
    }
  }

  async setCachedSC(key, data) {
    try {
      await pool.query(
        `INSERT INTO soundcharts_cache (cache_key, data, created_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (cache_key) DO UPDATE SET data = $2, created_at = NOW()`,
        [key, JSON.stringify(data)]
      );
    } catch (error) {
      console.error('Error setting SC DB cache:', error);
    }
  }

  // Structured artist catalog storage (queryable via SQL)
  async artistSongExists(artistUuid, songUuid) {
    const result = await pool.query(
      `SELECT 1 FROM artist_songs WHERE artist_uuid = $1 AND song_uuid = $2 LIMIT 1`,
      [artistUuid, songUuid]
    );
    return result.rows.length > 0;
  }

  async upsertArtistCatalog(artistUuid, artistName, songs, latestSongUuid, genre = null) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO artist_catalogs (artist_uuid, artist_name, genre, song_count, latest_song_uuid, cached_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (artist_uuid) DO UPDATE SET
           artist_name = $2, genre = COALESCE($3, artist_catalogs.genre),
           song_count = $4, latest_song_uuid = $5, cached_at = NOW()`,
        [artistUuid, artistName, genre, songs.length, latestSongUuid]
      );
      // Incremental insert — only add songs not already stored
      for (const song of songs) {
        await client.query(
          `INSERT INTO artist_songs (artist_uuid, song_uuid, song_name, isrc, release_date)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (song_uuid) DO NOTHING`,
          [artistUuid, song.uuid || null, song.name, song.isrc || null, song.releaseDate || null]
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK');
      console.error(`Error upserting artist catalog for ${artistName}:`, err.message);
    } finally {
      client.release();
    }
  }

  // Platform User IDs
  async getPlatformUserIds(email) {
    const result = await pool.query(`
      SELECT * FROM platform_user_ids WHERE email = $1
    `, [email]);
    return result.rows.length > 0 ? result.rows[0] : null;
  }

  async setPlatformUserId(email, platform, platformUserId) {
    // Validate platform and build safe query
    if (platform === 'spotify') {
      await pool.query(`
        INSERT INTO platform_user_ids (email, spotify_user_id)
        VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE SET spotify_user_id = $2
      `, [email, platformUserId]);
    } else if (platform === 'apple') {
      await pool.query(`
        INSERT INTO platform_user_ids (email, apple_music_user_id)
        VALUES ($1, $2)
        ON CONFLICT (email) DO UPDATE SET apple_music_user_id = $2
      `, [email, platformUserId]);
    } else {
      throw new Error(`Invalid platform: ${platform}`);
    }
  }

  async getEmailFromPlatformUserId(platformUserId) {
    const result = await pool.query(`
      SELECT email FROM platform_user_ids
      WHERE spotify_user_id = $1 OR apple_music_user_id = $1
    `, [platformUserId]);
    return result.rows.length > 0 ? result.rows[0].email : null;
  }

  async markTourCompleted(email) {
    await pool.query(
      `UPDATE users SET product_tour_completed = TRUE, updated_at = NOW() WHERE email = $1`,
      [email]
    );
  }

  async updateUserSettings(email, { allowExplicit, darkMode }) {
    await pool.query(
      `UPDATE users SET allow_explicit = $1, dark_mode = $2, updated_at = NOW() WHERE email = $3`,
      [allowExplicit, darkMode, email]
    );
  }

  // Song Details
  async getSongDetail(uuid) {
    const result = await pool.query(`SELECT * FROM song_details WHERE uuid = $1`, [uuid]);
    return result.rows[0] || null;
  }

  async getSongDetailsByUuids(uuids) {
    if (!uuids || uuids.length === 0) return new Map();
    const result = await pool.query(`SELECT * FROM song_details WHERE uuid = ANY($1)`, [uuids]);
    const map = new Map();
    for (const row of result.rows) map.set(row.uuid, row);
    return map;
  }

  async upsertSongDetail(uuid, data) {
    const {
      name, artistName, artistUuid, isrc, releaseDate,
      energy, valence, danceability, tempo, loudness,
      acousticness, instrumentalness, speechiness, liveness,
      keySignature, mode, timeSignature,
      moods, themes, genres, subgenres,
    } = data;
    await pool.query(`
      INSERT INTO song_details (
        uuid, name, artist_name, artist_uuid, isrc, release_date,
        energy, valence, danceability, tempo, loudness,
        acousticness, instrumentalness, speechiness, liveness,
        key_signature, mode, time_signature,
        moods, themes, genres, subgenres
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22)
      ON CONFLICT (uuid) DO UPDATE SET
        name            = COALESCE($2,  song_details.name),
        artist_name     = COALESCE($3,  song_details.artist_name),
        artist_uuid     = COALESCE($4,  song_details.artist_uuid),
        isrc            = COALESCE($5,  song_details.isrc),
        release_date    = COALESCE($6,  song_details.release_date),
        energy          = COALESCE($7,  song_details.energy),
        valence         = COALESCE($8,  song_details.valence),
        danceability    = COALESCE($9,  song_details.danceability),
        tempo           = COALESCE($10, song_details.tempo),
        loudness        = COALESCE($11, song_details.loudness),
        acousticness    = COALESCE($12, song_details.acousticness),
        instrumentalness= COALESCE($13, song_details.instrumentalness),
        speechiness     = COALESCE($14, song_details.speechiness),
        liveness        = COALESCE($15, song_details.liveness),
        key_signature   = COALESCE($16, song_details.key_signature),
        mode            = COALESCE($17, song_details.mode),
        time_signature  = COALESCE($18, song_details.time_signature),
        moods           = COALESCE($19, song_details.moods),
        themes          = COALESCE($20, song_details.themes),
        genres          = COALESCE($21, song_details.genres),
        subgenres       = COALESCE($22, song_details.subgenres),
        updated_at      = NOW()
    `, [
      uuid, name || null, artistName || null, artistUuid || null, isrc || null, releaseDate || null,
      energy ?? null, valence ?? null, danceability ?? null, tempo ?? null, loudness ?? null,
      acousticness ?? null, instrumentalness ?? null, speechiness ?? null, liveness ?? null,
      keySignature ?? null, mode ?? null, timeSignature ?? null,
      moods?.length ? moods : null,
      themes?.length ? themes : null,
      genres?.length ? genres : null,
      subgenres?.length ? subgenres : null,
    ]);
  }

  async getArtistDetailsByNames(names) {
    if (!names || names.length === 0) return new Map();
    const lowerNames = names.map(n => n.toLowerCase());
    const result = await pool.query(
      `SELECT * FROM artist_details WHERE name_lower = ANY($1)`,
      [lowerNames]
    );
    const map = new Map();
    for (const row of result.rows) map.set(row.name_lower, row);
    return map;
  }

  async getArtistSpotifyIdsByUuids(uuids) {
    if (!uuids || uuids.length === 0) return new Map();
    const result = await pool.query(
      `SELECT uuid, spotify_id FROM artist_details WHERE uuid = ANY($1) AND spotify_id IS NOT NULL`,
      [uuids]
    );
    const map = new Map();
    for (const row of result.rows) map.set(row.uuid, row.spotify_id);
    return map;
  }

  async upsertArtistDetail(uuid, data) {
    const { name, careerStage, spotifyId, spotifyPopularity, spotifyGenres, scGenres, scSubgenres } = data;
    await pool.query(`
      INSERT INTO artist_details (
        uuid, name, name_lower,
        career_stage, spotify_id, spotify_popularity,
        spotify_genres, sc_genres, sc_subgenres
      ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)
      ON CONFLICT (uuid) DO UPDATE SET
        name               = COALESCE($2, artist_details.name),
        name_lower         = COALESCE($3, artist_details.name_lower),
        career_stage       = COALESCE($4, artist_details.career_stage),
        spotify_id         = COALESCE($5, artist_details.spotify_id),
        spotify_popularity = COALESCE($6, artist_details.spotify_popularity),
        spotify_genres     = COALESCE($7, artist_details.spotify_genres),
        sc_genres          = COALESCE($8, artist_details.sc_genres),
        sc_subgenres       = COALESCE($9, artist_details.sc_subgenres),
        updated_at         = NOW()
    `, [
      uuid,
      name || null,
      name ? name.toLowerCase() : null,
      careerStage || null,
      spotifyId || null,
      spotifyPopularity ?? null,
      spotifyGenres?.length ? spotifyGenres : null,
      scGenres?.length ? scGenres : null,
      scSubgenres?.length ? scSubgenres : null,
    ]);
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
