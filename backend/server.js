const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const SpotifyWebApi = require('spotify-web-api-node');
const Anthropic = require('@anthropic-ai/sdk');
const jwt = require('jsonwebtoken');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const geoip = require('geoip-lite');
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
const { spawn } = require('child_process');
const getStripe = () => {
  if (!process.env.STRIPE_SECRET_KEY) throw new Error('STRIPE_SECRET_KEY is not configured');
  return require('stripe')(process.env.STRIPE_SECRET_KEY);
};
const { handleCriticalError } = require('./services/errorNotificationService');

// Load services with error handling
let AppleMusicService, PlatformService;
try {
  AppleMusicService = require('./services/appleMusicService');
  PlatformService = require('./services/platformService');
  console.log('✓ Apple Music and Platform services loaded successfully');
} catch (error) {
  console.error('❌ Failed to load services:', error.message);
  console.error('Stack:', error.stack);
  // Continue without services - some endpoints won't work but server will start
}

dotenv.config();

// Use PostgreSQL if DATABASE_URL is set, otherwise use SQLite
const usePostgres = !!(process.env.DATABASE_URL || process.env.POSTGRES_URL);
const db = usePostgres ? require('./database-postgres') : require('./database');

console.log(`Using ${usePostgres ? 'PostgreSQL' : 'SQLite'} database`);

const app = express();
const PORT = process.env.PORT || 3001;

// Per-user in-flight generation deduplication
const inFlightGenerations = new Map(); // key: userId+prompt -> timestamp

// Middleware
// Configure CORS for production and development
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      'https://tryfins.com',
      'https://www.tryfins.com',
      'https://ai-playlist-creator-7cgm.vercel.app',
      'http://localhost:3000',
      'http://127.0.0.1:3000'
    ];

    // Allow requests with no origin (like mobile apps or curl)
    if (!origin) return callback(null, true);

    // Check if origin is in allowed list
    if (allowedOrigins.includes(origin)) {
      return callback(null, true);
    }

    // Allow Vercel preview deployments for this project
    if (/^https:\/\/ai-playlist-creator-7cgm.*\.vercel\.app$/.test(origin)) {
      return callback(null, true);
    }

    // Allow all other origins in development
    if (process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }

    // In production, log and reject unknown origins
    console.log('CORS blocked origin:', origin);
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
// Stripe webhook needs raw body — must be before express.json()
app.use('/api/stripe/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' })); // Increase limit for Apple Music tokens

// Normalise FRONTEND_URL once — ensures it always has a protocol so redirects
// don't turn into relative paths (e.g. "tryfins.com" → "https://tryfins.com")
const FRONTEND_URL = (() => {
  const raw = process.env.FRONTEND_URL || 'http://localhost:3000';
  return /^https?:\/\//.test(raw) ? raw : `https://${raw}`;
})();

// Initialize Spotify API
const spotifyApi = new SpotifyWebApi({
  clientId: process.env.SPOTIFY_CLIENT_ID,
  clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
  redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
});

// Initialize Anthropic API
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY
});

// Cache: artist name (lowercase) → array of known aliases/side-projects/supergroups
// Persists for the server lifetime so the same artist never hits Claude twice.
const _artistAliasCache = new Map();

// Configure SendGrid for email
if (process.env.SENDGRID_API_KEY) {
  sgMail.setApiKey(process.env.SENDGRID_API_KEY);
  console.log('SendGrid email configured');
} else if (process.env.GMAIL_ACCOUNT && process.env.GMAIL_APP_PASSWORD) {
  console.log('Gmail email configured via nodemailer');
} else {
  console.log('No email provider configured. Password reset emails will be logged to console.');
}

// Unified email sender: tries SendGrid first, falls back to nodemailer/Gmail
async function sendEmail({ to, subject, html }) {
  if (process.env.SENDGRID_API_KEY) {
    await sgMail.send({
      to,
      from: process.env.SENDGRID_FROM_EMAIL || process.env.GMAIL_ACCOUNT || 'noreply@aiplaylistcreator.com',
      subject,
      html,
    });
    return;
  }
  if (process.env.GMAIL_ACCOUNT && process.env.GMAIL_APP_PASSWORD) {
    const transporter = nodemailer.createTransport({
      service: process.env.GMAIL_SERVICE || 'gmail',
      auth: { user: process.env.GMAIL_ACCOUNT, pass: process.env.GMAIL_APP_PASSWORD },
    });
    await transporter.sendMail({ from: process.env.GMAIL_ACCOUNT, to, subject, html });
    return;
  }
  throw new Error('No email provider configured');
}

// Normalize a track name for song history deduplication
function normalizeForHistory(name) {
  return (name || '').toLowerCase()
    .replace(/\s*-\s*(a\s+)?colors?\s+show/gi, '')
    .replace(/\s*-\s*((single|album|ep)\s+)?version/gi, '')
    .replace(/\s*[\(\[].*?[\)\]]/g, '')
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Helper function to validate Spotify track URIs
// Spotify track IDs should be 22 characters of valid base62 characters (0-9, a-z, A-Z)
function isValidSpotifyTrackUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  if (!uri.startsWith('spotify:track:')) return false;

  const trackId = uri.substring('spotify:track:'.length);

  // Spotify track IDs are 22 characters long
  if (trackId.length !== 22) {
    if (trackId === '2xdZtNiWVfQvZFTF9Zhgjc' || trackId === '6Sobxk91KFGm5agYKw0ODD') {
      console.log(`[VALIDATION] URI ${uri} has trackId length ${trackId.length}, expected 22`);
    }
    return false;
  }

  // Check if all characters are valid base62 (0-9, a-z, A-Z)
  const isValid = /^[0-9a-zA-Z]{22}$/.test(trackId);
  if (!isValid && (trackId === '2xdZtNiWVfQvZFTF9Zhgjc' || trackId === '6Sobxk91KFGm5agYKw0ODD')) {
    console.log(`[VALIDATION] URI ${uri} has invalid characters in trackId`);
  }
  return isValid;
}

// Generate Apple Music JWT Token
// This function creates a JWT token dynamically for Apple Music authentication
function generateAppleMusicToken() {
  try {
    const teamId = process.env.APPLE_MUSIC_TEAM_ID;
    const keyId = process.env.APPLE_MUSIC_KEY_ID;
    const privateKeyPath = process.env.APPLE_MUSIC_PRIVATE_KEY_PATH;
    const privateKeyEnv = process.env.APPLE_MUSIC_PRIVATE_KEY;

    // If using pre-generated token, return it
    if (process.env.APPLE_MUSIC_DEV_TOKEN && !privateKeyPath && !privateKeyEnv) {
      return process.env.APPLE_MUSIC_DEV_TOKEN;
    }

    // Get private key from environment variable or file
    let privateKey;
    if (privateKeyEnv) {
      // Use private key from environment variable (for production/Railway)
      privateKey = privateKeyEnv;
    } else if (privateKeyPath) {
      // Read private key from file (for local development)
      privateKey = fs.readFileSync(privateKeyPath, 'utf8');
    } else {
      throw new Error('No Apple Music private key found (set APPLE_MUSIC_PRIVATE_KEY or APPLE_MUSIC_PRIVATE_KEY_PATH)');
    }

    // Generate JWT token if credentials are available
    if (teamId && keyId && privateKey) {

      const now = Math.floor(Date.now() / 1000);
      const expiresIn = 15777000; // 6 months (max allowed by Apple)

      const token = jwt.sign(
        {
          iss: teamId,
          iat: now,
          exp: now + expiresIn,
        },
        privateKey,
        {
          algorithm: 'ES256',
          keyid: keyId,
        }
      );

      console.log('Generated new Apple Music JWT token (valid for 6 months)');
      return token;
    }

    console.warn('Apple Music token generation: missing credentials (APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID, or APPLE_MUSIC_PRIVATE_KEY_PATH)');
    return null;
  } catch (error) {
    console.error('Error generating Apple Music token:', error.message);
    return null;
  }
}

// File path for persistent token storage
const TOKENS_FILE = path.join(__dirname, '.tokens.json');
const PLAYLISTS_FILE = path.join(__dirname, '.playlists.json');
const USERS_FILE = path.join(__dirname, '.users.json');
const REACTIONS_FILE = path.join(__dirname, '.reactions.json');
const SAVED_PLAYLISTS_FILE = path.join(__dirname, '.saved_playlists.json');

// Load tokens from file on startup
function loadTokens() {
  try {
    if (fs.existsSync(TOKENS_FILE)) {
      const data = fs.readFileSync(TOKENS_FILE, 'utf8');
      const tokensObj = JSON.parse(data);
      console.log('Loaded', Object.keys(tokensObj).length, 'user sessions from file');
      return new Map(Object.entries(tokensObj));
    }
  } catch (error) {
    console.error('Error loading tokens:', error);
  }
  return new Map();
}

// Save tokens to file - NO LONGER NEEDED (using database)
function saveTokens() {
  // Database auto-saves, this function is kept for compatibility
}

// Spotify Client Credentials token (for searching without user auth)
let spotifyClientToken = null;
let spotifyClientTokenExpiry = 0;

// Get Spotify access token using Client Credentials Flow (no user auth needed)
async function getSpotifyClientToken() {
  // Return cached token if still valid
  if (spotifyClientToken && Date.now() < spotifyClientTokenExpiry) {
    return spotifyClientToken;
  }

  try {
    const response = await axios.post(
      'https://accounts.spotify.com/api/token',
      'grant_type=client_credentials',
      {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': 'Basic ' + Buffer.from(
            process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
          ).toString('base64')
        }
      }
    );

    spotifyClientToken = response.data.access_token;
    // Set expiry 5 minutes before actual expiry to be safe
    spotifyClientTokenExpiry = Date.now() + (response.data.expires_in - 300) * 1000;
    console.log('✓ Obtained Spotify client credentials token');
    return spotifyClientToken;
  } catch (error) {
    console.error('Failed to get Spotify client token:', error.message);
    throw error;
  }
}

// Search Spotify for tracks using Client Credentials (no user auth needed)
async function searchSpotifyWithClientCredentials(query, limit = 10) {
  const token = await getSpotifyClientToken();

  try {
    const response = await axios.get('https://api.spotify.com/v1/search', {
      headers: { 'Authorization': `Bearer ${token}` },
      params: {
        q: query,
        type: 'track',
        limit: limit
      }
    });

    return response.data.tracks.items;
  } catch (error) {
    console.error('Spotify search error:', error.message);
    return [];
  }
}

// Get recommendations from ReccoBeats API (no auth required)
// Uses Spotify track IDs as seeds and returns similar tracks
async function getReccoBeatsRecommendations(seedTrackIds = [], size = 60) {
  if (seedTrackIds.length === 0) {
    console.warn('getReccoBeatsRecommendations: No seed tracks provided');
    return [];
  }

  try {
    // Build URL with multiple seeds parameters
    const seedParams = seedTrackIds.slice(0, 5).map(id => `seeds=${id}`).join('&');
    const url = `https://api.reccobeats.com/v1/track/recommendation?${seedParams}&size=${size}`;

    console.log(`🎵 Calling ReccoBeats API with ${seedTrackIds.length} seed tracks...`);

    const response = await axios.get(url, {
      timeout: 30000 // 30 second timeout
    });

    if (response.data && response.data.tracks) {
      console.log(`✓ ReccoBeats returned ${response.data.tracks.length} recommendations`);
      return response.data.tracks;
    } else if (response.data && Array.isArray(response.data)) {
      console.log(`✓ ReccoBeats returned ${response.data.length} recommendations`);
      return response.data;
    }

    console.log('ReccoBeats response format:', typeof response.data, Object.keys(response.data || {}));
    return [];
  } catch (error) {
    console.error('ReccoBeats API error:', error.response?.status, error.response?.data || error.message);
    return [];
  }
}

// Genre family keywords used to validate Spotify artist genres against a requested genre.
// If NONE of an artist's Spotify genres contain any keyword from the family, the artist
// is considered outside that genre and their songs are filtered from the playlist.
const SPOTIFY_GENRE_FAMILIES = {
  'r&b':       ['r&b', 'neo soul', 'alternative r&b', 'contemporary r&b', 'trap soul', 'quiet storm', 'urban contemporary', 'southern soul'],
  'hip hop':   ['hip hop', 'rap', 'trap', 'drill', 'grime', 'boom bap', 'crunk'],
  'pop':       ['pop', 'synth pop', 'electropop', 'teen pop', 'indie pop', 'chamber pop'],
  'rock':      ['rock', 'indie rock', 'alternative rock', 'punk', 'metal', 'grunge', 'emo', 'hardcore'],
  'country':   ['country', 'americana', 'bluegrass', 'honky tonk', 'outlaw country'],
  'jazz':      ['jazz', 'bebop', 'swing', 'bossa nova', 'smooth jazz'],
  'classical': ['classical', 'baroque', 'romantic period', 'contemporary classical'],
  'electronic':['electronic', 'edm', 'house', 'techno', 'trance', 'dubstep', 'drum and bass', 'ambient'],
  'latin':     ['latin', 'reggaeton', 'salsa', 'bachata', 'cumbia', 'corrido'],
  'soul':      ['soul', 'neo soul', 'funk', 'motown', 'r&b'],
  'reggae':    ['reggae', 'dancehall', 'ska'],
  'folk':      ['folk', 'indie folk', 'singer-songwriter', 'americana'],
};

// Session-scoped cache for Spotify artist genre lookups within a single playlist generation.
// Avoids re-fetching the same artist multiple times when many songs share the same artist.
const _spotifyGenreCache = new Map();

// Batch-fetch Spotify artist genres for a list of artist names using client credentials.
// Returns a Map<normalizedArtistName, string[]> of genre arrays.
// Caps at 30 unique artists to stay within reasonable API budget.
async function batchGetSpotifyArtistGenres(artistNames) {
  const unique = [...new Set(artistNames.map(n => n.trim()))].slice(0, 30);
  const result = new Map();
  const toFetch = unique.filter(name => !_spotifyGenreCache.has(name.toLowerCase()));

  if (toFetch.length > 0) {
    let token;
    try { token = await getSpotifyClientToken(); } catch { return result; }

    await Promise.allSettled(toFetch.map(async (name) => {
      try {
        const r = await axios.get('https://api.spotify.com/v1/search', {
          headers: { Authorization: `Bearer ${token}` },
          params: { q: name, type: 'artist', limit: 3 },
          timeout: 8000,
        });
        const artists = r.data?.artists?.items || [];
        const norm = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        // Pick the best match: exact normalized name or highest-popularity artist
        const match = artists.find(a => a.name.toLowerCase().replace(/[^a-z0-9]/g, '') === norm)
          || artists.sort((a, b) => (b.popularity || 0) - (a.popularity || 0))[0];
        const genres = match?.genres || [];
        _spotifyGenreCache.set(name.toLowerCase(), genres);
      } catch {
        _spotifyGenreCache.set(name.toLowerCase(), []);
      }
    }));
  }

  for (const name of unique) {
    result.set(name.toLowerCase(), _spotifyGenreCache.get(name.toLowerCase()) || []);
  }
  return result;
}

// Returns true if the artist's Spotify genres overlap with the requested genre family.
// Returns true (allow) when uncertain — only rejects when there is a CLEAR genre mismatch
// (artist has genres on Spotify but none match the family at all).
function isArtistInGenreFamily(spotifyGenres, requestedGenre) {
  if (!spotifyGenres || spotifyGenres.length === 0) return true; // no data → allow
  const genreLower = (requestedGenre || '').toLowerCase();
  // Find the matching family keywords
  const familyKey = Object.keys(SPOTIFY_GENRE_FAMILIES).find(k => genreLower.includes(k) || k.includes(genreLower));
  if (!familyKey) return true; // unknown genre → allow
  const keywords = SPOTIFY_GENRE_FAMILIES[familyKey];
  return spotifyGenres.some(g => keywords.some(kw => g.toLowerCase().includes(kw)));
}

// Get top tracks for an artist from Spotify (to use as seeds for ReccoBeats)
async function getArtistTopTrackIds(artistName, limit = 3) {
  const token = await getSpotifyClientToken();

  try {
    // First, find the artist
    const artistResponse = await axios.get('https://api.spotify.com/v1/search', {
      headers: { 'Authorization': `Bearer ${token}` },
      params: {
        q: artistName,
        type: 'artist',
        limit: 5 // Get multiple results to find best match
      }
    });

    if (artistResponse.data.artists.items.length === 0) {
      console.log(`Could not find artist: ${artistName}`);
      return { trackIds: [], foundArtist: null, isExactMatch: false };
    }

    // Find the best matching artist
    const requestedNameLower = artistName.toLowerCase().trim();
    let bestMatch = null;
    let isExactMatch = false;

    for (const artist of artistResponse.data.artists.items) {
      const foundNameLower = artist.name.toLowerCase().trim();

      // Check for exact match
      if (foundNameLower === requestedNameLower) {
        bestMatch = artist;
        isExactMatch = true;
        break;
      }

      // Check if one contains the other (e.g., "Pete Bailey" matches "Pete Bailey & Someone")
      if (foundNameLower.includes(requestedNameLower) || requestedNameLower.includes(foundNameLower)) {
        if (!bestMatch) {
          bestMatch = artist;
        }
      }
    }

    // Fall back to first result if no good match found
    if (!bestMatch) {
      bestMatch = artistResponse.data.artists.items[0];
    }

    console.log(`🔍 Searched for "${artistName}" → Found "${bestMatch.name}" (popularity: ${bestMatch.popularity}, exact match: ${isExactMatch})`);

    // If the match is poor (not exact and low popularity), return empty to trigger Claude fallback
    if (!isExactMatch && bestMatch.popularity < 20) {
      console.log(`⚠️ Poor match for "${artistName}" - "${bestMatch.name}" has low popularity (${bestMatch.popularity}), skipping`);
      return { trackIds: [], foundArtist: bestMatch.name, isExactMatch: false };
    }

    // Get artist's top tracks
    const topTracksResponse = await axios.get(`https://api.spotify.com/v1/artists/${bestMatch.id}/top-tracks`, {
      headers: { 'Authorization': `Bearer ${token}` },
      params: { market: 'US' }
    });

    const trackIds = topTracksResponse.data.tracks.slice(0, limit).map(track => track.id);
    console.log(`✓ Got ${trackIds.length} top track IDs for ${bestMatch.name}`);
    return { trackIds, foundArtist: bestMatch.name, isExactMatch };
  } catch (error) {
    console.error(`Failed to get top tracks for ${artistName}:`, error.message);
    return { trackIds: [], foundArtist: null, isExactMatch: false };
  }
}

// Get Spotify artist ID by name (for seeding recommendations)
async function getSpotifyArtistId(artistName) {
  const token = await getSpotifyClientToken();

  try {
    const response = await axios.get('https://api.spotify.com/v1/search', {
      headers: { 'Authorization': `Bearer ${token}` },
      params: {
        q: artistName,
        type: 'artist',
        limit: 1
      }
    });

    if (response.data.artists.items.length > 0) {
      return response.data.artists.items[0].id;
    }
    return null;
  } catch (error) {
    console.error(`Failed to find Spotify artist ID for ${artistName}:`, error.message);
    return null;
  }
}

// Get Spotify track ID by name and artist (for seeding recommendations)
async function getSpotifyTrackId(trackName, artistName) {
  const token = await getSpotifyClientToken();

  try {
    const query = artistName ? `track:${trackName} artist:${artistName}` : trackName;
    const response = await axios.get('https://api.spotify.com/v1/search', {
      headers: { 'Authorization': `Bearer ${token}` },
      params: {
        q: query,
        type: 'track',
        limit: 1
      }
    });

    if (response.data.tracks.items.length > 0) {
      return response.data.tracks.items[0].id;
    }
    return null;
  } catch (error) {
    console.error(`Failed to find Spotify track ID for ${trackName}:`, error.message);
    return null;
  }
}

// Helper function to resolve platform-specific userId from email
async function resolvePlatformUserId(email, platform) {
  try {
    const platformIds = await db.getPlatformUserIds(email);
    if (!platformIds) {
      console.log(`No platform user IDs found for email: ${email}`);
      return null;
    }

    if (platform === 'spotify') {
      return platformIds.spotify_user_id;
    } else if (platform === 'apple' || platform === 'apple_music') {
      return platformIds.apple_music_user_id;
    }

    return null;
  } catch (error) {
    console.error(`Error resolving platform userId for ${email}:`, error);
    return null;
  }
}

// SoundCharts cache — reduces duplicate lookups and prevents 429 rate-limit errors
const soundChartsCache = new Map();
const SOUNDCHARTS_CACHE_TTL = 10 * 60 * 1000; // 10 minutes
let soundChartsLastCallTime = 0;

function getSCCache(key) {
  const entry = soundChartsCache.get(key);
  if (entry && Date.now() - entry.ts < SOUNDCHARTS_CACHE_TTL) return entry.data;
  soundChartsCache.delete(key);
  return undefined; // explicitly undefined so null results can still be cached
}

function setSCCache(key, data) {
  soundChartsCache.set(key, { data, ts: Date.now() });
}

async function throttleSoundCharts() {
  const now = Date.now();
  const elapsed = now - soundChartsLastCallTime;
  if (elapsed < 300) await new Promise(r => setTimeout(r, 300 - elapsed));
  soundChartsLastCallTime = Date.now();
}

// Helper function to search artist on SoundCharts
async function searchSoundChartsArtist(artistName, expectedGenre = null, knownUuid = null) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;

  if (!appId || !apiKey) {
    return null;
  }

  const cacheKey = `search:${artistName.toLowerCase()}`;
  // L1: in-memory cache
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;
  // L2: DB cache (7-day TTL, survives restarts)
  const dbCached = await db.getCachedSC(cacheKey);
  if (dbCached !== undefined) { setSCCache(cacheKey, dbCached); return dbCached; }

  try {
    await throttleSoundCharts();
    const response = await axios.get(
      `https://customer.api.soundcharts.com/api/v2/artist/search/${encodeURIComponent(artistName)}`,
      {
        headers: {
          'x-app-id': appId,
          'x-api-key': apiKey
        },
        params: { offset: 0, limit: 10 },
        timeout: 10000
      }
    );

    if (response.data?.items?.length > 0) {
      // If we already know the SC UUID (from a similarity graph reference), use it to pick
      // the right artist directly — avoids name-collision bugs like wrong "Dante" (Spanish rap
      // vs R&B) when the search returns multiple artists with the same name.
      if (knownUuid) {
        const uuidMatch = response.data.items.find(a => a.uuid === knownUuid);
        if (uuidMatch) {
          console.log(`🔍 SoundCharts: "${uuidMatch.name}" matched by UUID (${knownUuid.slice(0, 8)}...)`);
          setSCCache(cacheKey, uuidMatch); db.setCachedSC(cacheKey, uuidMatch);
          return uuidMatch;
        }
        // UUID not in first-page results — fall through to normal disambiguation
        console.log(`⚠️  SoundCharts: known UUID ${knownUuid.slice(0, 8)}... not in search results for "${artistName}" — falling back to name match`);
      }

      // Collect all exact name matches (case-insensitive)
      const exactMatches = response.data.items.filter(a =>
        a.name.toLowerCase() === artistName.toLowerCase()
      );
      const candidates = exactMatches.length > 0 ? exactMatches : response.data.items;

      // For short search terms with no exact match, filter out candidates whose names are
      // much longer — e.g. "IVE" should not match "Iveta Bartošová" (len 3 vs 15).
      // A legitimate match for a short term should have a similarly short name.
      let viableCandidates = candidates;
      if (exactMatches.length === 0) {
        const searchNorm = artistName.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (searchNorm.length <= 6) {
          const maxLen = searchNorm.length * 2 + 3; // e.g. "ive"(3) → max 9 chars
          const shortCandidates = candidates.filter(a => {
            const norm = a.name.toLowerCase().replace(/[^a-z0-9]/g, '');
            return norm.length <= maxLen;
          });
          if (shortCandidates.length > 0) {
            viableCandidates = shortCandidates;
          } else {
            // No candidate is close in length — likely all wrong
            console.log(`🔍 SoundCharts: "${artistName}" — no close-length match (${candidates.length} candidates all too long) — skipping`);
            setSCCache(cacheKey, null); db.setCachedSC(cacheKey, null);
            return null;
          }
        }
      }

      // If only one viable candidate, return it directly
      if (viableCandidates.length === 1) {
        console.log(`🔍 SoundCharts: "${viableCandidates[0].name}" matched (genres: ${(viableCandidates[0].genres || []).map(g => g.root).join(', ') || 'unknown'})`);
        setSCCache(cacheKey, viableCandidates[0]); db.setCachedSC(cacheKey, viableCandidates[0]);
        return viableCandidates[0];
      }

      // Multiple candidates with same name — disambiguate by genre if we know the expected genre
      if (expectedGenre) {
        const genreLower = expectedGenre.toLowerCase();
        const genreRanked = viableCandidates.map(a => {
          const artistGenres = (a.genres || []).map(g => (g.root || '').toLowerCase());
          const artistSubgenres = (a.genres || []).flatMap(g => (g.sub || []).map(s => s.toLowerCase()));
          const allGenres = [...artistGenres, ...artistSubgenres];
          const score = allGenres.reduce((acc, g) => {
            if (g.includes(genreLower) || genreLower.includes(g)) return acc + 2;
            if (g.replace(/[-\s]/g, '').includes(genreLower.replace(/[-\s]/g, ''))) return acc + 1;
            return acc;
          }, 0);
          return { artist: a, score };
        }).sort((a, b) => b.score - a.score);

        // If no candidate matched the genre, guard against wrong-name matches
        // (e.g. searching "Shé" returning "She & Him" because all scores are 0)
        if (genreRanked[0].score === 0) {
          const searchNorm = artistName.toLowerCase().replace(/[^a-z0-9]/g, '');
          const bestNorm = genreRanked[0].artist.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          if (Math.abs(bestNorm.length - searchNorm.length) > 3) {
            console.log(`🔍 SoundCharts: "${artistName}" — no genre/name match among ${viableCandidates.length} results — skipping`);
            setSCCache(cacheKey, null); db.setCachedSC(cacheKey, null);
            return null;
          }
        }

        const best = genreRanked[0].artist;
        console.log(`🔍 SoundCharts: "${best.name}" selected from ${viableCandidates.length} matches by genre (${expectedGenre}); genres: ${(best.genres || []).map(g => g.root).join(', ') || 'unknown'}`);
        setSCCache(cacheKey, best); db.setCachedSC(cacheKey, best);
        return best;
      }

      // No genre hint — return first viable result (SoundCharts sorts by relevance)
      console.log(`🔍 SoundCharts: "${viableCandidates[0].name}" matched (first of ${viableCandidates.length}; no genre hint)`);
      setSCCache(cacheKey, viableCandidates[0]); db.setCachedSC(cacheKey, viableCandidates[0]);
      return viableCandidates[0];
    }
    setSCCache(cacheKey, null); db.setCachedSC(cacheKey, null);
    return null;
  } catch (error) {
    console.log(`⚠️  SoundCharts search error for "${artistName}": ${error.message}`);
    return null;
  }
}

// Helper function to get similar artists from SoundCharts
async function getSoundChartsSimilarArtists(artistUuid, limit = 10) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;

  if (!appId || !apiKey) {
    return [];
  }

  const cacheKey = `similar:${artistUuid}:${limit}`;
  // L1: in-memory cache
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;
  // L2: DB cache (7-day TTL)
  const dbCached = await db.getCachedSC(cacheKey);
  if (dbCached !== undefined) { setSCCache(cacheKey, dbCached); return dbCached; }

  try {
    await throttleSoundCharts();
    const response = await axios.get(
      `https://customer.api.soundcharts.com/api/v2/artist/${artistUuid}/related`,
      {
        headers: {
          'x-app-id': appId,
          'x-api-key': apiKey
        },
        params: { offset: 0, limit },
        timeout: 10000
      }
    );

    if (response.data?.items?.length > 0) {
      const result = response.data.items.map(a => ({
        name: a.name,
        uuid: a.uuid,
        slug: a.slug
      }));
      setSCCache(cacheKey, result); db.setCachedSC(cacheKey, result);
      return result;
    }
    setSCCache(cacheKey, []); db.setCachedSC(cacheKey, []);
    return [];
  } catch (error) {
    console.log(`⚠️  SoundCharts similar artists error: ${error.message}`);
    return [];
  }
}

// Helper function to get artist info including genres and similar artists from SoundCharts
async function getSoundChartsArtistInfo(artistName, expectedGenre = null, knownUuid = null) {
  const artist = await searchSoundChartsArtist(artistName, expectedGenre, knownUuid);
  if (!artist) {
    console.log(`🔍 SoundCharts: "${artistName}" not found`);
    return null;
  }

  console.log(`🔍 SoundCharts: Found "${artist.name}" (${artist.careerStage || 'unknown stage'})`);

  // Extract genres
  const genres = artist.genres?.map(g => g.root) || [];
  const subgenres = artist.genres?.flatMap(g => g.sub || []) || [];

  // Get similar artists — preserve UUIDs so pool builder can pass them as hints
  // when looking up each similar artist, preventing name-collision bugs (e.g. two "Dante"s)
  const similarArtists = await getSoundChartsSimilarArtists(artist.uuid, 10);

  const result = {
    name: artist.name,
    uuid: artist.uuid,
    genres: [...new Set([...genres, ...subgenres])],
    similarArtists: similarArtists.map(a => a.name),
    // Map of lowercased name → SC UUID for all similar artists
    _similarUuids: Object.fromEntries(similarArtists.map(a => [a.name.toLowerCase(), a.uuid])),
    careerStage: artist.careerStage // long_tail, developing, mainstream, superstar
  };

  if (result.genres.length > 0) {
    console.log(`   Genres: ${result.genres.join(', ')}`);
  }
  if (result.similarArtists.length > 0) {
    console.log(`   Similar artists: ${result.similarArtists.slice(0, 5).join(', ')}${result.similarArtists.length > 5 ? '...' : ''}`);
  }

  return result;
}

// Helper function to get songs from an artist on SoundCharts
async function getSoundChartsArtistSongs(artistUuid, limit = 20) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;

  if (!appId || !apiKey) {
    return [];
  }

  const cacheKey = `songs:${artistUuid}:${limit}`;
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;

  try {
    await throttleSoundCharts();
    const response = await axios.get(
      `https://customer.api.soundcharts.com/api/v2/artist/${artistUuid}/songs`,
      {
        headers: {
          'x-app-id': appId,
          'x-api-key': apiKey
        },
        params: { offset: 0, limit },
        timeout: 10000
      }
    );

    if (response.data?.items?.length > 0) {
      const result = response.data.items.map(song => ({
        uuid: song.uuid,
        name: song.name,
        releaseDate: song.releaseDate,
        isrc: song.isrc?.value || song.isrc || null
      }));
      setSCCache(cacheKey, result);
      return result;
    }
    setSCCache(cacheKey, []);
    return [];
  } catch (error) {
    console.log(`⚠️  SoundCharts artist songs error: ${error.message}`);
    return [];
  }
}

// ── Full artist catalog cache ─────────────────────────────────────���───────────────────────────
// Fetches ALL songs for an artist (not just top 10), caches in DB, and uses a freshness check
// (1-song fetch) to detect new releases and trigger a repull automatically.

async function getArtistFullCatalogFromSC(artistUuid, artistName, genre = null) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) return [];

  // Step 1: Check DB cache — skip freshness check if cached within last 24h
  const catalogKey = `full_catalog:${artistUuid}`;
  const cached = await db.getCachedSC(catalogKey);
  if (cached?.songs?.length > 0) {
    const cachedAt = cached.cachedAt ? new Date(cached.cachedAt).getTime() : 0;
    const ageHours = (Date.now() - cachedAt) / 3600000;
    if (ageHours < 24) {
      console.log(`📦 [CATALOG] Cache hit for "${artistName}" (${cached.songs.length} songs, ${Math.round(ageHours)}h old — skipping freshness check)`);
      return cached.songs;
    }
    // Cache is stale (>24h) — check for new releases before using it
    let latestSongUuid = null;
    try {
      await throttleSoundCharts();
      const latestResp = await axios.get(
        `https://customer.api.soundcharts.com/api/v2/artist/${artistUuid}/songs`,
        { headers: { 'x-app-id': appId, 'x-api-key': apiKey }, params: { offset: 0, limit: 1 }, timeout: 5000 }
      );
      latestSongUuid = latestResp.data?.items?.[0]?.uuid || null;
    } catch (e) {
      console.log(`⚠️  [CATALOG] Freshness check failed for "${artistName}": ${e.message}`);
    }
    // Check if the latest song already exists in artist_songs — more reliable than comparing stored UUID field
    const alreadyStored = latestSongUuid ? await db.artistSongExists(artistUuid, latestSongUuid) : false;
    if (!latestSongUuid || alreadyStored) {
      // No new music — bump cachedAt so we skip the freshness check for another 24h
      db.setCachedSC(catalogKey, { ...cached, cachedAt: new Date().toISOString() });
      console.log(`📦 [CATALOG] Cache hit for "${artistName}" (${cached.songs.length} songs, no new releases)`);
      return cached.songs;
    }
    console.log(`🔄 [CATALOG] New release detected for "${artistName}" — repulling full catalog`);
  }

  // Step 3: Paginate through all songs (100 per page, cap at 500)
  const allSongs = [];
  let offset = 0;
  const pageSize = 100;

  while (true) {
    try {
      await throttleSoundCharts();
      const resp = await axios.get(
        `https://customer.api.soundcharts.com/api/v2/artist/${artistUuid}/songs`,
        {
          headers: { 'x-app-id': appId, 'x-api-key': apiKey },
          params: { offset, limit: pageSize },
          timeout: 15000
        }
      );
      const items = resp.data?.items || [];
      for (const song of items) {
        allSongs.push({
          uuid: song.uuid,
          name: song.name,
          releaseDate: song.releaseDate,
          isrc: song.isrc?.value || song.isrc || null,
        });
      }
      if (items.length < pageSize || allSongs.length >= 500) break;
      offset += pageSize;
    } catch (e) {
      console.log(`⚠️  [CATALOG] Page fetch error for "${artistName}" at offset ${offset}: ${e.message}`);
      break;
    }
  }

  console.log(`📡 [CATALOG] Fetched ${allSongs.length} songs for "${artistName}"`);

  if (allSongs.length > 0) {
    // Use first song from full fetch as the authoritative latest (same sort order as freshness check)
    const freshLatestSongUuid = allSongs[0]?.uuid || latestSongUuid;
    db.setCachedSC(catalogKey, { songs: allSongs, latestSongUuid: freshLatestSongUuid, cachedAt: new Date().toISOString() });
    // Also write to structured tables for SQL queryability (incremental — only new songs)
    db.upsertArtistCatalog(artistUuid, artistName, allSongs, freshLatestSongUuid, genre).catch(e => {
      console.log(`⚠️  [CATALOG] Structured write failed for "${artistName}": ${e.message}`);
    });
  }

  return allSongs;
}

// Enrich up to maxSongs from a catalog with SC audio features (energy, valence, etc.)
// Also fetches SC lyrics-analysis moods (Melancholic, Joyful, etc.) for mood conflict detection.
// Each song's details are cached individually so repeat calls are instant.
async function enrichCatalogWithAudioFeatures(songs, maxSongs = 40) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) return songs;

  const ENRICH_BATCH = 5; // parallel SC detail calls per batch
  const enriched = new Map(); // uuid → { audio, moods, themes }
  let fetchCount = 0;

  // Pass 1: serve from cache (instant)
  const needsFetch = [];
  for (const song of songs) {
    if (!song.uuid) continue;
    const cached = await db.getCachedSC(`song_detail:${song.uuid}`);
    // Treat empty audio as stale — entries cached before the enrichment fix had audio: {}
    if (cached?.audio && Object.keys(cached.audio).length > 0) {
      enriched.set(song.uuid, { audio: cached.audio, moods: cached.moods || [], themes: cached.themes || [] });
    } else {
      needsFetch.push(song);
    }
  }

  // Pass 2: fetch uncached songs in parallel batches with inter-batch throttle
  for (let i = 0; i < needsFetch.length && fetchCount < maxSongs; i += ENRICH_BATCH) {
    const batch = needsFetch.slice(i, Math.min(i + ENRICH_BATCH, i + (maxSongs - fetchCount)));
    if (batch.length === 0) break;
    if (i > 0) await new Promise(r => setTimeout(r, 150)); // throttle between batches

    const results = await Promise.allSettled(
      batch.map(song =>
        axios.get(`https://customer.api.soundcharts.com/api/v2.25/song/${song.uuid}`, {
          headers: { 'x-app-id': appId, 'x-api-key': apiKey },
          timeout: 8000,
        }).then(resp => ({ uuid: song.uuid, object: resp.data?.object }))
      )
    );

    for (const r of results) {
      if (r.status === 'fulfilled' && r.value.object) {
        const s = r.value.object;
        const detail = { audio: s.audio || {}, moods: s.moods || [], themes: s.themes || [] };
        db.setCachedSC(`song_detail:${r.value.uuid}`, detail);
        enriched.set(r.value.uuid, detail);
        if (Object.keys(detail.audio).length > 0) fetchCount++;
      }
      // On failure: song stays unenriched (returned as-is below)
    }
  }

  if (fetchCount > 0) {
    console.log(`🎵 [CATALOG] Enriched ${fetchCount} songs with audio features + moods`);
  }

  // Return songs in original order with enrichment applied where available
  return songs.map(song =>
    song.uuid && enriched.has(song.uuid) ? { ...song, ...enriched.get(song.uuid) } : song
  );
}

// Filter catalog songs by energy/valence from SC query filters.
// Songs with matching audio features are preferred; songs without features are used as fallback.
function filterCatalogByVibe(songs, soundchartsFilters, targetCount) {
  const energyFilter = soundchartsFilters?.find(f => f.type === 'energy')?.data;
  const valenceFilter = soundchartsFilters?.find(f => f.type === 'valence')?.data;
  const moodsFilter = soundchartsFilters?.find(f => f.type === 'moods')?.data;
  const requiredMoods = moodsFilter?.values || [];

  // SC mood groups for conflict detection: if playlist requires sad moods, Joyful/Euphoric/etc. conflict
  const UPBEAT_MOODS = new Set(['Joyful', 'Euphoric', 'Happy', 'Playful', 'Energetic', 'Empowering']);
  const SAD_MOODS = new Set(['Sad', 'Melancholic', 'Dark']);
  const hasUpbeatRequired = requiredMoods.some(m => UPBEAT_MOODS.has(m));
  const hasSadRequired = requiredMoods.some(m => SAD_MOODS.has(m));

  function isMoodConflict(songMoods) {
    if (!songMoods || songMoods.length === 0) return false;
    if (hasSadRequired && songMoods.some(m => UPBEAT_MOODS.has(m))) return true;
    if (hasUpbeatRequired && songMoods.some(m => SAD_MOODS.has(m))) return true;
    return false;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
  }

  if (!energyFilter && !valenceFilter) {
    const good = [];
    const bad = [];
    for (const song of songs) {
      (isMoodConflict(song.moods) ? bad : good).push(song);
    }
    shuffle(good);
    shuffle(bad);
    if (bad.length > 0) {
      console.log(`🎭 [MOOD-FILTER] no audio filters — ${good.length} OK / ${bad.length} mood-conflict songs deprioritized`);
    }
    return [...good, ...bad].slice(0, targetCount);
  }

  const matched = [];
  const unmatched = [];
  const conflicting = [];

  for (const song of songs) {
    const e = song.audio?.energy;
    const v = song.audio?.valence;
    const hasFeatures = e !== undefined && e !== null;
    const moodConflict = isMoodConflict(song.moods);

    if (!hasFeatures) {
      (moodConflict ? conflicting : unmatched).push(song);
      continue;
    }

    let passes = true;
    if (energyFilter) {
      if (energyFilter.min !== undefined && e < energyFilter.min) passes = false;
      if (energyFilter.max !== undefined && e > energyFilter.max) passes = false;
    }
    if (valenceFilter && passes) {
      if (valenceFilter.min !== undefined && v !== undefined && v < valenceFilter.min) passes = false;
      if (valenceFilter.max !== undefined && v !== undefined && v > valenceFilter.max) passes = false;
    }

    if (passes) matched.push(song);
    else if (moodConflict) conflicting.push(song);
    else unmatched.push(song);
  }

  console.log(`🎛️  [VIBE] ${matched.length} matched / ${unmatched.length} no-features / ${conflicting.length} mood-conflict (energy: ${JSON.stringify(energyFilter)}, valence: ${JSON.stringify(valenceFilter)})`);

  for (const arr of [matched, unmatched, conflicting]) {
    shuffle(arr);
  }

  return [...matched, ...unmatched, ...conflicting].slice(0, targetCount);
}
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Helper function to search for a specific song on SoundCharts by title + artist
// Returns the matching song's artist UUID directly — no ambiguity from artist name search
// Helper: get artist info when UUID is already known (skips the name-search step entirely)
async function getSoundChartsArtistInfoByUuid(uuid, displayName) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;

  const similarArtists = await getSoundChartsSimilarArtists(uuid, 10);
  console.log(`🔍 SoundCharts: Using confirmed UUID for "${displayName}"`);
  if (similarArtists.length > 0) {
    console.log(`   Similar artists: ${similarArtists.slice(0, 5).map(a => a.name).join(', ')}${similarArtists.length > 5 ? '...' : ''}`);
  }

  // Also fetch genres and careerStage by searching by name and matching our confirmed UUID.
  // This ensures genre inference works correctly even when UUID bypass was used.
  let genres = [];
  let careerStage = null;
  try {
    const cacheKey = `searchall:${displayName.toLowerCase()}`;
    let items = getSCCache(cacheKey);
    if (items === undefined) {
      await throttleSoundCharts();
      const resp = await axios.get(
        `https://customer.api.soundcharts.com/api/v2/artist/search/${encodeURIComponent(displayName)}`,
        { headers: { 'x-app-id': appId, 'x-api-key': apiKey }, params: { offset: 0, limit: 10 }, timeout: 10000 }
      );
      items = resp.data?.items || [];
      setSCCache(cacheKey, items);
    }
    const match = items.find(a => a.uuid === uuid);
    if (match) {
      genres = [...new Set([
        ...(match.genres?.map(g => g.root) || []),
        ...(match.genres?.flatMap(g => g.sub || []) || [])
      ])];
      careerStage = match.careerStage || null;
      if (genres.length > 0) console.log(`   Genres: ${genres.join(', ')}`);
    }
  } catch (e) {
    // Non-fatal — genres stay empty, genre inference falls back gracefully
  }

  return {
    name: displayName,
    uuid,
    genres,
    careerStage,
    similarArtists: similarArtists.map(a => a.name)
  };
}

async function searchSoundChartsSong(title, artist, preferredGenres = null, spotifyIsrc = null, appSpotify = null, confirmedSpotifyArtistId = null) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) return null;

  const cacheKey = `songsearch:${title.toLowerCase()}:${artist.toLowerCase()}`;
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;

  // Fastest path: if we have the Spotify ISRC, look up the song directly in SC by ISRC.
  // This bypasses name-search ambiguity entirely (e.g. multiple "Dante" artists in SC where
  // by-platform Spotify-ID lookup can return a wrong same-name artist with an incorrect link).
  if (spotifyIsrc && appId && apiKey) {
    try {
      await throttleSoundCharts();
      const isrcDirectResp = await axios.get(
        `https://customer.api.soundcharts.com/api/v2/song/by-isrc/${encodeURIComponent(spotifyIsrc)}`,
        { headers: { 'x-app-id': appId, 'x-api-key': apiKey }, timeout: 10000 }
      );
      const isrcSong = isrcDirectResp.data?.object || isrcDirectResp.data?.song;
      if (isrcSong?.uuid) {
        const artistUuid = isrcSong.artists?.[0]?.uuid || null;
        const artistName = isrcSong.artists?.[0]?.name || isrcSong.creditName;
        // When we have a confirmed Spotify artist ID, verify that the SC artist returned by
        // ISRC lookup actually corresponds to that artist — SC's ISRC→artist links can be
        // wrong (e.g. ISRC US3DF2602370 maps to electronic Keffer, not R&B Keffer).
        if (confirmedSpotifyArtistId && artistUuid) {
          try {
            const scSpotifyId = await getSoundChartsArtistPlatformId(artistUuid, 'spotify');
            if (!scSpotifyId) {
              console.log(`⚠️  SC ISRC lookup: "${artistName}" (${artistUuid}) has no Spotify link in SC — cannot verify against expected ${confirmedSpotifyArtistId}, falling through to by-platform`);
              // Don't return — fall through to by-platform / name-search
            } else if (scSpotifyId !== confirmedSpotifyArtistId) {
              console.log(`⚠️  SC ISRC lookup: "${artistName}" (${artistUuid}) Spotify ID ${scSpotifyId} ≠ expected ${confirmedSpotifyArtistId} — SC ISRC data mismatch, falling through to by-platform`);
              // Don't return — fall through to by-platform / name-search
            } else {
              console.log(`✓ SoundCharts ISRC direct lookup: "${isrcSong.name}" by ${artistName} (ISRC: ${spotifyIsrc}) → artist UUID ${artistUuid} [Spotify ID verified]`);
              const result = { songUuid: isrcSong.uuid, artistUuid, artistName, _confirmedStrong: true };
              setSCCache(cacheKey, result);
              return result;
            }
          } catch (_) {
            // Verification call failed — when we have a confirmedSpotifyArtistId we can't
            // trust an unverified ISRC result (SC ISRC→artist links can be wrong).
            // Fall through to by-platform / name-search instead.
            console.log(`⚠️  SC ISRC lookup: "${artistName}" (${artistUuid}) Spotify ID verification failed — falling through to by-platform`);
          }
        } else {
          console.log(`✓ SoundCharts ISRC direct lookup: "${isrcSong.name}" by ${artistName} (ISRC: ${spotifyIsrc}) → artist UUID ${artistUuid}`);
          const result = { songUuid: isrcSong.uuid, artistUuid, artistName, _confirmedStrong: true };
          setSCCache(cacheKey, result);
          return result;
        }
      }
    } catch (isrcDirectErr) {
      if (isrcDirectErr?.response?.status !== 404) {
        console.log(`🔍 SC ISRC direct lookup failed for ${spotifyIsrc}: ${isrcDirectErr.message}`);
      }
    }
  }

  try {
    await throttleSoundCharts();
    const response = await axios.get(
      `https://customer.api.soundcharts.com/api/v2/song/search/${encodeURIComponent(title)}`,
      {
        headers: { 'x-app-id': appId, 'x-api-key': apiKey },
        params: { offset: 0, limit: 10 },
        timeout: 10000
      }
    );

    const artistNorm = artist.toLowerCase().replace(/[^a-z0-9]/g, '');
    const findArtistMatch = (items) => items.find(song => {
      const creditNorm = (song.creditName || '').toLowerCase().replace(/[^a-z0-9]/g, '');
      const artistsNorm = (song.artists || []).map(a => a.name.toLowerCase().replace(/[^a-z0-9]/g, ''));
      return creditNorm === artistNorm || artistsNorm.some(n => n === artistNorm || n.startsWith(artistNorm) || artistNorm.startsWith(n));
    });

    // If we have a Spotify ISRC, try exact ISRC match first — works across name ambiguity
    if (spotifyIsrc) {
      // SC may store ISRC in multiple field shapes — check all known variants
      const extractScIsrc = (s) => s.isrc?.value || s.isrc || s.isrcs?.[0]?.value || s.isrcs?.[0] || null;
      const isrcMatch = (response.data?.items || []).find(s => extractScIsrc(s) === spotifyIsrc);
      if (isrcMatch) {
        const artistUuid = isrcMatch.artists?.[0]?.uuid || null;
        const artistName = isrcMatch.artists?.[0]?.name || isrcMatch.creditName;
        console.log(`✓ SoundCharts ISRC match: "${isrcMatch.name}" by ${artistName} (ISRC: ${spotifyIsrc}) → UUID ${artistUuid}`);
        const result = { songUuid: isrcMatch.uuid, artistUuid, artistName, _confirmedStrong: true };
        setSCCache(cacheKey, result);
        return result;
      }
    }

    let match = findArtistMatch(response.data?.items || []);

    // If no match and title has apostrophes/special chars, retry with normalized title
    if (!match) {
      const normalizedTitle = title.replace(/[''`]/g, '').replace(/\s+/g, ' ').trim();
      if (normalizedTitle !== title) {
        console.log(`🔍 SoundCharts song search: retrying "${title}" as "${normalizedTitle}"...`);
        await throttleSoundCharts();
        const retryResponse = await axios.get(
          `https://customer.api.soundcharts.com/api/v2/song/search/${encodeURIComponent(normalizedTitle)}`,
          {
            headers: { 'x-app-id': appId, 'x-api-key': apiKey },
            params: { offset: 0, limit: 20 },
            timeout: 10000
          }
        );
        match = findArtistMatch(retryResponse.data?.items || []);
      }
    }

    if (match) {
      // The song search endpoint returns abbreviated items — the ISRC field is typically absent
      // even when the song has one (e.g. Marvin's Room USCM51100267 is in SC's DB but not in
      // search results). Fetch the full song detail to get the authoritative ISRC for comparison.
      let matchIsrc = match.isrc?.value || match.isrc || match.isrcs?.[0]?.value || match.isrcs?.[0] || null;
      let detailSong = null;
      // SC song search returns abbreviated items — fetch full detail to get ISRC and artist UUID
      // (both fields are absent from search results but present in the detail endpoint).
      if ((!matchIsrc || !match.artists?.[0]?.uuid) && match.uuid) {
        try {
          await throttleSoundCharts();
          const detailResp = await axios.get(
            `https://customer.api.soundcharts.com/api/v2/song/${match.uuid}`,
            { headers: { 'x-app-id': appId, 'x-api-key': apiKey }, timeout: 8000 }
          );
          detailSong = detailResp.data?.object || detailResp.data;
          if (!matchIsrc) {
            matchIsrc = detailSong?.isrc?.value || detailSong?.isrc || null;
            if (matchIsrc) console.log(`🔍 SoundCharts song detail ISRC for "${match.name}": ${matchIsrc}`);
          }
        } catch (_) { /* detail fetch failed — proceed without it */ }
      }
      const isrcConflict = spotifyIsrc && matchIsrc && matchIsrc !== spotifyIsrc;
      if (isrcConflict) {
        console.log(`⚠️  SoundCharts title match for "${title}" by "${match.artists?.[0]?.name || match.creditName}" ISRC ${matchIsrc} conflicts with Spotify ISRC ${spotifyIsrc} — falling through to artist-candidate fallback`);
        match = null; // fall through to artist-candidate fallback below
      } else {
        // Prefer UUID/name from detail (more complete) over abbreviated search result
        const artistUuid = match.artists?.[0]?.uuid || detailSong?.artists?.[0]?.uuid || null;
        const artistName = match.artists?.[0]?.name || detailSong?.artists?.[0]?.name || match.creditName;
        console.log(`🔍 SoundCharts song search: "${match.name}" by ${artistName} → artist UUID ${artistUuid}${matchIsrc ? ` (ISRC: ${matchIsrc})` : ''}`);
        // Strong if both ISRCs exist and match — confirms this is the right song/artist beyond title similarity
        const _confirmedStrong = !!(spotifyIsrc && matchIsrc && matchIsrc === spotifyIsrc);
        const result = { songUuid: match.uuid, artistUuid, artistName, _confirmedStrong };
        setSCCache(cacheKey, result);
        return result;
      }
    }

    // Log what artists were returned to help diagnose misses
    const returnedArtists = (response.data?.items || []).map(s => s.artists?.[0]?.name || s.creditName || '?').join(', ');
    console.log(`🔍 SoundCharts song search: no title match for "${title}" by "${artist}". Artists in results: [${returnedArtists}]`);

    // Fallback: search artist candidates by name, then check each one's songs for the reference title
    // This handles cases where song-title search doesn't credit the right artist (features, compilations, etc.)
    console.log(`🔍 SoundCharts song search: trying artist-candidate fallback for "${artist}"...`);

    // Direct SC lookup by Spotify artist ID — O(1), bypasses name-search ambiguity entirely.
    // When we have a confirmed Spotify artist ID, ask SC directly for the matching artist profile
    // instead of searching by name and iterating candidates (which misses low-popularity profiles).
    if (confirmedSpotifyArtistId && appId && apiKey) {
      try {
        await throttleSoundCharts();
        const byPlatformResp = await axios.get(
          `https://customer.api.soundcharts.com/api/v2/artist/by-platform/spotify/${confirmedSpotifyArtistId}`,
          { headers: { 'x-app-id': appId, 'x-api-key': apiKey }, timeout: 10000 }
        );
        const scArtist = byPlatformResp.data?.object || byPlatformResp.data?.artist || byPlatformResp.data;
        if (scArtist?.uuid) {
          // Cross-verify: SC's by-platform mapping can be wrong (e.g. Dante's Spotify ID
          // returned Latin Dante). Confirm by checking the returned artist's Spotify link
          // maps back to the same ID we queried with.
          const scSpotifyId = await getSoundChartsArtistPlatformId(scArtist.uuid, 'spotify').catch(() => null);
          if (!scSpotifyId) {
            console.log(`⚠️  SC by-platform: "${scArtist.name}" (${scArtist.uuid}) has no Spotify link in SC — cannot verify against expected ${confirmedSpotifyArtistId}, falling through to name search`);
            // fall through to name search
          } else if (scSpotifyId !== confirmedSpotifyArtistId) {
            console.log(`⚠️  SC by-platform: "${scArtist.name}" (${scArtist.uuid}) Spotify ID ${scSpotifyId} ≠ expected ${confirmedSpotifyArtistId} — SC mapping wrong, falling through to name search`);
            // fall through to name search
          } else {
            console.log(`✓ SoundCharts direct Spotify-ID lookup: "${scArtist.name}" → UUID ${scArtist.uuid} [verified]`);
            const songs = await getSoundChartsArtistSongs(scArtist.uuid, 5);
            const result = { songUuid: songs[0]?.uuid || null, artistUuid: scArtist.uuid, artistName: scArtist.name, _confirmedStrong: true };
            setSCCache(cacheKey, result);
            return result;
          }
        }
      } catch (platformErr) {
        // 404 = SC doesn't have this Spotify artist — fall through to name search
        if (platformErr?.response?.status !== 404) {
          console.log(`🔍 SC by-platform lookup failed for ${confirmedSpotifyArtistId}: ${platformErr.message}`);
        }
      }
    }

    try {
      // Fetch up to 25 candidates — SC sorts by popularity so the right artist for a less-mainstream
      // act (e.g. R&B "Dante") can be buried below more-popular same-name artists (e.g. Russian pop
      // "Dante"). When we have a confirmed Spotify artist ID, paginate a second page if needed.
      const FALLBACK_LIMIT = 25;
      const artistSearchResp = await axios.get(
        `https://customer.api.soundcharts.com/api/v2/artist/search/${encodeURIComponent(artist)}`,
        {
          headers: { 'x-app-id': appId, 'x-api-key': apiKey },
          params: { offset: 0, limit: FALLBACK_LIMIT },
          timeout: 10000
        }
      );
      let allItems = artistSearchResp.data?.items || [];
      // If we have a confirmed Spotify ID and still haven't found a matching profile, fetch page 2
      // before falling through to lower-confidence matching strategies.
      if (confirmedSpotifyArtistId && allItems.length === FALLBACK_LIMIT) {
        try {
          await throttleSoundCharts();
          const page2 = await axios.get(
            `https://customer.api.soundcharts.com/api/v2/artist/search/${encodeURIComponent(artist)}`,
            { headers: { 'x-app-id': appId, 'x-api-key': apiKey }, params: { offset: FALLBACK_LIMIT, limit: FALLBACK_LIMIT }, timeout: 10000 }
          );
          allItems = allItems.concat(page2.data?.items || []);
        } catch (_) { /* page 2 optional */ }
      }
      const candidates = allItems.filter(
        a => a.name.toLowerCase() === artist.toLowerCase()
      );
      const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      const prefNorms = (preferredGenres || []).map(g => g.toLowerCase());

      // Priority -1: Spotify artist ID match at the artist profile level — strongest signal.
      // When multiple SC artists share a name (e.g. R&B "Keffer" vs electronic "Keffer"),
      // check which SC artist profile has a Spotify link matching our confirmed Spotify artist ID.
      // This works even when the reference song isn't in the SC artist's top-50 songs.
      if (confirmedSpotifyArtistId) {
        for (const candidate of candidates) {
          try {
            const scSpotifyArtistId = await getSoundChartsArtistPlatformId(candidate.uuid, 'spotify');
            if (scSpotifyArtistId && scSpotifyArtistId === confirmedSpotifyArtistId) {
              console.log(`✓ SoundCharts artist-fallback: Spotify artist ID match at profile level → "${candidate.name}" (${confirmedSpotifyArtistId}) — UUID ${candidate.uuid}`);
              // Grab any song from this artist for the songUuid (used for Spotify QA downstream)
              const songs = await getSoundChartsArtistSongs(candidate.uuid, 5);
              const result = { songUuid: songs[0]?.uuid || null, artistUuid: candidate.uuid, artistName: candidate.name, _confirmedStrong: true };
              setSCCache(cacheKey, result);
              return result;
            }
          } catch (e) { /* fall through */ }
        }
      }

      // Collect ALL candidates that have a matching song, then prefer the one
      // whose SC genres overlap with the caller's genre hint (e.g. "trap soul")
      // so we don't grab a genre-homonymous artist (e.g. an electro "Keffer"
      // instead of the R&B "Keffer") just because it appears first in results.
      const songMatches = []; // { candidate, songMatch, genres }
      for (const candidate of candidates) {
        await throttleSoundCharts();
        const songs = await getSoundChartsArtistSongs(candidate.uuid, 50);
        const songMatch = songs.find(s => {
          const sNorm = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          // Guard: empty sNorm means non-Latin title (e.g. Cyrillic) — titleNorm.startsWith("") is
          // always true, so skip these to avoid falsely matching wrong-language songs.
          if (!sNorm) return false;
          return sNorm === titleNorm || sNorm.startsWith(titleNorm) || titleNorm.startsWith(sNorm);
        });
        if (songMatch) {
          const artistInfo = await getSoundChartsArtistInfoByUuid(candidate.uuid, candidate.name).catch(() => null);
          const genres = (artistInfo?.genres || []).map(g => g.toLowerCase());
          const songIsrc = songMatch.isrc?.value || songMatch.isrc || null;
          songMatches.push({ candidate, songMatch, genres, songIsrc });
        }
      }

      if (songMatches.length > 0) {
        // Priority 0: Spotify artist ID match — strongest signal when multiple SC artists share a name.
        // For each candidate's song, look up its Spotify track via SC identifiers and compare artist IDs.
        if (appSpotify && confirmedSpotifyArtistId) {
          for (const m of songMatches) {
            try {
              const spotifyTrackId = await getSoundChartsSongPlatformId(m.songMatch.uuid, 'spotify');
              if (spotifyTrackId) {
                const trackRes = await appSpotify.getTrack(spotifyTrackId);
                const artistIdOnTrack = trackRes.body.artists?.[0]?.id;
                if (artistIdOnTrack === confirmedSpotifyArtistId) {
                  console.log(`✓ SoundCharts artist-fallback: Spotify ID match → "${m.candidate.name}" (${confirmedSpotifyArtistId}) — UUID ${m.candidate.uuid}`);
                  const result = { songUuid: m.songMatch.uuid, artistUuid: m.candidate.uuid, artistName: m.candidate.name, _confirmedStrong: true };
                  setSCCache(cacheKey, result);
                  return result;
                }
              }
            } catch (e) { /* fall through to lower priority */ }
          }
        }

        // Priority 1: ISRC exact match — same song across platforms, no ambiguity
        const isrcPick = spotifyIsrc ? songMatches.find(m => m.songIsrc === spotifyIsrc) : null;
        if (isrcPick) {
          console.log(`✓ SoundCharts artist-fallback: ISRC match → "${isrcPick.candidate.name}" (ISRC: ${spotifyIsrc}) — UUID ${isrcPick.candidate.uuid}`);
          const result = { songUuid: isrcPick.songMatch.uuid, artistUuid: isrcPick.candidate.uuid, artistName: isrcPick.candidate.name, _confirmedStrong: true };
          setSCCache(cacheKey, result);
          return result;
        }
        // Priority 2: genre preference
        const pick = prefNorms.length > 0
          ? (songMatches.find(m => m.genres.some(g => prefNorms.some(p => g.includes(p) || p.includes(g)))) || songMatches[0])
          : songMatches[0];
        if (songMatches.length > 1) {
          const others = songMatches.filter(m => m !== pick).map(m => `"${m.candidate.name}" [${m.genres.slice(0,2).join(',')||'no genre'}]`).join(', ');
          console.log(`✓ SoundCharts artist-fallback: picked "${pick.candidate.name}" [${pick.genres.slice(0,2).join(',')||'no genre'}] over ${others} (genre preference: [${prefNorms.slice(0,3).join(',')}])`);
        } else {
          console.log(`✓ SoundCharts artist-fallback: "${pick.candidate.name}" has "${pick.songMatch.name}" → UUID ${pick.candidate.uuid}`);
        }
        // Title-only match with no Spotify/ISRC verification — could be wrong artist (e.g. Russian "Dante" vs R&B "Dante")
        const result = { songUuid: pick.songMatch.uuid, artistUuid: pick.candidate.uuid, artistName: pick.candidate.name, _confirmedStrong: false };
        setSCCache(cacheKey, result);
        return result;
      }
      console.log(`🔍 SoundCharts song search: artist-fallback found no match among ${candidates.length} "${artist}" candidates`);
    } catch (fbErr) {
      console.log(`🔍 SoundCharts song search: artist-fallback error: ${fbErr.message}`);
    }

    setSCCache(cacheKey, null);
    return null;
  } catch (error) {
    console.log(`⚠️  SoundCharts song search error for "${title}": ${error.message}`);
    return null;
  }
}

// Given a SoundCharts song UUID and platform code ('spotify' or 'applemusic'),
// return the platform track ID (or null if not found).
// Uses GET /api/v2/song/{uuid}/identifiers?platform=<p>&onlyDefault=true
// This lets us skip unreliable title-based text search for songs without an ISRC.
async function getSoundChartsSongPlatformId(songUuid, scPlatform) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey || !songUuid) return null;

  const cacheKey = `song-platformid:${scPlatform}:${songUuid}`;
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;

  try {
    await throttleSoundCharts();
    const response = await axios.get(
      `https://customer.api.soundcharts.com/api/v2/song/${songUuid}/identifiers`,
      {
        headers: { 'x-app-id': appId, 'x-api-key': apiKey },
        params: { platform: scPlatform, onlyDefault: true, offset: 0, limit: 5 },
        timeout: 10000
      }
    );

    const items = response.data?.items || [];
    const platformItem = items.find(item =>
      (item.platform || '').toLowerCase() === scPlatform ||
      (item.identifier || '').includes(scPlatform)
    );

    if (platformItem) {
      let id = platformItem.identifier || platformItem.id || platformItem.value || null;
      // Spotify identifiers may be full URLs — extract just the track ID
      if (scPlatform === 'spotify' && id && id.includes('spotify.com/track/')) {
        id = id.split('spotify.com/track/')[1].split('?')[0];
      }
      setSCCache(cacheKey, id);
      return id;
    }

    setSCCache(cacheKey, null);
    return null;
  } catch (error) {
    console.log(`⚠️  SoundCharts identifiers error for UUID ${songUuid} (${scPlatform}): ${error.message}`);
    setSCCache(cacheKey, null);
    return null;
  }
}

// Look up an artist's platform identifier (e.g. Spotify artist ID) via SC artist identifiers API.
// Mirrors getSoundChartsSongPlatformId but for the artist resource.
async function getSoundChartsArtistPlatformId(artistUuid, scPlatform) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey || !artistUuid) return null;

  const cacheKey = `artist-platformid:${scPlatform}:${artistUuid}`;
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;

  try {
    await throttleSoundCharts();
    const response = await axios.get(
      `https://customer.api.soundcharts.com/api/v2/artist/${artistUuid}/identifiers`,
      {
        headers: { 'x-app-id': appId, 'x-api-key': apiKey },
        params: { platform: scPlatform, onlyDefault: true, offset: 0, limit: 5 },
        timeout: 10000
      }
    );
    const items = response.data?.items || [];
    const platformItem = items.find(item =>
      (item.platform || '').toLowerCase() === scPlatform ||
      (item.identifier || '').includes(scPlatform)
    );
    if (platformItem) {
      let id = platformItem.identifier || platformItem.id || platformItem.value || null;
      if (scPlatform === 'spotify' && id && id.includes('spotify.com/artist/')) {
        id = id.split('spotify.com/artist/')[1].split('?')[0];
      }
      setSCCache(cacheKey, id);
      return id;
    }
    setSCCache(cacheKey, null);
    return null;
  } catch (error) {
    console.log(`⚠️  SoundCharts artist identifiers error for UUID ${artistUuid} (${scPlatform}): ${error.message}`);
    setSCCache(cacheKey, null);
    return null;
  }
}

// Helper function to get song details including audio features from SoundCharts
async function getSoundChartsSongDetails(songUuid, options = {}) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;

  if (!appId || !apiKey) {
    return null;
  }

  const { includeLyrics = false, includePopularity = false } = options;

  try {
    const response = await axios.get(
      `https://customer.api.soundcharts.com/api/v2.25/song/${songUuid}`,
      {
        headers: {
          'x-app-id': appId,
          'x-api-key': apiKey
        },
        timeout: 10000
      }
    );

    if (response.data?.object) {
      const song = response.data.object;
      const result = {
        uuid: song.uuid,
        name: song.name,
        artists: song.artists?.map(a => a.name) || [song.creditName],
        releaseDate: song.releaseDate,
        genres: song.genres?.map(g => g.root) || [],
        subgenres: song.genres?.flatMap(g => g.sub || []) || [],
        audio: song.audio || {},
        moods: song.moods || [],
        themes: song.themes || [],
        isrc: song.isrc?.value,
        explicit: song.explicit,
        duration: song.duration
      };

      // Optionally fetch Spotify popularity score (0-100)
      if (includePopularity) {
        try {
          const popResp = await axios.get(
            `https://customer.api.soundcharts.com/api/v2/song/${songUuid}/popularity/spotify`,
            {
              headers: {
                'x-app-id': appId,
                'x-api-key': apiKey
              },
              params: { limit: 1 },
              timeout: 5000
            }
          );
          if (popResp.data?.items?.[0]?.plots?.[0]?.value !== undefined) {
            result.spotifyPopularity = popResp.data.items[0].plots[0].value;
          }
        } catch (popErr) {
          // Popularity data not available
        }
      }

      // Optionally fetch lyrics analysis for themes/moods
      if (includeLyrics) {
        try {
          const lyricsResp = await axios.get(
            `https://customer.api.soundcharts.com/api/v2/song/${songUuid}/lyrics-analysis`,
            {
              headers: {
                'x-app-id': appId,
                'x-api-key': apiKey
              },
              timeout: 5000
            }
          );
          if (lyricsResp.data?.lyricsAnalysis) {
            result.themes = lyricsResp.data.lyricsAnalysis.themes || [];
            result.moods = lyricsResp.data.lyricsAnalysis.moods || [];
            result.emotionalIntensity = lyricsResp.data.lyricsAnalysis.emotionalIntensityScore || 0;
          }
        } catch (lyricsErr) {
          // Lyrics analysis not available for this song
        }
      }

      return result;
    }
    return null;
  } catch (error) {
    console.log(`⚠️  SoundCharts song details error: ${error.message}`);
    return null;
  }
}

// Map Claude genre names → SoundCharts genre slugs
// Genre slugs verified against SoundCharts top/songs API — these are the actual root values
// the API accepts. Invalid slugs silently return 0 results.
const SOUNDCHARTS_GENRE_MAP = {
  'pop': 'pop', 'dance pop': 'pop', 'synth-pop': 'pop', 'electropop': 'pop',
  'k-pop': 'pop', 'kpop': 'pop', 'korean pop': 'pop',
  'hip hop': 'hip hop', 'hip-hop': 'hip hop', 'rap': 'hip hop', 'trap': 'hip hop',
  'drill': 'hip hop', 'underground hip hop': 'hip hop',
  'r&b': 'r&b', 'rnb': 'r&b', 'neo soul': 'r&b', 'soul': 'r&b', 'funk': 'r&b',
  'rock': 'rock', 'indie rock': 'rock', 'pop rock': 'rock', 'punk': 'rock',
  'alternative': 'alternative', 'indie': 'alternative', 'indie pop': 'alternative',
  'electronic': 'electro', 'edm': 'electro', 'house': 'electro',
  'techno': 'electro', 'dance': 'electro', 'lo-fi': 'electro', 'ambient': 'electro',
  'country': 'country', 'country pop': 'country',
  'latin': 'latin', 'reggaeton': 'latin', 'latin pop': 'latin',
  'jazz': 'jazz', 'classical': 'classical',
  'metal': 'metal',
  'afrobeats': 'african', 'afro pop': 'african', 'afro': 'african',
  'reggae': 'reggae', 'blues': 'blues', 'gospel': 'r&b',
};

// Map Claude subgenre labels → SoundCharts sub-genre slugs
const SOUNDCHARTS_SUBGENRE_MAP = {
  // Pop subgenres
  'dance pop': 'dance pop', 'electropop': 'electropop', 'synth-pop': 'synth pop',
  'indie pop': 'indie pop', 'art pop': 'art pop', 'dream pop': 'dream pop',
  'k-pop': 'k-pop', 'j-pop': 'j-pop',
  // Hip-hop subgenres
  'trap': 'trap', 'drill': 'drill', 'lo-fi hip hop': 'lo-fi hip hop',
  'conscious hip hop': 'conscious hip hop', 'mumble rap': 'mumble rap',
  'phonk': 'phonk', 'cloud rap': 'cloud rap',
  // R&B subgenres
  'neo soul': 'neo soul', 'contemporary r&b': 'contemporary r&b',
  'alternative r&b': 'alternative r&b',
  // Electronic subgenres
  'house': 'house', 'deep house': 'deep house', 'tech house': 'tech house',
  'techno': 'techno', 'dubstep': 'dubstep', 'drum and bass': 'drum and bass',
  'ambient': 'ambient', 'lo-fi': 'lo-fi', 'chillout': 'chillout',
  'trance': 'trance', 'future bass': 'future bass',
  // Rock subgenres
  'indie rock': 'indie rock', 'alternative rock': 'alternative rock',
  'punk rock': 'punk rock', 'hard rock': 'hard rock', 'emo': 'emo',
  'shoegaze': 'shoegaze', 'grunge': 'grunge',
  // Latin subgenres
  'reggaeton': 'reggaeton', 'latin pop': 'latin pop', 'bachata': 'bachata',
  'salsa': 'salsa', 'dembow': 'dembow',
};


// Catalog-level context overrides — tracks with confirmed repeated false positives
// that cannot be fixed via prompt engineering alone. Spotify audio features API
// returns 403 (deprecated for this app), so energy/valence filtering is not
// available at query time. These tracks have high popularity scores (>70) that
// cause them to survive the candidate pool regardless of playlist context.
//
// Format: "artistnamelower::tracknamelower"
// requiredMoods:    playlist moods in which this track IS appropriate (allowlist)
// requiredEnergies: playlist energy targets in which this track IS appropriate (allowlist)
// If the current playlist context does not match BOTH, the track is removed before
// the vibe check. This is an allowlist (not a blocklist) — tracks only survive if
// the context explicitly permits them.
//
// HOW TO ADD NEW ENTRIES:
//   1. Confirm the false positive across at least 3 independent test prompts
//   2. Record which test prompts it appeared in (for audit trail)
//   3. Set requiredMoods/requiredEnergies to contexts where the track genuinely fits
//   4. Add the date so stale entries can be reviewed
//
// If this list exceeds ~15 entries, consider a proper energy/valence filter
// via a third-party audio analysis API (Spotify's is deprecated).
const TRACK_CONTEXT_OVERRIDES = {
  // Added 2026-03-25. Slow breakup ballad (2006). Popularity: 74.
  // False positives in: Prompt 73 (pregame), Prompt 74 (dinner party), Prompt 82 (summer),
  // Prompt D (high-energy pregame), Prompts 84/86/88 — 10 confirmed appearances across test suite.
  // blockedUseCases provides deterministic block even when mood/energy aren't extracted.
  'rihanna::unfaithful': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'slow breakup ballad — 10 confirmed false positives in high-energy/positive contexts',
  },
  // Added 2026-03-25. Anxious acoustic piano ballad (2021). Popularity: 78.
  // False positives in: Prompt 71 (nervous/excited), Prompt 73 (pregame), Prompt 80 (cooking),
  // Prompt D (high-energy pregame) — 4 confirmed appearances across test suite.
  'olivia rodrigo::1 step forward, 3 steps back': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'anxious acoustic piano ballad — 4 confirmed false positives in high-energy/positive contexts',
  },
  // Added 2026-03-26. Melancholic indie-pop breakup song (2022). Popularity: 90.
  // False positives in: Prompt 84 run 2 (hype), Prompt 85 run 2 (turn up), Prompt 88 run 3 (gym) —
  // 3 confirmed appearances in high-energy contexts. Acoustic and emotional, not a party/workout track.
  'harry styles::as it was': {
    requiredMoods: ['melancholic', 'neutral'],
    requiredEnergies: ['low', 'medium'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'melancholic indie-pop breakup song — 3 confirmed false positives in high-energy contexts',
  },
  // Added 2026-03-26. Slow acoustic ballad variant of "Bad Decisions". Popularity: ~60.
  // False positives in: Prompt 84 run 2 (hype), Prompt 88 run 3 (gym) — acoustic = wrong for high-energy.
  'benny blanco::bad decisions - acoustic': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'acoustic ballad variant — wrong for any high-energy/party/workout context',
  },
  // Added 2026-03-26. Soft acoustic-pop ballad (2022). Popularity: ~75.
  // False positives: summer playlists run 2-3 (Sam Smith is depth-2 from summer seed graph
  // but consistently melancholic — no Sam Smith song belongs in summer/party/workout).
  'sam smith::all this madness': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'slow emotional ballad — wrong for summer/party/workout contexts',
  },
  // Added 2026-03-27. Winter-coded introspective folk-pop ballad (2020). Popularity: ~80.
  // False positives: Prompt 86 summer runs 1 and 6 (appears twice in 6 runs — most persistent
  // summer offender). Thematically unambiguous: it is literally about autumn/winter.
  'taylor swift::\'tis the damn season': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'winter-coded introspective ballad — thematically wrong for any high-energy or warm-weather context',
  },
  // Added 2026-03-27. Slow sad indie-pop (2019). Popularity: ~72.
  // False positives: Prompt 86 summer run 6. Whispered vocals, sparse instrumentation — clearly wrong
  // for summer/party/workout even though Billie Eilish is a summer seed graph depth-2 artist.
  'billie eilish::8': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'slow sad indie-pop — wrong for any high-energy or summer context',
  },
  // Added 2026-03-27. Slow sad ballad from HSM TV show (2019). Popularity: ~70.
  // False positives: Prompt 86 summer. Non-standard album track that bypasses SC energy filtering.
  'olivia rodrigo::all i want': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'slow sad TV-show ballad — wrong for any high-energy or summer context',
  },
  // Added 2026-03-27. Mid-tempo tropicalia-pop (2017). Popularity: 84.
  // False positives: Prompt 86 summer — 8 of 9 runs. Enters via gap-fill top_songs. Most persistent
  // summer false positive in entire test suite. Ed Sheeran depth-2 via Bruno Mars.
  'ed sheeran::shape of you': {
    requiredMoods: ['positive'],
    requiredEnergies: ['medium', 'high'],
    blockedUseCases: ['summer'],
    reason: 'mid-tempo pop — 8/9 summer false positives, too generic/indoors-coded for windows-down summer context',
  },
  // Added 2026-03-27. Slow dreamy R&B remix (2021). Popularity: ~55.
  // False positives: Prompt 86 summer runs 3, 8, 9. Key mismatch with existing 'all this madness' entry.
  // The Spotify title is the remix version — need separate entry for both forms.
  'sam smith::a little melancholy': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'slow melancholic R&B ballad — wrong for any upbeat or summer context',
  },
  'sam smith::a little melancholy - arbitraire remix': {
    requiredMoods: ['melancholic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'slow melancholic R&B remix — wrong for any upbeat or summer context',
  },
  // Added 2026-03-27. Slow romantic ballad (2024). Popularity: ~65.
  // False positives: Prompt 86 summer runs 8, 9. Dua Lipa enters via depth-2 artist graph
  // but this is one of her slow ballads, not her dance-pop tracks.
  'dua lipa::anything for love': {
    requiredMoods: ['melancholic', 'romantic'],
    requiredEnergies: ['low'],
    blockedUseCases: ['workout', 'party', 'summer', 'morning'],
    reason: 'slow romantic ballad — wrong for upbeat summer context despite artist being dance-pop',
  },
  // Added 2026-03-27. Dark/satirical upbeat pop (2019). Popularity: ~75.
  // False positives: Prompt 86 summer runs 8, 9. High production energy but thematically dark
  // (climate anxiety, going to hell) — wrong emotional register for carefree summer.
  'billie eilish::all the good girls go to hell': {
    requiredMoods: ['melancholic', 'dark'],
    requiredEnergies: ['low', 'medium'],
    blockedUseCases: ['summer', 'morning'],
    reason: 'dark satirical pop — climate anxiety theme wrong for carefree summer context',
  },
  // Added 2026-03-27. Brooklyn rap track featuring Macy Gray (2009). Popularity: ~60.
  // False positive: cozy winter fireplace prompt run 1. Enters via Macy Gray depth-2 connection.
  // Maino is a high-energy rapper with zero overlap with chill/folk/acoustic contexts.
  'maino::all again (feat. macy gray)': {
    requiredMoods: ['energetic'],
    requiredEnergies: ['high'],
    blockedUseCases: ['chill', 'background', 'sleep', 'focus', 'morning'],
    reason: 'Brooklyn rap — contextually wrong for any low-energy or calm context; enters via Macy Gray depth-2',
  },
};

// Build a SoundCharts query from Claude-extracted genreData.
// Used by executeSoundChartsStrategy() to replace the old similarity-tree approach.
function buildSoundchartsQuery(genreData, allowExplicit = true) {
  const isExclusive = genreData.artistConstraints.exclusiveMode === true ||
                      genreData.artistConstraints.exclusiveMode === 'true';
  const requestedArtists = genreData.artistConstraints.requestedArtists || [];
  // Never use Claude's suggestedSeedArtists as seed artists — SC's own similarity graph
  // determines what artists appear. Only user-explicit requestedArtists are trusted.
  const seedArtists = requestedArtists;

  // Strategy selection:
  // - exclusive mode or user explicitly named artists → artist_songs (SC graph from requested artists)
  // - reference songs provided → artist_songs (reference artists injected as seeds post-build)
  // - no specific artists or reference songs → top_songs with all SC filters
  const hasReferenceSongs = (genreData.referenceSongs || []).length > 0;
  const strategy = (isExclusive || requestedArtists.length > 0 || hasReferenceSongs)
    ? 'artist_songs'
    : 'top_songs';

  const filters = [];

  // Genre filter (used for top_songs fallback; also passed so artist_songs can apply era filter)
  if (genreData.primaryGenre) {
    const genreLower = genreData.primaryGenre.toLowerCase().trim();
    let scGenre = SOUNDCHARTS_GENRE_MAP[genreLower];
    if (!scGenre) {
      for (const [key, val] of Object.entries(SOUNDCHARTS_GENRE_MAP)) {
        if (genreLower.includes(key) || key.includes(genreLower)) { scGenre = val; break; }
      }
    }
    // Drift diagnostic: log genre resolution so we can spot mismatches (e.g. neo-soul → r&b when SC has no neo-soul top-songs)
    console.log(`🎵 SC genre resolution: primaryGenre="${genreData.primaryGenre}" → scGenre=${scGenre || '(none — no SC mapping)'}`);
    if (scGenre) filters.push({ type: 'songGenres', data: { values: [scGenre], operator: 'in' } });
  }

  // Release year filter
  if (genreData.era?.yearRange?.min || genreData.era?.yearRange?.max) {
    const rdf = { type: 'releaseDate', data: { operator: 'in' } };
    if (genreData.era.yearRange.min) rdf.data.min = `${genreData.era.yearRange.min}-01-01`;
    if (genreData.era.yearRange.max) rdf.data.max = `${genreData.era.yearRange.max}-12-31`;
    filters.push(rdf);
  }

  // Mood filter — collect unique SC mood values from atmosphere + style + keyCharacteristics
  const moodLabels = [
    ...(genreData.atmosphere || []),
    ...(genreData.keyCharacteristics || []),
    genreData.style || '',
  ].map(l => l.toLowerCase().trim()).filter(Boolean);

  // NOTE: SC moods filter returns 0 when combined with genre + audio filters (valence/energy).
  // Moods filter is unreliable for top_songs — valence/energy already capture the mood numerically.
  // Mood labels are still used to derive audio feature ranges below.

  // Audio feature filters.
  // For top_songs: apply all matched audio feature ranges.
  // For artist_songs: the artist graph already constrains genre/sound, so only pass through
  // STRONG energy or tempo constraints (e.g. gym = high energy, sleep = very calm).
  // Weaker signals (valence, danceability, acousticness) are skipped for artist_songs to
  // avoid over-shrinking the pool.
  const STRONG_ENERGY_MIN = 0.72; // matches 'energetic'/'hype'/'workout' threshold
  const STRONG_CALM_MAX   = 0.40; // matches 'calm'/'sleep' threshold

  const energyTarget = genreData.energyTarget || null;

  const featureRanges = {};
  for (const label of moodLabels) {
    const features = SOUNDCHARTS_AUDIO_FEATURE_MAP[label];
    if (!features) continue;
    for (const [feature, range] of Object.entries(features)) {
      if (!featureRanges[feature]) featureRanges[feature] = {};
      if (range.min !== undefined) featureRanges[feature].min = Math.max(featureRanges[feature].min ?? 0, range.min);
      if (range.max !== undefined) featureRanges[feature].max = Math.min(featureRanges[feature].max ?? 9999, range.max);
    }
  }

  for (const [feature, range] of Object.entries(featureRanges)) {
    if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
      // Contradictory energy signals (e.g. "chill but kinda hype") → use medium band
      // instead of skipping entirely, so we don't lose all filtering for that feature.
      if (feature === 'energy' && energyTarget !== 'low' && energyTarget !== 'high') {
        console.log(`⚡ Contradictory energy signals → falling back to medium band (0.38–0.68)`);
        filters.push({ type: 'energy', data: { min: 0.38, max: 0.68 } });
      } else {
        console.log(`⚠️  Skipping contradictory ${feature} filter (min ${range.min} > max ${range.max})`);
      }
      continue;
    }
    if (strategy === 'artist_songs') {
      if (feature === 'energy') {
        const isStrongHigh = range.min !== undefined && range.min >= STRONG_ENERGY_MIN;
        const isStrongLow  = range.max !== undefined && range.max <= STRONG_CALM_MAX;
        if (!isStrongHigh && !isStrongLow) continue; // weak energy signal — skip
      } else if (feature !== 'tempo') {
        continue; // skip valence/danceability/acousticness etc for artist_songs
      }
    }
    const filterData = {};
    if (range.min !== undefined) filterData.min = range.min;
    if (range.max !== undefined) filterData.max = range.max;
    filters.push({ type: feature, data: filterData });
    console.log(`🎛️  SoundCharts audio filter: ${feature} ${JSON.stringify(filterData)}${strategy === 'artist_songs' ? ' [strong signal]' : ''}`);
  }

  // Hard BPM constraint — overrides any label-derived tempo filter
  const bpmMin = genreData.bpmConstraint?.min;
  const bpmMax = genreData.bpmConstraint?.max;
  if (bpmMin || bpmMax) {
    // Remove any existing tempo filter added by the label-based pass above
    const tempoIdx = filters.findIndex(f => f.type === 'tempo');
    if (tempoIdx !== -1) filters.splice(tempoIdx, 1);
    const tempoData = {};
    if (bpmMin) tempoData.min = bpmMin;
    if (bpmMax) tempoData.max = bpmMax;
    filters.push({ type: 'tempo', data: tempoData });
    console.log(`🎵 Hard BPM constraint: ${JSON.stringify(tempoData)}`);
  }

  // Energy target — maps "low"/"medium"/"high" to an energy range.
  // Only applies when a label-derived energy range hasn't already been set,
  // or when the label-derived range is contradictory (min > max was skipped).
  if (energyTarget) {
    const energyIdx = filters.findIndex(f => f.type === 'energy');
    // Skip energy filter if moods are Sad/Melancholic — sad R&B/pop spans all energy levels,
    if (energyIdx === -1) {
      // No energy filter was set — add one based on the target
      const energyRanges = { low: { max: 0.42 }, medium: { min: 0.38, max: 0.68 }, high: { min: 0.72 } };
      const er = energyRanges[energyTarget];
      if (er) {
        filters.push({ type: 'energy', data: er });
        console.log(`⚡ Energy target "${energyTarget}": ${JSON.stringify(er)}`);
      }
    }
    // If an energy filter already exists (from label pass), leave it — it's more specific
  }

  // Mood → valence filter (positive = high valence, melancholic = low valence)
  const mood = genreData.mood;
  if (mood) {
    const valenceIdx = filters.findIndex(f => f.type === 'valence');
    if (valenceIdx === -1) {
      if (mood === 'positive') {
        filters.push({ type: 'valence', data: { min: 0.45 } });
        console.log(`😊 Mood "positive": valence ≥ 0.45`);
      } else if (mood === 'melancholic') {
        filters.push({ type: 'valence', data: { max: 0.45 } });
        console.log(`😔 Mood "melancholic": valence ≤ 0.45`);
      }
      // neutral: no valence filter
    }
  }

  // Language filter
  const preferredLangs = genreData.culturalContext?.language?.prefer || [];
  if (preferredLangs.length > 0) {
    // SoundCharts uses ISO 639-1 codes (e.g. 'en', 'es', 'ko')
    const ISO_LANG_MAP = {
      'english': 'en', 'spanish': 'es', 'french': 'fr', 'portuguese': 'pt',
      'korean': 'ko', 'japanese': 'ja', 'german': 'de', 'italian': 'it',
      'hindi': 'hi', 'arabic': 'ar', 'mandarin': 'zh', 'chinese': 'zh',
      'russian': 'ru', 'dutch': 'nl', 'swedish': 'sv',
    };
    const langCodes = preferredLangs
      .map(l => ISO_LANG_MAP[l.toLowerCase()] || (l.length === 2 ? l.toLowerCase() : null))
      .filter(Boolean);
    if (langCodes.length > 0) {
      filters.push({ type: 'languageCode', data: { values: langCodes, operator: 'in' } });
      console.log(`🌐 SoundCharts language filter: [${langCodes.join(', ')}]`);
    }
  }

  // Explicit filter — filter at source instead of relying on post-processing
  if (!allowExplicit) {
    filters.push({ type: 'explicit', data: { value: false } });
  }

  // Duration filter — pass trackConstraints directly to SoundCharts
  const durMin = genreData.trackConstraints?.duration?.min;
  const durMax = genreData.trackConstraints?.duration?.max;
  if (durMin || durMax) {
    const durData = {};
    if (durMin) durData.min = durMin;
    if (durMax) durData.max = durMax;
    filters.push({ type: 'duration', data: durData });
    console.log(`⏱️  SoundCharts duration filter: ${JSON.stringify(durData)}s`);
  }

  // Subgenre filter
  if (genreData.subgenre) {
    const subLower = genreData.subgenre.toLowerCase().trim();
    const scSubgenre = SOUNDCHARTS_SUBGENRE_MAP[subLower] ||
      Object.entries(SOUNDCHARTS_SUBGENRE_MAP).find(([k]) => subLower.includes(k) || k.includes(subLower))?.[1];
    // Drift diagnostic: log subgenre resolution (critical for neo-soul — maps to 'neo soul' subgenre filter on top of r&b genre)
    console.log(`🎸 SC subgenre resolution: subgenre="${genreData.subgenre}" → scSubgenre=${scSubgenre || '(none — no SC mapping)'}`);
    if (scSubgenre) {
      filters.push({ type: 'songSubGenres', data: { values: [scSubgenre], operator: 'in' } });
      console.log(`🎸 SoundCharts subgenre filter: ${scSubgenre}`);
    }
  }

  // NOTE: themes filter (Heartbreak, Party, etc.) has very sparse SC coverage — AND'd with
  // genre+moods+audio it consistently returns 0 results. Removed from SC filters entirely.

  // Artist career stage filter — maps popularity preference to career stage
  const popPref = genreData.trackConstraints?.popularity?.preference;
  const popMax = genreData.trackConstraints?.popularity?.max;
  const _useCaseLower = (genreData.contextClues?.useCase || '').toLowerCase();
  const isPartyContext = _useCaseLower === 'party';
  if (popPref === 'underground' || (popMax !== null && popMax !== undefined && popMax <= 40)) {
    filters.push({ type: 'artistCareerStages', data: { values: ['long_tail', 'developing'], operator: 'in' } });
    console.log(`🎤 SoundCharts career stage filter: underground (long_tail, developing)`);
  } else if (popPref === 'mainstream' || (genreData.trackConstraints?.popularity?.min !== null &&
             genreData.trackConstraints?.popularity?.min !== undefined &&
             genreData.trackConstraints?.popularity?.min >= 70)) {
    filters.push({ type: 'artistCareerStages', data: { values: ['mainstream', 'superstar'], operator: 'in' } });
    console.log(`🎤 SoundCharts career stage filter: mainstream/superstar`);
  } else if (isPartyContext) {
    // Party/social playlists need recognizable songs everyone knows — boost toward mainstream
    filters.push({ type: 'artistCareerStages', data: { values: ['mainstream', 'superstar', 'developing'], operator: 'in' } });
    console.log(`🎉 SoundCharts career stage filter: party context → mainstream/superstar/developing`);
  }

  // Liveness filter — if user excluded live versions, filter them out at source
  const excludeVersions = genreData.trackConstraints?.excludeVersions || [];
  if (excludeVersions.includes('live')) {
    filters.push({ type: 'liveness', data: { max: 0.4 } });
    console.log(`🎙️  SoundCharts liveness filter: max 0.4 (no live recordings)`);
  }

  // Speechiness filter — high speechiness = rap/spoken word; low = sung music
  // Only applied on top_songs since artist graph already handles genre
  if (strategy === 'top_songs') {
    const avoidances = genreData.contextClues?.avoidances || [];
    const lyricsAvoid = genreData.lyricalContent?.avoid || [];
    const allAvoid = [...avoidances, ...lyricsAvoid].map(a => a.toLowerCase());
    if (allAvoid.some(a => a.includes('rap') || a.includes('hip hop') || a.includes('spoken'))) {
      filters.push({ type: 'speechiness', data: { max: 0.33 } });
      console.log(`🗣️  SoundCharts speechiness filter: max 0.33 (no rap/spoken word)`);
    } else if (genreData.primaryGenre?.toLowerCase().includes('rap') ||
               genreData.primaryGenre?.toLowerCase().includes('hip hop')) {
      filters.push({ type: 'speechiness', data: { min: 0.33 } });
      console.log(`🗣️  SoundCharts speechiness filter: min 0.33 (rap/hip-hop focus)`);
    }
  }

  // Merge Claude's directly-output SC filters (audio, mood, lyrical).
  // These replace lookup-table-derived filters of the same type, since Claude interprets
  // the prompt more dynamically than static keyword maps can.
  // Skip types that need server-side slug/code mapping (handled above by existing logic).
  // moods is also skipped — SC moods filter returns 0 when combined with genre + audio filters
  const CLAUDE_SC_SKIP_TYPES = new Set(['songGenres', 'songSubGenres', 'languageCode', 'explicit', 'releaseDate', 'duration', 'artistCareerStages', 'emotionalIntensityScore', 'themes', 'moods']);
  const claudeScFilters = Array.isArray(genreData.soundchartsFilters) ? genreData.soundchartsFilters : [];
  for (const cf of claudeScFilters) {
    if (!cf || !cf.type || CLAUDE_SC_SKIP_TYPES.has(cf.type)) continue;
    const finalCf = cf;
    const existingIdx = filters.findIndex(f => f.type === finalCf.type);
    if (existingIdx !== -1) {
      filters.splice(existingIdx, 1, finalCf);
      console.log(`🎯 Claude SC filter override: ${finalCf.type} ${JSON.stringify(finalCf.data)}`);
    } else {
      filters.push(finalCf);
      console.log(`🎯 Claude SC filter added: ${finalCf.type} ${JSON.stringify(finalCf.data)}`);
    }
  }

  return {
    strategy,
    artists: seedArtists,
    expandToSimilar: !isExclusive,
    seedArtists,
    soundchartsFilters: filters,
    soundchartsSort: { type: 'metric', platform: 'spotify', metricType: 'streams', period: 'month', sortBy: 'total', order: 'desc' },
    primaryGenre: genreData.primaryGenre || null,
  };
}

// Map Claude atmosphere/mood labels → SoundCharts mood values
const SOUNDCHARTS_MOOD_MAP = {
  'energetic': 'Energetic', 'energy': 'Energetic', 'hype': 'Energetic',
  'chill': 'Calm', 'relaxed': 'Calm', 'calm': 'Calm', 'peaceful': 'Peaceful',
  'happy': 'Happy', 'upbeat': 'Happy', 'feel-good': 'Happy', 'joyful': 'Joyful',
  'sad': 'Sad', 'melancholic': 'Melancholic', 'emotional': 'Melancholic',
  'romantic': 'Romantic', 'love': 'Romantic', 'sensual': 'Sensual',
  'dark': 'Dark', 'aggressive': 'Aggressive', 'angry': 'Aggressive',
  'motivational': 'Empowering', 'motivation': 'Empowering', 'empowering': 'Empowering',
  'party': 'Euphoric', 'euphoric': 'Euphoric',
  'melancholy': 'Melancholic', 'nostalgic': 'Nostalgic',
  'spiritual': 'Spiritual', 'peaceful': 'Peaceful',
  'excited': 'Energetic', 'intense': 'Aggressive', 'dreamy': 'Peaceful',
  'rebellious': 'Aggressive', 'confident': 'Empowering', 'powerful': 'Empowering',
  'groovy': 'Euphoric', 'fun': 'Joyful', 'playful': 'Joyful', 'summer': 'Happy',
};

// Map Claude atmosphere/characteristic labels → SoundCharts audio feature ranges.
// Only applied on top_songs (no seed artists) — artist_songs already finds genre-relevant songs
// via the artist graph, so audio feature filters there would narrow the pool too aggressively.
// Values are 0–1 (normalized) except tempo (BPM).
const SOUNDCHARTS_AUDIO_FEATURE_MAP = {
  // Energy (intensity/activity level)
  'energetic': { energy: { min: 0.72 } },
  'hype':      { energy: { min: 0.80 } },
  'intense':   { energy: { min: 0.78 } },
  'workout':   { energy: { min: 0.75 } },
  'powerful':  { energy: { min: 0.72 } },
  'chill':     { energy: { max: 0.45 } },
  'relaxed':   { energy: { max: 0.45 } },
  'calm':      { energy: { max: 0.40 } },
  'peaceful':  { energy: { max: 0.40 } },
  'ambient':   { energy: { max: 0.35 } },
  'lo-fi':     { energy: { max: 0.50 } },
  'sleep':     { energy: { max: 0.30 } },
  'focus':     { energy: { max: 0.55 } },
  'study':     { energy: { max: 0.55 } },

  // Valence (musical positivity)
  'happy':     { valence: { min: 0.65 } },
  'feel-good': { valence: { min: 0.62 } },
  'upbeat':    { valence: { min: 0.60 } },
  'joyful':    { valence: { min: 0.70 } },
  'fun':       { valence: { min: 0.60 } },
  'summer':    { valence: { min: 0.60 } },
  'playful':   { valence: { min: 0.60 } },
  'sad':       { valence: { max: 0.35 } },
  'melancholic': { valence: { max: 0.40 } },
  'melancholy':  { valence: { max: 0.40 } },
  'dark':      { valence: { max: 0.30 } },
  'heartbreak': { valence: { max: 0.38 } },
  'emotional': { valence: { max: 0.45 } },

  // Danceability
  'dance':     { danceability: { min: 0.72 } },
  'danceable': { danceability: { min: 0.72 } },
  'party':     { danceability: { min: 0.75 } },
  'groovy':    { danceability: { min: 0.68 } },
  'club':      { danceability: { min: 0.78 } },

  // Acousticness
  'acoustic':   { acousticness: { min: 0.60 } },
  'unplugged':  { acousticness: { min: 0.60 } },
  'raw':        { acousticness: { min: 0.50 } },

  // Instrumentalness
  'instrumental':  { instrumentalness: { min: 0.55 } },
  'no vocals':     { instrumentalness: { min: 0.55 } },
  'concentration': { instrumentalness: { min: 0.40 } },

  // Tempo (BPM)
  'slow':   { tempo: { max: 85 } },
  'ballad': { tempo: { max: 90 } },
  'fast':   { tempo: { min: 128 } },
  'uptempo': { tempo: { min: 120 } },
};

// ─────────────────────────────────────────────────────────────────────────────
// Classify seed artists by gender using a Haiku call and return only those matching
// targetGender. Applied at seed selection time — before the SC similarity graph expands —
// so a male seed's graph never generates a pool of male candidates for a female-only request.
// Returns all artists unchanged if the call fails or targetGender is unset/'any'.
async function filterArtistsByGender(artistNames, targetGender) {
  if (!targetGender || targetGender === 'any' || !artistNames || artistNames.length === 0) return artistNames;
  try {
    const response = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `For each artist, classify them as "female", "male", or "mixed" (bands/groups with mixed gender membership).
For an artist credit with a feature, classify by the PRIMARY artist only — ignore featured guests.
Examples: "SZA featuring The Weeknd" → female. "The Weeknd featuring SZA" → male. "TLC" → female. "Maroon 5" → male.

Artists:
${artistNames.map((a, i) => `${i + 1}. ${a}`).join('\n')}

Return ONLY a JSON object mapping 1-based index to classification: {"1": "female", "2": "male", ...}`
      }]
    });
    const text = response.content[0].text.trim()
      .replace(/^```json\n?/, '').replace(/\n?```$/, '')
      .replace(/^```\n?/, '').replace(/\n?```$/, '');
    const classifications = JSON.parse(text);
    const filtered = artistNames.filter((_, i) => {
      const g = classifications[String(i + 1)];
      return g === targetGender || g === 'mixed';
    });
    console.log(`���� Gender filter (${targetGender}): ${artistNames.length} → ${filtered.length} artists kept [${filtered.join(', ')}]`);
    // Fallback: if filter removes every seed, return originals (avoids empty pool)
    return filtered.length > 0 ? filtered : artistNames;
  } catch (err) {
    console.log(`⚠️  Gender filter classification failed: ${err.message} — using all seed artists`);
    return artistNames;
  }
}

// executeSoundChartsStrategy — direct attribute-based song discovery.
// ───────���──────────────────────────────────────────────────���──────────────────

// Cached flag: once we know top/songs returns 403 on this plan, skip the call.
async function executeSoundChartsStrategy(query, fetchCount, confirmedArtistUuids = {}, minArtists = 0, pendingEnrichment = null) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) return [];

  const { strategy, artists = [], soundchartsFilters = [], soundchartsSort } = query;

  // ─��� top_songs / trending ──────────────────────────────────────���──��───────
  if (strategy === 'top_songs' || strategy === 'trending') {
    const sort = soundchartsSort || {
      type: 'metric', platform: 'spotify', metricType: 'streams',
      period: strategy === 'trending' ? 'week' : 'month',
      sortBy: 'total', order: 'desc'
    };
    const body = { sort, ...(soundchartsFilters.length > 0 ? { filters: soundchartsFilters } : {}) };
    console.log(`🎵 SoundCharts ${strategy}: filters=[${soundchartsFilters.map(f => f.type).join(', ')}]`);
    console.log(`🔍 SC request body: ${JSON.stringify(body)}`);

    // Paginate through SC's filtered song database — 500 per page (SC max), up to 2 pages (1000 total).
    // SC sorts by streams, but pagination gives progressively less-popular songs (deep cuts).
    // All results already have genre + mood + energy + themes applied server-side by SC.
    const PAGE_SIZE = 500;
    const MAX_PAGES = strategy === 'trending' ? 1 : 2;
    const allItems = [];

    try {
      for (let page = 0; page < MAX_PAGES; page++) {
        await throttleSoundCharts();
        const response = await axios.post(
          'https://customer.api.soundcharts.com/api/v2/top/songs',
          body,
          {
            headers: { 'x-app-id': appId, 'x-api-key': apiKey, 'Content-Type': 'application/json' },
            params: { offset: page * PAGE_SIZE, limit: PAGE_SIZE },
            timeout: 15000
          }
        );
        const pageItems = response.data?.items || [];
        allItems.push(...pageItems);

        // Stop paging early if SC returned fewer than a full page (no more results)
        if (pageItems.length < PAGE_SIZE) break;
      }

      const items = allItems;
      console.log(`✓ SoundCharts returned ${items.length} songs (${Math.ceil(items.length / PAGE_SIZE)} page(s))`);

      // If top_songs returned 0, progressively loosen filters before falling back to artist_songs.
      const genreFilters = soundchartsFilters.filter(f => f.type === 'songGenres');
      if (items.length === 0 && genreFilters.length > 0) {
        const moodsFilter = soundchartsFilters.find(f => f.type === 'moods');
        const energyFilter = soundchartsFilters.find(f => f.type === 'energy');
        const valenceFilter = soundchartsFilters.find(f => f.type === 'valence');
        const hasAudioFilters = energyFilter || valenceFilter;

        // Step 1: if moods + tight audio → 0, loosen the audio thresholds and keep moods.
        // Widen by ~30% to recover songs while keeping mood quality.
        // _audioLoosened prevents infinite recursion.
        if (moodsFilter && hasAudioFilters && !query._audioLoosened) {
          const loosenedFilters = soundchartsFilters.map(f => {
            if (f.type === 'energy' || f.type === 'valence') {
              const loosened = { ...f, data: { ...f.data } };
              if (loosened.data.max != null) loosened.data.max = Math.min(loosened.data.max * 1.3, 1.0);
              if (loosened.data.min != null) loosened.data.min = Math.max(loosened.data.min * 0.7, 0.0);
              return loosened;
            }
            return f;
          });
          console.log(`⚠️  SoundCharts top_songs returned 0 — loosening audio thresholds and retrying with moods`);
          return executeSoundChartsStrategy(
            { ...query, soundchartsFilters: loosenedFilters, _audioLoosened: true },
            fetchCount,
            confirmedArtistUuids,
            minArtists,
            pendingEnrichment
          );
        }

        // Step 2: drop moods but keep audio.
        // Dropping moods without audio risks pulling off-era songs (Nat King Cole, etc.)
        // so only do this after audio-loosening has already been attempted.
        if (moodsFilter) {
          const filtersWithoutMoods = soundchartsFilters.filter(f => f.type !== 'moods');
          console.log(`⚠️  SoundCharts top_songs returned 0 — retrying without moods filter`);
          return executeSoundChartsStrategy(
            { ...query, soundchartsFilters: filtersWithoutMoods },
            fetchCount,
            confirmedArtistUuids,
            minArtists,
            pendingEnrichment
          );
        }

        // Step 3: audio-only also returned 0 — fall back to artist_songs with seed artists.
        const seeds = query.seedArtists || [];
        if (seeds.length > 0) {
          console.log(`⚠️  SoundCharts genre filter returned 0 — falling back to artist_songs with seeds [${seeds.join(', ')}]`);
          return executeSoundChartsStrategy(
            { ...query, strategy: 'artist_songs', artists: seeds, expandToSimilar: true },
            fetchCount,
            confirmedArtistUuids,
            minArtists,
            pendingEnrichment
          );
        }
        // No seed artists — last resort: retry without genre filter
        const filtersWithoutGenre = soundchartsFilters.filter(f => f.type !== 'songGenres');
        console.log(`⚠️  SoundCharts genre filter returned 0 and no seed artists — retrying without genre filter`);
        return executeSoundChartsStrategy(
          { ...query, soundchartsFilters: filtersWithoutGenre },
          fetchCount,
          confirmedArtistUuids,
          minArtists,
          pendingEnrichment
        );
      }

      const mappedItems = items
        .filter(item => item.song?.name)  // drop items with no song name
        .map(item => ({
          name: item.song.name,
          artistName: item.song.creditName || 'Unknown',
          isrc: item.song?.isrc?.value || item.song?.isrc || null,
          uuid: item.song?.uuid,
          releaseDate: item.song?.releaseDate || null,
          source: strategy,
          _scEnergy: item.song?.audio?.energy ?? null,
          audio: item.song?.audio || {},
          moods: item.song?.moods || [],
          themes: item.song?.themes || [],
        }));
      if (mappedItems.length < items.length) {
        console.log(`⚠️  Dropped ${items.length - mappedItems.length} SoundCharts items with missing song name`);
      }
      return mappedItems;
    } catch (err) {
      if (err.response?.status === 403) {
        console.log('⚠️  SoundCharts top/songs: 403 — falling back to artist-based discovery');
      } else if (err.response?.status === 404) {
        // 404 = invalid filter value (e.g. unrecognised theme slug or unsupported filter type).
        // Strip exotic filters and retry — keep only core audio/mood/genre filters.
        const EXOTIC_TYPES = new Set(['themes', 'emotionalIntensityScore', 'imageryScore', 'complexityScore', 'rhymeSchemeScore', 'repetitivenessScore', 'liveness']);
        const simplifiedFilters = soundchartsFilters.filter(f => !EXOTIC_TYPES.has(f.type));
        if (simplifiedFilters.length < soundchartsFilters.length) {
          const stripped = soundchartsFilters.filter(f => EXOTIC_TYPES.has(f.type)).map(f => f.type);
          console.log(`⚠️  SC 404 — stripping exotic filters [${stripped.join(', ')}] and retrying`);
          return executeSoundChartsStrategy(
            { ...query, soundchartsFilters: simplifiedFilters },
            fetchCount,
            confirmedArtistUuids,
            minArtists,
            pendingEnrichment
          );
        }
        console.log(`⚠️  SoundCharts error: 404 (no exotic filters to strip) ${err.message}`);
        return [];
      } else {
        console.log(`⚠️  SoundCharts error: ${err.response?.status} ${err.message}`);
        return [];
      }
    }

    // Artist-based fallback (used when top/songs is unavailable)
    const seeds = query.seedArtists || [];
    if (seeds.length === 0) {
      console.log('⚠️  top/songs fallback: no seed artists provided, cannot fall back to artist_songs — returning empty');
      return [];
    }
    let songs = await executeSoundChartsStrategy(
      { ...query, strategy: 'artist_songs', artists: seeds, expandToSimilar: true },
      fetchCount,
      confirmedArtistUuids,
      minArtists,
      pendingEnrichment
    );
    // Apply release date filter if the original query had one
    const rdFilter = soundchartsFilters.find(f => f.type === 'releaseDate');
    if (rdFilter && songs.length > 0) {
      const minYear = rdFilter.data.min ? parseInt(rdFilter.data.min) : null;
      const maxYear = rdFilter.data.max ? parseInt(rdFilter.data.max) : null;
      const before = songs.length;
      songs = songs.filter(song => {
        if (!song.releaseDate) return true;
        const year = new Date(song.releaseDate).getFullYear();
        if (minYear && year < minYear) return false;
        if (maxYear && year > maxYear) return false;
        return true;
      });
      if (before !== songs.length) console.log(`🗓️  Release date filter (${minYear || ''}–${maxYear || ''}): ${before} → ${songs.length} songs`);
    }
    return songs;
  }

  // ── artist_songs ─────────────────────────────────────────────────────────
  if (strategy === 'artist_songs') {
    const expandToSimilar = query.expandToSimilar === true;

    // Phase 1: resolve seed artist infos
    const seedInfos = [];
    const genreInconsistentSeedNames = new Set(); // seeds whose SC genres contradict Claude's extraction
    for (const artistName of artists) {
      let confirmedUuid = confirmedArtistUuids[artistName.toLowerCase()];
      if (confirmedUuid === 'INVALID') {
        console.log(`⏭️  Skipping "${artistName}" — SoundCharts UUID invalidated (genre mismatch with Spotify)`);
        continue;
      }
      // NOSIMILAR: right artist confirmed, but SC has wrong genre/similar data — fetch songs only
      let skipSimilarAndGenres = false;
      if (typeof confirmedUuid === 'string' && confirmedUuid.startsWith('NOSIMILAR:')) {
        skipSimilarAndGenres = true;
        confirmedUuid = confirmedUuid.slice('NOSIMILAR:'.length);
      }
      try {
        const artistInfo = confirmedUuid
          ? await getSoundChartsArtistInfoByUuid(confirmedUuid, artistName)
          : await getSoundChartsArtistInfo(artistName);
        if (artistInfo?.uuid) {
          if (skipSimilarAndGenres) {
            // Don't let this artist's wrong SC genres/similar artists affect the pool filter
            artistInfo.similarArtists = [];
            artistInfo.genres = [];
            console.log(`🎵 "${artistName}" — fetching songs only (SC genre data unreliable, using Spotify genres)`);
          }
          seedInfos.push(artistInfo);
        } else console.log(`⚠️  Could not find "${artistName}" on SoundCharts`);
      } catch (err) {
        console.log(`⚠️  Error looking up "${artistName}": ${err.message}`);
      }
    }

    // Phase 2: expand with similar artists (1 level, 2 per seed) for variety
    let allArtistInfos = [...seedInfos];
    if (expandToSimilar && seedInfos.length > 0) {
      const seenNames = new Set(seedInfos.map(a => a.name.toLowerCase()));
      const similarNames = []; // { name, uuid } pairs — uuid may be null
      // Scale similar-artist target with pool size: ~1 artist per 8 songs needed, min 10, max 20.
      // Cap at 20 to avoid runaway serial SC calls for large song counts (each call is ~300ms).
      // minArtists overrides the cap when per-artist diversity requires more unique artists.
      const similarTarget = Math.max(
        minArtists > 0 ? minArtists : 0,
        Math.min(Math.max(10, Math.ceil(fetchCount / 8)), 20)
      );
      const similarPerSeed = Math.max(2, Math.ceil(similarTarget / seedInfos.length));
      for (const seedInfo of seedInfos) {
        let added = 0;
        for (const simName of (seedInfo.similarArtists || [])) {
          if (added >= similarPerSeed) break;
          if (seenNames.has(simName.toLowerCase())) continue;
          seenNames.add(simName.toLowerCase());
          // Preserve the SC UUID from the similarity graph so we can pass it as a hint
          // when looking up the artist — prevents name-collision bugs (e.g. two "Dante"s)
          const simUuid = seedInfo._similarUuids?.[simName.toLowerCase()] || null;
          similarNames.push({ name: simName, uuid: simUuid });
          added++;
        }
      }
      // Derive expected genres from the seed artists' actual SoundCharts genres — much more
      // reliable than Claude's extraction for underground/niche artists Claude may not know.
      // Fall back to Claude's extracted genre (from soundchartsFilters) only when seeds have
      // no genre metadata at all.
      //
      // Guard: if Claude has a clear genre extraction, exclude any seed whose SC genres have
      // zero overlap with Claude's genres — this prevents a single mislabeled SC artist (e.g.
      // a trap-soul artist tagged as electro/techno) from poisoning the entire genre filter.
      const genreFilter = soundchartsFilters.find(f => f.type === 'songGenres');
      const claudeGenres = (genreFilter?.data?.values || []).map(g => g.toLowerCase());
      const normalizeGenreEarly = g => g.toLowerCase().replace(/[^a-z0-9]/g, '');
      const claudeNorms = claudeGenres.map(normalizeGenreEarly);

      let seedActualGenres;
      if (claudeNorms.length > 0) {
        // Only include genres from seeds that have at least one genre overlapping with Claude's
        const consistentSeeds = seedInfos.filter(s => {
          if (!s.genres || s.genres.length === 0) return false; // no SC genre data — neutral
          const sNorms = s.genres.map(g => normalizeGenreEarly(g));
          return sNorms.some(sg => claudeNorms.some(cg => sg === cg || sg.startsWith(cg) || cg.startsWith(sg)));
        });
        const droppedSeeds = seedInfos.filter(s => s.genres?.length > 0 && !consistentSeeds.includes(s));
        droppedSeeds.forEach(s => {
          console.log(`⚠️  Dropping "${s.name}" genres [${s.genres.join(', ')}] from genre filter — inconsistent with Claude's extraction [${claudeGenres.join(', ')}]`);
          genreInconsistentSeedNames.add(s.name.toLowerCase());
        });
        seedActualGenres = [...new Set(consistentSeeds.flatMap(s => (s.genres || []).map(g => g.toLowerCase())))];
      } else {
        seedActualGenres = [...new Set(seedInfos.flatMap(s => (s.genres || []).map(g => g.toLowerCase())))];
      }

      const expectedGenres = seedActualGenres.length > 0 ? seedActualGenres : claudeGenres;
      if (seedActualGenres.length > 0) {
        console.log(`🎯 Similar-artist genre filter: using seed genres [${seedActualGenres.join(', ')}] (not Claude's extraction)`);
      }

      // Normalize genre strings for comparison — strip punctuation and spaces so
      // 'r&b', 'r-b', 'r b' all collapse to 'rb'; 'hip hop' and 'hip-hop' both → 'hiphop'.
      const normalizeGenre = g => g.toLowerCase().replace(/[^a-z0-9]/g, '');
      // An artist "has" a genre if any of their genre strings, when normalized, equal or start with
      // the expected slug (covers 'r-b/soul' matching 'r-b', etc.)
      const artistHasGenre = (artistGenres, expected) => {
        const expNorm = normalizeGenre(expected);
        return artistGenres.some(ag => {
          const agNorm = normalizeGenre(ag);
          return agNorm === expNorm || agNorm.startsWith(expNorm + '/') || agNorm.startsWith(expNorm + '-') || agNorm.includes(expNorm);
        });
      };

      // Genres that indicate a stylistically incompatible artist when the seed doesn't have them.
      // Use EXACT normalised match only — substring matching would block 'alternative r&b' artists
      // (Frank Ocean, Steve Lacy) because they contain the word 'alternative'.
      const contrastingGenres = ['rock', 'k-rock', 'j-rock', 'alternative', 'metal', 'punk',
        'country', 'jazz', 'classical', 'folk', 'blues', 'gospel', 'bluegrass'];
      const seedGenreSet = new Set(seedInfos.flatMap(s => (s.genres || []).map(g => normalizeGenre(g))));
      const seedHasContrastingGenre = contrastingGenres.some(g => seedGenreSet.has(normalizeGenre(g)));
      // Exact-match check: artist genre must normalise to exactly the contrasting genre string
      const artistHasExactGenre = (artistGenres, target) => {
        const tNorm = normalizeGenre(target);
        return artistGenres.some(ag => normalizeGenre(ag) === tNorm);
      };

      // If every seed that carries SC genre data is genre-inconsistent (e.g. all seeds
      // resolved to metal artists for an R&B playlist), the entire traversal graph is
      // poisoned.  Skip expansion so no-genre depth-1/2 artists (Blutzeugen Official, etc.)
      // can't sneak through the unknown-genre pool-overlap check.  The supplement flow will
      // find correct artists using Claude's genre extraction instead.
      const genreBearingSeeds = seedInfos.filter(s => s.genres?.length > 0);
      const allGenreBearingInconsistent =
        genreBearingSeeds.length > 0 &&
        genreBearingSeeds.every(s => genreInconsistentSeedNames.has(s.name.toLowerCase()));
      const hasConfirmedSeeds = seedInfos.some(s => {
        const cu = confirmedArtistUuids[s.name.toLowerCase()];
        return cu && cu !== 'INVALID' && !String(cu).startsWith('NOSIMILAR:');
      });
      // Normalized primary genre slug — used for strict depth-1 AND depth-2 checks.
      // Defined here (before depth-1 loop) so both phases share the same value.
      const _primaryNorm = query?.primaryGenre ? normalizeGenre(query.primaryGenre) : null;

      if (allGenreBearingInconsistent && !hasConfirmedSeeds) {
        console.log(`⛔ Every genre-bearing seed is genre-inconsistent — skipping SC graph traversal entirely. Supplement flow will find correct artists.`);
        allArtistInfos = [];
      } else {
        if (allGenreBearingInconsistent) {
          console.log(`⚠️  All genre-bearing seeds inconsistent but confirmed reference artist(s) present — traversing their similarity graph with Claude's genre filter.`);
        }
        for (const { name: simName, uuid: simUuid } of similarNames) {
        try {
          const simInfo = await getSoundChartsArtistInfo(simName, null, simUuid);
          if (!simInfo?.uuid) continue;
          const artistGenres = (simInfo.genres || []).map(g => g.toLowerCase());

          // 1. Must include the expected genre (e.g. r&b) — prevents genre drift.
          if (expectedGenres.length > 0 && artistGenres.length > 0 && !expectedGenres.some(g => artistHasGenre(artistGenres, g))) {
            console.log(`⏭️  Skipping "${simInfo.name}" — missing expected genre [${expectedGenres.join(', ')}]`);
            continue;
          }
          // 1c. Strict primary-genre check for depth-1: same logic as depth-2 — when
          // primaryGenre is set, require at least one of the artist's genres to contain
          // the primary genre slug. Prevents e.g. Italian neo-soul artists entering an
          // R&B playlist because they have 'soul' but not 'r&b' in their SC genres.
          if (_primaryNorm && artistGenres.length > 0 && !artistGenres.some(g => normalizeGenre(g).includes(_primaryNorm))) {
            console.log(`⏭️  Skipping "${simInfo.name}" (depth-1) — missing primary genre "${query.primaryGenre}" in genres [${artistGenres.join(', ')}]`);
            continue;
          }
          // 1b. If the artist has NO genre data, check whether their own SC similar artists
          // overlap with our seed pool. A legitimate underground artist in this genre will
          // usually have similar artists that include seeds we already know; a completely
          // unrelated artist (wrong SC match, different genre) won't.
          if (expectedGenres.length > 0 && artistGenres.length === 0) {
            const theirSimilar = (simInfo.similarArtists || []).map(n => n.toLowerCase());
            const hasPoolOverlap = theirSimilar.some(n => seenNames.has(n));
            if (!hasPoolOverlap) {
              console.log(`⏭️  Skipping "${simInfo.name}" — no genre data and no similar-artist overlap with seed pool`);
              continue;
            }
          }
          // 2. If seed has no contrasting genres, reject similar artists that do —
          //    e.g. seed is pure pop → reject rock artists. Uses exact match so
          //    'alternative r&b' does NOT trigger the 'alternative' contrasting-genre block.
          if (!seedHasContrastingGenre && contrastingGenres.some(g => artistHasExactGenre(artistGenres, g))) {
            console.log(`⏭️  Skipping "${simInfo.name}" — has contrasting genres [${artistGenres.filter(g => contrastingGenres.some(c => artistHasExactGenre([g], c))).join(', ')}]`);
            continue;
          }

          allArtistInfos.push(simInfo);
        } catch (err) { /* skip */ }
      }
      } // end else (traversal)
      console.log(`🎨 Artist pool: ${seedInfos.length} seeds + ${allArtistInfos.length - seedInfos.length} similar = ${allArtistInfos.length} artists`);
      console.log(`🌱 Seeds: [${seedInfos.map(s => s.name).join(', ')}]`);

      // Phase 2b: expand with depth-2 similar artists only when the depth-1 pool is small.
      // With 8+ artists depth-1 already provides enough diversity; unconditional depth-2
      // causes graph drift (e.g. Bruno Mars and Kendrick entering a sad R&B playlist via
      // a misidentified seed’s wrong similar-artist graph).
      const DEPTH2_MAX = 15;
      const DEPTH2_MIN_POOL = 8; // only expand when depth-1 found fewer than this many artists
      if (allArtistInfos.length >= DEPTH2_MIN_POOL) {
        console.log(`⏩ Skipping depth-2 expansion — depth-1 pool already has ${allArtistInfos.length} artists`);
      } else {
      console.log(`🔍 Phase 2b: depth-1 pool has ${allArtistInfos.length} artists (< ${DEPTH2_MIN_POOL}) — expanding with depth-2 similar artists...`);
      const depth2Candidates = []; // { name, uuid } pairs
      for (const artistInfo of allArtistInfos) {
        for (const name of (artistInfo.similarArtists || [])) {
          if (seenNames.has(name.toLowerCase())) continue;
          seenNames.add(name.toLowerCase());
          const uuid = artistInfo._similarUuids?.[name.toLowerCase()] || null;
          depth2Candidates.push({ name, uuid });
          if (depth2Candidates.length >= DEPTH2_MAX * 3) break;
        }
        if (depth2Candidates.length >= DEPTH2_MAX * 3) break;
      }

      let depth2Added = 0;
      for (const { name, uuid: d2Uuid } of depth2Candidates) {
        if (depth2Added >= DEPTH2_MAX) break;
        try {
          const info = await getSoundChartsArtistInfo(name, null, d2Uuid);
          if (!info?.uuid) continue;
          const artistGenres = (info.genres || []).map(g => g.toLowerCase());
          if (expectedGenres.length > 0 && artistGenres.length > 0 && !expectedGenres.some(g => artistHasGenre(artistGenres, g))) continue;
          if (!seedHasContrastingGenre && contrastingGenres.some(g => artistHasExactGenre(artistGenres, g))) continue;
          // Stricter depth-2 check: when primaryGenre is set, require at least one of the
          // artist's genres to contain the primary genre slug. This prevents secondary genres
          // from seeds (e.g. 'hip hop' on an R&B artist) from admitting pure hip-hop artists
          // like Tyler, the Creator into an R&B playlist via depth-2 graph drift.
          if (_primaryNorm && artistGenres.length > 0 && !artistGenres.some(g => normalizeGenre(g).includes(_primaryNorm))) continue;
          // Same unknown-genre pool-overlap check as depth-1: if no genre data, require that
          // at least one of this artist's similar artists overlaps with the known seed pool.
          if (expectedGenres.length > 0 && artistGenres.length === 0) {
            const theirSimilar = (info.similarArtists || []).map(n => n.toLowerCase());
            if (!theirSimilar.some(n => seenNames.has(n))) continue;
          }
          allArtistInfos.push(info);
          depth2Added++;
        } catch (err) { /* skip */ }
      }

      if (depth2Added > 0) {
        console.log(`🎨 Artist pool after depth-2 expansion: ${allArtistInfos.length} total (+${depth2Added} new artists)`);
      }
      } // end else (depth-2 expansion — only when pool < DEPTH2_MIN_POOL)
    }

    // Phase 3: fetch songs.
    // Strategy: run top_songs with the genre filter and keep only songs whose credited
    // artist is in the pool. This gives popular, Spotify-findable tracks from relevant
    // artists instead of alphabetically-sorted deep cuts from the SoundCharts song list.
    // For artists that don't appear in top_songs (underground/niche), supplement with
    // direct artist song fetches.
    let songs = [];
    const poolNames = new Set(allArtistInfos.map(a => a.name.toLowerCase()));

    // 3a: top_songs pass — popular songs from artists in the pool.
    // Use only the genre filter (not energy/valence) to maximise the result set.
    // Paginate up to 1000 songs so niche artists in the pool are more likely to appear.
    // Vibe filtering (energy/valence) is not needed here — Phase 3b and the main vibe
    // check handle it. This replaces full-catalog fetches for artists that chart.
    const genreFilterForSongs = soundchartsFilters.find(f => f.type === 'songGenres');
    if (genreFilterForSongs) {
      try {
        const sort = soundchartsSort || { type: 'metric', platform: 'spotify', metricType: 'streams', period: 'month', sortBy: 'total', order: 'desc' };
        const body = { sort, filters: [genreFilterForSongs] };
        const PAGE_SIZE_3A = 500;
        const MAX_PAGES_3A = 2; // up to 1000 songs
        let allTopItems = [];
        for (let page = 0; page < MAX_PAGES_3A; page++) {
          await throttleSoundCharts();
          const resp = await axios.post(
            'https://customer.api.soundcharts.com/api/v2/top/songs',
            body,
            { headers: { 'x-app-id': appId, 'x-api-key': apiKey, 'Content-Type': 'application/json' }, params: { offset: page * PAGE_SIZE_3A, limit: PAGE_SIZE_3A }, timeout: 15000 }
          );
          const items = resp.data?.items || [];
          allTopItems = allTopItems.concat(items);
          if (items.length < PAGE_SIZE_3A) break;
        }
        const poolMatches = allTopItems.filter(item => {
          const creditName = (item.song?.creditName || '').toLowerCase();
          return poolNames.has(creditName) || allArtistInfos.some(a => creditName.includes(a.name.toLowerCase()) || a.name.toLowerCase().includes(creditName));
        });
        for (const item of poolMatches) {
          if (item.song?.name) {
            songs.push({
              name: item.song.name,
              artistName: item.song.creditName || 'Unknown',
              isrc: item.song?.isrc?.value || item.song?.isrc || null,
              uuid: item.song?.uuid,
              releaseDate: item.song?.releaseDate || null,
              source: 'artist_pool_top',
              _scEnergy: item.song?.audio?.energy ?? null,
            });
          }
        }
        console.log(`🎯 Artist pool top_songs: ${poolMatches.length} songs matched from pool of ${allArtistInfos.length} artists (scanned ${allTopItems.length} genre songs)`);
      } catch (err) {
        console.log(`⚠️  Artist pool top_songs fetch failed: ${err.message}`);
      }
    }

    // 3b: direct artist songs for artists not represented in top_songs results
    const representedArtists = new Set(songs.map(s => s.artistName.toLowerCase()));
    const unrepresented = allArtistInfos.filter(a =>
      !representedArtists.has(a.name.toLowerCase()) &&
      !genreInconsistentSeedNames.has(a.name.toLowerCase())
    );
    if (genreInconsistentSeedNames.size > 0) {
      console.log(`⛔ Skipping songs from genre-inconsistent seeds: ${[...genreInconsistentSeedNames].join(', ')}`);
    }
    const songsPerArtist = Math.max(Math.ceil(fetchCount / Math.max(unrepresented.length, 1)), 10);
    for (const artistInfo of unrepresented) {
      try {
        // Check DB cache for a previously enriched full catalog (populated by background enrichment).
        // Cache hit: vibe-filter with energy/valence so we don't return upbeat songs for sad prompts.
        // Cache miss: quick fetch for now, schedule background enrichment for next time.
        const catalogKey = `full_catalog:${artistInfo.uuid}`;
        const cachedCatalog = await db.getCachedSC(catalogKey);
        if (cachedCatalog?.songs?.length > 0) {
          const mainSongs = cachedCatalog.songs.filter(s => !/\b(live|remix|karaoke|instrumental|bonus|interlude|skit|intro|outro)\b/i.test(s.name));
          const pool = mainSongs.length > 0 ? mainSongs : cachedCatalog.songs;
          const enriched = await enrichCatalogWithAudioFeatures(pool, 40);
          const vibeFiltered = filterCatalogByVibe(enriched, query.soundchartsFilters, songsPerArtist);
          for (const song of vibeFiltered) {
            songs.push({ ...song, artistName: artistInfo.name, source: 'artist_songs', _scEnergy: song.audio?.energy ?? null });
          }
          console.log(`✓ [CACHED] ${vibeFiltered.length}/${pool.length} vibe-filtered songs for "${artistInfo.name}"`);
        } else {
          // No cache: quick fetch so the user isn't blocked, then enrich in the background.
          const artistSongs = await getSoundChartsArtistSongs(artistInfo.uuid, Math.max(songsPerArtist, 20));
          const mainSongs = artistSongs.filter(s => !/\b(live|remix|karaoke|instrumental|bonus|interlude|skit|intro|outro)\b/i.test(s.name));
          for (const song of (mainSongs.length > 0 ? mainSongs : artistSongs).slice(0, songsPerArtist)) {
            songs.push({ ...song, artistName: artistInfo.name, source: 'artist_songs', _scEnergy: null });
          }
          console.log(`✓ [QUICK] ${Math.min((mainSongs.length > 0 ? mainSongs : artistSongs).length, songsPerArtist)} songs for "${artistInfo.name}" — queued for background enrichment`);
          // Queue for enrichment after res.json() — caller drains pendingEnrichment post-response.
          if (pendingEnrichment) pendingEnrichment.push(artistInfo);
        }
      } catch (err) {
        console.log(`⚠️  Error fetching songs for "${artistInfo.name}": ${err.message}`);
      }
    }

    // Queue all uncached pool artists (including Phase 3a ones and similar artists from
    // depth-1/depth-2 expansion) for background enrichment. This warms the cache for
    // future requests so Phase 3b hits the fast vibe-filtered path next time.
    if (pendingEnrichment) {
      const alreadyQueued = new Set(pendingEnrichment.map(a => a.uuid));
      for (const artistInfo of allArtistInfos) {
        if (alreadyQueued.has(artistInfo.uuid)) continue;
        const catalogKey = `full_catalog:${artistInfo.uuid}`;
        const cached = db.getCachedSC(catalogKey);
        if (!cached?.songs?.length) {
          pendingEnrichment.push(artistInfo);
          alreadyQueued.add(artistInfo.uuid);
        }
      }
    }

    // Phase 4: shuffle so artists interleave (prevents one artist dominating)
    for (let i = songs.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [songs[i], songs[j]] = [songs[j], songs[i]];
    }

    // Phase 5a: drop songs whose names have no alphanumeric characters (e.g. Coldplay symbol tracks ⦵ ❍ ♡)
    // These can't be found via Spotify/Apple Music name search and Phase A rarely resolves them
    const beforeSymbolFilter = songs.length;
    songs = songs.filter(song => /[a-zA-Z0-9]/.test(song.name || ''));
    if (songs.length < beforeSymbolFilter) {
      console.log(`🧹 Symbol filter: removed ${beforeSymbolFilter - songs.length} unsearchable tracks`);
    }

    // Phase 5: deduplicate variants (remixes, karaoke, commentaries, etc.)
    const normalizeTitle = (t) => (t || '').toLowerCase()
      .replace(/\s*[\(\[].*?[\)\]]/g, '')
      .replace(/\s*-\s*(remix|edit|mix|version|live|acoustic|instrumental|karaoke|radio|extended|remaster.*|taylor's version).*$/i, '')
      .replace(/\s+/g, ' ').trim();
    const seenTitles = new Set();
    const deduped = songs.filter(song => {
      const key = `${normalizeTitle(song.name)}::${(song.artistName || '').toLowerCase()}`;
      if (seenTitles.has(key)) return false;
      seenTitles.add(key);
      return true;
    });
    if (deduped.length < songs.length) {
      console.log(`🧹 Deduped: ${songs.length} → ${deduped.length} (removed ${songs.length - deduped.length} variant tracks)`);
    }
    return deduped;
  }

  return [];
}


function isEmailBasedUserId(userId) {
  // Email-based userIds contain @ symbol
  return userId && userId.includes('@');
}

// Helper function to get email userId from platform-specific userId
async function getEmailUserIdFromPlatform(platformUserId) {
  if (isEmailBasedUserId(platformUserId)) {
    return platformUserId; // Already email-based
  }

  // Platform userId format: spotify_xxx or apple_music_xxx
  // Query platform_user_ids table to find the email with this platform ID
  try {
    const email = await db.getEmailFromPlatformUserId(platformUserId);

    if (email) {
      console.log(`Resolved platform userId ${platformUserId} to email: ${email}`);
      return email;
    }
  } catch (error) {
    console.error('Error looking up email for platform userId:', error);
  }

  // Fallback: return the platform userId if no email found
  console.warn(`Could not find email for platform userId: ${platformUserId}, using platform userId as fallback`);
  return platformUserId;
}

// Helper function to get user tokens (from memory or database)
async function getUserTokens(userId) {
  // Try to get from memory first
  let tokens = userTokens.get(userId);

  // If not in memory, try loading from database
  if (!tokens) {
    console.log('Tokens not in memory, loading from database for userId:', userId);
    tokens = await db.getToken(userId);
    if (tokens) {
      userTokens.set(userId, tokens);
      console.log('Loaded tokens from database for userId:', userId);
    }
  }

  return tokens;
}

// Load playlists from database (for PostgreSQL) or file (for SQLite)
async function loadPlaylistsFromDB() {
  if (usePostgres) {
    try {
      const playlistsByUser = await db.getAllPlaylists();
      const userPlaylistsMap = new Map();
      for (const [userId, playlists] of Object.entries(playlistsByUser)) {
        userPlaylistsMap.set(userId, playlists);
      }
      console.log('Loaded playlists for', userPlaylistsMap.size, 'users from database');
      return userPlaylistsMap;
    } catch (error) {
      console.error('Error loading playlists from database:', error);
      return new Map();
    }
  } else {
    // Fallback to file-based storage for SQLite
    return loadPlaylistsFromFile();
  }
}

// Load playlists from file (SQLite fallback)
function loadPlaylistsFromFile() {
  try {
    if (fs.existsSync(PLAYLISTS_FILE)) {
      const data = fs.readFileSync(PLAYLISTS_FILE, 'utf8');
      const playlistsObj = JSON.parse(data);
      console.log('Loaded playlists for', Object.keys(playlistsObj).length, 'users from file');
      return new Map(Object.entries(playlistsObj));
    }
  } catch (error) {
    console.error('Error loading playlists from file:', error);
  }
  return new Map();
}

// Save playlist to database or file
async function savePlaylist(userId, playlistData) {
  // Always keep the in-memory map in sync (used by mutation routes like react-to-song)
  const userPlaylistsArray = userPlaylists.get(userId) || [];
  const existingIndex = userPlaylistsArray.findIndex(p => p.playlistId === playlistData.playlistId);
  if (existingIndex >= 0) {
    userPlaylistsArray[existingIndex] = playlistData;
  } else {
    userPlaylistsArray.push(playlistData);
  }
  userPlaylists.set(userId, userPlaylistsArray);

  if (usePostgres) {
    try {
      await db.savePlaylist(userId, playlistData.playlistId, playlistData);
    } catch (error) {
      console.error('Error saving playlist to database:', error);
    }

    // Record all artists from this playlist for history tracking
    try {
      const tracks = playlistData.tracks || [];
      const artistNames = [...new Set(
        tracks.map(t => t.artist).filter(Boolean)
      )];
      if (artistNames.length > 0) {
        await db.trackArtists(userId, artistNames);
      }
    } catch (error) {
      // Non-critical — don't fail the save
    }
  } else {
    // Save to file
    savePlaylistsToFile();
  }
}

// Delete playlist from database or file
async function deletePlaylist(userId, playlistId) {
  if (usePostgres) {
    try {
      await db.deletePlaylist(userId, playlistId);
    } catch (error) {
      console.error('Error deleting playlist from database:', error);
    }
  } else {
    // Remove from in-memory map
    const userPlaylistsArray = userPlaylists.get(userId) || [];
    const filtered = userPlaylistsArray.filter(p => p.playlistId !== playlistId);
    userPlaylists.set(userId, filtered);
    // Save to file
    savePlaylistsToFile();
  }
}

// Save all playlists to file (SQLite only)
function savePlaylistsToFile() {
  if (!usePostgres) {
    try {
      const playlistsObj = Object.fromEntries(userPlaylists);
      fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(playlistsObj, null, 2));
    } catch (error) {
      console.error('Error saving playlists to file:', error);
    }
  }
}

// Load users from file on startup
function loadUsers() {
  try {
    if (fs.existsSync(USERS_FILE)) {
      const data = fs.readFileSync(USERS_FILE, 'utf8');
      const usersObj = JSON.parse(data);
      console.log('Loaded', Object.keys(usersObj).length, 'registered users from file');
      return new Map(Object.entries(usersObj));
    }
  } catch (error) {
    console.error('Error loading users:', error);
  }
  return new Map();
}

// Save users to file - NO LONGER NEEDED (using database)
function saveUsers() {
  // Database auto-saves, this function is kept for compatibility
}

// Load reactions from file on startup
function loadReactions() {
  try {
    if (fs.existsSync(REACTIONS_FILE)) {
      const data = fs.readFileSync(REACTIONS_FILE, 'utf8');
      const reactionsObj = JSON.parse(data);
      console.log('Loaded reactions for', Object.keys(reactionsObj).length, 'playlists from file');
      return new Map(Object.entries(reactionsObj));
    }
  } catch (error) {
    console.error('Error loading reactions:', error);
  }
  return new Map();
}

// Save reactions to file
function saveReactions() {
  try {
    const reactionsObj = Object.fromEntries(playlistReactions);
    fs.writeFileSync(REACTIONS_FILE, JSON.stringify(reactionsObj, null, 2));
  } catch (error) {
    console.error('Error saving reactions:', error);
  }
}

// Load saved playlists from file on startup
function loadSavedPlaylists() {
  try {
    if (fs.existsSync(SAVED_PLAYLISTS_FILE)) {
      const data = fs.readFileSync(SAVED_PLAYLISTS_FILE, 'utf8');
      const savedObj = JSON.parse(data);
      console.log('Loaded saved playlists for', Object.keys(savedObj).length, 'users from file');
      return new Map(Object.entries(savedObj));
    }
  } catch (error) {
    console.error('Error loading saved playlists:', error);
  }
  return new Map();
}

// Save saved playlists to file
function saveSavedPlaylists() {
  try {
    const savedObj = Object.fromEntries(userSavedPlaylists);
    fs.writeFileSync(SAVED_PLAYLISTS_FILE, JSON.stringify(savedObj, null, 2));
  } catch (error) {
    console.error('Error saving saved playlists:', error);
  }
}

// Returns the UTC moment for the next 5 AM occurrence in the given timezone.
// Uses Intl.DateTimeFormat.formatToParts throughout — no locale string parsing.
function getNext5AM(timezone, now = new Date()) {
  const tz = timezone || 'America/Los_Angeles';

  // Get current date components in the target timezone
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', hour12: false
  }).formatToParts(now);

  let tzYear = 0, tzMonth = 0, tzDay = 0, tzHour = 0, tzMinute = 0;
  for (const p of parts) {
    if (p.type === 'year') tzYear = parseInt(p.value);
    if (p.type === 'month') tzMonth = parseInt(p.value);
    if (p.type === 'day') tzDay = parseInt(p.value);
    if (p.type === 'hour') tzHour = parseInt(p.value);
    if (p.type === 'minute') tzMinute = parseInt(p.value);
  }

  // If it's already past 5 AM in the target timezone, schedule for tomorrow
  const targetDay = (tzHour > 5 || (tzHour === 5 && tzMinute > 0)) ? tzDay + 1 : tzDay;

  // Build naive UTC for "targetDay at 05:00 in tz"
  const naiveUtc = new Date(Date.UTC(tzYear, tzMonth - 1, targetDay, 5, 0, 0));

  // Get what the clock reads in the target timezone for that naive moment
  const clockParts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric', hour12: false
  }).formatToParts(naiveUtc);

  let cYear = 0, cMonth = 0, cDay = 0, cH = 0, cMin = 0, cSec = 0;
  for (const p of clockParts) {
    if (p.type === 'year') cYear = parseInt(p.value);
    if (p.type === 'month') cMonth = parseInt(p.value);
    if (p.type === 'day') cDay = parseInt(p.value);
    if (p.type === 'hour') cH = parseInt(p.value);
    if (p.type === 'minute') cMin = parseInt(p.value);
    if (p.type === 'second') cSec = parseInt(p.value);
  }
  if (cH === 24) cH = 0;

  const clockAsUtc = Date.UTC(cYear, cMonth - 1, cDay, cH, cMin, cSec);
  const targetAsUtc = Date.UTC(tzYear, tzMonth - 1, targetDay, 5, 0, 0);
  const correctionMs = targetAsUtc - clockAsUtc;

  return new Date(naiveUtc.getTime() + correctionMs);
}

// Calculate next update date based on frequency and user's timezone.
// Always schedules at 5 AM in the user's local timezone (detected from IP).
function calculateNextUpdate(frequency, playlistId = null, updateTime = null) {
  const now = new Date();
  const timezone = updateTime?.timezone || 'America/Los_Angeles';

  let next = getNext5AM(timezone, now);

  // Adjust based on frequency
  switch (frequency) {
    case 'daily':
      // getNext5AM already returns the next 5 AM — nothing extra needed
      break;
    case 'weekly':
      next.setDate(next.getDate() + 7);
      break;
    case 'monthly':
      next.setMonth(next.getMonth() + 1);
      break;
    default:
      return null;
  }

  const localStr = next.toLocaleString('en-US', { timeZone: timezone, dateStyle: 'medium', timeStyle: 'short' });
  console.log(`[SCHEDULE] Next update: ${next.toISOString()} UTC = ${localStr} (${timezone})`);
  return next.toISOString();
}

// Detect timezone from request IP using geoip-lite
function getTimezoneFromRequest(req) {
  const forwarded = req.headers['x-forwarded-for'];
  const ip = forwarded ? forwarded.split(',')[0].trim() : req.ip;
  // Strip IPv6 prefix if present (e.g. ::ffff:1.2.3.4)
  const cleanIp = ip?.replace(/^::ffff:/, '');
  const geo = geoip.lookup(cleanIp);
  return geo?.timezone || 'America/Los_Angeles';
}

// Database-backed token storage
const userTokens = {
  get: (userId) => db.getToken(userId),
  set: (userId, tokenData) => db.setToken(userId, tokenData),
  has: (userId) => db.getToken(userId) !== null,
  delete: (userId) => db.deleteToken(userId)
};

// Database-backed user storage
const registeredUsers = {
  get: (email) => db.getUser(email),
  set: (email, userData) => {
    const existing = db.getUser(email);
    if (existing) {
      // Only call updateUser if we have all required fields
      if (userData.password && userData.platform && userData.userId) {
        db.updateUser(email, userData);
      }
      // Update individual fields as needed
      if (userData.userId && (!userData.password || !userData.platform)) {
        db.updateUserId(email, userData.userId);
      }
      if (userData.connectedPlatforms) {
        db.updatePlatforms(email, userData.connectedPlatforms);
      }
    } else {
      db.createUser(email, userData.password, userData.platform, userData.userId);
      if (userData.connectedPlatforms) {
        db.setConnectedPlatforms(email, userData.connectedPlatforms.spotify, userData.connectedPlatforms.apple);
      }
    }
  },
  has: (email) => db.getUser(email) !== null,
  delete: (email) => db.deleteUser(email)
};

// Store user playlists (persisted to database in production, file in development)
let userPlaylists = new Map();

// Store playlist reactions (persisted to file)
// Format: { playlistId: { thumbsUp: [userId1, userId2], thumbsDown: [userId3] } }
const playlistReactions = loadReactions();

// Store user saved playlists (persisted to file)
// Format: { userId: [playlistId1, playlistId2, ...] }
const userSavedPlaylists = loadSavedPlaylists();

// Routes

// Check if email is already registered (used on signup form before showing password field)
app.post('/api/check-email', async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: 'Email is required' });
  const existing = await db.getUser(email.trim().toLowerCase());
  res.json({ exists: !!existing });
});

// User Signup
app.post('/api/signup', async (req, res) => {
  console.log('📱 Signup request received:', { email: req.body.email, platform: req.body.platform });
  try {
    const { email, password, platform } = req.body;

    if (!email || !password || !platform) {
      console.log('❌ Missing required fields');
      return res.status(400).json({ error: 'Email, password, and platform are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Check if user already exists (await for PostgreSQL compatibility)
    const existingUser = await db.getUser(normalizedEmail);
    if (existingUser) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    // Create user in database
    await db.createUser(normalizedEmail, password, platform, normalizedEmail);

    saveUsers();

    // Generate a simple auth token (in production, use JWT)
    const token = Buffer.from(`${normalizedEmail}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      token: token,
      email: normalizedEmail,
      platform: platform,
      userId: normalizedEmail,
      plan: 'free',
    });
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).json({
      error: 'Failed to create account',
      details: error.message
    });
  }
});

// User Login
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const normalizedEmail = email.trim().toLowerCase();

    // Get user from database (not cache) to ensure we have latest password
    const user = await db.getUser(normalizedEmail);

    if (!user) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (user.password !== password) { // TODO: Use proper password hashing comparison
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Update in-memory cache with latest user data
    registeredUsers.set(normalizedEmail, user);

    // Generate auth token
    const token = Buffer.from(`${normalizedEmail}:${Date.now()}`).toString('base64');

    // Return email as userId (platform-independent)
    res.json({
      success: true,
      token: token,
      email: normalizedEmail,
      platform: user.platform,
      userId: normalizedEmail, // Always use email as userId
      plan: user.plan || 'free',
      productTourCompleted: user.productTourCompleted || false,
      allowExplicit: user.allowExplicit !== false,
      darkMode: user.darkMode || false,
    });
  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Failed to login',
      details: error.message
    });
  }
});

// Request password reset
app.post('/api/forgot-password', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = await db.getUser(normalizedEmail);

    // Always return success even if user doesn't exist (security best practice)
    if (!user) {
      return res.json({ success: true, message: 'If an account exists with that email, you will receive a password reset link.' });
    }

    // Generate reset token
    const resetToken = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 3600000).toISOString(); // 1 hour from now

    // Save reset token to database
    await db.createResetToken(normalizedEmail, resetToken, expiresAt);

    // Create reset link
    const resetLink = `${FRONTEND_URL}/reset-password?token=${resetToken}`;

    // Send email
    try {
      await sendEmail({
        to: normalizedEmail,
        subject: 'Password Reset Request - AI Playlist Creator',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
            <h2 style="color: #333;">Password Reset Request</h2>
            <p>You requested to reset your password for AI Playlist Creator.</p>
            <p>Click the button below to reset your password:</p>
            <div style="text-align: center; margin: 30px 0;">
              <a href="${resetLink}" style="background-color: #000000; color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; display: inline-block;">Reset Password</a>
            </div>
            <p>Or copy and paste this link into your browser:</p>
            <p style="word-break: break-all; color: #666;">${resetLink}</p>
            <p style="color: #999; font-size: 14px;">This link will expire in 1 hour.</p>
            <p style="color: #999; font-size: 14px;">If you didn't request this, please ignore this email.</p>
          </div>
        `
      });
      console.log(`Password reset email sent to ${normalizedEmail}`);
    } catch (emailError) {
      console.error('Failed to send password reset email:', emailError.message);
      // Log the link so it's not completely lost
      console.log(`Password reset link for ${normalizedEmail}: ${resetLink}`);
    }

    res.json({ success: true, message: 'If an account exists with that email, you will receive a password reset link.' });
  } catch (error) {
    console.error('Forgot password error:', error);
    res.status(500).json({
      error: 'Failed to process password reset request',
      details: error.message
    });
  }
});

// Verify reset token
app.get('/api/verify-reset-token/:token', async (req, res) => {
  try {
    const { token } = req.params;

    const resetToken = await db.getResetToken(token);

    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const now = new Date();
    const expiresAt = new Date(resetToken.expires_at);
    if (expiresAt < now) {
      await db.deleteResetToken(resetToken.email);
      return res.status(400).json({ error: 'Reset token has expired' });
    }

    res.json({ success: true, email: resetToken.email });
  } catch (error) {
    console.error('Verify reset token error:', error);
    res.status(500).json({
      error: 'Failed to verify reset token',
      details: error.message
    });
  }
});

// User feedback
app.post('/api/feedback', async (req, res) => {
  try {
    const { userId, email, rating, message } = req.body;
    if (!message && !rating) {
      return res.status(400).json({ error: 'Message or rating required' });
    }
    const stars = rating ? '★'.repeat(rating) + '☆'.repeat(5 - rating) : 'No rating';
    const html = `
      <h2>New Feedback from Fins</h2>
      <p><strong>User:</strong> ${email || userId || 'Anonymous'}</p>
      <p><strong>Rating:</strong> ${stars} (${rating || 0}/5)</p>
      <p><strong>Message:</strong></p>
      <blockquote style="border-left:3px solid #ccc;padding-left:12px;color:#333">${(message || '').replace(/\n/g, '<br/>')}</blockquote>
    `;
    const hasEmailProvider = process.env.SENDGRID_API_KEY || (process.env.GMAIL_ACCOUNT && process.env.GMAIL_APP_PASSWORD);
    if (hasEmailProvider) {
      await sendEmail({
        to: 'support@tryfins.com',
        subject: `Fins Feedback${rating ? ` — ${rating}/5 stars` : ''}`,
        html,
      });
    } else {
      // No email provider in local dev — just log the feedback
      console.log(`[FEEDBACK] ${email || userId || 'Anonymous'} (${rating}/5): ${message}`);
    }
    res.json({ success: true });
  } catch (error) {
    console.error('Feedback error:', error);
    if (error.response?.body?.errors) {
      console.error('SendGrid error details:', JSON.stringify(error.response.body.errors));
    }
    res.status(500).json({ error: 'Failed to send feedback' });
  }
});

// Reset password
app.post('/api/reset-password', async (req, res) => {
  try {
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters long' });
    }

    const resetToken = await db.getResetToken(token);

    if (!resetToken) {
      return res.status(400).json({ error: 'Invalid or expired reset token' });
    }

    const now = new Date();
    const expiresAt = new Date(resetToken.expires_at);
    if (expiresAt < now) {
      await db.deleteResetToken(resetToken.email);
      return res.status(400).json({ error: 'Reset token has expired' });
    }

    // Update password
    await db.updatePassword(resetToken.email, newPassword);

    // Delete the used reset token
    await db.deleteResetToken(resetToken.email);

    // Update in-memory cache
    const user = await db.getUser(resetToken.email);
    if (user) {
      registeredUsers.set(resetToken.email, user);
    }

    res.json({ success: true, message: 'Password has been reset successfully' });
  } catch (error) {
    console.error('Reset password error:', error);
    res.status(500).json({
      error: 'Failed to reset password',
      details: error.message
    });
  }
});

// Temporary admin: directly set plan for a user
app.post('/api/admin/set-plan', async (req, res) => {
  const adminKey = req.query.key;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { email, plan } = req.body;
    if (!email || !plan) return res.status(400).json({ error: 'email and plan required' });
    const normalizedEmail = email.trim().toLowerCase();
    await db.updateSubscription(normalizedEmail, {
      subscriptionId: null,
      status: plan === 'paid' ? 'active' : null,
      endsAt: null,
      plan,
    });
    res.json({ success: true, email: normalizedEmail, plan });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Temporary admin diagnostic: find all users with their playlist counts and plan
app.get('/api/admin/users', async (req, res) => {
  const adminKey = req.query.key;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const users = await db.getAllUsers();
    const result = await Promise.all(users.map(async (u) => {
      const playlists = await db.getUserPlaylists(u.email);
      return {
        email: u.email,
        plan: u.plan || 'free',
        playlistCount: playlists ? playlists.length : 0,
        stripeCustomerId: u.stripeCustomerId || null,
        createdAt: u.createdAt,
      };
    }));
    res.json(result.sort((a, b) => b.playlistCount - a.playlistCount));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Temporary admin: copy plan + Stripe fields from one account to another
app.post('/api/admin/transfer-plan', async (req, res) => {
  const adminKey = req.query.key;
  if (!adminKey || adminKey !== process.env.ADMIN_KEY) {
    return res.status(403).json({ error: 'Forbidden' });
  }
  try {
    const { fromEmail, toEmail } = req.body;
    if (!fromEmail || !toEmail) return res.status(400).json({ error: 'fromEmail and toEmail required' });
    const fromUser = await db.getUser(fromEmail.trim().toLowerCase());
    if (!fromUser) return res.status(404).json({ error: 'Source user not found' });
    await db.updateSubscription(toEmail.trim().toLowerCase(), {
      subscriptionId: fromUser.stripeSubscriptionId,
      status: fromUser.subscriptionStatus,
      endsAt: null,
      plan: fromUser.plan || 'paid',
    });
    if (fromUser.stripeCustomerId) {
      await db.updateStripeCustomer(toEmail.trim().toLowerCase(), fromUser.stripeCustomerId);
    }
    res.json({ success: true, plan: fromUser.plan, stripeCustomerId: fromUser.stripeCustomerId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get user account info
// Temporary admin endpoint — remove after use
app.get('/api/admin/clear-trending-cache', async (req, res) => {
  const { secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET || !secret) return res.status(403).json({ error: 'Forbidden' });
  try {
    if (usePostgres) {
      const { Pool } = require('pg');
      const pool = new Pool({ connectionString: process.env.DATABASE_URL || process.env.POSTGRES_URL, ssl: { rejectUnauthorized: false } });
      await pool.query('DELETE FROM trending_artists_cache');
      await pool.end();
    } else {
      const Database = require('better-sqlite3');
      const localDb = new Database('./playlist-creator.db');
      localDb.prepare('DELETE FROM trending_artists_cache').run();
    }
    res.json({ ok: true, message: 'Trending cache cleared for all users' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/user-info', async (req, res) => {
  const { email, secret } = req.query;
  if (secret !== process.env.ADMIN_SECRET || !secret) return res.status(403).json({ error: 'Forbidden' });
  if (!email) return res.status(400).json({ error: 'email required' });
  try {
    const user = await db.getUser(email.trim().toLowerCase());
    if (!user) return res.status(404).json({ error: 'User not found' });
    const playlists = await db.getUserPlaylists(email.trim().toLowerCase());
    const allTracks = (playlists || []).flatMap(p => p.tracks || []);
    const artistCounts = {};
    allTracks.forEach(t => {
      if (t.artist) artistCounts[t.artist] = (artistCounts[t.artist] || 0) + 1;
    });
    const topArtists = Object.entries(artistCounts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([artist, count]) => ({ artist, count }));
    res.json({ user: { email: user.email, plan: user.plan, createdAt: user.createdAt }, playlistCount: (playlists || []).length, totalTracks: allTracks.length, topArtists });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/account/:email', async (req, res) => {
  try {
    const { email } = req.params;
    const normalizedEmail = email.trim().toLowerCase();

    // Get user from database first (source of truth)
    const dbUser = await db.getUser(normalizedEmail);

    if (!dbUser) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Get platform userIds from database
    const platformUserIds = await db.getPlatformUserIds(normalizedEmail);
    console.log(`[/api/account/${normalizedEmail}] Platform userIds from DB:`, platformUserIds);

    // Also check in-memory registeredUsers for additional data
    const memUser = registeredUsers.get(normalizedEmail);

    // Combine data from both sources, preferring database for connectedPlatforms and platform userIds
    res.json({
      success: true,
      email: normalizedEmail,
      platform: dbUser.platform || memUser?.platform,
      connectedPlatforms: dbUser.connectedPlatforms || {
        spotify: dbUser.platform === 'spotify' || memUser?.platform === 'spotify',
        apple: dbUser.platform === 'apple' || memUser?.platform === 'apple'
      },
      userId: memUser?.userId || dbUser.userId,
      spotifyUserId: platformUserIds?.spotify_user_id || memUser?.spotifyUserId,
      appleMusicUserId: platformUserIds?.apple_music_user_id || memUser?.appleMusicUserId,
      plan: dbUser.plan || 'free',
      trialUsed: dbUser.trialUsed || false,
      productTourCompleted: dbUser.productTourCompleted || false,
      allowExplicit: dbUser.allowExplicit !== false,
      darkMode: dbUser.darkMode || false,
    });
  } catch (error) {
    console.error('Get account error:', error);
    res.status(500).json({
      error: 'Failed to get account info',
      details: error.message
    });
  }
});

// Update user email
app.put('/api/account/email', async (req, res) => {
  try {
    const { currentEmail, newEmail, password, authToken, userId } = req.body;

    if (!currentEmail || !newEmail || !password) {
      return res.status(400).json({ error: 'Current email, new email, and password are required' });
    }

    let normalizedCurrentEmail = currentEmail.trim().toLowerCase();
    const normalizedNewEmail = newEmail.trim().toLowerCase();

    console.log('[updateEmail] Looking up user by currentEmail:', normalizedCurrentEmail);

    // Read from DB to ensure we have the latest data
    let user = await db.getUser(normalizedCurrentEmail);
    console.log('[updateEmail] DB lookup by currentEmail result:', user ? 'found' : 'not found');

    // Fallback 1: decode the auth token to find the real DB email
    if (!user && authToken) {
      try {
        const decoded = Buffer.from(authToken, 'base64').toString('utf8');
        const tokenEmail = decoded.split(':')[0].trim().toLowerCase();
        console.log('[updateEmail] Trying authToken fallback email:', tokenEmail);
        if (tokenEmail && tokenEmail !== normalizedCurrentEmail) {
          const tokenUser = await db.getUser(tokenEmail);
          console.log('[updateEmail] authToken fallback result:', tokenUser ? 'found' : 'not found');
          if (tokenUser) {
            user = tokenUser;
            normalizedCurrentEmail = tokenEmail;
          }
        }
      } catch (e) { console.error('[updateEmail] authToken decode error:', e.message); }
    }

    // Fallback 2: look up by userId (also the email for email-based accounts)
    if (!user && userId) {
      const normalizedUserId = userId.trim().toLowerCase();
      console.log('[updateEmail] Trying userId fallback:', normalizedUserId);
      if (normalizedUserId !== normalizedCurrentEmail) {
        const userByUserId = await db.getUser(normalizedUserId);
        console.log('[updateEmail] userId fallback result:', userByUserId ? 'found' : 'not found');
        if (userByUserId) {
          user = userByUserId;
          normalizedCurrentEmail = normalizedUserId;
        }
      }
    }

    // Fallback 3: account missing from DB (e.g. SQLite→Postgres migration, data loss).
    // Re-create it using the authToken email + the password the user just provided.
    if (!user && authToken) {
      try {
        const decoded = Buffer.from(authToken, 'base64').toString('utf8');
        const tokenEmail = decoded.split(':')[0].trim().toLowerCase();
        if (tokenEmail && tokenEmail.includes('@')) {
          console.log('[updateEmail] Account not in DB — recovering account for:', tokenEmail);
          await db.createUser(tokenEmail, password, 'none', tokenEmail);
          user = await db.getUser(tokenEmail);
          normalizedCurrentEmail = tokenEmail;
          console.log('[updateEmail] Account recovered:', user ? 'success' : 'failed');
        }
      } catch (e) {
        console.error('[updateEmail] Account recovery error:', e.message);
      }
    }

    if (!user) {
      console.log('[updateEmail] All lookups failed for currentEmail:', normalizedCurrentEmail);
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify password
    if (user.password !== password) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Check if new email is already taken (check DB, not stale cache)
    if (normalizedNewEmail !== normalizedCurrentEmail) {
      const existingUser = await db.getUser(normalizedNewEmail);
      if (existingUser) {
        return res.status(409).json({ error: 'An account with that email already exists' });
      }
    }

    // Update email in database (persists across restarts)
    await db.updateEmail(normalizedCurrentEmail, normalizedNewEmail);

    // Update in-memory cache
    registeredUsers.delete(normalizedCurrentEmail);
    user.email = normalizedNewEmail;
    registeredUsers.set(normalizedNewEmail, user);

    // Generate new auth token
    const token = Buffer.from(`${normalizedNewEmail}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      token: token,
      email: normalizedNewEmail,
      message: 'Email updated successfully'
    });
  } catch (error) {
    console.error('Update email error:', error);
    res.status(500).json({
      error: 'Failed to update email',
      details: error.message
    });
  }
});

// Update user password
app.put('/api/account/password', async (req, res) => {
  try {
    const { email, currentPassword, newPassword } = req.body;

    if (!email || !currentPassword || !newPassword) {
      return res.status(400).json({ error: 'Email, current password, and new password are required' });
    }

    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'New password must be at least 6 characters long' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    // Read from DB (not cache) to ensure we have the latest password
    const user = await db.getUser(normalizedEmail);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    if (user.password !== currentPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update password in DB and cache
    user.password = newPassword;
    registeredUsers.set(normalizedEmail, user);
    saveUsers();

    res.json({
      success: true,
      message: 'Password updated successfully'
    });
  } catch (error) {
    console.error('Update password error:', error);
    res.status(500).json({
      error: 'Failed to update password',
      details: error.message
    });
  }
});

// Update user music platform
app.put('/api/account/platform', async (req, res) => {
  try {
    const { email, platform } = req.body;

    if (!email || !platform) {
      return res.status(400).json({ error: 'Email and platform are required' });
    }

    if (!['spotify', 'apple'].includes(platform)) {
      return res.status(400).json({ error: 'Invalid platform. Must be "spotify" or "apple"' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = registeredUsers.get(normalizedEmail);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Update platform
    user.platform = platform;
    registeredUsers.set(normalizedEmail, user);
    saveUsers();

    res.json({
      success: true,
      platform: platform,
      message: 'Music platform updated successfully'
    });
  } catch (error) {
    console.error('Update platform error:', error);
    res.status(500).json({
      error: 'Failed to update platform',
      details: error.message
    });
  }
});

// Update multiple music platforms
app.get('/api/account/platforms', async (req, res) => {
  try {
    const { email } = req.query;
    console.log('Get platforms request - Email:', email);

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = registeredUsers.get(normalizedEmail);

    if (!user) {
      console.error('User not found in registeredUsers. Email:', normalizedEmail);
      return res.status(404).json({ error: 'User not found', email: normalizedEmail });
    }

    // Return connected platforms
    const platforms = user.connectedPlatforms || { spotify: false, apple: false };
    console.log('Returning platforms for', normalizedEmail, ':', platforms);
    res.json(platforms);
  } catch (error) {
    console.error('Error getting platforms:', error);
    res.status(500).json({ error: 'Failed to get platforms', details: error.message });
  }
});

app.put('/api/account/platforms', async (req, res) => {
  try {
    const { email, platforms } = req.body;
    console.log('Update platforms request - Email:', email, 'Platforms:', platforms, 'Body:', req.body);

    if (!email || !platforms) {
      return res.status(400).json({ error: 'Email and platforms are required', received: { email, platforms } });
    }

    if (!Array.isArray(platforms) && typeof platforms !== 'object') {
      return res.status(400).json({ error: 'Platforms must be an object', received: { type: typeof platforms, isArray: Array.isArray(platforms) } });
    }

    const normalizedEmail = email.trim().toLowerCase();
    console.log('Normalized email:', normalizedEmail);
    console.log('Registered users count:', registeredUsers.size);
    const user = registeredUsers.get(normalizedEmail);

    if (!user) {
      console.error('User not found in registeredUsers. Email:', normalizedEmail, 'Available emails:', Array.from(registeredUsers.keys()).slice(0, 5));
      return res.status(404).json({ error: 'User not found', email: normalizedEmail });
    }

    // Update platforms (store as object {spotify: bool, apple: bool})
    user.connectedPlatforms = platforms;
    registeredUsers.set(normalizedEmail, user);
    saveUsers();

    // Update platforms in database
    await db.updatePlatforms(normalizedEmail, platforms);

    // If disconnecting a platform, clear userId if it matches that platform
    const dbUser = await db.getUser(normalizedEmail);
    if (dbUser && dbUser.userId) {
      if (dbUser.userId.startsWith('spotify_') && !platforms.spotify) {
        console.log('Clearing Spotify userId from database:', dbUser.userId);
        await db.updateUserId(normalizedEmail, null);
        user.userId = null;
      } else if (dbUser.userId.startsWith('apple_music_') && !platforms.apple) {
        console.log('Clearing Apple Music userId from database:', dbUser.userId);
        await db.updateUserId(normalizedEmail, null);
        user.userId = null;
      }
    }

    res.json({
      success: true,
      platforms: platforms,
      message: 'Music platforms updated successfully'
    });
  } catch (error) {
    console.error('Update platforms error:', error);
    res.status(500).json({
      error: 'Failed to update platforms',
      details: error.message
    });
  }
});

// Create user account (for users who skip platform selection)
app.post('/api/account/create', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const normalizedEmail = email.trim().toLowerCase();
    const user = registeredUsers.get(normalizedEmail);

    if (!user) {
      return res.status(404).json({ error: 'User not found', email: normalizedEmail });
    }

    // Generate a userId for users who skip all platforms
    const userId = `local_${Date.now()}`;
    user.userId = userId;
    registeredUsers.set(normalizedEmail, user);
    saveUsers();

    console.log('Created user account without platform connection:', { email: normalizedEmail, userId });

    res.json({
      success: true,
      userId: userId,
      email: normalizedEmail,
      message: 'User account created successfully'
    });
  } catch (error) {
    console.error('Create user account error:', error);
    res.status(500).json({
      error: 'Failed to create user account',
      details: error.message
    });
  }
});

// Update user settings (allowExplicit, darkMode)
app.put('/api/account/settings', async (req, res) => {
  try {
    const { email, allowExplicit, darkMode } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    await db.updateUserSettings(email.trim().toLowerCase(), { allowExplicit, darkMode });
    res.json({ success: true });
  } catch (error) {
    console.error('Update settings error:', error);
    res.status(500).json({ error: 'Failed to update settings' });
  }
});

// Mark product tour as completed
app.post('/api/account/tour-completed', async (req, res) => {
  try {
    const { email } = req.body;
    if (!email) return res.status(400).json({ error: 'Email is required' });
    await db.markTourCompleted(email.trim().toLowerCase());
    res.json({ success: true });
  } catch (error) {
    console.error('Mark tour completed error:', error);
    res.status(500).json({ error: 'Failed to update tour status' });
  }
});

// Get Spotify authorization URL
app.get('/api/auth/spotify', (req, res) => {
  const { email, fromAccount } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter is required for Spotify authentication' });
  }

  const scopes = [
    'playlist-modify-public',
    'playlist-modify-private',
    'user-read-private',
    'user-read-email',
    'user-top-read',
    'user-read-recently-played',
    'playlist-read-private',
    'playlist-read-collaborative'
  ];

  // Use email and redirect context as state to identify user on callback
  // Format: email|fromAccount (e.g., "user@example.com|true")
  const state = fromAccount === 'true' ? `${email}|fromAccount` : email;
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, state);
  console.log('Spotify auth URL requested for email:', email, 'fromAccount:', fromAccount, 'State:', state);
  res.json({ url: authorizeURL });
});

// Spotify callback
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  try {
    // Parse state to get email and redirect context
    // State format: "email|fromAccount" or just "email"
    let userEmail = state;
    let fromAccount = false;

    if (state && state.includes('|fromAccount')) {
      const parts = state.split('|fromAccount');
      userEmail = parts[0];
      fromAccount = true;
    }

    const data = await spotifyApi.authorizationCodeGrant(code);
    const { access_token, refresh_token } = data.body;

    // Create temporary API instance to get user info
    const tempApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
    });
    tempApi.setAccessToken(access_token);
    tempApi.setRefreshToken(refresh_token);

    // Get Spotify user ID to use as consistent identifier
    const meData = await tempApi.getMe();
    const spotifyUserId = meData.body.id;

    // Create platform-specific userId for token storage
    const spotifyPlatformUserId = `spotify_${spotifyUserId}`;
    const tokenData = { access_token, refresh_token };
    userTokens.set(spotifyPlatformUserId, tokenData);

    // Save tokens to database (keyed by platform userId for API calls)
    await db.setToken(spotifyPlatformUserId, {
      ...tokenData,
      platform: 'spotify',
      email: userEmail
    });
    console.log('Spotify tokens saved to database:', spotifyPlatformUserId);

    // The userEmail was already parsed from state at the beginning
    // If state is 'state' (old default), it means email wasn't provided
    if (userEmail === 'state') {
      console.warn('OAuth callback received without email in state parameter. This should not happen.');
      userEmail = '';
    }

    console.log('Linking Spotify platform userId:', spotifyPlatformUserId, 'to email:', userEmail, 'fromAccount:', fromAccount);

    // Update the user record in registeredUsers to link the Spotify connection
    if (userEmail && registeredUsers.has(userEmail)) {
      const user = registeredUsers.get(userEmail);
      // Keep userId as email (platform-independent)
      if (!user.userId) {
        user.userId = userEmail;
      }
      user.connectedPlatforms = user.connectedPlatforms || {};

      // Disconnect Apple Music if it was previously connected
      if (user.connectedPlatforms.apple) {
        console.log('Disconnecting Apple Music for:', userEmail);
        user.connectedPlatforms.apple = false;

        // Get and delete Apple Music platform user ID
        const platformUserIds = await db.getPlatformUserIds(userEmail);
        if (platformUserIds && platformUserIds.apple_music_user_id) {
          await db.deleteToken(platformUserIds.apple_music_user_id);
          console.log('Deleted Apple Music token for:', platformUserIds.apple_music_user_id);
        }
      }

      user.connectedPlatforms.spotify = true;
      registeredUsers.set(userEmail, user);
      saveUsers();

      // Store platform user ID separately in database
      await db.setPlatformUserId(userEmail, 'spotify', spotifyPlatformUserId);
      await db.updateUserId(userEmail, userEmail);
      await db.updatePlatforms(userEmail, user.connectedPlatforms);

      console.log('Updated user record for:', userEmail, 'userId:', userEmail);
    } else if (userEmail) {
      console.warn('User email from OAuth callback not found in registered users:', userEmail);
    }

    // Redirect back to frontend with email-based userId (not platform-specific)
    const redirectUrl = `${FRONTEND_URL}?userId=${userEmail}&spotifyUserId=${spotifyPlatformUserId}&email=${encodeURIComponent(userEmail)}&success=true&spotify=connected`;
    console.log('Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.redirect(`${FRONTEND_URL}?error=auth_failed`);
  }
});

// Get Apple Music authorization URL
app.get('/api/auth/apple', (req, res) => {
  const { email } = req.query;

  if (!email) {
    return res.status(400).json({ error: 'Email parameter is required for Apple Music authentication' });
  }

  const clientId = process.env.APPLE_MUSIC_CLIENT_ID;
  const redirectUri = process.env.APPLE_MUSIC_REDIRECT_URI || 'http://127.0.0.1:3001/apple-callback';

  if (!clientId) {
    return res.status(400).json({ error: 'Apple Music integration not configured' });
  }

  // Apple Music OAuth authorization URL
  const appleMusicAuthUrl = `https://appleid.apple.com/auth/oauth2/authorize?${new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    response_mode: 'form_post',
    scope: 'user-profile user-library playlist-library-read playlist-library-modify',
    state: email
  }).toString()}`;

  console.log('Apple Music auth URL requested for email:', email);
  res.json({ url: appleMusicAuthUrl });
});

// Apple Music callback - handles both GET and POST
app.all('/apple-callback', async (req, res) => {
  try {
    // Get code and state from either query params (GET) or body (POST)
    const code = req.query.code || req.body.code;
    const state = req.query.state || req.body.state;
    const error = req.query.error || req.body.error;

    if (error) {
      console.error('Apple Music OAuth error:', error);
      return res.redirect(`${FRONTEND_URL}?error=${error}`);
    }

    if (!code) {
      return res.redirect(`${FRONTEND_URL}?error=missing_code`);
    }

    const userEmail = state || '';

    // Generate a developer token for accessing Apple Music API
    const appleMusicDevToken = generateAppleMusicToken();

    if (!appleMusicDevToken) {
      throw new Error('Failed to generate Apple Music developer token');
    }

    // For Apple Music, the 'code' from OAuth callback needs to be exchanged for a user token
    // However, Apple Music uses MusicKit which handles this differently
    // The code here is actually the user music token from MusicKit
    const userMusicToken = code;

    // Get user's storefront using the developer token and user music token
    const appleMusicApi = new AppleMusicService(appleMusicDevToken);

    let storefront = 'us'; // Default
    try {
      storefront = await appleMusicApi.getUserStorefront(userMusicToken);
      console.log('User storefront:', storefront);
    } catch (storefrontError) {
      console.warn('Could not fetch storefront, using default (us):', storefrontError.message);
    }

    // Create a unique user ID for this Apple Music connection
    const userId = `apple_music_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // Store tokens in database
    const tokenData = {
      access_token: userMusicToken,
      user_music_token: userMusicToken, // Apple Music user token
      developer_token: appleMusicDevToken,
      platform: 'apple_music',
      email: userEmail,
      storefront: storefront,
      authorized_at: new Date().toISOString()
    };

    userTokens.set(userId, tokenData);
    await db.setToken(userId, tokenData);

    console.log('Apple Music user authenticated:', userId);
    console.log('Storefront:', storefront);

    // Update the user record in registeredUsers to link the Apple Music connection
    if (userEmail && registeredUsers.has(userEmail)) {
      const user = registeredUsers.get(userEmail);
      user.appleMusicUserId = userId;
      user.connectedPlatforms = user.connectedPlatforms || {};

      // Disconnect Spotify if it was previously connected
      if (user.connectedPlatforms.spotify) {
        console.log('Disconnecting Spotify for:', userEmail);
        user.connectedPlatforms.spotify = false;

        // Get and delete Spotify platform user ID
        const platformUserIds = await db.getPlatformUserIds(userEmail);
        if (platformUserIds && platformUserIds.spotify_user_id) {
          await db.deleteToken(platformUserIds.spotify_user_id);
          console.log('Deleted Spotify token for:', platformUserIds.spotify_user_id);
        }
      }

      user.connectedPlatforms.apple = true;
      registeredUsers.set(userEmail, user);
      saveUsers();
      console.log('Updated user record for:', userEmail);

      // Save platform userId mapping in database
      await db.setPlatformUserId(userEmail, 'apple', userId);
      console.log('Saved Apple Music platform userId for:', userEmail);

      // Also update connected_platforms in database
      await db.updatePlatforms(userEmail, {
        spotify: false,
        apple: true
      });
    } else if (userEmail) {
      console.warn('User email from Apple Music callback not found in registered users:', userEmail);
    }

    // Redirect back to frontend with userId, email, and success flag
    // Use appleMusicUserId parameter so frontend knows to store it
    const redirectUrl = `${FRONTEND_URL}?userId=${userEmail}&appleMusicUserId=${userId}&email=${encodeURIComponent(userEmail)}&success=true&apple=connected`;
    console.log('Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error in Apple Music callback:', error);
    res.redirect(`${FRONTEND_URL}?error=apple_auth_failed&message=${encodeURIComponent(error.message)}`);
  }
});

// ============================================================================
// MusicKit JS Endpoints (New Apple Music authentication flow)
// ============================================================================

// Get Apple Music developer token for MusicKit JS
app.get('/api/apple-music/developer-token', (req, res) => {
  try {
    const developerToken = generateAppleMusicToken();

    if (!developerToken) {
      return res.status(500).json({ error: 'Failed to generate developer token' });
    }

    console.log('Generated Apple Music developer token for MusicKit');
    res.json({ token: developerToken });
  } catch (error) {
    console.error('Error generating Apple Music developer token:', error);
    res.status(500).json({ error: 'Failed to generate developer token' });
  }
});

// Get shareable Apple Music URL for a library playlist (resolves pl.u-xxx from p.xxx)
app.post('/api/apple-music/playlist-url', async (req, res) => {
  const { userId, playlistId, playlistName } = req.body;
  if (!userId || !playlistId) return res.status(400).json({ error: 'Missing userId or playlistId' });

  try {
    // Resolve to the apple_music_xxx platform userId
    let platformUserId = userId;
    if (isEmailBasedUserId(userId)) {
      platformUserId = await resolvePlatformUserId(userId, 'apple');
    }
    if (!platformUserId) return res.status(401).json({ error: 'Not authenticated with Apple Music' });

    const tokens = await getUserTokens(platformUserId);
    if (!tokens?.access_token) return res.status(401).json({ error: 'Not authenticated with Apple Music' });

    const appleMusicDevToken = generateAppleMusicToken();
    if (!appleMusicDevToken) return res.status(500).json({ error: 'Apple Music service unavailable' });

    const appleMusicApi = new AppleMusicService(appleMusicDevToken);
    const url = await appleMusicApi.getPlaylistShareableUrl(tokens.access_token, playlistId, playlistName);
    return res.json({ url });
  } catch (err) {
    console.error('Error fetching Apple Music playlist URL:', err.message);
    return res.status(500).json({ error: 'Failed to fetch playlist URL' });
  }
});

// Connect Apple Music with user music token from MusicKit JS
app.post('/api/apple-music/connect', async (req, res) => {
  console.log('🔵 Apple Music connect endpoint HIT - request received');
  console.log('Request body keys:', Object.keys(req.body));

  try {
    const { userMusicToken, email } = req.body;

    console.log('=== Apple Music Connect Request (v3 - with SQL fix) ===');
    console.log('Email:', email);
    console.log('User token length:', userMusicToken?.length);

    // Check if AppleMusicService loaded successfully
    if (!AppleMusicService) {
      console.error('AppleMusicService not available - service failed to load at startup');
      return res.status(500).json({
        error: 'Apple Music service is not available',
        details: 'The service failed to load. Please contact support.'
      });
    }

    if (!userMusicToken) {
      return res.status(400).json({ error: 'userMusicToken is required' });
    }

    if (!email) {
      return res.status(400).json({ error: 'email is required' });
    }

    console.log('Connecting Apple Music via MusicKit for:', email);

    // Generate developer token
    let appleMusicDevToken;
    try {
      console.log('Step 1: Generating developer token...');
      appleMusicDevToken = generateAppleMusicToken();
      console.log('Developer token generated successfully');
    } catch (tokenError) {
      console.error('Error generating developer token:', tokenError);
      return res.status(500).json({ error: 'Failed to generate developer token', details: tokenError.message });
    }

    if (!appleMusicDevToken) {
      console.error('Developer token is null/undefined');
      return res.status(500).json({ error: 'Failed to generate Apple Music developer token' });
    }

    // Get user's storefront using the developer token and user music token
    console.log('Step 2: Creating AppleMusicService instance...');
    let appleMusicApi;
    try {
      appleMusicApi = new AppleMusicService(appleMusicDevToken);
      console.log('AppleMusicService instance created successfully');
    } catch (serviceError) {
      console.error('Error creating AppleMusicService instance:', serviceError);
      return res.status(500).json({ error: 'Failed to create Apple Music service', details: serviceError.message });
    }

    let storefront = 'us'; // Default
    try {
      console.log('Step 3: Getting user storefront...');
      storefront = await appleMusicApi.getUserStorefront(userMusicToken);
      console.log('User storefront:', storefront);
    } catch (storefrontError) {
      console.warn('Could not fetch storefront, using default (us):', storefrontError.message);
      // Continue with default storefront
    }

    // Create platform-specific user ID for Apple Music
    console.log('Step 4: Creating platform user ID...');
    const appleMusicPlatformUserId = `apple_music_${Date.now()}_${Math.random().toString(36).substring(7)}`;
    console.log('Platform user ID:', appleMusicPlatformUserId);

    // Store tokens in database (keyed by platform userId for API calls)
    console.log('Step 5: Storing tokens in database...');
    const tokenData = {
      access_token: userMusicToken,
      user_music_token: userMusicToken,
      developer_token: appleMusicDevToken,
      platform: 'apple_music',
      email: email,
      storefront: storefront,
      authorized_at: new Date().toISOString()
    };

    try {
      userTokens.set(appleMusicPlatformUserId, tokenData);
      await db.setToken(appleMusicPlatformUserId, tokenData);
      console.log('Tokens stored successfully');
    } catch (dbError) {
      console.error('Error storing tokens:', dbError);
      return res.status(500).json({ error: 'Failed to store tokens', details: dbError.message });
    }

    console.log('Apple Music tokens saved to database:', appleMusicPlatformUserId);
    console.log('Storefront:', storefront);

    // Update the user record in registeredUsers
    console.log('Step 6: Updating user record...');
    try {
      if (email && registeredUsers.has(email)) {
        const user = registeredUsers.get(email);
        // Keep userId as email (platform-independent)
        if (!user.userId) {
          user.userId = email;
        }
        user.connectedPlatforms = user.connectedPlatforms || {};

        // Disconnect Spotify if it was previously connected
        if (user.connectedPlatforms.spotify) {
          console.log('Disconnecting Spotify for:', email);
          user.connectedPlatforms.spotify = false;

          // Get and delete Spotify platform user ID
          const platformUserIds = await db.getPlatformUserIds(email);
          if (platformUserIds && platformUserIds.spotify_user_id) {
            await db.deleteToken(platformUserIds.spotify_user_id);
            console.log('Deleted Spotify token for:', platformUserIds.spotify_user_id);
          }
        }

        user.connectedPlatforms.apple = true;
        registeredUsers.set(email, user);
        saveUsers();

        // Store platform user ID separately in database
        await db.setPlatformUserId(email, 'apple', appleMusicPlatformUserId);
        await db.updateUserId(email, email);
        await db.updatePlatforms(email, { spotify: false, apple: true });

        console.log('Updated user record for:', email, 'userId:', email);
      } else if (email) {
        console.warn('User email not found in registered users:', email);

        // Create user if doesn't exist
        console.log('Creating new user in database...');
        const tempPassword = `apple_music_${Date.now()}`;
        await db.createUser(email, tempPassword, 'apple_music', email);
        await db.setPlatformUserId(email, 'apple', appleMusicPlatformUserId);
        await db.updatePlatforms(email, { spotify: false, apple: true });

        // Add to in-memory cache
        registeredUsers.set(email, {
          email: email,
          password: tempPassword,
          platform: 'apple_music',
          userId: email,
          connectedPlatforms: { spotify: false, apple: true }
        });
        saveUsers();
        console.log('Created new user:', email);
      }
    } catch (userUpdateError) {
      console.error('Error updating user record:', userUpdateError);
      return res.status(500).json({ error: 'Failed to update user record', details: userUpdateError.message });
    }

    // Return success with email-based userId (not platform-specific)
    res.json({
      success: true,
      userId: email,
      appleMusicUserId: appleMusicPlatformUserId,
      platform: 'apple',
      storefront: storefront
    });

  } catch (error) {
    console.error('=== Error connecting Apple Music ===');
    console.error('Error message:', error.message);
    console.error('Error stack:', error.stack);
    res.status(500).json({
      error: 'Failed to connect Apple Music',
      message: error.message,
      details: error.stack
    });
  }
});

// Get user's top artists
app.get('/api/top-artists/:userId', async (req, res) => {
  try {
    let { userId } = req.params;

    // If userId is email-based, resolve to platform userId (try Spotify first, then Apple Music)
    let platformUserId = userId;
    let platform = null;

    if (isEmailBasedUserId(userId)) {
      // Try Spotify first
      platformUserId = await resolvePlatformUserId(userId, 'spotify');
      if (platformUserId) {
        platform = 'spotify';
        console.log(`Resolved email ${userId} to Spotify userId: ${platformUserId}`);
      } else {
        // Try Apple Music if Spotify not connected
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        if (platformUserId) {
          platform = 'apple';
          console.log(`Resolved email ${userId} to Apple Music userId: ${platformUserId}`);
        } else {
          // No platform connected
          console.log('No platform userId found for email:', userId, '- returning empty artists array');
          return res.json({ artists: [] });
        }
      }
    } else {
      // Detect platform from userId prefix
      if (platformUserId.startsWith('spotify_')) {
        platform = 'spotify';
      } else if (platformUserId.startsWith('apple_music_')) {
        platform = 'apple';
      }
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      console.log('No tokens found for userId:', platformUserId, '- returning empty artists array');
      return res.json({ artists: [] });
    }

    let topArtists = [];

    if (platform === 'spotify') {
      // Spotify: Use listening history API
      const userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);

      // Refresh token if needed
      try {
        const refreshData = await userSpotifyApi.refreshAccessToken();
        const newAccessToken = refreshData.body.access_token;
        userSpotifyApi.setAccessToken(newAccessToken);
        tokens.access_token = newAccessToken;
        userTokens.set(platformUserId, tokens);
        await db.updateAccessToken(platformUserId, newAccessToken);
      } catch (refreshError) {
        console.log('Token refresh failed or not needed:', refreshError.message);
      }

      // Get top 10 artists from the last 4 weeks
      const topArtistsData = await userSpotifyApi.getMyTopArtists({ limit: 10, time_range: 'short_term' });

      topArtists = topArtistsData.body.items.map(artist => ({
        id: artist.id,
        name: artist.name,
        image: artist.images[0]?.url,
        genres: artist.genres,
        popularity: artist.popularity,
        uri: artist.uri,
        platform: 'spotify'
      }));
    } else if (platform === 'apple') {
      // Apple Music: Analyze library playlists
      if (!AppleMusicService) {
        console.error('AppleMusicService not available');
        return res.json({ artists: [] });
      }

      const appleMusicDevToken = generateAppleMusicToken();
      if (!appleMusicDevToken) {
        console.error('Failed to generate Apple Music developer token');
        return res.json({ artists: [] });
      }

      const appleMusicApi = new AppleMusicService(appleMusicDevToken);
      topArtists = await appleMusicApi.getTopArtistsFromLibrary(tokens.access_token, 10);
    }

    res.json({ artists: topArtists });
  } catch (error) {
    console.error('Error fetching top artists:', error);

    // Check if it's a scope error
    if (error.statusCode === 403 && error.body?.error?.message?.includes('Insufficient client scope')) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        details: 'Please reconnect your Spotify account to grant the required permissions',
        requiresReauth: true
      });
    }

    res.status(500).json({
      error: 'Failed to fetch top artists',
      details: error.message
    });
  }
});

// Get new artist recommendations based on listening history
app.get('/api/new-artists/:userId', async (req, res) => {
  console.log('=== NEW ARTISTS ENDPOINT CALLED ===');
  console.log('UserId:', req.params.userId);
  try {
    let { userId } = req.params;
    let platformUserId = userId;
    let platform = null;

    // Detect platform
    console.log(`[new-artists] Received userId: ${userId}`);
    if (isEmailBasedUserId(userId)) {
      // Try Spotify first
      platformUserId = await resolvePlatformUserId(userId, 'spotify');
      console.log(`[new-artists] Spotify resolution result: ${platformUserId}`);
      if (platformUserId) {
        platform = 'spotify';
      } else {
        // Try Apple Music if Spotify not connected
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        console.log(`[new-artists] Apple Music resolution result: ${platformUserId}`);
        if (platformUserId) {
          platform = 'apple';
        } else {
          console.log('No platform userId found for email:', userId);
          return res.json({ artists: [] });
        }
      }
      console.log(`[new-artists] Resolved email ${userId} to ${platform} userId: ${platformUserId}`);
    } else if (userId.startsWith('spotify_')) {
      platform = 'spotify';
      console.log(`[new-artists] Direct Spotify userId detected`);
    } else if (userId.startsWith('apple_music_')) {
      platform = 'apple';
      console.log(`[new-artists] Direct Apple Music userId detected`);
    }

    // Check cache first (use platformUserId for cache key)
    const cachedArtists = await db.getCachedArtists(platformUserId);
    if (cachedArtists && Array.isArray(cachedArtists) && cachedArtists.length > 0) {
      console.log(`✓ Returning ${cachedArtists.length} cached artists for ${platformUserId}`);
      return res.json({ artists: cachedArtists, cached: true });
    }

    if (cachedArtists && !Array.isArray(cachedArtists)) {
      console.log('⚠️ Cached artists is not an array, invalidating cache');
    }

    console.log('No valid cache found, fetching fresh artist recommendations...');

    // Get user's tokens
    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      console.log('No tokens found for user');
      return res.json({ artists: [] });
    }

    let newArtists = [];

    if (platform === 'apple') {
      // Apple Music: Use library-based recommendations
      console.log('[new-artists] Platform is Apple Music, generating recommendations from library...');
      console.log('[new-artists] User token available:', !!tokens.access_token);
      console.log('[new-artists] Storefront:', tokens.storefront || 'us (default)');

      const appleMusicDevToken = generateAppleMusicToken();
      if (!appleMusicDevToken) {
        console.error('[new-artists] Failed to generate Apple Music developer token');
        return res.status(500).json({ error: 'Apple Music service unavailable' });
      }
      console.log('[new-artists] Developer token generated successfully');

      const appleMusicApi = new AppleMusicService(appleMusicDevToken);

      // Get storefront from tokens or detect it
      const storefront = tokens.storefront || 'us';
      console.log('[new-artists] Calling getRecommendedArtists...');
      newArtists = await appleMusicApi.getRecommendedArtists(tokens.access_token, storefront, 50);

      console.log(`[new-artists] Generated ${newArtists.length} Apple Music recommendations`);

      // Cache the results
      if (newArtists.length > 0) {
        await db.setCachedArtists(platformUserId, newArtists);
        console.log('[new-artists] ✓ Cached Apple Music recommendations');
      } else {
        console.log('[new-artists] No recommendations generated, not caching');
      }

      return res.json({ artists: newArtists, cached: false });
    }

    // Spotify: Use existing AI-based recommendation logic
    const userSpotifyApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
    });
    userSpotifyApi.setAccessToken(tokens.access_token);
    userSpotifyApi.setRefreshToken(tokens.refresh_token);

    // Refresh token if needed
    try {
      const refreshData = await userSpotifyApi.refreshAccessToken();
      userSpotifyApi.setAccessToken(refreshData.body.access_token);
      tokens.access_token = refreshData.body.access_token;
      userTokens.set(platformUserId, tokens);
      await db.updateAccessToken(platformUserId, refreshData.body.access_token);
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
    }

    // Get top 10 artists — try short_term (4 weeks) first, fall back to medium_term (6 months)
    let topArtistsData = await userSpotifyApi.getMyTopArtists({ limit: 10, time_range: 'short_term' });
    if (!topArtistsData.body.items || topArtistsData.body.items.length === 0) {
      console.log('No short_term top artists, falling back to medium_term');
      topArtistsData = await userSpotifyApi.getMyTopArtists({ limit: 10, time_range: 'medium_term' });
    }

    if (!topArtistsData.body.items || topArtistsData.body.items.length === 0) {
      console.log('No top artists found for user');
      return res.json({ artists: [] });
    }

    const topArtists = topArtistsData.body.items.map(artist => ({
      id: artist.id,
      name: artist.name,
      image: artist.images[0]?.url,
      genres: artist.genres,
      popularity: artist.popularity,
      uri: artist.uri
    }));

    const topArtistNames = topArtists.map(a => a.name);
    const genres = [...new Set(topArtists.flatMap(a => a.genres || []))];

    console.log('🎵 TOP 10 ARTISTS FOR EXCLUSION:', topArtistNames);

    // Track top artists in database for future filtering
    try {
      await db.trackArtists(platformUserId, topArtistNames);
      console.log('✓ Tracked top artists to database');
    } catch (trackError) {
      console.log('Could not track artists to database:', trackError.message);
    }

    // Get comprehensive list of all artists user has ever listened to
    let allListenedArtistNames = new Set();

    // 1. Get artist history from our database (builds over time)
    try {
      const artistHistory = await db.getArtistHistory(platformUserId);
      artistHistory.forEach(artist => allListenedArtistNames.add(artist.artistName));
      console.log(`Loaded ${artistHistory.length} artists from database history`);
    } catch (dbError) {
      console.log('Could not load artist history from database:', dbError.message);
    }

    // 2. Supplement with Spotify API data (reuse userSpotifyApi from above)
    // Get top artists from long_term only (most comprehensive, fastest)
    console.log('Fetching top artists from long term...');
    try {
      const topArtistsAllTime = await userSpotifyApi.getMyTopArtists({ limit: 50, time_range: 'long_term' });
      topArtistsAllTime.body.items.forEach(artist => allListenedArtistNames.add(artist.name));
      console.log(`Added ${topArtistsAllTime.body.items.length} artists from long_term`);
    } catch (err) {
      console.log(`Could not fetch top artists:`, err.message);
    }

    // 3. Get artists from recently played tracks (fast, single request)
    console.log('Fetching recently played artists...');
    try {
      const recentlyPlayedData = await userSpotifyApi.getMyRecentlyPlayedTracks({ limit: 50 });
      recentlyPlayedData.body.items.forEach(item => {
        item.track.artists.forEach(artist => allListenedArtistNames.add(artist.name));
      });
      console.log(`Added artists from ${recentlyPlayedData.body.items.length} recently played tracks`);
    } catch (err) {
      console.log('Could not fetch recently played tracks:', err.message);
    }

    console.log(`Total unique artists user has listened to: ${allListenedArtistNames.size}`);

    // Combine with top artists for exclusion
    const allArtistsToExclude = [...new Set([...topArtistNames, ...Array.from(allListenedArtistNames)])];

    console.log(`Total artists to exclude (already heard): ${allArtistsToExclude.length}`);

    // Use SoundCharts to find artists similar to the user's top artists
    // This is more accurate than asking Claude — SoundCharts knows real artist relationships
    const allArtistsToExcludeLower = allArtistsToExclude.map(name => name.toLowerCase().trim());
    let filteredArtists = [];

    if (process.env.SOUNDCHARTS_APP_ID) {
      console.log('🎵 Finding similar artists via SoundCharts...');
      const scCandidates = [];
      const seenScNames = new Set();

      for (const topArtist of topArtists) {
        try {
          const scInfo = await getSoundChartsArtistInfo(topArtist.name);
          if (scInfo?.similarArtists?.length > 0) {
            for (const simName of scInfo.similarArtists) {
              const simLower = simName.toLowerCase().trim();
              if (!seenScNames.has(simLower)) {
                seenScNames.add(simLower);
                scCandidates.push({ name: simName, genres: [], description: `Similar to ${topArtist.name}` });
              }
            }
          }
        } catch (err) {
          console.log(`SoundCharts lookup failed for ${topArtist.name}:`, err.message);
        }
      }
      console.log(`📊 SoundCharts found ${scCandidates.length} similar artists across all top artists`);

      filteredArtists = scCandidates.filter(artist => {
        const isExcluded = allArtistsToExcludeLower.some(ex => ex === artist.name.toLowerCase().trim());
        if (isExcluded) console.log(`⊘ Excluding: "${artist.name}" (already in listening history)`);
        return !isExcluded;
      });
      console.log(`✅ After filtering: ${filteredArtists.length} new artists to recommend`);
    } else {
      console.log('⚠️ SOUNDCHARTS_APP_ID not configured — skipping artist recommendations');
    }

    // Try to fetch images and details from Spotify for the suggested artists
    // (tokens already fetched above for recently played)
    const formattedArtists = [];

    if (tokens && tokens.platform !== 'apple_music') {
      // User has Spotify - fetch artist images from Spotify
      console.log('Fetching artist images from Spotify for', filteredArtists.length, 'artists...');
      const userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);

      // Refresh token if needed
      try {
        const refreshData = await userSpotifyApi.refreshAccessToken();
        userSpotifyApi.setAccessToken(refreshData.body.access_token);
      } catch (refreshError) {
        console.log('Token refresh failed or not needed:', refreshError.message);
      }

      const seenArtistIds = new Set();
      const seenArtistNames = new Set();

      // Process artists in parallel batches for faster loading
      console.log(`Processing ${filteredArtists.length} AI-suggested artists in parallel...`);

      // Search all artists in parallel (process up to 30 to ensure we get 10 valid matches)
      const searchPromises = filteredArtists.slice(0, 30).map(async (artist) => {
        try {
          // Search with limit 5 to get multiple candidates
          const searchPromise = userSpotifyApi.searchArtists(artist.name, { limit: 5 });
          const timeoutPromise = new Promise((_, reject) =>
            setTimeout(() => reject(new Error('Search timeout')), 5000)
          );
          const searchResult = await Promise.race([searchPromise, timeoutPromise]);
          const candidates = searchResult.body.artists.items;

          if (!candidates || candidates.length === 0) {
            return { artist, spotifyArtist: null };
          }

          // Normalize name for comparison
          const normalizeArtistName = (name) => {
            return name
              .toLowerCase()
              .trim()
              .normalize('NFD')
              .replace(/[\u0300-\u036f]/g, '') // Remove accents
              .replace(/[^a-z0-9\s]/g, '') // Remove special chars
              .replace(/\s+/g, ' '); // Normalize spaces
          };

          const targetName = normalizeArtistName(artist.name);

          // Find best match from candidates
          let spotifyArtist = null;
          for (const candidate of candidates) {
            const candidateName = normalizeArtistName(candidate.name);
            const namesMatch = targetName === candidateName ||
                              targetName.includes(candidateName) ||
                              candidateName.includes(targetName);

            if (namesMatch) {
              spotifyArtist = candidate;
              break;
            }
          }

          // If no exact match found, skip this artist entirely (don't use first result)
          if (!spotifyArtist) {
            return { artist, spotifyArtist: null };
          }

          // If we found an artist but it has no image, try fetching full artist details by ID
          if (spotifyArtist && (!spotifyArtist.images || spotifyArtist.images.length === 0)) {
            try {
              console.log(`Fetching full details for ${spotifyArtist.name} to get image...`);
              const fullArtistData = await userSpotifyApi.getArtist(spotifyArtist.id);
              if (fullArtistData.body.images && fullArtistData.body.images.length > 0) {
                spotifyArtist = fullArtistData.body;
                console.log(`✓ Got image from full artist data for ${spotifyArtist.name}`);
              }
            } catch (artistError) {
              console.log(`Could not fetch full artist details: ${artistError.message}`);
            }
          }

          return { artist, spotifyArtist };
        } catch (error) {
          return { artist, spotifyArtist: null, error };
        }
      });

      const searchResults = await Promise.all(searchPromises);

      // Process results and filter to get 10 unique artists
      for (const result of searchResults) {
        if (formattedArtists.length >= 10) break;

        const { artist, spotifyArtist, error } = result;

        // Skip duplicates
        if (seenArtistNames.has(artist.name.toLowerCase())) {
          console.log(`⊘ Skipping duplicate: ${artist.name}`);
          continue;
        }

        if (spotifyArtist) {
          // Name matching already done in search phase, so spotifyArtist is pre-validated

          // Skip duplicate Spotify IDs
          if (seenArtistIds.has(spotifyArtist.id)) {
            console.log(`⊘ Skipping duplicate Spotify ID: ${artist.name}`);
            continue;
          }

          // CRITICAL: Check if this Spotify artist is in the exclusion list
          const spotifyNameLower = spotifyArtist.name.toLowerCase().trim();
          if (allArtistsToExcludeLower.includes(spotifyNameLower)) {
            console.log(`🚫 BLOCKED: Spotify returned excluded artist "${spotifyArtist.name}" - skipping`);
            continue;
          }

          const popularity = spotifyArtist.popularity || 50;
          const artistImage = spotifyArtist.images && spotifyArtist.images.length > 0
            ? spotifyArtist.images[0].url
            : null;

          console.log(`✓ Found ${artist.name} on Spotify (popularity: ${popularity}, has image: ${!!artistImage})`);
          if (!artistImage) {
            console.log(`⚠️ No image found for ${artist.name}, images array:`, spotifyArtist.images);
          }

          seenArtistIds.add(spotifyArtist.id);
          seenArtistNames.add(artist.name.toLowerCase());

          formattedArtists.push({
            id: spotifyArtist.id,
            name: spotifyArtist.name,
            genres: spotifyArtist.genres || artist.genres || [],
            description: artist.description,
            image: artistImage,
            popularity: popularity,
            uri: spotifyArtist.uri
          });
        } else {
          console.log(`✗ Artist ${artist.name} not found on Spotify${error ? ': ' + error.message : ''}`);
          seenArtistNames.add(artist.name.toLowerCase());

          formattedArtists.push({
            id: `ai-artist-${formattedArtists.length}`,
            name: artist.name,
            genres: artist.genres || [],
            description: artist.description,
            image: null,
            popularity: 50,
            uri: null
          });
        }
      }
      console.log(`Finished fetching images, got ${formattedArtists.length} unique artists`);
    } else {
      // No platform tokens or Apple Music user - return AI data only
      console.log('No Spotify tokens available, returning AI data without images');
      filteredArtists.slice(0, 10).forEach((artist, index) => {
        formattedArtists.push({
          id: `ai-artist-${index}`,
          name: artist.name,
          genres: artist.genres || [],
          description: artist.description,
          image: null,
          popularity: 50,
          uri: null
        });
      });
    }

    console.log(`\n📤 RETURNING ${formattedArtists.length} artists to frontend:`);
    console.log(`   - Artists: ${formattedArtists.map(a => a.name).join(', ')}`);
    console.log(`   - ${formattedArtists.filter(a => a.image).length} with images`);

    if (formattedArtists.length > 0) {
      try {
        await db.setCachedArtists(platformUserId, formattedArtists);
        console.log('✓ Cached artist recommendations for user');
      } catch (cacheError) {
        console.error('Failed to cache artists:', cacheError.message);
      }
      return res.json({ artists: formattedArtists, cached: false });
    }

    // Fresh fetch returned 0 — fall back to stale cache so the section doesn't disappear
    // (SoundCharts quota may be temporarily exhausted)
    const staleArtists = await db.getStaleCachedArtists(platformUserId);
    if (staleArtists && Array.isArray(staleArtists) && staleArtists.length > 0) {
      console.log(`⚠️ Fresh fetch returned 0 artists — serving ${staleArtists.length} stale cached artists`);
      return res.json({ artists: staleArtists, cached: true, stale: true });
    }

    res.json({ artists: [], cached: false });
  } catch (error) {
    console.error('Error fetching new artists:', error);
    console.error('Error status code:', error.statusCode);
    console.error('Error body:', error.body);

    // Handle 404 errors (insufficient listening history)
    if (error.statusCode === 404) {
      console.log('User has insufficient listening history for new artists recommendations');
      return res.json({ artists: [] });
    }

    if (error.statusCode === 403 && error.body?.error?.message?.includes('Insufficient client scope')) {
      return res.status(403).json({
        error: 'Insufficient permissions',
        details: 'Please reconnect your Spotify account to grant the required permissions',
        requiresReauth: true
      });
    }

    res.status(500).json({
      error: 'Failed to fetch new artists',
      details: error.message
    });
  }
});

// Clear artist cache for a user (development/admin endpoint)
app.delete('/api/new-artists/cache/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    await db.deleteCachedArtists(userId);
    console.log(`Cleared artist cache for ${userId}`);
    res.json({ success: true, message: 'Artist cache cleared' });
  } catch (error) {
    console.error('Error clearing artist cache:', error);
    res.status(500).json({ error: 'Failed to clear cache' });
  }
});

// Maps Spotify artist genre strings to Spotify Browse category IDs
// Substring-based genre → category mapping (order matters — more specific checks first)
function getGenreCategory(genre) {
  const g = genre.toLowerCase();
  // K-Pop (check before general pop)
  if (g.includes('k-pop') || g.includes('kpop') || g.includes('korean pop') || g.includes('k pop') || g.includes('girl group') || g.includes('boy group')) return 'kpop';
  if (g.includes('korean')) return 'kpop';
  // R&B / Soul (check before trap which bleeds into hiphop)
  if (g.includes('r&b') || g.includes('rnb') || g.includes('rhythm and blues') || g.includes('neo soul') || g.includes('trap soul') || g.includes('contemporary soul')) return 'rnb';
  // Hip-Hop / Rap
  if (g.includes('hip hop') || g.includes('hip-hop') || g.includes(' rap') || g === 'rap' || g.includes('trap') || g.includes('drill') || g.includes('grime') || g.includes('cloud rap') || g.includes('plugg')) return 'hiphop';
  // Latin
  if (g.includes('latin') || g.includes('reggaeton') || g.includes('bachata') || g.includes('salsa') || g.includes('cumbia') || g.includes('dembow') || g.includes('corrido')) return 'latin';
  // Afrobeats
  if (g.includes('afrobeat') || g.includes('afropop') || g.includes('afro pop') || g.includes('afro swing') || g.includes('amapiano')) return 'afro';
  // Metal
  if (g.includes('metal') || g.includes('hardcore') || g.includes('screamo') || g.includes('deathcore')) return 'metal';
  // Country
  if (g.includes('country') || g.includes('bluegrass') || g.includes('americana')) return 'country';
  // Electronic / Dance
  if (g.includes('electronic') || g.includes('edm') || g.includes('house') || g.includes('techno') || g.includes('trance') || g.includes('dubstep') || g.includes('drum and bass') || g.includes('dnb') || g.includes('bass music')) return 'edm_dance';
  // Rock / Punk
  if (g.includes('rock') || g.includes('punk') || g.includes('grunge') || g.includes('emo') || g.includes('shoegaze') || g.includes('post-punk')) return 'rock';
  // Indie / Alternative / Singer-Songwriter
  if (g.includes('indie') || g.includes('alternative') || g.includes('lo-fi') || g.includes('lofi') || g.includes('singer-songwriter') || g.includes('folk') || g.includes('bedroom')) return 'indie_alt';
  // Jazz / Blues
  if (g.includes('jazz') || g.includes('blues') || g.includes('swing') || g.includes('bossa nova')) return 'jazz';
  // Classical
  if (g.includes('classical') || g.includes('orchestra') || g.includes('opera') || g.includes('symphony') || g.includes('chamber')) return 'classical';
  // Gospel / Christian
  if (g.includes('gospel') || g.includes('christian') || g.includes('worship') || g.includes('ccm')) return 'christian';
  // Soul catch-all (before pop so "soulful pop" goes to rnb)
  if (g.includes('soul')) return 'rnb';
  // Pop broad catch-all — last so specific genres above take priority
  if (g.includes('pop') || g.includes('dance')) return 'pop';
  return null;
}

// Returns next Sunday at 3:00 AM UTC
function getNextSunday3AM() {
  const now = new Date();
  const day = now.getUTCDay();
  const daysUntilSunday = day === 0 ? 7 : 7 - day;
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntilSunday);
  next.setUTCHours(3, 0, 0, 0);
  return next;
}

// Get trending artists by genre for the home page
app.get('/api/trending-artists/:userId', async (req, res) => {
  console.log('=== TRENDING ARTISTS ENDPOINT CALLED ===');
  try {
    let { userId } = req.params;
    let platformUserId = userId;
    let platform = null;

    // Resolve platform
    if (isEmailBasedUserId(userId)) {
      platformUserId = await resolvePlatformUserId(userId, 'spotify');
      if (platformUserId) {
        platform = 'spotify';
      } else {
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        if (platformUserId) platform = 'apple';
        else return res.json({ sections: [] });
      }
    } else if (userId.startsWith('spotify_')) {
      platform = 'spotify';
    } else if (userId.startsWith('apple_music_')) {
      platform = 'apple';
    }

    // Return cache immediately if available
    const forceRefresh = req.query.refresh === 'true';
    if (forceRefresh) {
      await db.deleteCachedTrendingArtists(platformUserId);
      console.log(`[trending] Cache cleared for ${platformUserId} (forced refresh)`);
    }
    const cached = forceRefresh ? null : await db.getCachedTrendingArtists(platformUserId);
    if (cached && Array.isArray(cached) && cached.length > 0) {
      console.log(`✓ Returning cached trending artists for ${platformUserId}`);
      return res.json({ sections: cached });
    }

    const CATEGORY_DISPLAY = {
      kpop: 'K-Pop', hiphop: 'Hip-Hop', rnb: 'R&B', pop: 'Pop',
      latin: 'Latin', rock: 'Rock', edm_dance: 'Dance', country: 'Country',
      indie_alt: 'Indie', afro: 'Afrobeats', metal: 'Metal',
      jazz: 'Jazz', classical: 'Classical', christian: 'Christian',
    };

    // Spotify genre search tags per category (used with genre: filter in search API)
    const CATEGORY_GENRE_QUERY = {
      kpop: 'k-pop', hiphop: 'hip-hop', rnb: 'r-n-b', pop: 'pop',
      latin: 'latin', rock: 'rock', edm_dance: 'edm', country: 'country',
      indie_alt: 'indie', afro: 'afrobeat', metal: 'metal',
      jazz: 'jazz', classical: 'classical', christian: 'gospel',
    };

    const topArtistIds = new Set();
    let topGenres = [];

    // Phase 1: get user's top artists + genres (platform-specific)
    // Always use a Spotify CC client for the genre search in Phase 2
    const spotifyCC = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    });
    const ccData = await spotifyCC.clientCredentialsGrant();
    spotifyCC.setAccessToken(ccData.body.access_token);

    if (platform === 'spotify') {
      const tokens = await getUserTokens(platformUserId);
      if (!tokens) return res.json({ sections: [] });

      const userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);
      try {
        const refreshData = await userSpotifyApi.refreshAccessToken();
        userSpotifyApi.setAccessToken(refreshData.body.access_token);
      } catch (e) {}

      const topArtistsData = await userSpotifyApi.getMyTopArtists({ limit: 20, time_range: 'medium_term' });
      const topArtistsList = topArtistsData.body.items || [];
      topArtistsList.forEach(a => topArtistIds.add(a.id));

      const genreCounts = {};
      for (const artist of topArtistsList) {
        for (const genre of (artist.genres || [])) {
          genreCounts[genre] = (genreCounts[genre] || 0) + 1;
        }
      }
      topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).map(([g]) => g);
      console.log(`[trending] Spotify top genres: ${topGenres.slice(0, 5).join(', ')}`);

    } else {
      // Apple Music: resolve via Spotify CC to get genres
      const tokens = await getUserTokens(platformUserId);
      if (!tokens) return res.json({ sections: [] });

      const appleMusicDevToken = generateAppleMusicToken();
      const appleMusicApi = new AppleMusicService(appleMusicDevToken);
      const topArtistsList = await appleMusicApi.getTopArtistsFromLibrary(tokens.access_token, 15);
      if (topArtistsList.length === 0) return res.json({ sections: [] });

      const genreCounts = {};
      await Promise.all(topArtistsList.slice(0, 10).map(async (artist) => {
        try {
          const result = await spotifyCC.searchArtists(artist.name, { limit: 1 });
          const match = result.body.artists?.items?.[0];
          if (match && match.name.toLowerCase() === artist.name.toLowerCase()) {
            topArtistIds.add(match.id);
            for (const genre of (match.genres || [])) {
              genreCounts[genre] = (genreCounts[genre] || 0) + 1;
            }
          }
        } catch (e) {}
      }));
      topGenres = Object.entries(genreCounts).sort((a, b) => b[1] - a[1]).map(([g]) => g);
      console.log(`[trending] Apple Music top genres (via Spotify CC): ${topGenres.slice(0, 5).join(', ')}`);
    }

    // Map user's top genres to up to 3 category buckets
    const seenCategories = new Set();
    const categoryGenreMap = {};
    for (const genre of topGenres) {
      const categoryId = getGenreCategory(genre);
      if (categoryId && !seenCategories.has(categoryId)) {
        seenCategories.add(categoryId);
        categoryGenreMap[categoryId] = genre;
        console.log(`[trending] Genre "${genre}" → category "${categoryId}"`);
        if (seenCategories.size >= 3) break;
      }
    }

    if (seenCategories.size === 0) {
      console.log('[trending] No mappable genres found');
      return res.json({ sections: [] });
    }

    // Phase 2: for each category, search Spotify for popular artists in that genre,
    // excluding artists the user already listens to
    const POPULARITY_THRESHOLD = 40;
    const sections = [];
    for (const categoryId of seenCategories) {
      try {
        const displayGenre = CATEGORY_DISPLAY[categoryId] || categoryGenreMap[categoryId];
        const genreQuery = CATEGORY_GENRE_QUERY[categoryId];
        if (!genreQuery) continue;

        const searchResult = await spotifyCC.search(`genre:${genreQuery}`, ['artist'], { limit: 50, market: 'US' });
        const candidates = searchResult.body.artists?.items || [];

        const artists = candidates
          .filter(a => a && !topArtistIds.has(a.id) && a.popularity >= POPULARITY_THRESHOLD)
          .sort((a, b) => b.popularity - a.popularity)
          .slice(0, 10)
          .map(a => ({ id: a.id, name: a.name, image: a.images?.[0]?.url || null, uri: `spotify:artist:${a.id}` }));

        if (artists.length > 0) {
          sections.push({ categoryId, displayGenre, artists });
          console.log(`[trending] Section "${displayGenre}": ${artists.length} artists`);
        }
      } catch (err) {
        console.log(`[trending] Failed for category ${categoryId}:`, err.message);
      }
    }

    // Cache until next Sunday 3 AM UTC
    if (sections.length > 0) {
      await db.setCachedTrendingArtists(platformUserId, sections);
    }

    res.json({ sections });
  } catch (error) {
    console.error('Error fetching trending artists:', error);
    res.status(500).json({ error: 'Failed to fetch trending artists' });
  }
});

// Get user profile
app.get('/api/user-profile/:userId', async (req, res) => {
  try {
    let { userId } = req.params;

    // If userId is email-based, resolve to platform userId
    let platformUserId = userId;
    let platform = null;

    if (isEmailBasedUserId(userId)) {
      // Check which platform is actively connected (check Apple Music first for consistency)
      const user = await db.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      if (user.connectedPlatforms?.apple) {
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        platform = 'apple';
      } else if (user.connectedPlatforms?.spotify) {
        platformUserId = await resolvePlatformUserId(userId, 'spotify');
        platform = 'spotify';
      }

      if (!platformUserId) {
        console.log('No platform connection found for email:', userId);
        // Return basic profile for users without platform connection
        return res.json({
          displayName: null,
          image: null,
          email: userId
        });
      }
    } else {
      // Detect platform from userId prefix
      if (userId.startsWith('spotify_')) {
        platform = 'spotify';
      } else if (userId.startsWith('apple_music_')) {
        platform = 'apple';
      }
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      console.log('No tokens found for platformUserId:', platformUserId);
      // Return basic profile for users without platform connection
      return res.json({
        displayName: 'Music Lover',
        image: null,
        email: userId
      });
    }

    if (platform === 'spotify') {
      // Fetch Spotify profile
      const userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);

      // Refresh token if needed
      try {
        const refreshData = await userSpotifyApi.refreshAccessToken();
        const newAccessToken = refreshData.body.access_token;
        userSpotifyApi.setAccessToken(newAccessToken);
        tokens.access_token = newAccessToken;
        userTokens.set(platformUserId, tokens);
        await db.updateAccessToken(platformUserId, newAccessToken);
      } catch (refreshError) {
        console.log('Token refresh failed or not needed:', refreshError.message);
      }

      // Get user profile
      const userData = await userSpotifyApi.getMe();

      res.json({
        displayName: userData.body.display_name || 'User',
        email: userData.body.email,
        image: userData.body.images?.[0]?.url,
        country: userData.body.country,
        product: userData.body.product
      });

    } else if (platform === 'apple') {
      // Apple Music doesn't have a "get user profile" endpoint
      const emailForLookup = isEmailBasedUserId(userId) ? userId : (tokens?.email || null);
      const user = emailForLookup ? await db.getUser(emailForLookup) : null;
      const email = user?.email || tokens?.email || null;
      res.json({
        displayName: null,
        email: email || userId,
        image: null
      });
    }

  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({
      error: 'Failed to fetch user profile',
      details: error.message
    });
  }
});

// Search Spotify for tracks and artists
// Platform-agnostic search endpoint (supports both Spotify and Apple Music)
app.post('/api/search', async (req, res) => {
  try {
    let { query, userId } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // Check if PlatformService loaded successfully
    if (!PlatformService) {
      console.error('PlatformService not available - service failed to load at startup');
      return res.status(500).json({
        error: 'Platform service is not available',
        details: 'The service failed to load. Please contact support.'
      });
    }

    // If userId is email-based, resolve to platform userId
    let platformUserId = userId;
    if (isEmailBasedUserId(userId)) {
      // Try Spotify first
      platformUserId = await resolvePlatformUserId(userId, 'spotify');
      if (!platformUserId) {
        // Try Apple Music if Spotify not connected
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        if (!platformUserId) {
          return res.status(401).json({ error: 'No music platform connected' });
        }
      }
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const platformService = new PlatformService();

    // Get user's storefront (for Apple Music)
    const storefront = tokens.storefront || 'us';

    // Search using platform service
    const trackResults = await platformService.searchTracks(platformUserId, query, tokens, storefront, 5);

    // Format results for frontend (tracks only for now)
    const results = trackResults.map(track => ({
      id: track.id,
      type: 'track',
      name: track.name,
      artist: track.artists[0].name,
      album: track.album.name,
      image: track.album.images?.[0]?.url || null,
      uri: track.uri,
      platform: track.platform
    }));

    res.json(results);
  } catch (error) {
    console.error('Error searching:', error);
    res.status(500).json({
      error: 'Failed to search',
      details: error.message
    });
  }
});

// ─── Mix Analyzer helpers ─────────────���──────────────────────────────────────

function extractYouTubeId(url) {
  const patterns = [
    /[?&]v=([^&#]+)/,
    /youtu\.be\/([^?&#]+)/,
    /youtube\.com\/embed\/([^?&#]+)/,
  ];
  for (const p of patterns) {
    const m = (url || '').match(p);
    if (m) return m[1];
  }
  return null;
}

function parseIsoDuration(iso) {
  const m = (iso || '').match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}


async function parseMixTracklist(videoTitle, description, log = console.log) {
  const combined = `${videoTitle || ''}\n\n${description || ''}`;
  log(`description length=${(description || '').length} preview="${(description || '').slice(0, 200).replace(/\n/g, ' ')}"`);

  // Skip Claude call only if description is basically empty
  if ((description || '').trim().length < 20) {
    log('description too short, skipping tracklist parse');
    return { tracks: [], contextArtist: null };
  }

  try {
    const resp = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `Analyze this DJ mix description and extract:
1. "tracks": a JSON array of {"title","artist"} for each song. Use "" for artist if unknown.
2. "contextArtist": if the description, title, or credits make clear that all or most songs are by one artist (e.g. "All tracks by X", "X Official", channel name = artist, etc.), set this to that artist name. Otherwise null.

Return ONLY valid JSON in this shape:
{"tracks":[{"title":"...","artist":"..."}],"contextArtist":"Artist Name or null"}

${combined.slice(0, 7000)}`
      }]
    });
    const raw = resp.content[0].text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/,'');
    log(`tracklist parsed: ${raw.slice(0, 400).replace(/\n/g, ' ')}`);
    const parsed = JSON.parse(raw);
    const tracks = Array.isArray(parsed.tracks) ? parsed.tracks.filter(t => t.title) : [];
    const contextArtist = parsed.contextArtist || null;
    if (contextArtist) log(`context artist detected: "${contextArtist}"`);
    return { tracks, contextArtist };
  } catch (e) {
    log(`parseMixTracklist failed: ${e.message}`);
    return { tracks: [], contextArtist: null };
  }
}


// GET /api/analyze-mix — SSE endpoint; streams identified tracks back as they're found
app.get('/api/analyze-mix', async (req, res) => {
  const { youtubeUrl, userId, platform = 'spotify' } = req.query;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  let closed = false;
  req.on('close', () => { closed = true; });

  const reqId = Math.random().toString(36).slice(2, 7);
  const log = (...args) => console.log(`[mix:${reqId}]`, ...args);

  const send = (data) => {
    if (!closed) res.write(`data: ${JSON.stringify(data)}\n\n`);
  };

  log(`START url=${youtubeUrl} user=${userId} platform=${platform}`);

  try {
    const videoId = extractYouTubeId(youtubeUrl);
    if (!videoId) {
      send({ type: 'error', message: 'Invalid YouTube URL' });
      return res.end();
    }

    // Resolve platform user + tokens
    let platformUserId = userId;
    if (userId && isEmailBasedUserId(userId)) {
      platformUserId = await resolvePlatformUserId(userId, platform);
    }
    const tokens = platformUserId ? await getUserTokens(platformUserId) : null;
    if (!tokens) {
      send({ type: 'error', message: 'Not authenticated with music platform' });
      return res.end();
    }

    // ── Step 1: Get video metadata ───────────────────────────────────────────
    send({ type: 'status', message: 'Loading video info...' });
    let videoTitle = '', videoDescription = '', videoDuration = 0, videoChapters = [];

    // Primary: yt-dlp --dump-json (no API key needed, most reliable)
    let metaLoaded = false;
    try {
      const meta = await new Promise((resolve, reject) => {
        const proc = spawn('python3', ['-m', 'yt_dlp', '--dump-json', '--no-playlist', youtubeUrl]);
        let out = '';
        proc.stdout.on('data', d => { out += d.toString(); });
        proc.on('close', code => {
          if (code === 0 && out.trim()) {
            try { resolve(JSON.parse(out.trim())); } catch { reject(new Error('Bad JSON')); }
          } else {
            reject(new Error(`yt-dlp exited ${code}`));
          }
        });
        proc.on('error', (err) => reject(new Error(`yt-dlp spawn error: ${err.code}`)));
        setTimeout(() => { proc.kill(); reject(new Error('yt-dlp timeout')); }, 20000);
      });
      videoTitle       = meta.title || '';
      videoDescription = meta.description || '';
      videoDuration    = meta.duration || 0;
      videoChapters    = meta.chapters || [];
      metaLoaded = true;
    } catch (e) {
      log(`yt-dlp metadata failed: ${e.message}`);
    }

    // Fallback: YouTube Data API (requires YOUTUBE_API_KEY)
    if (!metaLoaded && process.env.YOUTUBE_API_KEY) {
      try {
        const ytResp = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
          params: { id: videoId, part: 'snippet,contentDetails', key: process.env.YOUTUBE_API_KEY },
          timeout: 8000,
        });
        const item = ytResp.data.items?.[0];
        if (item) {
          videoTitle       = item.snippet.title;
          videoDescription = item.snippet.description;
          videoDuration    = parseIsoDuration(item.contentDetails.duration);
          metaLoaded = true;
        }
      } catch (e) {
        log(`YouTube API fallback failed: ${e.message}`);
      }
    }

    if (!metaLoaded) {
      send({ type: 'error', message: 'Could not load video. Install yt-dlp (pip3 install yt-dlp) or set YOUTUBE_API_KEY.' });
      return res.end();
    }

    send({ type: 'info', title: videoTitle, duration: videoDuration });

    // Platform search helper
    const platformSvc = new PlatformService();
    const storefront  = tokens.storefront || 'us';
    const seenIds     = new Set();

    // Check if a result title is a plausible match for what we searched.
    // Requires at least one significant word in common to prevent Spotify's
    // "best guess" false positives when a song isn't available.
    const STOPWORDS = new Set(['the','a','an','in','on','at','to','for','of','and','or','but','is','it','be','me','my','you','we','he','she','they','just','not','so','if','by','as','with','from','up','do','did','was','are','has','had','will','no','can','its','our','out','his','her','now','new','all','one','two','feat','ft']);
    const sigWords = (s) => s.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter(w => w.length >= 3 && !STOPWORDS.has(w));
    const hasNonAscii = (s) => /[^\x00-\x7F]/.test(s);
    const titleMatches = (searchTitle, resultTitle, artistKnown) => {
      if (hasNonAscii(searchTitle)) {
        // For non-ASCII titles (Japanese, Korean, etc.), only accept if the result
        // also contains non-ASCII characters — an English result for a Japanese
        // search is always a wrong match.
        return hasNonAscii(resultTitle);
      }
      const qWords = sigWords(searchTitle);
      if (qWords.length === 0) return true; // too short to check
      const rWords = sigWords(resultTitle);
      const rWordSet = new Set(rWords);

      if (!artistKnown) {
        // Without an artist, Spotify returns its "best guess" even when the exact
        // song isn't in its catalog. Require strict bidirectional word match:
        // every significant word in the search must appear in the result AND
        // vice versa. This rejects "similar title, different song" false positives
        // (e.g. "Snow Beneath My Breath" → "The snow melted beneath my breath").
        const qWordSet = new Set(qWords);
        return qWords.every(w => rWordSet.has(w)) && rWords.every(w => qWordSet.has(w));
      }

      // Artist is known — one significant word overlap is enough since the artist
      // field already anchors the search to the right song.
      return qWords.some(w => rWordSet.has(w));
    };

    const searchSpotify = async (title, artist) => {
      const query = artist ? `${title} ${artist}` : title;
      const results = await platformSvc.searchTracks(platformUserId, query, tokens, storefront, 1);
      return results?.length > 0 ? results[0] : null;
    };

    const searchAndEmit = async (title, artist) => {
      if (closed) return false;
      try {
        let track = await searchSpotify(title, artist);

        // Reject false positives: if result title shares no significant words with search title, discard it
        if (track && !titleMatches(title, track.name, !!artist)) {
          log(`false positive rejected: searched "${title}", got "${track.name}"`);
          track = null;
        }

        if (track) {
          if (seenIds.has(track.id)) return true;
          seenIds.add(track.id);
          log(`matched "${title}" → "${track.name}" by ${track.artists[0].name}`);
          send({
            type:     'track',
            id:       track.id,
            name:     track.name,
            artist:   track.artists[0].name,
            album:    track.album.name,
            image:    track.album.images?.[0]?.url || null,
            uri:      track.uri,
            explicit: track.explicit || false,
          });
          return true;
        }
      } catch (e) {
        log(`search error for "${title}": ${e.message}`);
      }
      log(`unmatched "${title}" by "${artist}"`);
      send({ type: 'unmatched', title, artist });
      return false;
    };

    // ── Step 2: Description parsing ──────────────────────────────────────────
    log(`video title="${videoTitle}" duration=${videoDuration}s`);
    send({ type: 'status', message: 'Analyzing mix...' });
    const { tracks: tracklist, contextArtist } = await parseMixTracklist(videoTitle, videoDescription, log);

    if (tracklist.length > 0) {
      log(`tracklist found: ${tracklist.length} tracks`);

      // Apply contextArtist to tracks that have no individual artist
      if (contextArtist) {
        tracklist.forEach(t => { if (!t.artist) t.artist = contextArtist; });
        log(`applied context artist "${contextArtist}" to tracks without an artist`);
      }

      send({ type: 'source', method: 'description', total: tracklist.length });
      for (const track of tracklist) {
        if (closed) break;
        await searchAndEmit(track.title, track.artist);
      }
      send({ type: 'done' });
      return res.end();
    }

    // ── Step 2.5: Try chapters ───────────────────────────────────────────────
    if (videoChapters.length > 0) {
      log(`found ${videoChapters.length} chapters, parsing for tracklist`);
      const chapterText = videoChapters.map(c => c.title).join('\n');
      const { tracks: chapterTracklist, contextArtist: chapterContextArtist } = await parseMixTracklist(videoTitle, chapterText, log);
      if (chapterTracklist.length > 0) {
        log(`tracklist found in chapters: ${chapterTracklist.length} tracks`);
        if (chapterContextArtist) {
          chapterTracklist.forEach(t => { if (!t.artist) t.artist = chapterContextArtist; });
        }
        send({ type: 'source', method: 'description', total: chapterTracklist.length });
        for (const track of chapterTracklist) {
          if (closed) break;
          await searchAndEmit(track.title, track.artist);
        }
        send({ type: 'done' });
        return res.end();
      }
      log('no tracklist found in chapters');
    }

    // ── Step 3: Try top comments ─────────────────────────────────────────────
    if (process.env.YOUTUBE_API_KEY) {
      send({ type: 'status', message: 'Fetching songs...' });
      try {
        const commentsResp = await axios.get('https://www.googleapis.com/youtube/v3/commentThreads', {
          params: { videoId, part: 'snippet', order: 'relevance', maxResults: 20, key: process.env.YOUTUBE_API_KEY },
          timeout: 8000,
        });
        const comments = (commentsResp.data.items || [])
          .map(item => item.snippet.topLevelComment.snippet.textDisplay)
          .join('\n\n---\n\n');

        if (comments.trim()) {
          log(`fetched ${commentsResp.data.items?.length || 0} comments, parsing for tracklist`);
          const { tracks: commentTracklist, contextArtist: commentContextArtist } = await parseMixTracklist(videoTitle, comments, log);

          if (commentTracklist.length > 0) {
            log(`tracklist found in comments: ${commentTracklist.length} tracks`);
            if (commentContextArtist) {
              commentTracklist.forEach(t => { if (!t.artist) t.artist = commentContextArtist; });
            }
            send({ type: 'source', method: 'description', total: commentTracklist.length });
            for (const track of commentTracklist) {
              if (closed) break;
              await searchAndEmit(track.title, track.artist);
            }
            send({ type: 'done' });
            return res.end();
          }
          log('no tracklist found in comments');
        }
      } catch (e) {
        log(`comments fetch failed: ${e.message}`);
      }
    }

    // No tracklist found anywhere
    send({ type: 'error', message: "No tracklist found in this video's description or comments. Song identification without a tracklist is not yet supported, but we're actively working on it." });
    log('no tracklist found, ending');
    return res.end();

  } catch (err) {
    log(`fatal: ${err.message}`);
    send({ type: 'error', message: err.message || 'Analysis failed' });
    res.end();
  }
});

// Legacy Spotify search endpoint (kept for backwards compatibility)
app.post('/api/search-spotify', async (req, res) => {
  try {
    let { query, userId } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    // If userId is email-based, resolve to Spotify platform userId
    let platformUserId = userId;
    if (isEmailBasedUserId(userId)) {
      platformUserId = await resolvePlatformUserId(userId, 'spotify');
      if (!platformUserId) {
        return res.status(404).json({ error: 'Spotify not connected' });
      }
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const userSpotifyApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
    });
    userSpotifyApi.setAccessToken(tokens.access_token);
    userSpotifyApi.setRefreshToken(tokens.refresh_token);

    // Refresh token if needed
    try {
      const refreshData = await userSpotifyApi.refreshAccessToken();
      const newAccessToken = refreshData.body.access_token;
      userSpotifyApi.setAccessToken(newAccessToken);
      tokens.access_token = newAccessToken;
      userTokens.set(platformUserId, tokens);
      await db.updateAccessToken(platformUserId, newAccessToken);
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
    }

    // Search for both tracks and artists
    const searchResult = await userSpotifyApi.search(query, ['track', 'artist'], { limit: 5 });

    const results = [];

    // Add artists
    if (searchResult.body.artists && searchResult.body.artists.items) {
      searchResult.body.artists.items.forEach(artist => {
        results.push({
          id: artist.id,
          type: 'artist',
          name: artist.name,
          image: artist.images[0]?.url,
          uri: artist.uri
        });
      });
    }

    // Add tracks
    if (searchResult.body.tracks && searchResult.body.tracks.items) {
      searchResult.body.tracks.items.forEach(track => {
        results.push({
          id: track.id,
          type: 'track',
          name: track.name,
          artist: track.artists[0].name,
          album: track.album.name,
          image: track.album.images[0]?.url,
          uri: track.uri
        });
      });
    }

    res.json(results);
  } catch (error) {
    console.error('Error searching Spotify:', error);
    res.status(500).json({
      error: 'Failed to search',
      details: error.message
    });
  }
});

// Generate playlist using AI
app.post('/api/generate-playlist', async (req, res) => {
  try {
    let { prompt, userId, platform = 'spotify', allowExplicit = true, songCount = 30, excludeTrackUris = [], playlistId = null, internalCall = false } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Weekly generation limit for free users (skip for internal auto-update calls)
    if (!internalCall) {
      const requestEmail = isEmailBasedUserId(userId) ? userId : await getEmailUserIdFromPlatform(userId);
      if (requestEmail) {
        const userRecord = await db.getUser(requestEmail);
        if (userRecord && userRecord.plan !== 'paid') {
          const now = new Date();
          const resetAt = userRecord.weeklyResetAt ? new Date(userRecord.weeklyResetAt) : null;
          const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

          if (resetAt && (now - resetAt) < sevenDaysMs) {
            // Same week - check limit
            if (userRecord.weeklyGenerations >= 1) {
              const nextReset = new Date(resetAt.getTime() + sevenDaysMs);
              return res.status(429).json({
                error: 'You have reached your weekly playlist limit. Upgrade to generate more playlists.',
                code: 'WEEKLY_LIMIT_REACHED',
                resetsAt: nextReset.toISOString()
              });
            } else {
              await db.incrementWeeklyGenerations(requestEmail);
            }
          } else {
            // New week or first generation - reset counter (sets to 1) and allow
            await db.resetWeeklyGenerations(requestEmail);
          }
        }
      }
    }

    // Deduplicate parallel identical requests from the same user
    if (!internalCall) {
      const dedupKey = `${userId}::${prompt}::${songCount}`;
      const now = Date.now();
      const last = inFlightGenerations.get(dedupKey);
      if (last && (now - last) < 15000) {
        console.log(`[dedup] Rejecting duplicate generation request for key: ${dedupKey}`);
        return res.status(429).json({ error: 'A generation request is already in progress. Please wait.' });
      }
      inFlightGenerations.set(dedupKey, now);
      setTimeout(() => inFlightGenerations.delete(dedupKey), 30000);
    }

    // If userId is email-based, resolve to platform userId
    let platformUserId = userId;
    if (isEmailBasedUserId(userId)) {
      platformUserId = await resolvePlatformUserId(userId, platform);
      if (!platformUserId) {
        return res.status(404).json({ error: `${platform === 'spotify' ? 'Spotify' : 'Apple Music'} not connected` });
      }
    }

    // Get user tokens
    const tokens = await getUserTokens(platformUserId);
    if (!tokens && platform === 'spotify') {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    // Create a new instance for this user to avoid conflicts
    let userSpotifyApi;
    if (platform === 'spotify') {
      userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);

      // Try to refresh the access token if it's expired
      try {
        const refreshData = await userSpotifyApi.refreshAccessToken();
        const newAccessToken = refreshData.body.access_token;
        userSpotifyApi.setAccessToken(newAccessToken);

        // Update stored tokens
        tokens.access_token = newAccessToken;
        userTokens.set(platformUserId, tokens);
        saveTokens(); // Persist to file

        console.log('Access token refreshed for generate playlist');
      } catch (refreshError) {
        console.log('Token refresh failed or not needed:', refreshError.message);
        // Continue anyway - token might still be valid
      }
    }

    // Existing tracks from the stored playlist — used later in the vibe check as concrete
    // reference examples so Claude can judge new candidates against real songs, not just labels.
    let existingPlaylistTracks = [];

    // For refreshes/refinements: rebuild prompt from stored playlist data
    // BEFORE Claude extraction so genreData comes from the user's actual intent, not a
    // frontend-built track list that drifts every refresh. Always enrich with description
    // and top-5 artists so Claude has concrete genre anchors regardless of how sparse the
    // original prompt is.
    if (playlistId && userId) {
      let userPlaylistsArray = userPlaylists.get(userId) || [];
      let storedPlaylist = userPlaylistsArray.find(p => p.playlistId === playlistId);
      // DB fallback: in-memory map is empty after server restart; load from Postgres
      if (!storedPlaylist && usePostgres) {
        const dbPlaylists = await db.getUserPlaylists(userId);
        userPlaylists.set(userId, dbPlaylists);
        userPlaylistsArray = dbPlaylists;
        storedPlaylist = dbPlaylists.find(p => p.playlistId === playlistId);
      }
      if (storedPlaylist) {
        // Extract the new refinement from the incoming prompt if present
        // (the frontend sends "Original request: "..." \n\nRefinement: <new message>" or
        // "...\n\nNew refinement: <new message>" — this hasn't been saved to the DB yet)
        let incomingRefinement = null;
        const _newRefinementMatch = prompt.match(/\n\nNew refinement:\s*(.+)$/is)
          || prompt.match(/\n\nRefinement:\s*(.+)$/is);
        if (_newRefinementMatch) {
          incomingRefinement = _newRefinementMatch[1].trim();
        }

        const storedRefinements = [
          ...(storedPlaylist.chatMessages || []).filter(m => m.role === 'user').map(m => m.content),
          ...(storedPlaylist.refinementInstructions || []),
          ...(incomingRefinement ? [incomingRefinement] : []),
        ];

        // Resolve description first — needed to decide whether to include the playlist name
        let desc = (storedPlaylist.description || '').trim();

        // If stored description is empty, re-fetch live from Spotify and persist it
        if (!desc && platform === 'spotify' && userSpotifyApi && playlistId) {
          try {
            const livePlaylist = await userSpotifyApi.getPlaylist(playlistId, { fields: 'description' });
            const liveDesc = (livePlaylist.body.description || '').trim();
            if (liveDesc) {
              desc = liveDesc;
              storedPlaylist.description = liveDesc;
              db.savePlaylist(userId, storedPlaylist.playlistId, storedPlaylist).catch(() => {});
              console.log(`[REFRESH] Fetched live Spotify description for "${storedPlaylist.playlistName}": "${liveDesc}"`);
            }
          } catch (descErr) {
            console.log(`[REFRESH] Could not fetch live Spotify description: ${descErr.message}`);
          }
        }

        // Base prompt: use originalPrompt for AI-generated playlists.
        // For imports: skip the name when a description is available (the name can bias
        // genre extraction, e.g. "Kings & Sinners" → metal). Fall back to name only
        // when there is no description to anchor on.
        if (storedPlaylist.originalPrompt) {
          prompt = storedPlaylist.originalPrompt;
        } else if (desc) {
          prompt = `Generate a playlist`;
        } else {
          prompt = `Generate songs similar to the playlist "${storedPlaylist.playlistName}"`;
        }
        if (storedRefinements.length > 0) {
          prompt += `. Refinements: ${storedRefinements.join('. ')}`;
        }

        if (desc) prompt += `\n\nPlaylist description: ${desc}`;
        // Only include key artists for imported playlists (no originalPrompt) where genre
        // context cannot be inferred from the original user request. For AI-generated playlists,
        // originalPrompt + description already define the genre — adding current track artists
        // creates a feedback loop where bad artists perpetuate across refreshes.
        if (!storedPlaylist.originalPrompt && storedPlaylist.tracks?.length > 0) {
          const trackArtists = [...new Set(storedPlaylist.tracks.map(t => t.artist).filter(Boolean))].slice(0, 5);
          if (trackArtists.length > 0) prompt += `\n\nKey artists in this playlist: ${trackArtists.join(', ')}.`;
        }

        // Capture up to 10 existing songs as vibe check reference examples
        if (storedPlaylist.tracks?.length > 0) {
          existingPlaylistTracks = storedPlaylist.tracks.slice(0, 10).map(t => `"${t.name}" by ${t.artist}`);
        }

        console.log(`[REFRESH] Rebuilt prompt for "${storedPlaylist.playlistName}": "${prompt.substring(0, 150)}${prompt.length > 150 ? '...' : ''}"`);
      }
    }

    // ── Structured refinement prompt normalization ────────────────────────────
    // When the draft lookup above didn't fire (no playlistId, or draft not found),
    // the frontend's structured prompt still reaches here unchanged:
    //   Original request: "indie songs like Phoebe Bridgers"
    //   Key artists in this playlist: Phoebe Bridgers, Alex G, ...
    //   Refinement: can you make it r&b songs
    //
    // The "Key artists" line biases Claude's genre extraction toward the old genre.
    // Strip it and rebuild into the cleaner format that Claude handles correctly.
    {
      const _origMatch = prompt.match(/^Original request:\s*"([^"]+)"/i);
      const _refMatch = prompt.match(/\n\n(?:New refinement|Refinement):\s*(.+)$/is);
      const _prevRefMatch = prompt.match(/\n\nPrevious refinements:\s*(.+?)\n\nNew refinement:/is);
      if (_origMatch && _refMatch) {
        const _origReq = _origMatch[1].trim();
        const _newRef = _refMatch[1].trim();
        const _prevRefs = _prevRefMatch ? _prevRefMatch[1].trim() : null;
        const _descMatch = prompt.match(/\n\nPlaylist description:\s*(.+?)(?:\n\n|$)/is);
        const _desc = _descMatch ? _descMatch[1].trim() : null;
        // Rebuild without artist context — keep only original, description, and refinements
        const _allRefinements = [
          ...(_prevRefs ? [_prevRefs] : []),
          _newRef,
        ].filter(Boolean).join('. ');
        prompt = _origReq;
        if (_allRefinements) prompt += `. Refinements: ${_allRefinements}`;
        if (_desc) prompt += `\n\nPlaylist description: ${_desc}`;
        console.log(`[REFINE-NORMALIZE] Stripped artist context, rebuilt prompt: "${prompt.substring(0, 150)}${prompt.length > 150 ? '...' : ''}"`);
      }
    }

    // ── Age-to-era preprocessing ─────���──────────────────��─────────────────────
    // Detect "I'm X, take me back to being Y" or "I was 16 in [year]" patterns
    // and inject the computed year range into the prompt so Claude doesn't have
    // to do the math (it often fails). Current year is used as reference.
    const _currentYear = new Date().getFullYear();
    const _ageToEraMatch = prompt.match(/i(?:'m| am) (\d{1,2}).*?(?:take me back|reminds? me|when i was|back to being|feel like i(?:'m| was)|being) (\d{1,2})/i)
      || prompt.match(/(?:take me back|feel like i(?:'m| was)|back to being|when i was|reminds? me of being) (\d{1,2}).*?i(?:'m| am) (\d{1,2})/i);
    if (_ageToEraMatch) {
      const [, a, b] = _ageToEraMatch;
      const currentAge = parseInt(a), targetAge = parseInt(b);
      if (currentAge > targetAge && currentAge <= 100 && targetAge >= 5) {
        const eraCenter = _currentYear - (currentAge - targetAge);
        const eraMin = eraCenter - 2;
        const eraMax = eraCenter + 3;
        prompt += ` [Era hint: user is ${currentAge} and wants to feel ${targetAge} again — that maps to approximately ${eraMin}–${eraMax}. Set yearRange.min=${eraMin}, yearRange.max=${eraMax}.]`;
        console.log(`🎂 Age-to-era: ${currentAge}yo → ${targetAge}yo = era ${eraMin}–${eraMax}`);
      }
    }

    // Escapism pre-processing: detect "stated desired state + conflicting real-world context."
    // Without this, the extraction step sees the real-world context word as a mood/energy signal
    // and delivers music for where the user IS rather than where they WANT TO BE.
    // The fix must run here — before extraction — so the override wins before mood inference starts.
    // Each check: (stated desire pattern) + (conflicting context pattern) → inject an override hint.
    // Only the first match fires; they're ordered by specificity.
    const _escapismChecks = [
      {
        // Summer/warm escapism + cold/winter context
        // e.g. "I need a summer playlist, it's freezing outside"
        wants: () => /\b(summer|beach|warm|tropical|july|august)\b.{0,60}\b(playlist|music|songs|vibes|feel|energy)\b/i.test(prompt)
          || /\b(playlist|music|songs|vibes)\b.{0,60}\b(summer|beach|warm|tropical)\b/i.test(prompt),
        conflict: () => /\b(freez|freezing|cold|winter|snow|icy|chilly)\b/i.test(prompt),
        hint: `User is requesting SUMMER ESCAPISM. The cold/winter/freezing detail explains WHY they want summer music — it is NOT a mood or genre signal. Set useCase: "summer", mood: "positive", atmosphere: ["carefree", "warm", "upbeat", "beachy"], suggestedSeedArtists to summery artists (Harry Styles, Doja Cat, Summer Salt, Bad Bunny, Outkast). Do NOT set any cold, melancholic, or wintry signals.`,
        emoji: '☀️ ',
      },
      {
        // Party/high-energy escapism + tired/weekday/work context
        // e.g. "it's Monday morning but I need a Friday night playlist"
        // e.g. "I'm exhausted but need something to hype me up"
        wants: () => /\b(party|hype|friday night|weekend energy|pregame|going out|bops|club|dance floor|high energy)\b/i.test(prompt),
        conflict: () => /\b(tired|exhausted|monday|tuesday|wednesday|thursday|early morning|work day|at work|office|long day|drained)\b/i.test(prompt),
        hint: `User wants HIGH ENERGY/PARTY music as escapism from tiredness or a weekday context. "Tired" / "Monday" / "work" explains WHY they need the energy boost — it is NOT an energy or mood signal. Set energyTarget: "high", mood: "positive", useCase: "party". Do NOT set low energy, melancholic, or study-mode signals.`,
        emoji: '🎉',
      },
      {
        // Outdoor/festival escapism + stuck inside/trapped context
        // e.g. "I'm stuck inside but give me an outdoor festival vibe"
        wants: () => /\b(outdoor|outside|festival|open air|windows down|fresh air|road trip)\b/i.test(prompt),
        conflict: () => /\b(stuck inside|trapped|can'?t go out|indoors|at home|locked in|can'?t leave|inside all day)\b/i.test(prompt),
        hint: `User wants OUTDOOR/FESTIVAL vibes as escapism from being stuck inside. The "stuck inside" detail explains WHY they want it — it is NOT a use-case or context signal. Deliver open, energetic, feel-good outdoor music. Do NOT set indoor, home, or ambient signals.`,
        emoji: '🌲',
      },
    ];
    for (const check of _escapismChecks) {
      if (check.wants() && check.conflict()) {
        prompt += ` [OVERRIDE: ${check.hint}]`;
        console.log(`${check.emoji} Escapism conflict detected — injecting override hint`);
        break;
      }
    }

    console.log('Generating playlist for prompt:', prompt);

    // Step 0: Use Claude to extract the genre, style, audio features, AND all refinement constraints from the prompt
    const genreExtractionResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1200,
      messages: [{
        role: 'user',
        content: `Extract ALL musical characteristics, constraints, and refinement preferences from this playlist prompt.

IMPORTANT — when the prompt contains "Refinements: ...", treat those as ADDITIVE constraints that layer on top of the original request. Refinements ALWAYS preserve ALL original constraints (genre, mood, energy, artists, era, etc.). They only add or narrow — never replace or remove.
Examples:
- "sad late-night playlist. Refinements: I want R&B" → sad R&B (keep mood + energy, add genre)
- "I want Drake songs. Refinements: sad songs" → sad Drake songs (keep requestedArtists: [Drake], add mood: melancholic)
- "upbeat workout songs. Refinements: make it hip-hop" → upbeat hip-hop workout (keep energyTarget: high, add genre)
- "chill indie music. Refinements: more acoustic" → chill acoustic indie (keep genre + mood, add production preference)
- "80s rock. Refinements: more guitar-driven" → 80s guitar-driven rock (keep era + genre, add style detail)
Never drop any constraint from the original request for any reason. If the user wants a completely different playlist, they start a new one.

Prompt: "${prompt}"

Respond ONLY with valid JSON in this format:
{
  "primaryGenre": "the main genre or null",
  "subgenre": "specific subgenre or null",
  "secondaryGenres": ["related genres"],
  "keyCharacteristics": ["soulful", "upbeat", etc.],
  "style": "overall vibe/style",
  "atmosphere": ["mood tags"],
  "era": {
    "decade": "specific decade or null",
    "yearRange": { "min": year or null, "max": year or null },
    "descriptors": ["vintage", "modern", etc.]
  },
  "culturalContext": {
    "region": "geographic region or null",
    "movement": "cultural movement or null",
    "scene": "music scene or null",
    "language": { "prefer": ["list of preferred languages, e.g. 'Spanish', 'Korean'"], "exclude": ["list of excluded languages"] }
  },
  "contextClues": {
    "useCase": "canonical activity/context — MUST be one of: party | workout | focus | chill | sleep | summer | heartbreak | background | morning | null. Never invent new values. Map semantically using these examples: party (pregame, hype, banger, bangers, turn up, turn up tonight, going out, we're going out, night out, club, dance, bar, tailgate, hard hitting, slaps, absolute banger) | workout (gym, run, running, exercise, training, cardio, lifting) | focus (study, deep work, coding, concentration, homework, productivity) | chill (relax, winding down, lazy, easy listening, background, drive, road trip) | sleep (bedtime, falling asleep, wind down, nap, meditation) | summer (beach, sunny, warm, pool, tropical, vacation, july, august) | heartbreak (sad, breakup, crying, missing someone, emotional) | background (dinner, cooking, hosting, ambient, gathering, friends over) | morning (waking up, commute, getting ready, start the day). If genuinely ambiguous between two categories, return null — falling through to genre/mood is better than a wrong useCase.",
    "audience": ["christian", "family", "youth", "clean"] or [],
    "avoidances": ["what NOT to include"]
  },
  "trackConstraints": {
    "popularity": { "min": 0-100 or null, "max": 0-100 or null, "preference": "mainstream/underground/balanced" or null },
    "duration": { "min": seconds or null, "max": seconds or null },
    "excludeVersions": ["live", "remix", "acoustic", "cover", "instrumental", "edit", "remaster"] or [],
    "albumDiversity": { "maxPerAlbum": number or null, "preferDeepCuts": boolean, "preferSingles": boolean },
    "artistDiversity": { "maxPerArtist": number or null }
  },
  "artistConstraints": {
    "vocalGender": "male/female/mixed/any" or null,
    "artistType": "solo/band/any" or null,
    "excludeFeatures": boolean,
    "requestedArtists": ["exact artist names mentioned in prompt"] or [],
    "excludedArtists": ["artist names the user explicitly wants excluded"] or [],
    "exclusiveMode": boolean (true if user wants ONLY these specific artists, false for "similar vibe" mix)
  },
  "productionStyle": {
    "preference": "acoustic/produced/lofi/polished/raw" or null,
    "avoidAutoTune": boolean
  },
  "lyricalContent": {
    "themes": ["love", "party", "introspective", etc.] or [],
    "avoid": ["breakup", "political", "explicit", etc.] or []
  },
  "discoveryBalance": {
    "preference": "cohesive/varied/unexpected" or null,
    "familiarityRatio": { "hits": 0.0-1.0 or null, "deepCuts": 0.0-1.0 or null }
  },
  "songCount": integer (5-100) or null,
  "referenceSongs": [{ "title": "song title", "artist": "artist name" }] or [],
  "bpmConstraint": { "min": BPM integer or null, "max": BPM integer or null },
  "mood": "positive" | "neutral" | "melancholic" | null,
  "energyTarget": "low" | "medium" | "high" | null,
  "energyProgression": "ramp_up" | "ramp_down" | null,
  "phases": [{"label": "string", "energy": "low"|"medium"|"high", "mood": "positive"|"neutral"|"melancholic"|null, "fraction": 0.0-1.0}] or null,
  "genreAccessibility": "newcomer" | "curious" | "enthusiast" | null,
  "soundchartsFilters": [
    { "type": "filterType", "data": {} }
  ]
}

EXTRACTION GUIDELINES:

ERA & TIME:
- CRITICAL: ONLY set yearRange.min/max for EXPLICIT year specifications. NEVER set yearRange.min/max for decade descriptors — only set the decade field.
- "90s", "2000s", "2010s", "X classics", "[decade] vibes", "old school", "throwback": Set decade field ONLY — leave yearRange.min and yearRange.max as null
- "past 5 years", "last 3 years", "recent": Set yearRange.min to ${new Date().getFullYear() - 5} (adjust N), yearRange.max to ${new Date().getFullYear()}
- "from 2015 to 2020": Set min: 2015, max: 2020
- "only 2020 songs": Set both min and max to 2020
- "contemporary", "modern": Set min to ${new Date().getFullYear() - 5}, max to null

POPULARITY:
- "mainstream hits", "popular songs": min: 70
- "underground", "indie", "deep cuts": max: 40
- "hidden gems", "lesser known": max: 50
- "mix of popular and underground": preference: "balanced"

SONG LENGTH (per-track duration only — NOT total playlist runtime):
- ONLY use trackConstraints.duration when the user describes individual song length: "short songs", "under 3 minutes", "no songs over 4 minutes", "long tracks"
- "short songs", "under 3 minutes": max: 180
- "longer tracks", "over 5 minutes": min: 300
- "no songs over 4 minutes": max: 240
- Convert minutes to seconds
- CRITICAL: "X minutes of music", "a 45-minute playlist", "an hour of music" → these describe TOTAL RUNTIME, not song length. Set songCount (e.g. 45 min → ~13 songs, 1 hour → ~15 songs, 2 hours → ~30 songs). Do NOT set trackConstraints.duration for total runtime requests.

VERSION EXCLUSIONS:
- "no live", "studio only": exclude ["live"]
- "no remixes": exclude ["remix"]
- "no covers": exclude ["cover"]
- "original versions only": exclude ["live", "remix", "cover", "acoustic", "edit"]

ALBUM DIVERSITY:
- "no more than 2 per album": maxPerAlbum: 2
- "album tracks", "deep cuts": preferDeepCuts: true
- "singles only", "hits only": preferSingles: true

ARTIST DIVERSITY:
- "each song by different artist", "one song per artist", "no repeats by same artist", "every song different artist", "no artist twice": maxPerArtist: 1
- "no more than 2 songs per artist", "max 2 per artist": maxPerArtist: 2
- "more diversity" (without specific artist count): maxPerArtist: 2

VOCALS:
- "female vocals", "female artists": vocalGender: "female"
- "male vocals": vocalGender: "male"
- "solo artists only": artistType: "solo"
- "bands only": artistType: "band"
- "no features", "no collaborations": excludeFeatures: true

SPECIFIC ARTISTS:
- "artists like [name]", "similar to [artist]", "songs from [artist]": Extract EXACT artist names to requestedArtists array
- Be precise with artist names - do NOT confuse similar names (e.g., "C.LACY" is NOT "Steve Lacy")
- Include ALL mentioned artists, even if they're indie/underground
- EXCLUSIVE MODE DETECTION:
  * exclusiveMode: true ONLY if user wants nothing but that artist: "only [artist]", "just [artist]", "exclusively [artist]"
  * exclusiveMode: false for everything else including: "add [artist] songs", "add more [artist]", "include [artist]", "songs from [artist]", "like [artist]", "similar to [artist]", "vibes of [artist]"
- Examples:
  * "artists like C.LACY or Tyree Thomas" → requestedArtists: ["C.LACY", "Tyree Thomas"], exclusiveMode: false
  * "i only want songs from drake" → requestedArtists: ["Drake"], exclusiveMode: true
  * "just Taylor Swift songs" → requestedArtists: ["Taylor Swift"], exclusiveMode: true
  * "add one direction songs" → requestedArtists: ["One Direction"], exclusiveMode: false
  * "add more beyoncé" → requestedArtists: ["Beyoncé"], exclusiveMode: false
  * "include some weeknd" → requestedArtists: ["The Weeknd"], exclusiveMode: false
  * "songs like Need my baby by Reo Xander" → requestedArtists: ["Reo Xander"], exclusiveMode: false
  * "Taylor Swift and Olivia Rodrigo vibes" → requestedArtists: ["Taylor Swift", "Olivia Rodrigo"], exclusiveMode: false

PRODUCTION:
- "acoustic", "unplugged", "stripped": preference: "acoustic"
- "produced", "polished": preference: "polished"
- "lo-fi", "bedroom pop": preference: "lofi"
- "raw", "live feel": preference: "raw"
- "no auto-tune": avoidAutoTune: true

LYRICAL CONTENT:
- "uplifting lyrics": themes: ["uplifting"]
- "love songs": themes: ["love", "romantic"]
- "party themes": themes: ["party", "celebration"]
- "no breakup songs": avoid: ["breakup"]
- "no political": avoid: ["political"]

DISCOVERY:
- "cohesive", "similar sound": preference: "cohesive"
- "variety", "eclectic": preference: "varied"
- "surprise me", "unexpected picks": preference: "unexpected"
- FAMILIARITY RATIO: When user specifies a split between hits and deep cuts, extract both fractions (must sum to 1.0):
  * "80% hits, 20% deep cuts" → familiarityRatio: { hits: 0.8, deepCuts: 0.2 }
  * "mostly popular songs with a few deep cuts" → familiarityRatio: { hits: 0.75, deepCuts: 0.25 }
  * "half and half, half known half obscure" → familiarityRatio: { hits: 0.5, deepCuts: 0.5 }
  * "mostly deep cuts with a few hits" → familiarityRatio: { hits: 0.25, deepCuts: 0.75 }
  * If no ratio specified → familiarityRatio: { hits: null, deepCuts: null }

SONG COUNT:
- Explicit numbers: "50 songs", "25 tracks", "30 pop songs", "give me 40" → extract that number
- Vague quantities: "a few songs" = 10, "a handful" = 10, "a couple" = 6, "a lot of songs" = 50, "loads of tracks" = 50, "a ton of music" = 60
- Duration-based: "an hour of music" = 15, "a 30-minute playlist" = 8, "a 2-hour mix" = 30
- Size descriptors: "short playlist" = 10, "quick playlist" = 10, "big playlist" = 50, "massive playlist" = 75, "full playlist" = 30
- If no count is implied at all → null

USE CASE → GENRE/MOOD DEFAULTS (when no explicit genre is given):
When the user describes a task, activity, or situation with no genre keywords, infer the music intent from context:
- "clean my apartment", "clean the house", "doing chores", "make time pass" → mood: "positive", energyTarget: "medium", atmosphere: ["upbeat", "fun"], useCase: "party", suggestedSeedArtists: ["Dua Lipa", "Lizzo", "Carly Rae Jepsen", "Paramore", "Katy Perry"]
- "pregame", "hype playlist", "banger", "bangers", "going out tonight", "turn up", "turn up tonight", "night out", "we're going out", "hard hitting", "hard-hitting", "slap", "slaps", "absolute banger" → mood: "positive", energyTarget: "high", atmosphere: ["hype", "energetic"], useCase: "party", suggestedSeedArtists: pick ONLY demonstrably high-energy artists — e.g. Travis Scott, Drake, Metro Boomin, 21 Savage, Calvin Harris (upbeat era), David Guetta, Dua Lipa (upbeat tracks), Cardi B, Megan Thee Stallion, Kendrick Lamar. DO NOT pick artists whose catalogs skew soft — no Ed Sheeran, no Sia, no Olly Alexander, no Sam Smith, no OneRepublic, no Swae Lee ballads, no Khalid. If the user's prompt implies a genre (e.g. hip-hop banger vs EDM banger), skew seeds to that genre's high-energy artists.
- "work out", "gym", "run", "running", "exercise", "lifting", "cardio" → mood: "positive", energyTarget: "high", useCase: "workout", suggestedSeedArtists: pick ONLY demonstrably high-energy artists — e.g. Eminem, Kendrick Lamar, Travis Scott, The Prodigy, Rage Against the Machine, Calvin Harris, Lil Uzi Vert, 21 Savage, Ski Mask the Slump God, or genre-appropriate equivalents. DO NOT pick Ed Sheeran, OneRepublic, Sia, Kylie Minogue, Olly Alexander, Imagine Dragons (ballads), or any artist whose catalog skews slow/emotional.
- "study", "focus", "deep work", "coding", "concentration", "homework" → mood: "neutral", energyTarget: "low", useCase: "focus"
- "drive", "road trip", "long drive", "commute" → mood: "positive", energyTarget: "medium", useCase: "chill"
- "relax", "chill out", "wind down after work", "easy listening", "lazy Sunday" → mood: "positive", energyTarget: "low", useCase: "chill"
- "sleep", "wind down before bed", "bedtime", "falling asleep" → mood: "neutral", energyTarget: "low", useCase: "sleep"
- "cooking", "making dinner", "in the kitchen" → mood: "positive", energyTarget: "medium", useCase: "background"
- "dinner party", "gathering", "friends over", "people coming over", "hosting" → mood: "positive", energyTarget: "medium", useCase: "background"
- "morning routine", "getting ready", "start the day", "waking up" → mood: "positive", energyTarget: "medium", useCase: "morning"
- "breakup", "heartbreak", "sad playlist", "crying", "missing someone", "feeling low" → mood: "melancholic", energyTarget: "low", useCase: "heartbreak"
- "summer playlist", "beach music", "poolside", "feels like summer", "need summer music", "summer vibes", "make it feel like summer", "summer songs" → mood: "positive", energyTarget: "medium", atmosphere: ["carefree", "warm", "upbeat", "beachy"], useCase: "summer", suggestedSeedArtists: ["Harry Styles", "Doja Cat", "Summer Salt", "Lizzo", "Kali Uchis", "Bad Bunny", "Outkast"]
  NOTE: the summer seed cluster should cover multiple flavors — indie-summer (Harry Styles, Summer Salt), pop-summer (Doja Cat, Lizzo), latin-summer (Bad Bunny, J Balvin), throwback-summer (Outkast, Missy Elliott). Pick seeds that match any genre or era hints in the prompt; if no hints, spread across the flavors.
NOTE: if the user says "I need a summer playlist, it's freezing outside" — they are requesting escapism. The "freezing" explains WHY they want summer music — it does NOT change the output. Deliver summer music.
These are defaults only — if the user specifies a genre or mood explicitly, that takes precedence.

LANGUAGE (culturalContext.language):
- "I want Spanish songs", "Spanish music", "songs in Spanish" → prefer: ["Spanish"], exclude: []
- "English songs only", "English only" → prefer: ["English"], exclude: []
- "no English songs", "not in English" → prefer: [], exclude: ["English"]
- "Korean pop", "K-pop" → prefer: ["Korean"], exclude: []
- "French music" → prefer: ["French"], exclude: []
- If no language is implied → prefer: [], exclude: []

AUDIENCE / SAFETY (contextClues.audience):
- "christian", "church", "worship", "faith", "gospel": audience: ["christian"]
- "youth retreat", "youth group", "youth event": audience: ["christian", "youth"]
- "family", "kids", "children", "all ages", "family friendly", "family-friendly": audience: ["family"]
- "clean", "no explicit", "safe for kids", "safe for work", "no bad words", "no curse words", "no swearing", "no profanity", "pg", "pg-13", "radio edit", "radio friendly", "radio-friendly": audience: ["clean"]
- "youth", "teenagers": audience: ["youth"]
- If multiple apply, include all. If none apply → []

REFERENCE SONGS:
If the user mentions a specific song title + artist (e.g. "songs like Take It Slow by Dante", "similar to Need My Baby by Reo Xander"), extract them into referenceSongs. These are used to confirm the correct artist identity.
- "songs like Take It Slow by Dante" → referenceSongs: [{ "title": "Take It Slow", "artist": "Dante" }]
- "songs similar to Need My Baby by Reo Xander" → referenceSongs: [{ "title": "Need My Baby", "artist": "Reo Xander" }]
- "songs like Dante and Ansel King" (no specific song title) → referenceSongs: []
- Only extract when the user clearly names BOTH a song title AND an artist.

SEED ARTISTS (CRITICAL):
These are used to find similar artists and build the playlist.
- When the prompt includes "Current songs include: ...", "Reference tracks: ...", use those artists to inform genre/mood extraction and put the most representative ones into suggestedSeedArtists.
- When the prompt includes "Key artists in this playlist: ...", use those artists ONLY to infer genre, mood, and vibe — do NOT put them into suggestedSeedArtists. They represent the current playlist contents, not the user's original intent. The user's original intent is in the prompt above.
- When the user explicitly names artists ("artists like X", "similar to Y"), put them in requestedArtists.
- When neither of the above apply, YOU MUST suggest 3-5 seed artists that exemplify the requested genre/mood.
- REVEALED vs. STATED PREFERENCES: If the user states a self-label ("I only listen to rap", "I'm a country fan") BUT also names specific songs or artists that clearly contradict that label, trust the songs over the label. Example: "I only listen to rap but my favorites are Olivia Rodrigo, JVKE, and Taylor Swift" → the actual taste is bedroom pop/indie pop; set genre and seed artists based on the named songs, not the self-label. The songs don't lie.
- EMOTIONAL STATE → SEED ARTISTS: When the user describes an emotional state with no genre keywords, infer appropriate artists. "Numb and empty after a breakup" → suggestedSeedArtists: ["Phoebe Bridgers", "The National", "Bon Iver", "Big Thief"]. "Need to clean my apartment, make time pass" → suggestedSeedArtists: ["Dua Lipa", "Lizzo", "Carly Rae Jepsen", "Paramore"] with mood: "positive", energyTarget: "medium".
- WORKOUT / HIGH-ENERGY → SEED ARTISTS: When useCase is "workout" or energyTarget is "high", suggestedSeedArtists MUST be demonstrably high-energy artists. Use artists known ONLY for pump-up music: Eminem, Kendrick Lamar, Travis Scott, 21 Savage, Lil Baby, Meek Mill, Skrillex, The Prodigy, Chemical Brothers, Rage Against the Machine, Metallica, Imagine Dragons, Marshmello, Calvin Harris, Tiësto. NEVER use The Weeknd, SZA, Khalid, Post Malone, Dua Lipa, Ed Sheeran, Sam Smith, Lewis Capaldi, or any artist primarily known for slow/mid-tempo songs — even if they occasionally have an upbeat track, their depth-2 similar-artist graph will pull in slow contamination. If the user names a soft artist ("gym playlist with Post Malone"), still pick high-energy artists for suggestedSeedArtists and keep Post Malone only in requestedArtists.
Examples (no reference tracks):
- "top pop songs" → suggestedSeedArtists: ["Taylor Swift", "Dua Lipa", "The Weeknd", "Harry Styles"]
- "r&b for when I'm in my feels" → suggestedSeedArtists: ["SZA", "Daniel Caesar", "H.E.R.", "Brent Faiyaz"]
- "underground hip-hop" → suggestedSeedArtists: ["JID", "Denzel Curry", "Freddie Gibbs", "EARTHGANG"]
- "chill lo-fi beats" → suggestedSeedArtists: ["Nujabes", "J Dilla", "Uyama Hiroto", "Fat Jon"]
- "2000s rock hits" → suggestedSeedArtists: ["Linkin Park", "Green Day", "Fall Out Boy", "My Chemical Romance"]
Choose artists that match the popularity level implied (mainstream vs underground).

BPM CONSTRAINTS:
- "over 150 BPM", "songs above 140 BPM", "fast tempo only": bpmConstraint.min = that number
- "under 100 BPM", "slow songs only": bpmConstraint.max = that number
- "between 120 and 140 BPM": bpmConstraint.min = 120, bpmConstraint.max = 140
- If no explicit BPM number mentioned → bpmConstraint: { min: null, max: null }

MOOD (emotional valence — separate from energy):
- "happy", "uplifting", "feel-good", "positive", "welcoming", "café", "bright", "cheerful", "healing", "hopeful", "good vibes", "triumphant", "euphoric", "everything works out", "happy ending", "movie ending", "breakthrough", "cathartic release" → mood: "positive"
- "emotional but uplifting", "bittersweet but hopeful", "emotional climax that resolves well" → mood: "positive"
- "sad", "melancholic", "heartbreak", "crying", "heavy", "gloomy", "dark emotions", "heartache", "longing" → mood: "melancholic"
- EMOTIONAL STATE INPUTS — treat the user's described emotional state as a genre/mood signal even with no genre keywords:
  * "numb", "empty", "hollow", "disconnected", "zoned out", "numb and empty", "feeling nothing" → mood: "melancholic", energyTarget: "low", atmosphere: ["introspective", "quiet", "sparse"] — think Phoebe Bridgers, The National, Bon Iver, Big Thief
  * "can't stop crying", "devastated", "broken", "wrecked" → mood: "melancholic", energyTarget: "low"
  * "anxious", "nervous", "spiraling", "in my head" → mood: "neutral", energyTarget: "low", atmosphere: ["introspective", "calm"]
  * "need to feel something", "processing", "healing" → mood: "neutral", atmosphere: ["introspective", "bittersweet"]
  * "angry", "frustrated", "need to vent" → mood: "neutral", energyTarget: "high", atmosphere: ["cathartic", "driving"]
  * "hyped", "energized", "pumped up", "unstoppable" → mood: "positive", energyTarget: "high"
- IMPORTANT: "emotional" alone is NOT melancholic — it is intensity, not valence. Only use "melancholic" when the context is clearly sad/negative.
- "chill", "background", "ambient", "focus", "study", "neutral", "calm" (without emotional context) → mood: "neutral"
- "emotional" without clear positive/negative context → null (let atmosphere and genre determine the tone)
- If genuinely ambiguous → null

STATED REQUEST vs. CONTEXTUAL CLUES — ALWAYS honor the stated desire:
When the user describes a desired mood, season, or context that conflicts with their real-world situation, deliver what they ASKED FOR — the real-world detail explains WHY, not WHAT.
- "It's freezing but I need a summer playlist" → summer vibes (positive mood, warm, upbeat). "Freezing" is the motivation, not the instruction.
- "I'm stressed, I just want something happy" → happy and uplifting, NOT stressed or anxious music
- "Dark and rainy but I want to feel like it's summer" → bright, carefree, warm-weather energy
- "Nothing like [current season] — give me [other season] vibes" → deliver the requested season
STATED SEASON signal: when the user names a season as a DESIRED state, set mood/atmosphere accordingly:
- "summer playlist", "summer vibes", "need summer music" → mood: "positive", energyTarget: "medium", atmosphere: ["carefree", "warm", "upbeat", "beachy"]
- "cozy winter vibes" → mood: "neutral", energyTarget: "low", atmosphere: ["warm", "intimate", "introspective"]
- "spring energy" → mood: "positive", energyTarget: "medium", atmosphere: ["fresh", "hopeful", "bright"]
- "fall/autumn vibes" → mood: "neutral", energyTarget: "low", atmosphere: ["warm", "nostalgic", "cozy"]
NEVER match music to the environmental context when the user is explicitly escaping it.

EXCLUDED ARTISTS:
- "no [artist name]", "nothing by [artist]", "avoid [artist]", "don't include [artist]", "[artist]-free" → excludedArtists: [artist names]
- "no mainstream hits", "no chart toppers", "no radio songs", "avoid popular songs", "underground only", "deep cuts only", "no famous songs" → set trackConstraints.popularity.preference: "underground" AND trackConstraints.popularity.max: 60
- "no [artist] but similar sound/vibe" → add [artist] to excludedArtists (include the artist names, not just the preference)
- If multiple exclusions mentioned, include all artist names
- ABBREVIATIONS & NICKNAMES: Resolve common abbreviations to full artist names. Examples: "TS" or "T.S." → "Taylor Swift", "TSwift" → "Taylor Swift", "Ye" → "Kanye West", "Bey" → "Beyoncé", "Jay" or "Hov" �� "Jay-Z", "Drizzy" → "Drake", "Weezy" → "Lil Wayne"
- PRODUCER EXCLUSIONS: "no Jack Antonoff songs", "no Max Martin production" → add those names to excludedArtists (the filter will match on artist name; note this won't filter by producer but will log the intent)
- CRITICAL: When the user says "no [name]", always try to resolve [name] to the most likely well-known artist before adding to excludedArtists
- IMPLICIT EXCLUSION — "expand beyond" phrases: When the user signals they want to DISCOVER BEYOND a named artist (not get more of them), add that artist to both suggestedSeedArtists (for genre/taste anchoring) AND excludedArtists (to keep their songs out of the output).
  TRIGGER — the exclusion fires ONLY when the phrasing signals escape/expansion, NOT when it signals "more of the same":
  ✓ EXCLUDE: "what else", "what other X should I listen to", "I only listen to X, what else?", "besides X", "beyond X", "other than X", "expand beyond X", "I've only ever listened to X"
  ✗ DO NOT EXCLUDE: "more like X", "give me more X", "similar to X", "songs like X", "I love X, give me more", "in the style of X", "X vibes", "artists like X"
  The test: does the user want to hear LESS of the named artist (escape) or find MORE of the same style (seed)? Only exclude on escape phrasing.
  * "I only listen to The Weeknd, what else is good?" → suggestedSeedArtists: ["The Weeknd", ...adjacent], excludedArtists: ["The Weeknd"] (escape)
  * "massive Radiohead fan, what should I listen to?" → suggestedSeedArtists: ["Radiohead", ...], excludedArtists: ["Radiohead"] (escape)
  * "I love The Weeknd, give me more like him" → requestedArtists: ["The Weeknd"], excludedArtists: [] (more-of, NO exclusion)
  * "songs similar to The Weeknd" → requestedArtists: ["The Weeknd"], excludedArtists: [] (seed request, NO exclusion)

ENERGY TARGET:
- "low energy", "very chill", "mellow", "slow", "sleepy", "relaxing" → energyTarget: "low"
- "high energy", "hype", "intense", "loud", "fast", "pump up", "hard" → energyTarget: "high"
- "kinda hype but chill", "chill but energizing", "mid-energy", "not too slow not too fast", "background but engaging", "light energy" → energyTarget: "medium"
- If conflicting signals are present (both chill and hype), use "medium" rather than picking one
- If unclear → null

ENERGY PROGRESSION (gradual ramps only — no hard split):
- Use energyProgression ONLY when the energy change is described as GRADUAL (no distinct halves/sections): "gradually get more intense", "slowly builds up", "gradual energy increase", "gradually increasing", "pacing", "energy curve", "ramp up", "warm up then peak"
- Running/workout context with "gradual", "build", "pacing", "warm up" → energyProgression: "ramp_up"
- "high energy then gradually winds down", "starts hype slowly gets chill" → energyProgression: "ramp_down"
- CRITICAL: Do NOT use energyProgression for "first half X, second half Y" or any prompt with clear halves/sections — those are phases (see below)
- All other cases → null

MULTI-PHASE DETECTION:
Use phases whenever the prompt describes two or more DISTINCT, named segments — "first half / second half", "start with X then Y", "X → Y", "X followed by Y", "X then switch to Y", "first part / second part", time-of-day arcs, or event arcs.
RULE: If the user is describing a SPLIT or TRANSITION between distinct moods/energies (even just two), use phases. energyProgression is only for smooth/gradual ramps with no clear division.
- Each phase: label (short name), energy ("low"|"medium"|"high"), mood ("positive"|"neutral"|"melancholic"|null), fraction (share of total tracks — must sum to 1.0)
- "first half chill, second half hype" → phases: [{"label":"chill","energy":"low","mood":"neutral","fraction":0.5},{"label":"hype","energy":"high","mood":"positive","fraction":0.5}]
- "start chill then get hype" → phases: [{"label":"chill","energy":"low","mood":"neutral","fraction":0.4},{"label":"hype","energy":"high","mood":"positive","fraction":0.6}]
- "chill then hype party" → phases: [{"label":"chill","energy":"low","mood":"neutral","fraction":0.4},{"label":"hype","energy":"high","mood":"positive","fraction":0.6}]
- "morning warm-up → focus mode → evening wind-down" → phases: [{"label":"morning","energy":"medium","mood":"positive","fraction":0.33},{"label":"focus","energy":"low","mood":"neutral","fraction":0.34},{"label":"wind-down","energy":"low","mood":"melancholic","fraction":0.33}]
- "build from chill to hype" (gradual, no clear split) → energyProgression: "ramp_up", phases: null
- If no multi-phase pattern → phases: null

GENRE ACCESSIBILITY (genreAccessibility):
- "just getting into X", "never listened to X", "ease me in", "good starting point for X", "where do I start with X", "I'm new to X", "jazz for beginners", "beginner [genre]", "never heard X before" → genreAccessibility: "newcomer"
- "I've heard some X and want to explore more", "getting deeper into X", "I've listened to a bit of X", "know the basics but want more", "heard a few X artists and loved it", "getting into X lately" → genreAccessibility: "curious"
- "deep cuts", "deep dive", "I know all the classics", "show me obscure", "advanced [genre]", "I've been listening for years", "non-obvious picks", "I know all the hits" → genreAccessibility: "enthusiast"
- When genreAccessibility: "newcomer" — choose suggestedSeedArtists that are widely loved, melodic, and approachable for that SPECIFIC genre. "Accessible" means different things per genre:
  * Jazz: Norah Jones, Chet Baker (vocal), Diana Krall, Kind of Blue-era Miles Davis, Melody Gardot — NOT bebop Charlie Parker, Oscar Peterson, or free jazz Coltrane
  * Classical: Ludovico Einaudi, Max Richter, Hans Zimmer, Yann Tiersen — NOT 12-tone serialism, dense operas, or avant-garde works
  * Metal: Linkin Park, Foo Fighters, System of a Down, Metallica's Black Album — NOT black metal, death metal, or grindcore
  * Country: Kacey Musgraves, Chris Stapleton, Zac Brown Band — NOT deep honky-tonk or old-time fiddle country
  * Electronic: Daft Punk, Bonobo, Caribou, Röyksopp — NOT techno, noise, or academic electroacoustic
- When genreAccessibility: "curious" — mix well-known entry points with one tier deeper: non-obvious picks from the same artist, acclaimed albums the casual fan hasn't reached, and 2-3 artists who are one step more niche than the obvious names
- When genreAccessibility: "enthusiast" — prefer deep cuts, obscure artists, and non-obvious picks that a long-time fan hasn't heard
- If no accessibility signal → null

SOUNDCHARTS DIRECT FILTERS (soundchartsFilters — CRITICAL):
Use this field to directly output SoundCharts API filter objects that precisely match the prompt's intent.
These are used VERBATIM in the SC song search — be accurate and specific.

DO output filters for: energy, valence, danceability, acousticness, tempo, liveness, speechiness, instrumentalness
DO NOT output filters for: songGenres, songSubGenres, languageCode, explicit, releaseDate, duration, artistCareerStages, emotionalIntensityScore, themes, moods (moods filter returns 0 results in SC when combined with other filters — use valence/energy instead)

FILTER SHAPES:
- Numeric range: { "type": "energy", "data": { "min": 0.6 } }  — include only min, only max, or both
- Theme list: { "type": "themes", "data": { "values": ["Heartbreak", "Love"], "operator": "in" } }

VALID MOOD VALUES (exact strings only):
Melancholic, Joyful, Euphoric, Sad, Happy, Calm, Energetic, Empowering, Aggressive, Dark, Romantic, Sensual, Spiritual, Peaceful, Nostalgic, Playful


AUDIO FEATURE RANGES (all 0.0–1.0 except tempo in BPM and scores 1–10):
- energy: activity/intensity. Sleep: max 0.30. Chill/relax: max 0.45. Focus/study: max 0.55. Medium: 0.38–0.68. Workout/gym: min 0.75. Hype/intense: min 0.80.
- valence: musical positivity. Dark/sad/melancholic: max 0.45. Neutral: 0.35–0.65. Happy/upbeat: min 0.65. Joyful/euphoric: min 0.72.
- danceability: rhythmic consistency. Groovy: min 0.65. Dance: min 0.72. Club/party: min 0.78.
- acousticness: acoustic instrumentation likelihood. Slightly acoustic: min 0.40. Acoustic/unplugged: min 0.60. Fully acoustic: min 0.80.
- tempo (BPM): Slow ballad: max 80. Slow: max 90. Mid-tempo: 90–120. Uptempo: min 120. Fast: min 140. EDM/rave: min 128.
- liveness: live audience presence. Exclude live recordings: max 0.40.
- speechiness: spoken word ratio. Rap-heavy: min 0.33. Exclude rap/spoken word: max 0.33.
- instrumentalness: absence of vocals. Instrumental: min 0.55. Lo-fi/background: min 0.30.
MAPPING EXAMPLES — think dynamically, these are not exhaustive:
- "songs I can dance to", "danceable", "banger" → { type: "danceability", data: { min: 0.72 } }
- "party anthems", "turn up" → { type: "danceability", data: { min: 0.75 } }, { type: "energy", data: { min: 0.70 } }, { type: "moods", data: { values: ["Euphoric", "Energetic"], operator: "in" } }
- "sad songs", "heartbreak", "crying" → { type: "valence", data: { max: 0.45 } }, { type: "energy", data: { max: 0.55 } }
- "happy/upbeat/feel-good" → { type: "valence", data: { min: 0.65 } }, { type: "energy", data: { min: 0.55 } }
- "chill/relaxing/laid-back" → { type: "energy", data: { max: 0.45 } }, { type: "valence", data: { min: 0.35 } }
- "gym/workout" → { type: "energy", data: { min: 0.75 } }, { type: "danceability", data: { min: 0.65 } }
- "acoustic/unplugged" → { type: "acousticness", data: { min: 0.60 } }
- "love songs/romantic" → { type: "valence", data: { min: 0.45 } }, { type: "tempo", data: { max: 100 } }
- "dark/moody" → { type: "valence", data: { max: 0.45 } }
- "nostalgic" → { type: "valence", data: { min: 0.35, max: 0.65 } }
- "motivational/empowering" → { type: "energy", data: { min: 0.65 } }, { type: "valence", data: { min: 0.50 } }
- "emotional/deeply emotional" → { type: "valence", data: { max: 0.45 } }
- "slow jams" → { type: "tempo", data: { max: 95 } }, { type: "valence", data: { min: 0.40 } }
- "lo-fi/study" → { type: "energy", data: { max: 0.50 } }, { type: "instrumentalness", data: { min: 0.30 } }
- "euphoric/euphoria" → { type: "valence", data: { min: 0.70 } }, { type: "energy", data: { min: 0.65 } }
- "sleep/meditation" → { type: "energy", data: { max: 0.30 } }, { type: "instrumentalness", data: { min: 0.20 } }
- "aggressive/intense/metal" → { type: "energy", data: { min: 0.78 } }
- "spiritual/worship" → { type: "valence", data: { min: 0.45 } }, { type: "energy", data: { max: 0.60 } }

RULES:
- Only include filters where you have HIGH CONFIDENCE in the mapping. Fewer accurate filters beat many uncertain ones.
- Do NOT output conflicting filters for the same type (e.g. energy min 0.75 AND energy max 0.45). If signals conflict, omit that filter type.
- Always output moods + valence together when the prompt is clearly sad or clearly happy.
- CRITICAL: do NOT output moods filters — they are ignored. Use valence and energy to express mood instead.
- For ambiguous prompts like "vibes" or "good music" with no emotional descriptor, output [] (empty array).

Use null, [], or false for any feature not mentioned.

DO NOT include any text outside the JSON.`
      }]
    });

    let genreData = {
      primaryGenre: null,
      subgenre: null,
      secondaryGenres: [],
      keyCharacteristics: [],
      style: '',
      atmosphere: [],
      era: {
        decade: null,
        yearRange: { min: null, max: null },
        descriptors: []
      },
      culturalContext: {
        region: null,
        movement: null,
        scene: null,
        language: { prefer: [], exclude: [] }
      },
      contextClues: {
        useCase: null,
        audience: [],
        avoidances: []
      },
      trackConstraints: {
        popularity: { min: null, max: null, preference: null },
        duration: { min: null, max: null },
        excludeVersions: [],
        albumDiversity: { maxPerAlbum: null, preferDeepCuts: false, preferSingles: false },
        artistDiversity: { maxPerArtist: null }
      },
      artistConstraints: {
        vocalGender: null,
        artistType: null,
        excludeFeatures: false,
        requestedArtists: [],
        excludedArtists: [],
        exclusiveMode: false
      },
      productionStyle: {
        preference: null,
        avoidAutoTune: false
      },
      lyricalContent: {
        themes: [],
        avoid: []
      },
      discoveryBalance: {
        preference: null,
        familiarityRatio: { hits: null, deepCuts: null }
      },
      songCount: null,
      bpmConstraint: { min: null, max: null },
      mood: null,
      energyTarget: null,
      energyProgression: null,
      phases: null,
      genreAccessibility: null,
      soundchartsFilters: [],
    };
    try {
      let genreText = genreExtractionResponse.content[0].text.trim();
      // Handle markdown code blocks
      if (genreText.startsWith('```json')) {
        genreText = genreText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      } else if (genreText.startsWith('```')) {
        genreText = genreText.replace(/^```\n?/, '').replace(/\n?```$/, '');
      }
      genreData = JSON.parse(genreText);
    } catch (parseError) {
      console.log('Could not parse genre extraction:', parseError.message);
      console.log('Raw response:', genreExtractionResponse.content[0].text.substring(0, 200));
    }

    console.log('Extracted genre data:', genreData);

    // ── Enforce reference song artists into requestedArtists ─────────────────
    // Claude sometimes puts reference song artists into suggestedSeedArtists
    // instead of requestedArtists (which we ignore). Ensure they always land in
    // requestedArtists so the SC artist_songs strategy is used correctly.
    if (genreData.referenceSongs?.length > 0 && genreData.artistConstraints) {
      const existing = new Set((genreData.artistConstraints.requestedArtists || []).map(a => a.toLowerCase()));
      for (const rs of genreData.referenceSongs) {
        if (rs.artist && !existing.has(rs.artist.toLowerCase())) {
          if (!genreData.artistConstraints.requestedArtists) genreData.artistConstraints.requestedArtists = [];
          genreData.artistConstraints.requestedArtists.push(rs.artist);
          existing.add(rs.artist.toLowerCase());
          console.log(`[REF-ENFORCE] Added "${rs.artist}" to requestedArtists from referenceSongs`);
        }
      }
    }

    // ── Prompt-level clean override ───────────────────────────────────────────
    // If the prompt or extracted audience signals clean/family/safe content,
    // force allowExplicit=false regardless of account setting. One explicit track
    // breaks trust for these use cases — this must be a hard zero-exception filter.
    const _promptLowerClean = prompt.toLowerCase();
    const _audienceClean = genreData.contextClues?.audience || [];
    const _cleanSignals = [
      'clean', 'no explicit', 'no bad words', 'no curse', 'no swear', 'no profan',
      'safe for kids', 'safe for work', 'family friendly', 'family-friendly',
      'radio edit', 'radio friendly', 'radio-friendly', 'pg-13', ' pg ', 'church',
      'kids playlist', 'children', 'all ages',
    ];
    const _promptHasCleanSignal = _cleanSignals.some(s => _promptLowerClean.includes(s));
    const _audienceHasCleanSignal = _audienceClean.some(a =>
      ['clean', 'family', 'christian', 'youth'].includes(a.toLowerCase())
    );
    if (_promptHasCleanSignal || _audienceHasCleanSignal) {
      if (allowExplicit) {
        console.log(`🔒 Prompt-level clean override: forcing allowExplicit=false (audience=${JSON.stringify(_audienceClean)}, promptMatch=${_promptHasCleanSignal})`);
      }
      allowExplicit = false;
    }

    // ── Emotional state → genre fallback ─────────────────────────────────────
    // When Claude left primaryGenre/seeds/mood null but the prompt describes an
    // emotional state, fill in safe defaults so the SC query has something to work with.
    // Only fills fields that Claude left empty — never overrides explicit extractions.
    {
      const _EMOTIONAL_GENRE_MAP = [
        { patterns: ['numb', 'empty', 'hollow', 'disconnected', 'zoned out', 'feeling nothing', 'feel nothing'],
          genre: 'indie', subgenre: 'indie folk', mood: 'melancholic', energy: 'low',
          seeds: ['Phoebe Bridgers', 'The National', 'Bon Iver', 'Big Thief'] },
        { patterns: ['anxious', 'stressed', 'stress', 'spiraling', 'spiralling', 'in my head', 'overwhelmed'],
          genre: 'ambient', subgenre: 'lo-fi', mood: 'neutral', energy: 'low',
          seeds: ['Nils Frahm', 'Brian Eno', 'Floating Points', 'Uyama Hiroto'] },
        { patterns: ['nostalgic', 'nostalgia', 'reminiscing', 'reminisce', 'throwback', 'back in the day', 'old times'],
          genre: null, subgenre: null, mood: null, energy: null,  // era comes from context; just flag
          seeds: [] },
        { patterns: ['angry', 'frustrated', 'rage', 'need to vent', 'so pissed', 'pissed off', 'so mad'],
          genre: 'alternative', subgenre: null, mood: 'neutral', energy: 'high',
          seeds: ['Paramore', 'Linkin Park', 'Bring Me The Horizon', 'Grandson'] },
        { patterns: [
            'celebratory', 'celebrating', "let's celebrate", 'celebration', 'party mode',
            'just got promoted', 'got promoted', 'got the job', 'new job', 'graduation',
            'main character', 'on top of the world', 'we did it', 'i did it',
            'feel like the main', 'best day', 'incredible news',
            'so excited', 'winning', 'nailed it', 'killed it', 'finally', 'i got in',
          ],
          genre: 'pop', subgenre: null, mood: 'positive', energy: 'high',
          seeds: ['Dua Lipa', 'Lizzo', 'Harry Styles', 'Doja Cat'] },
        { patterns: ['heartbroken', 'broken heart', 'just got dumped', 'he left me', 'she left me', 'breakup playlist'],
          genre: 'indie', subgenre: 'indie folk', mood: 'melancholic', energy: 'low',
          seeds: ['Phoebe Bridgers', 'Gracie Abrams', 'boygenius', 'Julien Baker'] },
      ];
      const _emoPromptLower = prompt.toLowerCase();
      for (const entry of _EMOTIONAL_GENRE_MAP) {
        if (entry.patterns.some(p => _emoPromptLower.includes(p))) {
          const fills = [];
          if (!genreData.primaryGenre && entry.genre) {
            genreData.primaryGenre = entry.genre; fills.push(`primaryGenre="${entry.genre}"`);
          }
          if (!genreData.subgenre && entry.subgenre) {
            genreData.subgenre = entry.subgenre; fills.push(`subgenre="${entry.subgenre}"`);
          }
          if (!genreData.mood && entry.mood) {
            genreData.mood = entry.mood; fills.push(`mood="${entry.mood}"`);
          }
          if (!genreData.energyTarget && entry.energy) {
            genreData.energyTarget = entry.energy; fills.push(`energyTarget="${entry.energy}"`);
          }
          const existingSeeds = genreData.artistConstraints?.suggestedSeedArtists || [];
          const requestedArtists = genreData.artistConstraints?.requestedArtists || [];
          if (existingSeeds.length === 0 && requestedArtists.length === 0 && entry.seeds.length > 0) {
            if (!genreData.artistConstraints) genreData.artistConstraints = {};
            genreData.artistConstraints.suggestedSeedArtists = entry.seeds;
            fills.push(`seeds=[${entry.seeds.join(', ')}]`);
          }
          if (fills.length > 0) {
            console.log(`🎭 Emotional state fallback (pattern match): ${fills.join(', ')}`);
          }
          break; // first match wins
        }
      }
    }

    // ── Event mode detection ──────────────────────────────────────────────────
    // Weddings, receptions, galas etc. need recognizable, crowd-friendly songs.
    // Enforce: Spotify popularity ≥ 70 AND default era 2005–now (unless overridden).
    const _ucForEvent = (genreData.contextClues?.useCase || '').toLowerCase();
    const _eventKeywords = ['wedding', 'reception', 'gala', 'banquet', 'prom', 'quinceanera', 'quinceañera', 'graduation party', 'birthday party', 'bar mitzvah', 'bat mitzvah', 'bat-mitzvah'];
    const _isEventMode = _eventKeywords.some(k => _ucForEvent.includes(k)) ||
                         _eventKeywords.some(k => _promptLowerClean.includes(k));
    if (_isEventMode) {
      if (genreData.trackConstraints.popularity.min === null || genreData.trackConstraints.popularity.min === undefined) {
        genreData.trackConstraints.popularity.min = 70;
        console.log('🎉 Event mode: setting popularity floor to 70');
      }
      if (!genreData.era.yearRange.min && !genreData.era.yearRange.max && !genreData.era.decade) {
        genreData.era.yearRange.min = 2005;
        genreData.era.yearRange.max = new Date().getFullYear();
        console.log(`🎉 Event mode: default era range ${genreData.era.yearRange.min}–${genreData.era.yearRange.max}`);
      }
    }

    // ── Superlative mode detection ────────────────────────────────────────────
    // "best ever", "GOAT", "top N of all time" → sort final pool by Spotify popularity DESC
    // so the most-streamed/recognised tracks surface first.
    const _superlativePatterns = [
      /\bbest\s+ever\b/i,
      /\bgreatest\s+of\s+all\s+time\b/i,
      /\bbest\s+of\s+all\s+time\b/i,
      /\bof\s+all\s+time\b/i,                                  // "top 5 rap songs of all time"
      /\bgoat\b/i,
      /\ball[- ]time\s+(?:best|greatest|classic|top|hit)\b/i,
      /\bgreatest\b.{0,60}\bever\b/i,                          // "greatest pop songs ever"
      /\bbest\b.{0,60}\bever\b/i,
      /\b(?:saddest|happiest|hardest|biggest|dopest|illest|rarest|craziest)\b.{0,60}\bever\b/i, // "saddest songs ever"
      /\b\d+\s+greatest\b/i,
      /\btop\s+\d+\b.{0,60}\b(?:of\s+all\s+time|ever)\b/i,   // "top 5 rap songs of all time"
      /\bclassics?\s+everyone\s+knows\b/i,
      /\bmost\s+(?:legendary|famous|iconic|celebrated|classic)\b/i, // "most legendary"
      /\buniversally?\s+(?:known|loved|recognized)\b/i,
    ];
    const _matchedSuperlative = _superlativePatterns.find(r => r.test(prompt));
    const _isSuperlativeMode = !!_matchedSuperlative;
    if (_isSuperlativeMode) {
      console.log(`🏆 Superlative mode triggered (pattern: ${_matchedSuperlative}) — will sort by popularity DESC`);
      // Ensure candidate pool has high-popularity tracks to choose from
      if (genreData.trackConstraints.popularity.min === null || genreData.trackConstraints.popularity.min === undefined || genreData.trackConstraints.popularity.min < 65) {
        genreData.trackConstraints.popularity.min = 65;
        console.log('🏆 Superlative mode: setting popularity floor to 65');
      }
      // "All time" means no era restriction unless the user specified one
      if (!genreData.era.decade && !genreData.era.descriptors?.length) {
        genreData.era.yearRange.min = null;
        genreData.era.yearRange.max = null;
        console.log('🏆 Superlative mode: cleared era constraints (all-time scope)');
      }
    }

    // ── Contradiction detection ────────────────────────────────────────────────
    // Detect the most common cases where constraints directly conflict with each
    // other. Surface a friendly clarification question rather than silently
    // picking one side or producing a broken playlist.
    // Only runs for new playlists (not refinements) where the user hasn't
    // already confirmed the intent.
    if (!playlistId) {
      const _contradictions = [];

      // 1. Artist requested AND excluded at the same time — only flag when exclusiveMode is on.
      // "Sounds like X, no X songs" is valid: use X as a style seed but exclude their tracks.
      // That case is handled correctly by the pipeline (seed for discovery, then exclude tracks).
      // Only flag as a contradiction when the user asked for *only* that artist's songs AND also
      // said to exclude them (exclusiveMode=true), which is caught by check #4 below.

      // 2. Underground preference conflicts with event mode popularity floor
      const _wantsUnderground = genreData.trackConstraints?.popularity?.preference === 'underground'
        || (genreData.trackConstraints?.popularity?.max !== null && genreData.trackConstraints?.popularity?.max !== undefined && genreData.trackConstraints?.popularity?.max <= 50);
      if (_wantsUnderground && _isEventMode) {
        _contradictions.push(`You asked for underground/deep cuts but also for a ${genreData.contextClues?.useCase || 'event'} setting — events usually work better with recognizable hits. Should I keep it underground or use crowd-friendly popular songs?`);
      }

      // 3. Era range min > max (user typo like "2020 to 2010")
      const _eraMin = genreData.era?.yearRange?.min;
      const _eraMax = genreData.era?.yearRange?.max;
      if (_eraMin && _eraMax && _eraMin > _eraMax) {
        _contradictions.push(`The year range you specified (${_eraMin}–${_eraMax}) seems reversed. Did you mean ${_eraMax}–${_eraMin}?`);
      }

      // 4. Exclusive mode with an artist who was also excluded
      if (genreData.artistConstraints?.exclusiveMode && genreData.artistConstraints?.excludedArtists?.length > 0) {
        const excNames = genreData.artistConstraints.excludedArtists.join(', ');
        const reqNames = (genreData.artistConstraints.requestedArtists || []).join(', ');
        _contradictions.push(`You asked for only ${reqNames} but also said to exclude ${excNames}. These conflict — could you clarify?`);
      }

      if (_contradictions.length > 0) {
        const question = _contradictions[0]; // surface the most important one
        console.log(`⚠️ Contradiction detected: ${question}`);
        return res.json({
          clarificationNeeded: true,
          clarificationQuestion: question,
          playlistName: null,
          tracks: [],
          trackCount: 0,
        });
      }
    }

    // Apply AI-extracted song count from prompt (replaces regex approach).
    // If the prompt implies a count, it overrides the options-menu value.
    // If null, the options-menu value (req.body.songCount) is used as-is.
    // During refinements (playlistId set), never override — keep the original count.
    if (!playlistId && genreData.songCount !== null && typeof genreData.songCount === 'number') {
      const clampedCount = Math.min(Math.max(5, Math.round(genreData.songCount)), 100);
      songCount = clampedCount;
      console.log(`AI extracted song count from prompt: ${songCount}`);
    } else {
      console.log(`Using provided song count: ${songCount}`);
    }

    // ── Artist alias expansion for exclusions ─────────────────────────────────
    // When the user excludes an artist, also block their known side projects,
    // supergroups, and aliases (e.g. "Phoebe Bridgers" → also block "boygenius").
    // We call Claude once per artist and cache the result for the server lifetime.
    const _rawExcluded = genreData.artistConstraints?.excludedArtists || [];
    if (_rawExcluded.length > 0) {
      const _toExpand = _rawExcluded.filter(a => !_artistAliasCache.has(a.toLowerCase()));
      if (_toExpand.length > 0) {
        try {
          const _aliasResp = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [{
              role: 'user',
              content: `For each artist below, list all known aliases, stage names, side projects, and supergroups they are a primary member of. Return ONLY a JSON object mapping each artist name to an array of strings. Include the original name as the first element. If none exist, return an empty array for that key.\n\nArtists: ${JSON.stringify(_toExpand)}\n\nDO NOT include any text outside the JSON.`
            }]
          });
          let _aliasText = _aliasResp.content[0].text.trim();
          if (_aliasText.startsWith('```')) _aliasText = _aliasText.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
          const _aliasMap = JSON.parse(_aliasText);
          for (const artist of _toExpand) {
            const aliases = Array.isArray(_aliasMap[artist]) ? _aliasMap[artist] : [];
            _artistAliasCache.set(artist.toLowerCase(), aliases);
            if (aliases.length > 0) {
              console.log(`[ALIAS] "${artist}" → [${aliases.join(', ')}]`);
            }
          }
        } catch (err) {
          console.log(`[ALIAS] Alias expansion failed: ${err.message} — using raw names only`);
          for (const artist of _toExpand) _artistAliasCache.set(artist.toLowerCase(), [artist]);
        }
      }
      // Merge all cached aliases back into excludedArtists (dedup)
      const _expandedExclusions = new Set(_rawExcluded.map(a => a.toLowerCase()));
      for (const artist of _rawExcluded) {
        const aliases = _artistAliasCache.get(artist.toLowerCase()) || [];
        for (const alias of aliases) _expandedExclusions.add(alias.toLowerCase());
      }
      genreData.artistConstraints.excludedArtists = [..._expandedExclusions];
      if (genreData.artistConstraints.excludedArtists.length > _rawExcluded.length) {
        console.log(`[ALIAS] Exclusion list expanded: ${_rawExcluded.join(', ')} → ${genreData.artistConstraints.excludedArtists.join(', ')}`);
      }
    }

    // Step 0.3: Look up reference songs FIRST to confirm artist identity before any name-based lookups.
    // This prevents the wrong-artist disambiguation problem (e.g. Spanish "Dante" vs R&B "Dante").
    // referenceSongs come from the user prompt: "songs similar to Ain't No One by Dante"
    const confirmedArtistUuids = {};      // { artistNameLower: uuid | 'INVALID' | 'NOSIMILAR:<uuid>' }
    const confirmedSpotifyArtistIds = {}; // { artistNameLower: spotifyArtistId }
    const confirmedArtistUuidsStrong = new Set(); // artists confirmed via ISRC/Spotify-ID match (right artist for sure)

    // Get app-level Spotify token once — used for both reference-song ID lookup and genre validation.
    // App credentials work for all platforms (no user auth needed).
    let appSpotify = null;
    try {
      const ccData = await spotifyApi.clientCredentialsGrant();
      appSpotify = new SpotifyWebApi({ clientId: process.env.SPOTIFY_CLIENT_ID, clientSecret: process.env.SPOTIFY_CLIENT_SECRET });
      appSpotify.setAccessToken(ccData.body.access_token);
    } catch (err) {
      console.log(`⚠️  Could not get Spotify app token: ${err.message}`);
    }

    const referenceSongs0 = genreData.referenceSongs || [];
    if (referenceSongs0.length > 0 && process.env.SOUNDCHARTS_APP_ID) {
      console.log(`🎯 Looking up ${referenceSongs0.length} reference song(s) on SoundCharts to confirm artist identity...`);
      // Genre hints help pick the right artist when multiple SC artists share the same name
      const refSongGenreHints = [genreData.primaryGenre, ...(genreData.secondaryGenres || [])].filter(Boolean).map(g => g.toLowerCase());
      const confirmedSongUuids = {}; // { artistNameLower: songUuid } — kept for Spotify QA below
      for (const refSong of referenceSongs0) {
        // Step A: Spotify search first — get confirmed artist ID and ISRC before touching SoundCharts.
        // Having these upfront lets SC artist-candidate selection validate by Spotify ID (strongest signal),
        // preventing wrong-artist disambiguation (e.g. two SC artists both named "Keffer").
        let refSpotifyIsrc = null;
        let refSpotifyArtistId = null;
        if (appSpotify) {
          try {
            const q = `track:${refSong.title.replace(/'/g, '')} artist:${refSong.artist}`;
            const searchRes = await appSpotify.searchTracks(q, { limit: 5 });
            const tracks = searchRes.body.tracks?.items || [];
            const artistNorm = refSong.artist.toLowerCase().replace(/[^a-z0-9]/g, '');
            const match = tracks.find(t =>
              (t.artists?.[0]?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === artistNorm
            );
            if (match) {
              if (match.artists?.[0]?.id) {
                refSpotifyArtistId = match.artists[0].id;
                confirmedSpotifyArtistIds[refSong.artist.toLowerCase()] = refSpotifyArtistId;
                console.log(`✓ Confirmed Spotify artist ID for "${refSong.artist}": ${refSpotifyArtistId}`);
              }
              if (match.external_ids?.isrc) {
                refSpotifyIsrc = match.external_ids.isrc;
                console.log(`✓ Spotify ISRC for "${refSong.title}": ${refSpotifyIsrc}`);
              }
            }
          } catch (err) { /* ignore — SC search will fall back to name/genre matching */ }
        }

        // Step B: SoundCharts UUID confirmation, armed with Spotify ISRC and artist ID.
        // The SC function will use these to pick the right artist when multiple SC profiles share a name.
        try {
          const result = await searchSoundChartsSong(
            refSong.title, refSong.artist,
            refSongGenreHints.length > 0 ? refSongGenreHints : null,
            refSpotifyIsrc,
            appSpotify,
            refSpotifyArtistId
          );
          if (result?.artistUuid) {
            confirmedArtistUuids[refSong.artist.toLowerCase()] = result.artistUuid;
            if (result.songUuid) confirmedSongUuids[refSong.artist.toLowerCase()] = result.songUuid;
            if (result._confirmedStrong) confirmedArtistUuidsStrong.add(refSong.artist.toLowerCase());
            console.log(`✓ Confirmed "${result.artistName}" via "${refSong.title}" — UUID: ${result.artistUuid}${result._confirmedStrong ? ' [strong]' : ' [weak]'}`);
          } else {
            console.log(`⚠ Could not confirm "${refSong.artist}" via song "${refSong.title}" — will fall back to name search`);
            // Step B.2: When the song lookup fails but we have a confirmed Spotify artist ID,
            // try to verify the SC artist profile directly. This catches the case where the
            // reference song is not in SC but we can still confirm (or reject) which SC artist
            // profile is correct via Spotify cross-link (e.g. wrong-Dante / Russian-pop Dante).
            if (refSpotifyArtistId && appSpotify && process.env.SOUNDCHARTS_APP_ID) {
              try {
                await throttleSoundCharts();
                const artistSearchResp = await axios.get(
                  `https://customer.api.soundcharts.com/api/v2/artist/search/${encodeURIComponent(refSong.artist)}`,
                  {
                    headers: { 'x-app-id': process.env.SOUNDCHARTS_APP_ID, 'x-api-key': process.env.SOUNDCHARTS_API_KEY },
                    params: { offset: 0, limit: 10 },
                    timeout: 10000,
                  }
                );
                const artistCandidates = (artistSearchResp.data?.items || []).filter(
                  a => a.name.toLowerCase() === refSong.artist.toLowerCase()
                );
                let artistConfirmed = false;
                let foundMismatch = false;
                for (const candidate of artistCandidates) {
                  try {
                    const scSpotifyId = await getSoundChartsArtistPlatformId(candidate.uuid, 'spotify');
                    if (scSpotifyId && scSpotifyId === refSpotifyArtistId) {
                      confirmedArtistUuids[refSong.artist.toLowerCase()] = candidate.uuid;
                      confirmedArtistUuidsStrong.add(refSong.artist.toLowerCase());
                      console.log(`✓ Artist profile match for "${refSong.artist}" via Spotify ID ${refSpotifyArtistId} → SC UUID ${candidate.uuid} [strong]`);
                      artistConfirmed = true;
                      break;
                    } else if (scSpotifyId && scSpotifyId !== refSpotifyArtistId) {
                      console.log(`⚠️  SC artist "${candidate.name}" (UUID ${candidate.uuid}) links to wrong Spotify artist ${scSpotifyId} (want ${refSpotifyArtistId})`);
                      foundMismatch = true;
                    }
                  } catch (_) { /* ignore per-candidate errors */ }
                }
                if (!artistConfirmed && artistCandidates.length > 0) {
                  if (foundMismatch) {
                    // Every SC candidate with a Spotify link pointed to the wrong artist — INVALID.
                    confirmedArtistUuids[refSong.artist.toLowerCase()] = 'INVALID';
                    console.log(`⚠️  All SC "${refSong.artist}" candidates link to wrong Spotify artist — marking INVALID`);
                  } else {
                    // SC’s platform ID data is simply absent (common even for major artists like Drake).
                    // Don’t penalize — leave unconfirmed so name-based fallback can still use the artist.
                    console.log(`⚠️  Could not verify SC artist for "${refSong.artist}" via Spotify ID (SC platform links missing) — leaving unconfirmed`);
                  }
                }
              } catch (artistSearchErr) {
                console.log(`⚠️  Artist profile fallback search failed for "${refSong.artist}": ${artistSearchErr.message}`);
              }
            }
          }
        } catch (refErr) {
          console.log(`⚠ Reference song lookup failed for "${refSong.title}": ${refErr.message}`);
        }

        // Step C: Spotify QA — safety net to catch any remaining SC/Spotify mismatches.
        // If SC's song still maps to the wrong Spotify artist (e.g. wrong Keffer profile),
        // mark NOSIMILAR so we keep the SC songs but skip its similar-artist graph.
        const scUuid = confirmedArtistUuids[refSong.artist.toLowerCase()];
        const scSongUuid = confirmedSongUuids[refSong.artist.toLowerCase()];
        if (scUuid && refSpotifyArtistId && scSongUuid && appSpotify && process.env.SOUNDCHARTS_APP_ID) {
          try {
            const scSpotifyTrackId = await getSoundChartsSongPlatformId(scSongUuid, 'spotify');
            if (scSpotifyTrackId) {
              const trackRes = await appSpotify.getTrack(scSpotifyTrackId);
              const scMappedSpotifyArtistId = trackRes.body.artists?.[0]?.id;
              if (scMappedSpotifyArtistId && scMappedSpotifyArtistId !== refSpotifyArtistId) {
                console.log(`⚠️  SC/Spotify artist mismatch for "${refSong.artist}": SC song maps to Spotify artist ${scMappedSpotifyArtistId} but reference song is by ${refSpotifyArtistId} — marking NOSIMILAR to skip wrong similar artists`);
                const existing = confirmedArtistUuids[refSong.artist.toLowerCase()];
                if (existing && existing !== 'INVALID' && !String(existing).startsWith('NOSIMILAR:')) {
                  confirmedArtistUuids[refSong.artist.toLowerCase()] = 'NOSIMILAR:' + existing;
                }
              } else if (scMappedSpotifyArtistId) {
                console.log(`✓ Spotify QA passed for "${refSong.artist}": SC song maps to correct Spotify artist ${scMappedSpotifyArtistId}`);
              }
            } else {
              // SC song has no Spotify mapping.
              // Only mark NOSIMILAR when the artist has NO confirmed Spotify presence.
              // If we already found them on Spotify (refSpotifyArtistId confirmed), the missing
              // SC→Spotify link is just a SC data gap, not a wrong-artist match (Keffer case).
              const hasSpotifyArtistConfirmed = !!confirmedSpotifyArtistIds[refSong.artist.toLowerCase()];
              if (!hasSpotifyArtistConfirmed) {
                console.log(`⚠️  SC song for "${refSong.artist}" has no Spotify mapping — SC artist likely wrong profile, marking NOSIMILAR`);
                const existing = confirmedArtistUuids[refSong.artist.toLowerCase()];
                if (existing && existing !== 'INVALID' && !String(existing).startsWith('NOSIMILAR:')) {
                  confirmedArtistUuids[refSong.artist.toLowerCase()] = 'NOSIMILAR:' + existing;
                }
              } else {
                // Spotify artist confirmed but SC song has no Spotify link.
                // Could be a SC data gap (right artist) OR the wrong SC profile that also has no Spotify link.
                // Disambiguate using genre: if the SC artist's genres have zero overlap with the
                // playlist's expected genres, it's almost certainly the wrong profile (e.g. electronic
                // Keffer when we want R&B Keffer) — mark NOSIMILAR so Spotify top tracks are used instead.
                const scArtistUuid = confirmedArtistUuids[refSong.artist.toLowerCase()];
                let scGenres = [];
                try {
                  const scArtistInfo = await getSoundChartsArtistInfoByUuid(scArtistUuid, refSong.artist);
                  scGenres = scArtistInfo?.genres || [];
                } catch (_) {}
                const playlistGenreNorms = [genreData.primaryGenre, ...(genreData.secondaryGenres || [])]
                  .filter(Boolean).map(g => g.toLowerCase().replace(/[^a-z0-9]/g, ''));
                const scGenreNorms = scGenres.map(g => g.toLowerCase().replace(/[^a-z0-9]/g, ''));
                const hasGenreOverlap = playlistGenreNorms.length === 0 || scGenreNorms.length === 0 ||
                  scGenreNorms.some(sg => playlistGenreNorms.some(pg => sg.includes(pg) || pg.includes(sg)));
                if (!hasGenreOverlap) {
                  console.log(`⚠️  SC artist genre mismatch for "${refSong.artist}": SC genres [${scGenres.join(', ')}] vs playlist [${[genreData.primaryGenre, ...(genreData.secondaryGenres||[])].filter(Boolean).join(', ')}] — marking NOSIMILAR, will use Spotify top tracks instead`);
                  const existing = confirmedArtistUuids[refSong.artist.toLowerCase()];
                  if (existing && existing !== 'INVALID' && !String(existing).startsWith('NOSIMILAR:')) {
                    confirmedArtistUuids[refSong.artist.toLowerCase()] = 'NOSIMILAR:' + existing;
                  }
                } else {
                  console.log(`⚠️  SC song for "${refSong.artist}" has no Spotify mapping but Spotify artist confirmed — SC data gap, keeping artist UUID`);
                }
              }
            }
          } catch (qaErr) {
            console.log(`⚠️  Spotify QA check failed for "${refSong.artist}": ${qaErr.message} — keeping SC UUID`);
          }
        }
      }
    }

    // Step 0.5: If no explicit genre was specified but artists were requested, analyze those artists to infer the genre
    if ((!genreData.primaryGenre || genreData.primaryGenre === 'not specified') &&
        genreData.artistConstraints.requestedArtists &&
        genreData.artistConstraints.requestedArtists.length > 0 &&
        !genreData.artistConstraints.exclusiveMode) {

      console.log('No explicit genre specified, but artists requested. Searching music platform for artist genres...');

      try {
        // Search for each artist on the platform to get their actual genre information
        const artistGenres = [];
        const allSimilarArtists = [];

        // Use SoundCharts to get genres, similar artists, and career stage (for popularity detection).
        // Collect per-artist first so we can validate before aggregating.
        console.log('🔍 Checking SoundCharts for artist info and similar artists...');
        const artistCareerStages = [];
        const artistSCInfoMap = {}; // { nameLower: soundChartsInfo }
        for (const artistName of genreData.artistConstraints.requestedArtists) {
          const confirmedUuid = confirmedArtistUuids[artistName.toLowerCase()];
          try {
            const soundChartsInfo = confirmedUuid
              ? await getSoundChartsArtistInfoByUuid(confirmedUuid, artistName)
              : await getSoundChartsArtistInfo(artistName);
            if (soundChartsInfo) artistSCInfoMap[artistName.toLowerCase()] = soundChartsInfo;
          } catch (err) { /* ignore individual lookup errors */ }
        }

        // Cross-check confirmed UUIDs against Spotify genres.
        // appSpotify was already initialized above with client credentials — works for all platforms.
        // SoundCharts sometimes tags artists with the wrong genre (e.g. an R&B artist tagged as electro).
        // When SC and Spotify disagree:
        //   - Keep the UUID (the reference-song confirmation means we have the RIGHT artist)
        //   - Discard SC's similar artists for this artist (they'll be wrong-genre too)
        //   - Use Spotify's genres instead for genre inference
        if (appSpotify) {
          const ELECTRO = ['electro', 'electronic', 'techno', 'house', 'edm', 'dance', 'trance', 'dubstep'];
          const RNB_HH  = ['r&b', 'rnb', 'soul', 'hip-hop', 'hip hop', 'rap', 'trap'];
          for (const artistName of genreData.artistConstraints.requestedArtists) {
            const scInfo = artistSCInfoMap[artistName.toLowerCase()];
            const scGenres = (scInfo?.genres || []).map(g => g.toLowerCase());
            if (scGenres.length === 0) continue; // nothing to validate
            try {
              // Prefer direct artist ID lookup (exact artist, no ambiguity) over name search
              let spotifyGenres = [];
              const confirmedSpotifyId = confirmedSpotifyArtistIds[artistName.toLowerCase()];
              if (confirmedSpotifyId) {
                const artistRes = await appSpotify.getArtist(confirmedSpotifyId);
                spotifyGenres = (artistRes.body.genres || []).map(g => g.toLowerCase());
              } else {
                const searchRes = await appSpotify.searchArtists(artistName, { limit: 5 });
                const items = searchRes.body.artists?.items || [];
                const match = items.find(a => a.name.toLowerCase() === artistName.toLowerCase()) || items[0];
                if (match?.genres?.length) spotifyGenres = match.genres.map(g => g.toLowerCase());
                // No continue — still run the SC vs Claude check even if Spotify has no genre data
              }
              const scIsElectroOnly = scGenres.some(g => ELECTRO.some(e => g.includes(e)))
                                   && !scGenres.some(g => RNB_HH.some(r => g.includes(r)));
              // When Spotify has no genre data for an obscure artist, fall back to Claude's
              // genre extraction as the tiebreaker (e.g. "Trap Soul" prompt → claudeIsRnbHh=true).
              const spotifyIsRnbHh = spotifyGenres.some(g => RNB_HH.some(r => g.includes(r)));
              const allClaudeGenres = [genreData.primaryGenre, ...(genreData.secondaryGenres || [])].map(g => (g || '').toLowerCase());
              const claudeIsRnbHh = allClaudeGenres.some(g => RNB_HH.some(r => g.includes(r)));
              if (scIsElectroOnly && (spotifyIsRnbHh || claudeIsRnbHh)) {
                const mismatchSource = spotifyIsRnbHh ? `Spotify=[${spotifyGenres.slice(0,2).join(',')}]` : `Claude=[${allClaudeGenres.slice(0,2).join(',')}]`;
                console.log(`⚠️  "${artistName}" SC genre mismatch: SC=[${scGenres.slice(0,2).join(',')}] vs ${mismatchSource} — keeping UUID for song fetch, dropping SC similar artists`);
                // Don't invalidate UUID — we confirmed the right artist via reference song.
                // Mark as NOSIMILAR so executeSoundChartsStrategy fetches songs but skips their
                // wrong-genre SC similar artists and genres when building the artist pool.
                const existingUuid = confirmedArtistUuids[artistName.toLowerCase()];
                if (existingUuid && existingUuid !== 'INVALID') {
                  confirmedArtistUuids[artistName.toLowerCase()] = 'NOSIMILAR:' + existingUuid;
                }
                // Remove from artistSCInfoMap so their wrong-genre similar artists don't pollute the pool.
                delete artistSCInfoMap[artistName.toLowerCase()];
                // Inject Spotify's correct genres directly into artistGenres for inference.
                artistGenres.push(...spotifyGenres);
              } else {
                console.log(`✓ "${artistName}" genre validated: SC=[${scGenres.slice(0,2).join(',')}] / Spotify=[${spotifyGenres.slice(0,2).join(',')}]`);
              }
            } catch (err) { /* ignore per-artist errors — don't discard on uncertainty */ }
          }
        }

        // Aggregate genres, similar artists, and career stages from validated artists only
        for (const scInfo of Object.values(artistSCInfoMap)) {
          if (scInfo.genres?.length > 0) artistGenres.push(...scInfo.genres);
          if (scInfo.similarArtists?.length > 0) allSimilarArtists.push(...scInfo.similarArtists);
          if (scInfo.careerStage) artistCareerStages.push(scInfo.careerStage);
        }

        // Store similar artists in genreData for use in playlist search
        if (allSimilarArtists.length > 0) {
          const uniqueSimilarArtists = [...new Set(allSimilarArtists)].slice(0, 15);
          genreData.artistConstraints.similarArtists = uniqueSimilarArtists;
          console.log(`📊 Found ${uniqueSimilarArtists.length} similar artists from SoundCharts: ${uniqueSimilarArtists.slice(0, 5).join(', ')}...`);
        }

        // Infer popularity preference from SoundCharts career stage (no Spotify needed)
        if (artistCareerStages.length > 0 && !genreData.trackConstraints.popularity.preference) {
          const stageScores = { long_tail: 1, developing: 2, mid_level: 3, mainstream: 4, superstar: 5 };
          const avgScore = artistCareerStages.reduce((a, s) => a + (stageScores[s] || 3), 0) / artistCareerStages.length;
          const stages = artistCareerStages.join(', ');
          if (avgScore <= 2) {
            genreData.trackConstraints.popularity.preference = 'underground';
            console.log(`🎯 Auto-detected popularity: UNDERGROUND (SoundCharts stages: ${stages})`);
          } else if (avgScore >= 4) {
            genreData.trackConstraints.popularity.preference = 'mainstream';
            console.log(`🎯 Auto-detected popularity: MAINSTREAM (SoundCharts stages: ${stages})`);
          } else {
            genreData.trackConstraints.popularity.preference = 'balanced';
            console.log(`🎯 Auto-detected popularity: BALANCED (SoundCharts stages: ${stages})`);
          }
        }

        // If we got genres from the platform, use Claude to analyze them
        // If we didn't get genres, let Claude make an educated guess (but log a warning)
        let claudePrompt;
        const artistsWithGenres = artistGenres.length;
        const totalArtists = genreData.artistConstraints.requestedArtists.length;

        if (artistGenres.length > 0) {
          // Check if we only have partial genre data (some artists missing genres)
          const hasPartialData = artistsWithGenres < totalArtists;
          const uniqueGenres = [...new Set(artistGenres)];

          console.log(`📊 Genre inference input: artists=[${genreData.artistConstraints.requestedArtists.join(', ')}], genres from SoundCharts=[${uniqueGenres.join(', ')}]`);

          claudePrompt = `Determine the genre for these music artists: "${genreData.artistConstraints.requestedArtists.join(', ')}"

GENRE DATA FROM SOUNDCHARTS: ${uniqueGenres.join(', ')}

CRITICAL RULES:
1. The genre data is REAL DATA from SoundCharts - use it as your primary guide
2. If the genre contains "r&b" or "R&B" or "soul", the primary genre should be "R&B" or "R&B/Soul"
3. DO NOT invent genres like "Electronic" or "Ambient" unless the data explicitly says so
4. IMPORTANT - ARTIST DISAMBIGUATION: When multiple artists share the same name, SoundCharts may have matched the wrong one. If the genre data includes language-specific genres (like "spanish hip hop", "rap conciencia", "french rap", "italian hip hop") but the OTHER requested artists are clearly from a different scene (e.g., English-speaking underground), treat the language-specific genres as potentially from the wrong artist match. In that case, use the broader/universal genre (e.g., just "Hip Hop") and set subgenre based on the overall artist group's likely scene — NOT the language-specific variant.

Respond ONLY with valid JSON:
{
  "primaryGenre": "use the genre data - if it says r&b, return R&B",
  "subgenre": "more specific subgenre if applicable",
  "keyCharacteristics": ["characteristic1", "characteristic2"],
  "style": "overall style description",
  "atmosphere": ["mood1", "mood2"]
}`;
        } else {
          // No SoundCharts genre data found - be very conservative and don't guess
          console.log('⚠️  WARNING: No SoundCharts genres found for artists - will NOT guess genre from artist names');
          console.log('🎵 Skipping genre inference - will use similar artists from SoundCharts instead');
          // Skip Claude API call - throw to exit this try block
          throw new Error('No SoundCharts genre data available - skipping genre inference');
        }

        const artistGenreResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 800,
          messages: [{
            role: 'user',
            content: claudePrompt
          }]
        });

        let artistGenreText = artistGenreResponse.content[0].text.trim();
        if (artistGenreText.startsWith('```json')) {
          artistGenreText = artistGenreText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        } else if (artistGenreText.startsWith('```')) {
          artistGenreText = artistGenreText.replace(/^```\n?/, '').replace(/\n?```$/, '');
        }

        const artistGenreData = JSON.parse(artistGenreText);

        // Skip genre inference if Claude returned "unknown"
        if (artistGenreData.primaryGenre === 'unknown') {
          console.log('⚠️  Claude could not confidently determine artist genres - skipping genre inference');
          throw new Error('Unknown artists, skipping genre inference');
        }

        // Merge artist-inferred genre data into genreData (only if fields are empty)
        if (artistGenreData.primaryGenre && !genreData.primaryGenre) {
          genreData.primaryGenre = artistGenreData.primaryGenre;
          console.log(`Inferred primary genre from artists: ${artistGenreData.primaryGenre}`);
        }
        if (artistGenreData.subgenre && !genreData.subgenre) {
          genreData.subgenre = artistGenreData.subgenre;
          console.log(`Inferred subgenre from artists: ${artistGenreData.subgenre}`);
        }
        if (artistGenreData.keyCharacteristics && artistGenreData.keyCharacteristics.length > 0 && genreData.keyCharacteristics.length === 0) {
          genreData.keyCharacteristics = artistGenreData.keyCharacteristics;
        }
        if (artistGenreData.style && !genreData.style) {
          genreData.style = artistGenreData.style;
        }
        if (artistGenreData.atmosphere && artistGenreData.atmosphere.length > 0 && genreData.atmosphere.length === 0) {
          genreData.atmosphere = artistGenreData.atmosphere;
        }
        console.log('Updated genre data with artist analysis:', genreData);
      } catch (error) {
        console.error('Failed to analyze artist genres:', error.message);
        // Continue anyway - we'll use the original genreData
      }
    }

    // Load existing playlist data if playlistId is provided (for refinements/refreshes)
    let existingPlaylistData = null;
    if (playlistId && userId) {
      console.log(`🔍 Looking up existing playlist: ${playlistId} for user ${userId}`);
      const userPlaylistsArray = userPlaylists.get(userId) || [];
      existingPlaylistData = userPlaylistsArray.find(p => p.playlistId === playlistId);
      // DB fallback: in-memory map is empty after server restart; load from Postgres
      if (!existingPlaylistData && usePostgres) {
        const dbPlaylists = await db.getUserPlaylists(userId);
        userPlaylists.set(userId, dbPlaylists);
        existingPlaylistData = dbPlaylists.find(p => p.playlistId === playlistId);
      }

      if (existingPlaylistData) {
        console.log(`✓ Found existing playlist: "${existingPlaylistData.playlistName || 'Untitled'}"`);
      } else {
        console.log(`⚠️  Playlist ${playlistId} not found in memory cache or database`);
      }

      // Prompt was already rebuilt from originalPrompt + refinements before Claude extraction.
      // genreData comes directly from Claude's analysis of that clean prompt — no overrides needed.
      if (existingPlaylistData && genreData.primaryGenre) {
        console.log(`genreData extracted from restored prompt — genre: ${genreData.primaryGenre} / ${genreData.subgenre}`);
      }
    }

    // Build context from liked/disliked songs if available
    let userFeedbackContext = '';
    if (existingPlaylistData) {
      const likedSongs = existingPlaylistData.likedSongs || [];
      const dislikedSongs = existingPlaylistData.dislikedSongs || [];

      if (likedSongs.length > 0 || dislikedSongs.length > 0) {
        userFeedbackContext = '\n\nUSER FEEDBACK FROM PREVIOUS SONGS:';

        if (likedSongs.length > 0) {
          userFeedbackContext += `\n\nSONGS THE USER LIKED (add more similar songs):`;
          likedSongs.slice(0, 10).forEach(song => {
            userFeedbackContext += `\n- "${song.name}" by ${song.artist}`;
          });
          if (likedSongs.length > 10) {
            userFeedbackContext += `\n...and ${likedSongs.length - 10} more`;
          }
        }

        if (dislikedSongs.length > 0) {
          userFeedbackContext += `\n\nSONGS THE USER DISLIKED (avoid similar songs):`;
          dislikedSongs.slice(0, 10).forEach(song => {
            userFeedbackContext += `\n- "${song.name}" by ${song.artist}`;
          });
          if (dislikedSongs.length > 10) {
            userFeedbackContext += `\n...and ${dislikedSongs.length - 10} more`;
          }
        }

        userFeedbackContext += '\n\nIMPORTANT: Analyze the liked songs to understand what the user enjoys (tempo, energy, mood, subgenre) and incorporate that into your search queries. Avoid songs similar in style, tempo, or mood to the disliked songs.';
      }
    }

    // Discover songs via SoundCharts — direct attribute-based query (no similarity tree)
    let soundChartsDiscoveredSongs = [];
    const maxPerArtist = genreData.trackConstraints?.artistDiversity?.maxPerArtist;
    // Collects Phase 3b cache-miss artists + all uncached pool artists for background enrichment.
    // Drained via setImmediate after res.json() so enrichment never blocks the response.
    const pendingEnrichment = [];

    // Enriches artists discovered via top_songs strategy (no UUID available — needs name lookup).
    // Also used for artist_songs pool artists passed via pendingEnrichment.
    const drainEnrichmentQueue = (extraArtistNames = []) => {
      const toEnrich = [...pendingEnrichment];
      const genre = genreData.primaryGenre || null;
      setImmediate(async () => {
        // Phase 3b cache-miss artists (have UUID already)
        for (const artistInfo of toEnrich) {
          await getArtistFullCatalogFromSC(artistInfo.uuid, artistInfo.name, genre).catch(() => {});
        }
        // top_songs strategy artists (only have name — need UUID lookup first)
        for (const artistName of extraArtistNames) {
          try {
            const info = await getSoundChartsArtistInfo(artistName, genre);
            if (info?.uuid) {
              await getArtistFullCatalogFromSC(info.uuid, artistName, genre).catch(() => {});
            }
          } catch (e) { /* skip */ }
        }
      });
    };
    const _phases = Array.isArray(genreData.phases) && genreData.phases.length >= 2 ? genreData.phases : null;

    if (process.env.SOUNDCHARTS_APP_ID) {
      if (_phases) {
        // ── Multi-phase: run a separate SC query per phase with phase-specific energy/mood ──
        console.log(`🎭 Multi-phase playlist: ${_phases.map(p => `"${p.label}" (${p.energy})`).join(' → ')}`);
        for (const phase of _phases) {
          const phaseGenreData = {
            ...genreData,
            energyTarget: phase.energy || genreData.energyTarget,
            mood: phase.mood !== undefined ? phase.mood : genreData.mood,
            phases: null, // prevent recursion
          };
          // Remove contradictory label-based energy signals so energyTarget takes over
          if (phase.energy) {
            phaseGenreData.atmosphere = (genreData.atmosphere || []).filter(a => {
              const a2 = a.toLowerCase();
              if (phase.energy === 'high') return !['calm', 'peaceful', 'sleep', 'mellow', 'lofi', 'chill'].some(w => a2.includes(w));
              if (phase.energy === 'low')  return !['hype', 'energetic', 'pump', 'intense', 'aggressive'].some(w => a2.includes(w));
              return true;
            });
          }
          const phaseQuery = buildSoundchartsQuery(phaseGenreData, allowExplicit);
          const phaseTarget = Math.max(1, Math.round(songCount * phase.fraction));
          const phaseFetch = Math.min(phaseTarget * 4, 120);
          console.log(`  Phase "${phase.label}": fetching ${phaseFetch} candidates (target ${phaseTarget})`);
          try {
            const phaseSongs = await executeSoundChartsStrategy(phaseQuery, phaseFetch, confirmedArtistUuids, 0);
            phaseSongs.forEach(s => { s._phaseLabel = phase.label; s._phaseIndex = _phases.indexOf(phase); });
            soundChartsDiscoveredSongs.push(...phaseSongs);
            console.log(`  ✓ Phase "${phase.label}": ${phaseSongs.length} songs`);
          } catch (phaseErr) {
            console.log(`  ⚠️  Phase "${phase.label}" SC query failed: ${phaseErr.message}`);
          }
        }
        console.log(`✓ Multi-phase SoundCharts total: ${soundChartsDiscoveredSongs.length} songs`);
      } else {
        const scQuery = buildSoundchartsQuery(genreData, allowExplicit);
        // Reference-song prompts ("find songs similar to X"): seed exclusively from the
        // confirmed reference artists and let SC's similarity graph determine what else appears.
        // Claude's suggestedSeedArtists (e.g. Michael Jackson injected for an R&B prompt) are
        // intentionally ignored — they would add extra seeds whose SC graphs dilute the
        // reference-artist-specific discovery. SC depth-1/depth-2 expansion from Dante/Keffer
        // will naturally surface the right co-similar artists (lisseXX, MYRZ, etc.) without
        // Claude steering the graph toward unrelated mainstream acts.
        //
        // Exception: when the user explicitly named artists (requestedArtists), those are kept
        // because they are the user's direct ask, not Claude's inference.
        const _hasReferenceSongs = (genreData.referenceSongs || []).length > 0;
        const _hasRequestedArtists = (genreData.artistConstraints?.requestedArtists || []).length > 0;
        if (_hasReferenceSongs && !_hasRequestedArtists) {
          // Replace Claude's seeds entirely — use only the confirmed reference artists.
          const refSeeds = [];
          const refSeedsSeen = new Set();
          for (const rs of genreData.referenceSongs) {
            const lower = rs.artist.toLowerCase();
            if (confirmedArtistUuids[lower] && !refSeedsSeen.has(lower)) {
              refSeeds.push(rs.artist);
              refSeedsSeen.add(lower);
            }
          }
          if (refSeeds.length > 0) {
            console.log(`🌱 Reference-song prompt: seeding SC graph exclusively from reference artists [${refSeeds.join(', ')}] — ignoring Claude's suggestedSeedArtists`);
            scQuery.artists = refSeeds;
            scQuery.seedArtists = refSeeds;
            scQuery.expandToSimilar = true;
            scQuery.strategy = 'artist_songs';
          }
        } else if (_hasReferenceSongs && _hasRequestedArtists) {
          // User named artists explicitly — keep requested artists but also inject reference artists
          // so their SC graph is traversed alongside the user's picks.
          const existingLower = new Set(scQuery.artists.map(a => a.toLowerCase()));
          for (const rs of genreData.referenceSongs) {
            const lower = rs.artist.toLowerCase();
            if (confirmedArtistUuids[lower] && !existingLower.has(lower)) {
              scQuery.artists.push(rs.artist);
              existingLower.add(lower);
            }
          }
        }
        // Refresh/auto-update seed anchor: replace Claude's inferred suggestedSeedArtists with
        // the artists actually in the playlist. Claude sees the playlist name + 5 key artists
        // and infers a much wider genre pool (e.g. suggesting Bad Bunny/Travis Scott for a
        // CALLMEJB/elle. playlist). Locking seeds to playlist artists keeps the SC similarity
        // graph anchored to what the playlist actually sounds like, not what Claude thinks
        // the genre sounds like in general.
        //
        if (existingPlaylistData && scQuery.strategy === 'artist_songs' &&
            existingPlaylistData.tracks?.length === 0 && !genreData.artistConstraints?.exclusiveMode) {
          // 0-song playlist refresh: no artists to anchor to — fall back to top_songs so SC's
          // genre/mood/energy filters drive discovery instead of an empty artist list.
          scQuery.strategy = 'top_songs';
          scQuery.expandToSimilar = false;
          console.log(`⚡ Refresh: 0-song playlist — switching to top_songs (no anchor artists available)`);
        } else if (existingPlaylistData?.tracks?.length > 0 && !genreData.artistConstraints?.exclusiveMode) {
          // Anchor seeds to the top 8 most-represented artists already in the playlist.
          // This keeps refresh/auto-update grounded in what the playlist actually sounds like.
          const _anchorArtists = [...new Set(
            existingPlaylistData.tracks.map(t => t.artist).filter(Boolean)
          )];
          if (_anchorArtists.length > 0) {
            const _artistFreq = {};
            existingPlaylistData.tracks.forEach(t => {
              if (t.artist) _artistFreq[t.artist] = (_artistFreq[t.artist] || 0) + 1;
            });
            const _cappedAnchor = _anchorArtists
              .sort((a, b) => (_artistFreq[b] || 0) - (_artistFreq[a] || 0))
              .slice(0, 8);
            console.log(`🔒 Refresh: anchoring seeds to top ${_cappedAnchor.length} playlist artists [${_cappedAnchor.join(', ')}] — disabling Level 1/2 expansion`);
            scQuery.artists = _cappedAnchor;
            scQuery.expandToSimilar = false;
            scQuery.strategy = 'artist_songs';
          }
        }
        // Gender filter at seed selection — happens before the SC similarity graph expands.
        // Filtering here prevents a male seed's graph from generating a pool of male candidates.
        // The vibe check gender rule is a backstop for edge cases (mixed bands, guest features),
        // not the primary enforcement mechanism.
        {
          const _gf = genreData.artistConstraints?.vocalGender;
          if (_gf && _gf !== 'any' && scQuery.artists.length > 0) {
            scQuery.artists = await filterArtistsByGender(scQuery.artists, _gf);
          }
        }
        const fetchCount = Math.min(songCount * 3, 200);
        // When maxPerArtist is set, ensure the artist pool is large enough to cover songCount unique artists
        const minArtistsNeeded = maxPerArtist ? Math.min(Math.ceil(songCount / maxPerArtist * 1.5), 40) : 0;
        console.log(`🎵 SoundCharts strategy: "${scQuery.strategy}" (fetching ${fetchCount} candidates for ${songCount} target${minArtistsNeeded ? `, min ${minArtistsNeeded} artists` : ''})`);
        console.log(`   Filters: [${scQuery.soundchartsFilters.map(f => f.type).join(', ')}]`);
        try {
          soundChartsDiscoveredSongs = await executeSoundChartsStrategy(scQuery, fetchCount, confirmedArtistUuids, minArtistsNeeded, pendingEnrichment);
          console.log(`✓ SoundCharts returned ${soundChartsDiscoveredSongs.length} songs`);
        } catch (scErr) {
          console.log(`⚠️  SoundCharts strategy failed: ${scErr.message}`);
        }
      }
    } else {
      console.log('⚠️  SOUNDCHARTS_APP_ID not configured - skipping SoundCharts discovery');
    }

    // Artists that need Spotify-direct injection fall into two categories:
    // 1. No SC UUID at all (!scUuid) — SC couldn't find them.
    // 2. NOSIMILAR but NOT strongly confirmed — SC found a same-name artist but couldn't
    //    verify it's the right one (e.g. Russian "Dante" confirmed only by title-match bug,
    //    not by ISRC or Spotify ID). Their SC catalog may be wrong → use Spotify top tracks.
    //
    // EXCLUDED from Spotify-direct: NOSIMILAR artists that ARE strongly confirmed (ISRC/Spotify-ID
    // verified). These are right artists whose SC genre data just doesn't match the playlist
    // (e.g. Drake confirmed via Marvin's Room ISRC — his SC catalog has the correct sad songs,
    // and using getArtistTopTracks would inject mood-wrong hits like "One Dance" / "God's Plan").
    const nosimilarWithSpotify = new Set(
      Object.entries(confirmedSpotifyArtistIds)
        .filter(([artistLower]) => {
          const scUuid = confirmedArtistUuids[artistLower];
          if (!scUuid) return true; // no SC UUID — always use Spotify-direct
          if (typeof scUuid === 'string' && scUuid.startsWith('NOSIMILAR:')) {
            // NOSIMILAR + strongly confirmed = right artist, SC genre mismatch only → SC catalog handles it
            // NOSIMILAR + weakly confirmed  = possibly wrong SC profile → keep Spotify-direct
            return !confirmedArtistUuidsStrong.has(artistLower);
          }
          return false;
        })
        .map(([artistLower]) => artistLower)
    );
    if (nosimilarWithSpotify.size > 0) {
      console.log(`🎵 [SPOTIFY-DIRECT] ${nosimilarWithSpotify.size} artist(s) will use Spotify top tracks (no/wrong SC profile): [${[...nosimilarWithSpotify].join(', ')}]`);
    }

    // Map to recommendedTracks (ISRC + releaseDate passed through for exact lookup and era filtering)
    // Filter out any songs with missing names to prevent malformed Spotify searches
    // Also pre-filter by era using SoundCharts' original releaseDate — this avoids the
    // "compilation album" problem where Spotify returns a classic song on a recent re-release
    // and album.release_date passes the year check despite the song being much older.
    let eraMin = genreData.era?.yearRange?.min || null;
    let eraMax = genreData.era?.yearRange?.max || null;
    let recommendedTracks = soundChartsDiscoveredSongs
      .filter(scSong => {
        if (!scSong.name || !scSong.name.trim()) return false;
        // Skip songs from wrong-profile SC artists — they'll be sourced from Spotify directly
        if (nosimilarWithSpotify.has((scSong.artistName || '').toLowerCase())) return false;
        if (scSong.releaseDate && (eraMin || eraMax)) {
          const year = parseInt(scSong.releaseDate.substring(0, 4));
          if (eraMin && year < eraMin) {
            console.log(`[ERA-SC] Pre-filtering "${scSong.name}" by ${scSong.artistName} (${year} < ${eraMin})`);
            return false;
          }
          if (eraMax && year > eraMax) {
            console.log(`[ERA-SC] Pre-filtering "${scSong.name}" by ${scSong.artistName} (${year} > ${eraMax})`);
            return false;
          }
        }
        return true;
      })
      .map(scSong => ({
        track: scSong.name,
        artist: scSong.artistName,
        isrc: scSong.isrc || null,
        uuid: scSong.uuid || null,
        releaseDate: scSong.releaseDate || null,
        source: 'soundcharts',
        _phaseLabel: scSong._phaseLabel || null,
        _phaseIndex: scSong._phaseIndex ?? null,
      }));

    // Artist-level genre filter — SC sometimes tags songs as R&B whose artist is clearly not
    // (e.g. Lukas Graham, Sam Smith, Arctic Monkeys). Filter by Spotify artist genres to catch these.
    if (genreData.primaryGenre && recommendedTracks.length > 0) {
      const scArtistNames = [...new Set(recommendedTracks.map(t => t.artist).filter(Boolean))];
      const scGenreMap = await batchGetSpotifyArtistGenres(scArtistNames).catch(() => new Map());
      const beforeFilter = recommendedTracks.length;
      recommendedTracks = recommendedTracks.filter(t => {
        const spGenres = scGenreMap.get((t.artist || '').toLowerCase()) || null;
        const ok = isArtistInGenreFamily(spGenres, genreData.primaryGenre);
        if (!ok) console.log(`🚫 SC artist genre mismatch: "${t.artist}" (${(spGenres || []).join(', ')}) → not ${genreData.primaryGenre}`);
        return ok;
      });
      if (recommendedTracks.length < beforeFilter) {
        console.log(`🎯 SC artist genre filter: ${beforeFilter} → ${recommendedTracks.length} songs (removed ${beforeFilter - recommendedTracks.length} off-genre)`);
      }
    }

    console.log(`📋 Total songs to search: ${recommendedTracks.length} from SoundCharts (${soundChartsDiscoveredSongs.length - recommendedTracks.length} pre-filtered by era)`);

    // Safety: if era filtering was too aggressive (dropped >60% of songs and we have fewer than 2x target),
    // relax the era filter and use all songs — decade soft-filtering via vibe check will still apply.
    if ((eraMin || eraMax) && soundChartsDiscoveredSongs.length > 0) {
      const totalValid = soundChartsDiscoveredSongs.filter(s => s.name?.trim()).length;
      const filteredRatio = totalValid > 0 ? recommendedTracks.length / totalValid : 1;
      if (filteredRatio < 0.4 && recommendedTracks.length < songCount * 2) {
        console.warn(`⚠️  [ERA] Era filter too aggressive (kept ${Math.round(filteredRatio * 100)}% of songs, only ${recommendedTracks.length} remain for target ${songCount}). Relaxing era constraints.`);
        eraMin = null;
        eraMax = null;
        recommendedTracks = soundChartsDiscoveredSongs
          .filter(s => s.name?.trim())
          .map(scSong => ({
            track: scSong.name,
            artist: scSong.artistName,
            isrc: scSong.isrc || null,
            uuid: scSong.uuid || null,
            releaseDate: scSong.releaseDate || null,
            source: 'soundcharts'
          }));
        console.log(`📋 After relaxing era filter: ${recommendedTracks.length} songs available`);
      }
    }

    // Generate playlist name and description
    const hasRequestedArtists = genreData.artistConstraints.requestedArtists &&
                                 genreData.artistConstraints.requestedArtists.length > 0;
    var claudePlaylistName = null;
    var claudePlaylistDescription = null;
    try {
      const nameResponse = await anthropic.messages.create({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 300,
        messages: [{
          role: 'user',
          content: `Generate a creative playlist name and short description for this playlist request:

User's request: "${prompt}"
Genre: ${genreData.primaryGenre || 'mixed'}
${genreData.subgenre ? `Subgenre: ${genreData.subgenre}` : ''}
${hasRequestedArtists ? `Artists mentioned: ${genreData.artistConstraints.requestedArtists.join(', ')}` : ''}
${genreData.atmosphere.length > 0 ? `Vibe: ${genreData.atmosphere.join(', ')}` : ''}

Return ONLY valid JSON:
{"playlistName": "Creative Name Here", "description": "Brief 1-2 sentence description of the playlist vibe"}`
        }]
      });
      const nameText = nameResponse.content[0].text.trim()
        .replace(/^```json\n?/, '').replace(/\n?```$/, '')
        .replace(/^```\n?/, '').replace(/\n?```$/, '');
      const nameData = JSON.parse(nameText);
      claudePlaylistName = nameData.playlistName;
      claudePlaylistDescription = nameData.description;
      console.log('Playlist name:', claudePlaylistName);
    } catch (nameErr) {
      claudePlaylistName = genreData.primaryGenre
        ? `${genreData.primaryGenre} Vibes`
        : (hasRequestedArtists ? `${genreData.artistConstraints.requestedArtists[0]} Mix` : 'My Playlist');
      claudePlaylistDescription = hasRequestedArtists
        ? `Songs similar to ${genreData.artistConstraints.requestedArtists.join(', ')}`
        : `A curated ${genreData.primaryGenre || 'music'} playlist`;
    }

    // Step 3: Search for recommended songs on the user's platform
    const allTracks = [];
    const seenTrackIds = new Set(); // To prevent exact duplicates
    const seenSongSignatures = new Map(); // To prevent same song by same artist from different albums
    const artistTrackCount = new Map(); // Per-artist track count for maxPerArtist enforcement
    const excludeTrackIds = new Set(excludeTrackUris.map(uri => uri.split(':').pop())); // Extract track IDs from URIs

    // Load song history and excluded songs if playlistId is provided (for manual refresh)
    let playlistSongHistory = new Set();
    if (playlistId && userId) {
      let userPlaylistsArray = userPlaylists.get(userId) || [];
      let refreshPlaylist = userPlaylistsArray.find(p => p.playlistId === playlistId);
      if (!refreshPlaylist && usePostgres) {
        const dbPlaylists = await db.getUserPlaylists(userId);
        userPlaylists.set(userId, dbPlaylists);
        refreshPlaylist = dbPlaylists.find(p => p.playlistId === playlistId);
      }
      if (refreshPlaylist) {
        if (refreshPlaylist.songHistory && refreshPlaylist.songHistory.length > 0) {
          playlistSongHistory = new Set(refreshPlaylist.songHistory);
          console.log(`[MANUAL-REFRESH] Loaded ${playlistSongHistory.size} tracks from song history to filter out repeats`);
        }
        // Always apply the playlist's excludedSongs from the DB — this is the source of truth
        // for songs the user explicitly removed, regardless of what the frontend passes.
        if (refreshPlaylist.excludedSongs && refreshPlaylist.excludedSongs.length > 0) {
          for (const s of refreshPlaylist.excludedSongs) {
            const uri = (typeof s === 'object' ? s.uri : null) || s;
            if (uri) excludeTrackIds.add(uri.split(':').pop());
          }
          console.log(`[MANUAL-REFRESH] Auto-excluded ${refreshPlaylist.excludedSongs.length} user-removed song(s) from playlist record`);
        }
      }
    }

    // Extract the recording year from an ISRC code.
    // ISRC format: CC-XXX-YY-NNNNN (or without dashes), positions 5-6 = 2-digit year.
    // This reflects when the recording was originally made, not when it was repackaged.
    const extractIsrcYear = (isrc) => {
      if (!isrc) return null;
      const clean = isrc.replace(/-/g, '');
      if (clean.length < 7) return null;
      const twoDigit = parseInt(clean.substring(5, 7), 10);
      if (isNaN(twoDigit)) return null;
      // 30–99 → 1930–1999, 00–29 → 2000–2029
      return twoDigit >= 30 ? 1900 + twoDigit : 2000 + twoDigit;
    };

    // Helper function to normalize track names for comparison
    const normalizeTrackName = (name) => {
      // Remove common suffixes/prefixes that indicate same song
      let normalized = name.toLowerCase();

      // Remove parenthetical/bracketed content and dashes that indicate versions
      normalized = normalized
        .replace(/\s*-\s*(a\s+)?colors?\s+show/gi, '')  // Remove COLORS SHOW variations
        .replace(/\s*-\s*((single|album|ep)\s+)?version/gi, '')  // Remove version indicators
        .replace(/\s*[\(\[].*?[\)\]]/g, '')  // Remove content in parentheses or brackets
        .replace(/[^\w\s]/g, '')  // Remove special characters
        .replace(/\s+/g, ' ')     // Normalize whitespace
        .trim();

      return normalized;
    };

    // Helper function to check if a track is a unique variation
    const isUniqueVariation = (trackName) => {
      const variations = [
        'remix', 'mix', 'remaster', 'version', 'edit',
        'live', 'acoustic', 'demo', 'cover', 'feat',
        'featuring', 'ft', 'with', 'instrumental', 'radio edit',
        'extended', 'club', 'bonus', 'alternate', 'unplugged',
        'colors show', 'color show'  // Add COLORS SHOW as variation marker
      ];
      const lowerName = trackName.toLowerCase();
      return variations.some(variation => lowerName.includes(variation));
    };

    // ── Shared Phase A helper — fetch ISRCs (and platform IDs as fallback) for songs without one ──
    // SC almost always has ISRCs for catalogued songs — fetching them lets us use exact ISRC
    // search on Spotify/Apple Music instead of unreliable text search.
    const prefetchPlatformIds = async (pool, scPlatformCode) => {
      if (!process.env.SOUNDCHARTS_APP_ID) return;
      const appId = process.env.SOUNDCHARTS_APP_ID;
      const apiKey = process.env.SOUNDCHARTS_API_KEY;
      const needing = pool.filter(s => !s.isrc && s.uuid && !s.platformId);
      if (needing.length === 0) return;
      console.log(`🔍 [Phase A] Fetching ISRCs from SC for ${needing.length} songs without ISRC...`);
      let isrcHits = 0;
      let platformHits = 0;
      for (const song of needing) {
        // Primary: fetch ISRC from SC song detail — covers all platforms, SC coverage is high
        try {
          await throttleSoundCharts();
          const detailResp = await axios.get(
            `https://customer.api.soundcharts.com/api/v2/song/${song.uuid}`,
            { headers: { 'x-app-id': appId, 'x-api-key': apiKey }, timeout: 8000 }
          );
          const detail = detailResp.data?.object || detailResp.data;
          const isrc = detail?.isrc?.value || detail?.isrc || null;
          if (isrc) {
            song.isrc = isrc;
            isrcHits++;
            continue; // ISRC found — no need for platform ID lookup
          }
        } catch (_) { /* fall through to platform ID */ }
        // Fallback: try SC platform track ID (works for some mainstream artists)
        song.platformId = await getSoundChartsSongPlatformId(song.uuid, scPlatformCode);
        if (song.platformId) platformHits++;
      }
      console.log(`🔍 [Phase A] ISRCs: ${isrcHits}, platform IDs: ${platformHits} / ${needing.length} songs`);
    };

    // Scale batch size with song count so Phase B lookup time stays roughly constant
    const BATCH_SIZE = Math.min(Math.max(10, Math.ceil(songCount / 3)), 25);

    // ── Shared platform track finder — used by main, supplement, and fallback loops ──
    // Defined here (outside the recommendedTracks>0 guard) so the top-songs fallback
    // can also use it even when the main SC artist pool returned 0 songs.
    // Tries (1) ISRC, (2) pre-fetched platform ID, (3) text search.
    // Returns { track, usedExact } or null. Safe to run in parallel (read-only).
    const findTrackOnPlatform = async (song, opts = {}) => {
      const { storefront = 'us', appleMusicApi = null, platformSvc = null } = opts;
      const artistName = song.artistName || song.artist || '';

      const fLabel = `"${song.name || song.track}" by ${artistName}`;

      if (platform === 'spotify') {
        // 1. ISRC
        if (song.isrc) {
          const r = await Promise.race([
            userSpotifyApi.searchTracks(`isrc:${song.isrc}`, { limit: 5 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
          ]);
          const items = r.body.tracks.items;
          if (items.length > 0) {
            console.log(`🔑 [ISRC] ${fLabel}`);
            return { track: items[0], usedExact: true };
          }
          console.log(`⚠️  [ISRC-MISS] ${fLabel} — ISRC ${song.isrc} returned no results, trying fallback`);
        }
        // 2. SC platform ID (pre-fetched)
        if (song.platformId) {
          const r = await Promise.race([
            userSpotifyApi.getTrack(song.platformId),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
          ]);
          if (r.body?.id) {
            console.log(`🎯 [SC-ID] ${fLabel} → ${song.platformId}`);
            return { track: r.body, usedExact: true };
          }
        }
        // 3. Text search — three attempts with progressively looser queries
        const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
        const reqNorm = norm(artistName);
        const checkArtistMatch = (t) => (t.artists || []).some(a => {
          const fn = norm(a.name);
          return reqNorm.length < 6 ? fn === reqNorm : fn === reqNorm || fn.startsWith(reqNorm) || reqNorm.startsWith(fn);
        });

        // Strip feat. credit and mix/version suffixes for cleaner queries
        const stripTitle = (t) => t
          .replace(/\s*[\(\[](feat\.|ft\.|featuring)[^\)\]]*[\)\]]/gi, '')  // "(feat. X)" / "[feat. X]"
          .replace(/\s+-\s+(original mix|radio edit|extended mix|slowed|sped up|remix|remaster(ed)?|acoustic|live|instrumental).*$/i, '')
          .trim();
        const cleanTitle = stripTitle(song.name || song.track || '');

        const textAttempts = [
          // Attempt 1: exact field query with original title
          `track:${song.name} artist:${artistName}`,
          // Attempt 2: field query with cleaned title (no feat./mix suffix)
          cleanTitle !== song.name ? `track:${cleanTitle} artist:${artistName}` : null,
          // Attempt 3: unqualified search — Spotify's general search is more forgiving
          `${cleanTitle} ${artistName}`,
        ].filter(Boolean);

        for (const query of textAttempts) {
          const r = await Promise.race([
            userSpotifyApi.searchTracks(query, { limit: 5 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
          ]);
          const items = r.body.tracks.items;
          if (items.length === 0) continue;
          for (const t of items) {
            if (checkArtistMatch(t)) {
              const usedClean = query !== textAttempts[0];
              console.log(`🔍 [TEXT${usedClean ? '-LOOSE' : ''}] ${fLabel}`);
              return { track: t, usedExact: false };
            }
          }
        }
        const lastItems = await userSpotifyApi.searchTracks(textAttempts[textAttempts.length - 1], { limit: 3 }).then(r => r.body.tracks.items).catch(() => []);
        const topResults = lastItems.slice(0, 3).map(t => `"${t.name}" by ${t.artists?.[0]?.name}`).join(', ');
        console.log(`❌ [TEXT-MISS] ${fLabel}${topResults ? ` — top results: ${topResults}` : ' — 0 results'}`);
        return null;

      } else if (platform === 'apple') {
        // 1. ISRC
        if (song.isrc && appleMusicApi) {
          try {
            const result = await appleMusicApi.lookupByIsrc(song.isrc, storefront);
            if (result) {
              console.log(`🔑 [ISRC] ${fLabel}`);
              return { track: result, usedExact: true };
            }
            console.log(`⚠️  [ISRC-MISS] ${fLabel} — ISRC ${song.isrc} returned no results, trying fallback`);
          } catch (_) { /* fall through */ }
        }
        // 2. SC platform ID (pre-fetched)
        if (song.platformId && appleMusicApi) {
          try {
            const result = await appleMusicApi.getTrack(song.platformId, storefront);
            if (result) {
              console.log(`🎯 [SC-ID] ${fLabel} → ${song.platformId}`);
              return { track: result, usedExact: true };
            }
          } catch (_) { /* fall through */ }
        }
        // 3. Text search
        if (platformSvc) {
          const results = await platformSvc.searchTracks(platformUserId, `${song.name} ${artistName}`, tokens, storefront, 5);
          const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const reqNorm = norm(artistName);
          for (const t of (results || [])) {
            const nameLower = (t.name || '').toLowerCase();
            if (nameLower.includes(' / ') || /\[slowed|\(slowed|karaoke|orchestra version|\(mixed\)/i.test(t.name)) continue;
            // Check all artists (primary + featured) — some platforms list the featured artist as the credited artist
            const artistNames = t.artists?.length ? t.artists.map(a => a.name) : [t.artist];
            const artistMatch = artistNames.some(name => { const fn = norm(name); return reqNorm.length < 6 ? fn === reqNorm : fn === reqNorm || fn.startsWith(reqNorm) || reqNorm.startsWith(fn); });
            if (artistMatch) {
              console.log(`🔍 [TEXT] ${fLabel}`);
              return { track: t, usedExact: false };
            }
          }
          const topResults = (results || []).slice(0, 3).map(t => `"${t.name}" by ${t.artists?.[0]?.name || t.artist}`).join(', ');
          if (topResults) console.log(`❌ [TEXT-MISMATCH] ${fLabel} — top Apple Music results: ${topResults}`);
          else console.log(`❌ [TEXT-EMPTY] ${fLabel} — Apple Music returned 0 results`);
        }
        return null;
      }
      return null;
    };

    // If we have songs from SoundCharts, search for them on the user's platform
    if (recommendedTracks.length > 0) {
      console.log(`🔍 Searching ${platform} for ${recommendedTracks.length} SoundCharts-discovered songs...`);

      // ── Phase A: pre-fetch SoundCharts platform IDs (serial+throttled, one-time cost) ──
      // For songs that have no ISRC, fetch the platform ID from SC identifiers upfront so
      // Phase B can do all platform lookups in parallel without hitting the SC throttler.
      if (process.env.SOUNDCHARTS_APP_ID) {
        const scPlatformCode = platform === 'spotify' ? 'spotify' : 'applemusic';
        const songsNeedingId = recommendedTracks.filter(s => !s.isrc && s.uuid).slice(0, songCount * 2);
        if (songsNeedingId.length > 0) {
          console.log(`🔍 [Phase A] Pre-fetching SC identifiers for ${songsNeedingId.length} songs without ISRC...`);
          let phaseAConsecFails = 0;
          for (const song of songsNeedingId) {
            song.platformId = await getSoundChartsSongPlatformId(song.uuid, scPlatformCode);
            if (song.platformId) { phaseAConsecFails = 0; }
            else if (++phaseAConsecFails >= 2) {
              console.log(`🔍 [Phase A] Stopping early — 2 consecutive misses`);
              break;
            }
          }
          const found = songsNeedingId.filter(s => s.platformId).length;
          console.log(`🔍 [Phase A] Got platform IDs for ${found}/${songsNeedingId.length} songs`);
        }
      }

      // ── Shared post-lookup validator (runs sequentially after each parallel batch) ──
      // Returns true and mutates allTracks/seenTrackIds/seenSongSignatures if track passes all checks.
      // ── Constraint enforcement spectrum ─────────────────────────────────────────────────
      // Three stages; each constraint belongs to exactly one:
      //
      //   SEED SELECTION (before executeSoundChartsStrategy):
      //     "Does this constraint determine which artists generate the pool?"
      //     → Gender. Applied to scQuery.artists before the similarity graph expands.
      //       A male seed's graph never generates a male pool for a female-only request.
      //
      //   TRACK ADMISSION (validateAndAdd, here):
      //     "Does this constraint evaluate a specific track being added?"
      //     → Artist exclusion, explicit flag, era cutoff, resolution divergence.
      //       Hard binary rules. These run BEFORE the vibe check 75% floor — they bypass
      //       it entirely. The 75% floor exists to prevent over-aggressive vibe check
      //       removal of genre-adjacent tracks. It is NOT appropriate for binary constraints
      //       ("75% female-only" is not a valid outcome). Binary constraints belong here,
      //       not in the vibe check.
      //
      //   VIBE CHECK (post-selection):
      //     "Does this constraint require judgment about fit and context?"
      //     → Energy, mood, use-case coherence, edge cases that binary rules can't cover.
      //       If you find yourself adding a hard binary rule to the vibe check, it almost
      //       certainly belongs one stage earlier in the pipeline instead.
      //
      //   TRACK_CONTEXT_OVERRIDES: each entry is evidence of a missing upstream filter.
      //   A recurring entry after its "fix" means the fix landed at the wrong stage.
      // ────────────────────────────────────────────────────────────────────────────────────
      const validateAndAdd = async (track, recommendedSong, platform) => {
        if (seenTrackIds.has(track.id)) {
          console.log(`Skipping duplicate: "${track.name}" by ${track.artists?.[0]?.name || track.artist}`);
          return false;
        }
        if (excludeTrackIds.has(track.id)) {
          console.log(`Skipping "${track.name}" by ${track.artists?.[0]?.name || track.artist} (already in playlist)`);
          return false;
        }
        if (playlistSongHistory.size > 0) {
          const historyKey = `${normalizeTrackName(track.name)}|||${(track.artists?.[0]?.name || track.artist || '').toLowerCase()}`;
          if (playlistSongHistory.has(historyKey)) {
            console.log(`[MANUAL-REFRESH] Skipping "${track.name}" by ${track.artists?.[0]?.name || track.artist} (previously in playlist)`);
            return false;
          }
        }
        // Excluded artists check — hard filter for "no [artist]" constraints.
        // Checks ALL credited artists on the track, not just the primary, so featured
        // appearances (e.g. "Song (feat. Phoebe Bridgers)") are also caught.
        const _excludedArtistNorms = (genreData.artistConstraints?.excludedArtists || [])
          .map(a => a.toLowerCase().replace(/[^a-z0-9]/g, ''));
        if (_excludedArtistNorms.length > 0) {
          const _allTrackArtistNorms = [
            ...(track.artists || []).map(a => (a.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')),
            (track.artist || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
          ].filter(Boolean);
          const _matchedEx = _excludedArtistNorms.find(ex =>
            _allTrackArtistNorms.some(norm => norm === ex || norm.includes(ex) || ex.includes(norm))
          );
          if (_matchedEx) {
            console.log(`[EXCLUDE] Skipping "${track.name}" by ${track.artists?.map(a=>a.name).join(', ') || track.artist} (excluded: ${_matchedEx})`);
            return false;
          }
        }
        if (!allowExplicit && track.explicit) {
          console.log(`Skipping explicit track: "${track.name}" by ${track.artists?.[0]?.name || track.artist}`);
          return false;
        }
        if (_isEventMode && track.popularity !== undefined && track.popularity < 70) {
          console.log(`[EVENT] Skipping low-popularity track: "${track.name}" (${track.popularity})`);
          return false;
        }
        if (eraMin || eraMax) {
          const isCompilation = track.album?.album_type === 'compilation';
          const spotifyYear = track.album?.release_date ? parseInt(track.album.release_date.substring(0, 4)) : null;
          const appleYear = (track.releaseDate || track.album?.release_date)
            ? parseInt((track.releaseDate || track.album?.release_date).substring(0, 4)) : null;
          const scYear = recommendedSong.releaseDate ? parseInt(recommendedSong.releaseDate.substring(0, 4)) : null;
          const isrcYear = extractIsrcYear(recommendedSong.isrc);
          const platformYear = platform === 'apple' ? appleYear : spotifyYear;
          const candidateYears = isCompilation ? [isrcYear, scYear] : [isrcYear, scYear, platformYear];
          const years = candidateYears.filter(y => y !== null);
          if (years.length === 0) {
            console.log(`[ERA] Skipping "${track.name}" by ${track.artists?.[0]?.name || track.artist} (no release year data)`);
            return false;
          }
          const releaseYear = Math.min(...years);
          if (eraMin && releaseYear < eraMin) {
            console.log(`[ERA] Skipping "${track.name}" by ${track.artists?.[0]?.name || track.artist} (${releaseYear} < ${eraMin})`);
            return false;
          }
          if (eraMax && releaseYear > eraMax) {
            console.log(`[ERA] Skipping "${track.name}" by ${track.artists?.[0]?.name || track.artist} (${releaseYear} > ${eraMax})`);
            return false;
          }
        }
        // Hard-filter sped-up/slowed/nightcore variants — almost never desired in a curated playlist
        {
          const _badVariants = ['sped up', 'speed up', 'slowed', 'nightcore', 'sped-up'];
          const _tnl = track.name.toLowerCase();
          if (_badVariants.some(v => _tnl.includes(v))) {
            console.log(`[VERSION] Skipping unwanted variant: "${track.name}"`);
            return false;
          }
        }
        const normalizedName = normalizeTrackName(track.name);
        const songSignature = `${(track.artists?.[0]?.name || track.artist || '').toLowerCase()}:${normalizedName}`;
        if (seenSongSignatures.has(songSignature) && !isUniqueVariation(track.name)) {
          console.log(`Skipping duplicate song: "${track.name}" by ${track.artists?.[0]?.name || track.artist}`);
          return false;
        }
        const maxPerArtist = genreData.trackConstraints?.artistDiversity?.maxPerArtist;
        if (maxPerArtist !== null && maxPerArtist !== undefined) {
          const artistKey = (track.artists?.[0]?.name || track.artist || '').toLowerCase();
          const currentCount = artistTrackCount.get(artistKey) || 0;
          if (currentCount >= maxPerArtist) {
            console.log(`[ARTIST-LIMIT] Skipping "${track.name}" by ${track.artists?.[0]?.name || track.artist} (${currentCount}/${maxPerArtist} per artist)`);
            return false;
          }
          artistTrackCount.set(artistKey, currentCount + 1);
        }
        seenTrackIds.add(track.id);
        seenSongSignatures.set(songSignature, track.name);
        const externalUrl = track.url || track.external_urls?.spotify ||
          (platform === 'apple' ? `https://music.apple.com/us/song/${track.id}` : null);
        allTracks.push({
          ...track,
          artist: track.artists?.[0]?.name || track.artist || 'Unknown Artist',
          image: track.album?.images?.[0]?.url || null,
          externalUrl,
          _phaseLabel: recommendedSong._phaseLabel || null,
          _phaseIndex: recommendedSong._phaseIndex ?? null,
          _source: recommendedSong.source || null,
          _scEnergy: recommendedSong._scEnergy ?? null,
        });
        const _srcTag = recommendedSong.source ? `[${recommendedSong.source}]` : '[unknown-source]';
        const _energyTag = recommendedSong._scEnergy != null ? ` [energy: ${recommendedSong._scEnergy.toFixed(2)}]` : '';
        console.log(`✓ Pool: ${_srcTag} "${track.name}" by ${track.artists?.[0]?.name || track.artist}${_energyTag}`);
        return true;
      };

      // ── Spotify-direct top tracks for reference artists with wrong/missing SC profile ──
      // These artists were filtered out of recommendedTracks above; we fetch their actual
      // top tracks from Spotify instead of relying on the mismatched SC artist profile.
      if (platform === 'spotify' && nosimilarWithSpotify.size > 0) {
        // In refresh context, reference artists (e.g. Keffer) are style hints, not playlist members.
        // Only inject their top tracks if they're actually in the playlist being refreshed.
        const _isRefreshContext = existingPlaylistData?.tracks?.length > 0;
        const _playlistArtistSet = _isRefreshContext
          ? new Set(existingPlaylistData.tracks.map(t => (t.artist || '').toLowerCase()))
          : null;

        for (const artistLower of nosimilarWithSpotify) {
          if (_isRefreshContext && _playlistArtistSet && !_playlistArtistSet.has(artistLower)) {
            console.log(`🔒 [SPOTIFY-DIRECT] Skipping "${artistLower}" in refresh context — reference artist, not in playlist`);
            continue;
          }
          const spotifyArtistId = confirmedSpotifyArtistIds[artistLower];
          if (!spotifyArtistId) continue;
          const artistDisplay = referenceSongs0.find(r => r.artist.toLowerCase() === artistLower)?.artist || artistLower;
          try {
            console.log(`🎵 [SPOTIFY-DIRECT] Fetching top tracks for "${artistDisplay}" (${spotifyArtistId})...`);
            const topTracksRes = await userSpotifyApi.getArtistTopTracks(spotifyArtistId, 'US');
            const topTracks = (topTracksRes.body.tracks || []).slice(0, 5); // cap at 5 to preserve pool diversity
            console.log(`  → using ${topTracks.length} top tracks for "${artistDisplay}"`);
            for (const t of topTracks) {
              const syntheticSong = {
                track: t.name, artist: artistDisplay,
                isrc: t.external_ids?.isrc || null,
                releaseDate: t.album?.release_date || null,
              };
              await validateAndAdd(t, syntheticSong, platform);
            }
          } catch (err) {
            console.log(`⚠️  [SPOTIFY-DIRECT] Failed for "${artistDisplay}": ${err.message}`);
          }
        }
      }

      // Retry wrapper and error formatter — shared by Spotify and Apple Music search loops.
      // Defined here (outside the platform branch) so both branches can reference them.
      const withSearchRetry = async (fn, label, maxRetries = 2) => {
        for (let attempt = 0; attempt <= maxRetries; attempt++) {
          try {
            return await fn();
          } catch (err) {
            const isRateLimit = err?.statusCode === 429 || err?.message?.error?.status === 429;
            if (isRateLimit && attempt < maxRetries) {
              const delay = (attempt + 1) * 1500;
              console.log(`⏳ Rate limited searching "${label}", retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries})`);
              await new Promise(r => setTimeout(r, delay));
              continue;
            }
            throw err;
          }
        }
      };
      const formatSearchError = (err) => {
        if (err?.statusCode) return `HTTP ${err.statusCode}`;
        if (typeof err?.message === 'string') return err.message;
        if (typeof err?.message === 'object') return JSON.stringify(err.message);
        return String(err);
      };

      // Collect 20% more tracks than needed when vibe check will run, so it has a buffer
      // to trim bad tracks without falling back to supplement. Mirrors the selectionTarget
      // logic at line ~7828 — keep in sync if that formula changes.
      const _hasVibeReqs = (genreData.atmosphere.length > 0 || genreData.contextClues.useCase || genreData.era.decade || genreData.subgenre || genreData.trackConstraints.popularity.preference === 'underground' || genreData.energyTarget || genreData.mood || (genreData.contextClues.avoidances || []).length > 0 || genreData.genreAccessibility === 'newcomer' || (genreData.artistConstraints?.vocalGender && genreData.artistConstraints.vocalGender !== 'any'));
      const _earlyStopTarget = _hasVibeReqs && !_phases ? Math.ceil(songCount * 1.2) : songCount;
      console.log(`🎯 Track collection target: ${_earlyStopTarget} (songCount=${songCount}, vibeBuffer=${_hasVibeReqs && !_phases})`);

      if (platform === 'spotify') {

        // Per-song Spotify lookup (runs in parallel within each batch)
        const findSpotifyTrack = async (recommendedSong) => {
          const label = `"${recommendedSong.track}" by ${recommendedSong.artist}`;

          // 1st: ISRC exact match
          if (recommendedSong.isrc) {
            const result = await Promise.race([
              userSpotifyApi.searchTracks(`isrc:${recommendedSong.isrc}`, { limit: 5 }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), 5000))
            ]);
            const items = result.body.tracks.items;
            if (items.length > 0) {
              console.log(`🔑 [ISRC] ${label}`);
              return { track: items[0], usedExact: true };
            }
            console.log(`⚠️  [ISRC-MISS] ${label} — ISRC ${recommendedSong.isrc} returned no results, trying fallback`);
          }

          // 2nd: direct Spotify ID from SC identifiers (pre-fetched in Phase A)
          if (recommendedSong.platformId) {
            const result = await Promise.race([
              userSpotifyApi.getTrack(recommendedSong.platformId),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Track lookup timeout')), 5000))
            ]);
            if (result.body?.id) {
              console.log(`🎯 [SC-ID] ${label} → ${recommendedSong.platformId}`);
              return { track: result.body, usedExact: true };
            }
          }

          // 3rd: text search fallback
          const result = await Promise.race([
            userSpotifyApi.searchTracks(`track:${recommendedSong.track} artist:${recommendedSong.artist}`, { limit: 5 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), 5000))
          ]);
          const items = result.body.tracks.items;
          if (items.length === 0) {
            console.log(`❌ [TEXT-EMPTY] ${label} — Spotify returned 0 results`);
            return null;
          }

          // Text search: find a track that matches the requested artist (check all artists, not just primary)
          const requestedArtistNorm = recommendedSong.artist.toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const t of items) {
            const artistMatch = (t.artists || []).some(a => {
              const fn = (a.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
              return requestedArtistNorm.length < 6 ? fn === requestedArtistNorm : fn === requestedArtistNorm || fn.startsWith(requestedArtistNorm) || requestedArtistNorm.startsWith(fn);
            });
            if (artistMatch) {
              // Resolution divergence check: verify SC source artist appears in the PRIMARY
              // Spotify artist. Catches branded/compilation tracks where a known artist is
              // secondary but an unrelated entity is listed as primary (e.g. "FIFA Sound"
              // when SC source is "DJ Luian").
              // Token overlap on primary only — "DJ Luian" on "DJ Luian, Amenazzy" primary
              // passes; "DJ Luian" on "FIFA Sound" primary fails.
              const _primaryArtist = (t.artists?.[0]?.name || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ');
              const _scSourceTokens = recommendedSong.artist.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(tok => tok.length > 2);
              // Fallback: when tokenizer produces nothing (e.g. "H.E.R." → ["h","e","r"] → filtered to []),
              // use the full normalized name so the divergence check always runs.
              const _scSourceNorm = recommendedSong.artist.toLowerCase().replace(/[^a-z0-9]/g, '');
              const _tokensToCheck = _scSourceTokens.length > 0 ? _scSourceTokens : (_scSourceNorm ? [_scSourceNorm] : []);
              if (_tokensToCheck.length > 0) {
                const _primaryTokens = _primaryArtist.split(/\s+/);
                const _primaryNormFull = _primaryArtist.replace(/\s+/g, '');
                const _hasPrimaryOverlap = _tokensToCheck.some(tok =>
                  _primaryTokens.some(pt => pt === tok || pt.startsWith(tok) || tok.startsWith(pt)) ||
                  _primaryNormFull === tok || _primaryNormFull.startsWith(tok) || tok.startsWith(_primaryNormFull)
                );
                if (!_hasPrimaryOverlap) {
                  console.log(`❌ [ARTIST-DIVERGENCE] "${t.name}" — SC source "${recommendedSong.artist}" not in Spotify primary "${t.artists?.[0]?.name}" — trying next result`);
                  continue;
                }
              }
              console.log(`🔍 [TEXT] ${label}`);
              return { track: t, usedExact: false };
            }
          }
          const topResults = items.slice(0, 3).map(t => `"${t.name}" by ${t.artists?.[0]?.name}`).join(', ');
          console.log(`❌ [TEXT-MISMATCH] ${label} — top Spotify results: ${topResults}`);
          return null;
        };

        // ── Phase B: batched parallel Spotify lookups ──
        for (let i = 0; i < recommendedTracks.length && allTracks.length < _earlyStopTarget; i += BATCH_SIZE) {
          const batch = recommendedTracks.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(batch.map(async (recommendedSong) => {
            try {
              const found = await withSearchRetry(() => findSpotifyTrack(recommendedSong), recommendedSong.track);
              return { recommendedSong, found };
            } catch (err) {
              console.log(`Error searching for "${recommendedSong.track}": ${formatSearchError(err)}`);
              return { recommendedSong, found: null };
            }
          }));

          for (const { recommendedSong, found } of batchResults) {
            if (allTracks.length >= _earlyStopTarget) break;
            if (!found) { console.log(`✗ Could not find: "${recommendedSong.track}" by ${recommendedSong.artist}`); continue; }

            let { track } = found;

            // Verify confirmed Spotify artist ID (catches same-name artist collisions)
            if (!found.usedExact) {
              const confirmedSpotifyId = confirmedSpotifyArtistIds[recommendedSong.artist.toLowerCase()];
              if (confirmedSpotifyId) {
                const trackArtistId = track.artists?.[0]?.id;
                if (trackArtistId && trackArtistId !== confirmedSpotifyId) {
                  console.log(`✗ "${recommendedSong.track}" by ${recommendedSong.artist} — wrong Spotify artist`);
                  continue;
                }
              }
            }

            if (!await validateAndAdd(track, recommendedSong, 'spotify')) continue;
            if (allTracks.length >= _earlyStopTarget) { console.log(`🎯 Early stop: reached ${_earlyStopTarget} matched Spotify tracks`); break; }
          }
        }

      } else if (platform === 'apple') {
        const platformService = new PlatformService();
        const storefront = tokens.storefront || 'us';
        const appleMusicDevTokenForSearch = generateAppleMusicToken();
        const appleMusicApiForSearch = appleMusicDevTokenForSearch ? new AppleMusicService(appleMusicDevTokenForSearch) : null;

        // Per-song Apple Music lookup (runs in parallel within each batch)
        const findAppleTrack = async (recommendedSong) => {
          // 1st: ISRC exact match
          if (recommendedSong.isrc && appleMusicApiForSearch) {
            try {
              const result = await appleMusicApiForSearch.lookupByIsrc(recommendedSong.isrc, storefront);
              if (result) return { track: result, usedExact: true };
            } catch (isrcErr) {
              console.log(`ISRC lookup failed for ${recommendedSong.isrc}, falling back`);
            }
          }

          // 2nd: direct Apple Music ID from SC identifiers (pre-fetched in Phase A)
          if (recommendedSong.platformId && appleMusicApiForSearch) {
            try {
              const result = await appleMusicApiForSearch.getTrack(recommendedSong.platformId, storefront);
              if (result) {
                console.log(`🎯 SC identifiers match: "${recommendedSong.track}" by ${recommendedSong.artist} → ${recommendedSong.platformId}`);
                return { track: result, usedExact: true };
              }
            } catch (idErr) {
              console.log(`⚠️  Direct Apple Music ID lookup failed for ${recommendedSong.platformId}: ${idErr.message}`);
            }
          }

          // 3rd: text search fallback
          const searchQuery = `${recommendedSong.track} ${recommendedSong.artist}`;
          const items = await platformService.searchTracks(platformUserId, searchQuery, tokens, storefront, 5);
          if (!items || items.length === 0) return null;

          const requestedArtistNorm = recommendedSong.artist.toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const t of items) {
            const foundArtistNorm = (t.artists?.[0]?.name || t.artist || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            if (requestedArtistNorm.length < 6) {
              if (foundArtistNorm === requestedArtistNorm) return { track: t, usedExact: false };
            } else {
              if (foundArtistNorm === requestedArtistNorm ||
                  foundArtistNorm.startsWith(requestedArtistNorm) ||
                  requestedArtistNorm.startsWith(foundArtistNorm)) return { track: t, usedExact: false };
            }
          }
          return null;
        };

        // ── Phase B: batched parallel Apple Music lookups ──
        for (let i = 0; i < recommendedTracks.length && allTracks.length < _earlyStopTarget; i += BATCH_SIZE) {
          const batch = recommendedTracks.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(batch.map(async (recommendedSong) => {
            try {
              const found = await withSearchRetry(() => findAppleTrack(recommendedSong), recommendedSong.track);
              return { recommendedSong, found };
            } catch (err) {
              console.log(`Error searching for "${recommendedSong.track}": ${formatSearchError(err)}`);
              return { recommendedSong, found: null };
            }
          }));

          for (const { recommendedSong, found } of batchResults) {
            if (allTracks.length >= _earlyStopTarget) break;
            if (!found) { console.log(`✗ Could not find: "${recommendedSong.track}" by ${recommendedSong.artist}`); continue; }

            if (!await validateAndAdd(found.track, recommendedSong, 'apple')) continue;
            if (allTracks.length >= _earlyStopTarget) { console.log(`🎯 Early stop: reached ${_earlyStopTarget} matched Apple Music tracks`); break; }
          }
        }
      }

      console.log(`📊 Successfully found ${allTracks.length} out of ${recommendedTracks.length} SoundCharts-discovered songs`);

      if (allTracks.length >= 5) {
        let selectedTracks = [...allTracks];

        // CATALOG-OVERRIDE — apply context overrides before vibe check (mirrors Path B step 3.5)
        if (selectedTracks.length > 0) {
          const _pathAUseCase = (genreData.contextClues?.useCase || '').toLowerCase();
          const _pathAMood = genreData.mood;
          const _pathAEnergy = genreData.energyTarget;
          const _pathABefore = selectedTracks.length;
          selectedTracks = selectedTracks.filter(track => {
            const key = `${(track.artist || '').toLowerCase()}::${(track.name || '').toLowerCase()}`;
            const override = TRACK_CONTEXT_OVERRIDES[key];
            if (!override) return true;
            const moodOk = !_pathAMood || override.requiredMoods.includes(_pathAMood);
            const energyOk = !_pathAEnergy || override.requiredEnergies.includes(_pathAEnergy);
            const useCaseBlocked = _pathAUseCase && (override.blockedUseCases || []).includes(_pathAUseCase);
            if (useCaseBlocked || !moodOk || !energyOk) {
              console.log(`🚫 [CATALOG-OVERRIDE] Removing "${track.name}" by ${track.artist} — ${override.reason}`);
              return false;
            }
            return true;
          });
          if (selectedTracks.length < _pathABefore) {
            console.log(`🚫 [CATALOG-OVERRIDE] Removed ${_pathABefore - selectedTracks.length} track(s) via context overrides`);
          }
        }

        // Vibe check — only run when we actually have tracks to review
        if (selectedTracks.length >= 5) {

        const hasAvoidances = genreData.contextClues.avoidances && genreData.contextClues.avoidances.length > 0;
        const wantsUndergroundFilter = genreData.trackConstraints.popularity.preference === 'underground' ||
                                        (genreData.trackConstraints.popularity.max !== null &&
                                         genreData.trackConstraints.popularity.max !== undefined &&
                                         genreData.trackConstraints.popularity.max <= 50);

        console.log(`🎭 Running vibe check on ${selectedTracks.length} tracks...`);

        // Build constraint lines for the prompt
        const constraintLines = [];
        if (genreData.primaryGenre) constraintLines.push(`Genre: ${genreData.primaryGenre}`);
        if (genreData.style) constraintLines.push(`Style/Vibe: ${genreData.style}`);
        if (genreData.atmosphere?.length > 0) constraintLines.push(`Atmosphere: ${genreData.atmosphere.join(', ')}`);
        if (genreData.contextClues.useCase) constraintLines.push(`Use case: ${genreData.contextClues.useCase}`);
        // UseCase hard rules — mirror the Sonnet vibe check rules so this fast Haiku pass
        // catches the same contextual mismatches (it only sees "Use case: summer" otherwise,
        // which is too vague to catch emotionally mismatched tracks in the right genre).
        {
          const _fastUc = (genreData.contextClues.useCase || '').toLowerCase();
          const _fastHardRules = {
            summer:      'SUMMER — HARD RULE: REMOVE any track that is slow, mellow, low-energy, melancholic, anxious, or emotionally heavy. No breakup ballads, no late-night sad R&B, no emotionally heavy slow jams. Examples that are WRONG: "A Lonely Night" (The Weeknd), "30 For 30" (SZA), "\'tis the damn season" (Taylor Swift), "8" (Billie Eilish), "All I Want" (Olivia Rodrigo), "All This Madness" (Sam Smith), "Someone You Loved" (Lewis Capaldi). Every track must feel warm, bright, and carefree.',
            party:       'PARTY/PREGAME — HARD RULE: REMOVE any track that is mid-tempo, emotional, melancholic, or would not work on a dancefloor — even if the artist is generally upbeat. Test: would a DJ play this to keep a crowd dancing? If not, remove it.',
            workout:     'WORKOUT — HARD RULE: REMOVE any slow, emotional, sad, mellow, or mid-tempo songs. Every track must be pump-up and high-energy. If it would not make you want to sprint, cut it.',
            focus:       'FOCUS/STUDY — HARD RULE: REMOVE any high-energy, hype, aggressive, or distracting track. Only calm, background-friendly music.',
            sleep:       'SLEEP — HARD RULE: REMOVE anything with a strong beat, energetic production, or that could keep someone awake.',
            heartbreak:  'HEARTBREAK/SAD — HARD RULE: This is a sad, emotional, late-night playlist. KEEP any track that is melancholic, introspective, emotional, vulnerable, or bittersweet — even if the title sounds positive (e.g. "Good Days", "Best Part", "Godspeed" are all deeply emotional songs that BELONG here). ONLY remove tracks that are clearly high-energy, upbeat, celebratory, or would be out of place in a late-night feelings session (e.g. hype rap, dance-pop bangers, aggressive production). When in doubt, KEEP the track.',
          };
          if (_fastHardRules[_fastUc]) constraintLines.push(_fastHardRules[_fastUc]);
        }
        if (eraMin || eraMax) {
          const eraDesc = eraMin && eraMax ? `${eraMin}–${eraMax}` : eraMin ? `${eraMin} or later` : `${eraMax} or earlier`;
          constraintLines.push(`Era: songs must be from ${eraDesc}. REMOVE any song originally recorded/released outside this range, even if it was recently repackaged or re-released.`);
        }
        if (hasAvoidances) constraintLines.push(`AVOID: ${genreData.contextClues.avoidances.join(', ')}`);
        if (wantsUndergroundFilter) constraintLines.push(`Popularity: UNDERGROUND/INDIE only — remove mainstream chart artists`);
        const _fastVocalGender = genreData.artistConstraints?.vocalGender;
        if (_fastVocalGender === 'female') constraintLines.push(`GENDER — HARD RULE: This playlist requires FEMALE artists only. REMOVE any track by a male solo artist, male rapper, or male-fronted band. No exceptions — even if the music fits the vibe perfectly.`);
        if (_fastVocalGender === 'male') constraintLines.push(`GENDER — HARD RULE: This playlist requires MALE artists only. REMOVE any track by a female solo artist or female-fronted band. No exceptions.`);

        const seedArtistNames = hasRequestedArtists && !genreData.artistConstraints.exclusiveMode
          ? genreData.artistConstraints.requestedArtists
          : [];
        if (seedArtistNames.length > 0) {
          constraintLines.push(`Reference artists: ${seedArtistNames.join(', ')}. Remove any artist who clearly does not belong in the same musical scene (different era, unrelated genre, or totally different sound world).`);
        }

        // Attach known release year, featured artists, and SC energy to each track entry
        const trackLines = selectedTracks.map((t, i) => {
          const yr = t.releaseYear || (t.album?.release_date ? parseInt(t.album.release_date.substring(0, 4)) : null);
          const energyStr = t._scEnergy != null ? ` [energy: ${t._scEnergy.toFixed(2)}]` : '';
          // Include featured/additional artists so Claude has full collaboration context
          // e.g. "Fancy" by Drake becomes "Fancy" by Drake ft. T.I., Swizz Beatz
          const extraArtists = t.artists && t.artists.length > 1
            ? t.artists.slice(1).map(a => a.name).join(', ')
            : null;
          const artistStr = extraArtists ? `${t.artist} ft. ${extraArtists}` : t.artist;
          return `${i + 1}. "${t.name}" by ${artistStr}${yr ? ` (${yr})` : ''}${energyStr}`;
        });

        // Add energy-based guidance when SC energy data is present for at least some tracks
        const tracksWithEnergy = selectedTracks.filter(t => t._scEnergy != null);
        if (tracksWithEnergy.length > 0) {
          const _fastUcForEnergy = genreData.contextClues?.useCase;
          const energyGuidance = {
            heartbreak: 'Energy scores (0–1) are from audio analysis. For this sad/late-night playlist, tracks with energy > 0.75 are almost certainly wrong vibe — flag them unless lyrics/title are clearly melancholic.',
            sleep:      'Energy scores (0–1) are from audio analysis. For sleep music, any track with energy > 0.4 is likely too stimulating.',
            focus:      'Energy scores (0–1) are from audio analysis. For focus/study, tracks with energy > 0.7 are likely too distracting.',
            workout:    'Energy scores (0–1) are from audio analysis. For a workout playlist, tracks with energy < 0.5 are likely too low-energy.',
            party:      'Energy scores (0–1) are from audio analysis. For a party/pregame playlist, tracks with energy < 0.55 are likely too mellow for a dancefloor.',
            summer:     'Energy scores (0–1) are from audio analysis. For a summer playlist, tracks with energy < 0.45 are likely too slow/mellow.',
          };
          if (energyGuidance[_fastUcForEnergy]) {
            constraintLines.push(energyGuidance[_fastUcForEnergy]);
          } else {
            constraintLines.push('Energy scores (0–1) shown in [brackets] are from audio analysis — use them as an additional signal when a track feels like a vibe mismatch.');
          }
        }

        try {
          const vibeCheckResponse = await anthropic.messages.create({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 800,
            messages: [{
              role: 'user',
              content: `You are doing a final quality check on a playlist to make sure every song truly matches what the user asked for.

User's full request (including any refinements): "${prompt}"

Constraints that every song must satisfy:
${constraintLines.map(l => `- ${l}`).join('\n')}
${existingPlaylistTracks.length > 0 ? `\nExisting songs in this playlist (use as style reference — new songs should fit alongside these):\n${existingPlaylistTracks.map(s => `- ${s}`).join('\n')}` : ''}
Songs to review:
${trackLines.join('\n')}

Return ONLY a JSON array of 1-based indices to KEEP — no explanation.

Rules:
- KEEP songs that genuinely match the user's request and all constraints above.
- REMOVE songs that clearly violate any constraint (wrong era, wrong genre, wrong vibe, explicitly avoided).
- When uncertain about a song, KEEP it. Only remove songs you are confident are mismatches.
- Aim to keep at least 75% of tracks. Do not over-filter.

Example response: [1, 2, 4, 5, 7, ...]`
            }]
          });

          const vibeContent = vibeCheckResponse.content[0].text.trim()
            .replace(/^```json\n?/, '').replace(/\n?```$/, '')
            .replace(/^```\n?/, '').replace(/\n?```$/, '');

          const keepMatch = vibeContent.match(/\[[\d,\s]*\]/);
          if (keepMatch) {
            const keepIndices = JSON.parse(keepMatch[0]);
            const filteredTracks = keepIndices
              .map(idx => selectedTracks[idx - 1])
              .filter(t => t !== undefined);

            // For melancholic/heartbreak playlists the risk is almost exclusively upbeat songs
            // sneaking in — never missing sad ones. Raise the floor to 85% so Haiku can only
            // cut 15% of tracks, preventing good songs like "White Ferrari" / "Nights" being
            // removed because their titles don't signal sadness clearly enough.
            const _isMelancholic = genreData.mood === 'melancholic' || (genreData.contextClues?.useCase || '') === 'heartbreak';
            const minKeep = Math.ceil(selectedTracks.length * (_isMelancholic ? 0.85 : 0.75));
            const finalTracks = filteredTracks.length >= minKeep
              ? filteredTracks
              : selectedTracks.slice(0, Math.max(filteredTracks.length, minKeep));
            if (finalTracks.length >= 5) {
              const finalIds = new Set(finalTracks.map(t => t.id));
              const removedTracks = selectedTracks.filter(t => !finalIds.has(t.id));
              if (removedTracks.length > 0) {
                console.log(`✂️ Vibe check (fast) removed ${removedTracks.length} mismatched tracks:`);
                removedTracks.forEach(t => {
                  const _rsrc = t._source || 'unknown-source';
                  const _ren = t._scEnergy != null ? ` energy: ${t._scEnergy.toFixed(2)}` : ' energy: n/a';
                  console.log(`  ❌ VIBE_CHECK removed: "${t.name}" by ${t.artist} [source: ${_rsrc},${_ren}]`);
                });
              }
              selectedTracks = finalTracks;
            }
          }
        } catch (error) {
          console.log('Vibe check failed, using tracks as-is:', error.message);
        }
        } // end if (selectedTracks.length >= 5)


        // Return the final tracks
        selectedTracks = selectedTracks.slice(0, songCount);
        console.log(`🎯 Returning ${selectedTracks.length} tracks`);

        // Only take the early return if we have enough tracks — otherwise fall through to fallback.
        if (selectedTracks.length >= Math.min(songCount, 15)) {
          // Helper: normalized key used by the final dedup (mirrors logic at end of this block).
          // Pre-populate from already-selected tracks so supplement/gap fill don't add
          // variant titles (e.g. "BATTER UP" when "BATTER UP (7 ver.)" is already chosen)
          // that would be silently removed by the final dedup, leaving the count short.
          const _normTitle = (t) => (t || '').toLowerCase()
            .replace(/\s*[\(\[].*?[\)\]]/g, '')
            .replace(/\s*-\s*(remix|edit|mix|version|live|acoustic|instrumental|sped.?up|slowed|karaoke|radio|extended|remaster).*$/i, '')
            .replace(/\s+/g, ' ').trim();
          const _normArtist = (a) => (a || '').toLowerCase()
            .split(/\s*(?:feat\.|ft\.|featuring)\s*/i)[0]
            .split(/\s*&\s*/)[0].trim();
          const seenNormKeys = new Set(selectedTracks.map(t => `${_normTitle(t.name)}::${_normArtist(t.artist)}`));

          // _suppUseCase hoisted here so the CATALOG-OVERRIDE check inside the supplement loop can reference it
          const _suppUseCase = genreData.contextClues.useCase;

          // Supplement with more songs if short of target.
          const _preSupplementCount = selectedTracks.length;
          if (selectedTracks.length < songCount && process.env.SOUNDCHARTS_APP_ID) {
            const needed = songCount - selectedTracks.length;
            console.log(`🔁 Supplementing: need ${needed} more tracks to reach ${songCount}`);
            try {
              // Re-run artist-similarity discovery with relaxed constraints (no mood/theme filters)
              // to pull in more songs that weren't surfaced by the stricter primary pass.
              // Seed from artists already in the playlist — so supplement expands the playlist's
              // own internal graph, not the user's listening history.
              const playlistArtists = [...new Set(selectedTracks.map(t => t.artist).filter(Boolean))];
              // Cap supplement seeds at 5 — using all playlist artists causes depth-2 expansion
              // to balloon to 60+ artists and 500 songs each, which is overkill for a few missing tracks.
              const seedArtistsForSupplement = (playlistArtists.length > 0
                ? playlistArtists.slice(0, 5)
                : (genreData.artistConstraints.requestedArtists?.length > 0
                  ? genreData.artistConstraints.requestedArtists.slice(0, 5)
                  : (genreData.artistConstraints.suggestedSeedArtists || []).slice(0, 5)));

              // Build a relaxed query (genre + era only, no mood) using the new direct endpoint.
              // Include suggestedSeedArtists so the 403 fallback has artists to pull from.
              const supplementGenreData = {
                primaryGenre: genreData.primaryGenre,
                atmosphere: [],          // relaxed — no SC atmosphere/theme filter (mood + energy still enforced)
                era: genreData.era,
                mood: genreData.mood,              // inherit — energy/mood are non-negotiable
                energyTarget: genreData.energyTarget,
                trackConstraints: {},    // relaxed — no popularity filter
                artistConstraints: {
                  exclusiveMode: false,
                  requestedArtists: seedArtistsForSupplement,
                  suggestedSeedArtists: []
                }
              };
              const supplementQuery = buildSoundchartsQuery(supplementGenreData, allowExplicit);
              // Disable depth-2 expansion for supplement — we only need a few tracks,
              // depth-2 multiplies the artist pool dramatically for no benefit here.
              supplementQuery.expandToSimilar = false;

              // Request a larger pool so we have more candidates to match against
              const suppMinArtists = maxPerArtist ? Math.min(Math.ceil(needed / maxPerArtist * 1.5), 40) : 0;
              let supplementPool = await executeSoundChartsStrategy(supplementQuery, Math.max(needed * 4, 60), confirmedArtistUuids, suppMinArtists);
              console.log(`🔁 Supplement pool: ${supplementPool.length} songs`);

              // Genre validation: filter supplement pool by Spotify artist genres to block
              // SC genre mislabels (e.g. Amy Winehouse, Arctic Monkeys tagged as R&B).
              if (genreData.primaryGenre && supplementPool.length > 0) {
                const suppArtistNames = [...new Set(supplementPool.map(s => s.artistName).filter(Boolean))];
                const suppGenreMap = await batchGetSpotifyArtistGenres(suppArtistNames).catch(() => new Map());
                const beforeSupp = supplementPool.length;
                supplementPool = supplementPool.filter(s => {
                  const spGenres = suppGenreMap.get((s.artistName || '').toLowerCase()) || null;
                  return isArtistInGenreFamily(spGenres, genreData.primaryGenre);
                });
                if (supplementPool.length < beforeSupp) {
                  console.log(`🎯 Supplement genre filter: ${beforeSupp} → ${supplementPool.length} songs (Spotify validation)`);
                }
              }

              const seenSupplementArtists = new Set();

              // Phase A: pre-fetch SC platform IDs for songs missing ISRC
              await prefetchPlatformIds(supplementPool, platform === 'spotify' ? 'spotify' : 'applemusic');

              // Set up Apple Music instances once (reused across all batches)
              const suppStorefront = tokens.storefront || 'us';
              const suppAppleDevToken = platform === 'apple' ? generateAppleMusicToken() : null;
              const suppAppleApi = suppAppleDevToken ? new AppleMusicService(suppAppleDevToken) : null;
              const suppPlatformSvc = platform === 'apple' ? new PlatformService() : null;

              // Phase B: parallel batches of 10
              for (let si = 0; si < supplementPool.length && selectedTracks.length < songCount; si += BATCH_SIZE) {
                const batch = supplementPool.slice(si, si + BATCH_SIZE).filter(song => {
                  if (!song.name?.trim()) return false;
                  return true;
                });
                const batchResults = await Promise.all(batch.map(song =>
                  findTrackOnPlatform(song, { storefront: suppStorefront, appleMusicApi: suppAppleApi, platformSvc: suppPlatformSvc })
                    .then(result => ({ song, result }))
                    .catch(() => ({ song, result: null }))
                ));
                for (const { song, result } of batchResults) {
                  if (selectedTracks.length >= songCount) break;
                  if (!result) continue;
                  const { track } = result;
                  if (seenTrackIds.has(track.id)) continue;
                  if (!allowExplicit && track.explicit) continue;
                  // Hard constraint: excluded artists — supplement bypasses validateAndAdd so we enforce here
                  {
                    const _suppExcludedNorms = (genreData.artistConstraints?.excludedArtists || []).map(a => a.toLowerCase().replace(/[^a-z0-9]/g, ''));
                    if (_suppExcludedNorms.length > 0) {
                      const _suppTrackArtistNorms = (track.artists || []).map(a => (a.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
                      const _suppArtistExcluded = _suppExcludedNorms.some(exNorm =>
                        _suppTrackArtistNorms.some(an => an && exNorm && (an === exNorm || an.startsWith(exNorm) || exNorm.startsWith(an)))
                      );
                      if (_suppArtistExcluded) {
                        console.log(`🚫 [SUPP-EXCLUDED] "${track.name}" by ${track.artists?.[0]?.name} — artist in exclusion list`);
                        continue;
                      }
                    }
                  }
                  const suppMaxPerArtist = genreData.trackConstraints?.artistDiversity?.maxPerArtist;
                  if (suppMaxPerArtist !== null && suppMaxPerArtist !== undefined) {
                    const ak = (track.artists?.[0]?.name || track.artist || '').toLowerCase();
                    if ((artistTrackCount.get(ak) || 0) >= suppMaxPerArtist) continue;
                    artistTrackCount.set(ak, (artistTrackCount.get(ak) || 0) + 1);
                  }
                  // Apply catalog context overrides before accepting supplement track
                  const _suppKey = `${(track.artists?.[0]?.name || track.artist || '').toLowerCase()}::${(track.name || '').toLowerCase()}`;
                  const _suppOverride = TRACK_CONTEXT_OVERRIDES[_suppKey];
                  if (_suppOverride) {
                    const _suppMoodOk = !genreData.mood || _suppOverride.requiredMoods.includes(genreData.mood);
                    const _suppEnergyOk = !genreData.energyTarget || _suppOverride.requiredEnergies.includes(genreData.energyTarget);
                    const _suppUcBlocked = _suppUseCase && (_suppOverride.blockedUseCases || []).includes(_suppUseCase);
                    if (_suppUcBlocked || !_suppMoodOk || !_suppEnergyOk) {
                      console.log(`🚫 [CATALOG-OVERRIDE/SUPP] Skipping "${track.name}" by ${track.artists?.[0]?.name || track.artist} — ${_suppOverride.reason}`);
                      continue;
                    }
                  }
                  const _suppNormKey = `${_normTitle(track.name)}::${_normArtist(track.artists?.[0]?.name || track.artist || '')}`;
                  if (seenNormKeys.has(_suppNormKey)) continue;
                  seenNormKeys.add(_suppNormKey);
                  seenTrackIds.add(track.id);
                  seenSupplementArtists.add((song.artistName || '').toLowerCase());
                  selectedTracks.push({
                    id: track.id, name: track.name,
                    artist: track.artists?.[0]?.name || track.artist || 'Unknown',
                    uri: track.uri,
                    album: track.album?.name || track.album,
                    image: track.album?.images?.[0]?.url || null,
                    previewUrl: track.preview_url,
                    externalUrl: track.url || track.external_urls?.spotify ||
                      (platform === 'apple' ? `https://music.apple.com/us/song/${track.id}` : null),
                    explicit: track.explicit || false, genres: []
                  });
                }
              }
              console.log(`🔁 After supplement: ${selectedTracks.length}/${songCount} tracks (${seenSupplementArtists.size} new artists added)`);
            } catch (suppFetchErr) {
              console.log('Supplement failed:', suppFetchErr.message);
            }
          }

          // Shared rule map for post-supplement and post-gap-fill vibe filters.
          // Generic rules only — no hardcoded track lists (those are in TRACK_CONTEXT_OVERRIDES).
          const _useCaseVibeRules = {
              workout:    'This playlist is for a workout. Only high-energy, pump-up tracks belong here. REMOVE any track that is slow, mellow, emotional, sad, or mid-tempo.',
              party:      'This playlist is for a party or pregame. Only tracks that work on a dancefloor belong here. REMOVE any track that is slow, emotional, mid-tempo, or melancholic — even if the artist is generally upbeat. Ask: would a DJ play this to keep a crowd dancing? If not, REMOVE it.',
              summer:     'This playlist is for summer vibes. REMOVE any track that is slow, melancholic, sad, emotionally heavy, or winter-coded.',
              chill:      'This playlist is for relaxing or chilling. REMOVE any track that is high-energy, aggressive, hype, or contextually jarring — rap/hip-hop that is not laid-back, loud EDM drops, or anything that would interrupt a low-energy listening session.',
              background: 'This playlist is for background listening (dinner, cooking, hosting). REMOVE any track that is high-energy, aggressive, or attention-demanding — only mellow, easy-going music that works in the background.',
              focus:      'This playlist is for focus or study. REMOVE any track that is high-energy, hype, aggressive, or attention-grabbing.',
              sleep:      'This playlist is for sleeping. REMOVE any track that is energetic, upbeat, or attention-grabbing.',
              heartbreak: 'This is a heartbreak/sad/late-night emotional playlist. REMOVE any track that is clearly upbeat, celebratory, high-energy, or would not fit a late-night feelings session. KEEP sad, melancholic, emotional, or introspective tracks even if the title sounds positive.',
            };
          const _suppNewCount = selectedTracks.length - _preSupplementCount;
          {
            // Collect all hard/binary constraint rules that apply to supplement tracks.
            // Supplement bypasses the main vibe check, so binary constraints must be re-enforced here.
            const _suppVocalGender = genreData.artistConstraints?.vocalGender;
            const _suppConstraintRules = [];
            if (_suppUseCase && _useCaseVibeRules[_suppUseCase]) _suppConstraintRules.push(_useCaseVibeRules[_suppUseCase]);
            if (_suppVocalGender === 'female') _suppConstraintRules.push('GENDER HARD RULE: REMOVE any track by a male solo artist, male rapper, or male-fronted band. Only female artists allowed. Examples to REMOVE: The Weeknd, Drake, GIVĒON, James Blake, dvsn, J. Cole.');
            if (_suppVocalGender === 'male') _suppConstraintRules.push('GENDER HARD RULE: REMOVE any track by a female solo artist or female-fronted band. Only male artists allowed.');
            if (_suppConstraintRules.length > 0 && _suppNewCount > 0) {
              const suppNewTracks = selectedTracks.slice(_preSupplementCount);
              console.log(`🔍 Post-supplement filter: checking ${suppNewTracks.length} new tracks (${_suppConstraintRules.length} rules)...`);
              try {
                const _suppFilterResp = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 300,
                  messages: [{
                    role: 'user',
                    content: `Rules (ALL must be enforced):\n${_suppConstraintRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Tracks to check:
${suppNewTracks.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist}`).join('\n')}

List the NUMBER of every track that violates ANY rule. If all tracks pass, respond "NONE".
IMPORTANT: Output ONLY comma-separated numbers or "NONE". No explanations, no track names, no reasoning. Examples of valid responses: "NONE" or "2" or "1, 3, 4".`
                  }]
                });
                const _suppFilterText = _suppFilterResp.content[0]?.text?.trim() || 'NONE';
                console.log(`��� Post-supplement filter: ${_suppFilterText}`);
                if (_suppFilterText.toUpperCase() !== 'NONE') {
                  // Use regex to extract standalone numbers — avoids picking up list markers like "1." or "2."
                  const _suppBadNums = (_suppFilterText.match(/(?<![.\d])(\d+)(?![.\d])/g) || []).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= suppNewTracks.length);
                  if (_suppBadNums.length > 0) {
                    const _suppBadIndices = new Set(_suppBadNums.map(n => _preSupplementCount + n - 1));
                    const _suppRemovedNames = [..._suppBadIndices].map(i => selectedTracks[i]).filter(Boolean).map(t => `"${t.name}" by ${t.artist}`);
                    console.log(`🔍 Post-supplement: removing ${_suppBadIndices.size} off-constraint tracks: ${_suppRemovedNames.join(', ')}`);
                    selectedTracks = selectedTracks.filter((_, i) => !_suppBadIndices.has(i));
                  }
                }
              } catch (suppFilterErr) {
                console.log('Post-supplement filter failed (non-fatal):', suppFilterErr.message);
              }
            }
          }

          // Gap fill: if still short after supplement, pull from top_songs (different pool)
          // _gfUseCase hoisted here so the CATALOG-OVERRIDE/GAP check inside the loop can reference it
          const _gfUseCase = genreData.contextClues.useCase;
          const _preGapFillCount = selectedTracks.length;
          if (selectedTracks.length < songCount && process.env.SOUNDCHARTS_APP_ID) {
            const gapNeeded = songCount - selectedTracks.length;
            console.log(`🔄 Gap fill: need ${gapNeeded} more tracks from top_songs`);
            try {
              // Seed from artists already in the playlist — same logic as supplement.
              // Reuse playlistArtists if available (supplement ran first), otherwise recompute.
              const _gfPlaylistArtists = typeof playlistArtists !== 'undefined' && playlistArtists.length > 0
                ? playlistArtists
                : [...new Set(selectedTracks.map(t => t.artist).filter(Boolean))];
              const gapSeedArtists = _gfPlaylistArtists.length > 0
                ? _gfPlaylistArtists
                : (genreData.artistConstraints.requestedArtists?.length > 0
                  ? genreData.artistConstraints.requestedArtists
                  : genreData.artistConstraints.suggestedSeedArtists || []);
              const gapGenreData = {
                primaryGenre: genreData.primaryGenre,
                atmosphere: [],
                era: genreData.era,
                mood: genreData.mood,              // inherit — prevents off-vibe global hits
                energyTarget: genreData.energyTarget,
                contextClues: {}, // omit useCase — theme filters (e.g. Sport) are too narrow and cause 0 results; energy/mood filters are sufficient
                // Preserve popularity preference so career stage filter applies
                // (prevents unrelated mainstream artists like Ed Sheeran appearing)
                trackConstraints: { popularity: genreData.trackConstraints?.popularity },
                artistConstraints: { exclusiveMode: false, requestedArtists: gapSeedArtists, suggestedSeedArtists: [] }
              };
              const gapQuery = buildSoundchartsQuery(gapGenreData, false, allowExplicit);
              const gfMinArtists = maxPerArtist ? Math.min(Math.ceil(gapNeeded / maxPerArtist * 1.5), 40) : 0;
              const gapPool = await executeSoundChartsStrategy(gapQuery, Math.max(gapNeeded * 5, 60), {}, gfMinArtists);
              console.log(`🔄 Gap fill pool: ${gapPool.length} top_songs candidates`);
              await prefetchPlatformIds(gapPool, platform === 'spotify' ? 'spotify' : 'applemusic');

              const gfStorefront = tokens.storefront || 'us';
              const gfAppleDevToken = platform === 'apple' ? generateAppleMusicToken() : null;
              const gfAppleApi = gfAppleDevToken ? new AppleMusicService(gfAppleDevToken) : null;
              const gfPlatformSvc = platform === 'apple' ? new PlatformService() : null;

              for (let gi = 0; gi < gapPool.length && selectedTracks.length < songCount; gi += BATCH_SIZE) {
                const batch = gapPool.slice(gi, gi + BATCH_SIZE).filter(s => s.name?.trim());
                const results = await Promise.all(batch.map(song =>
                  findTrackOnPlatform(song, { storefront: gfStorefront, appleMusicApi: gfAppleApi, platformSvc: gfPlatformSvc })
                    .then(r => ({ song, result: r }))
                    .catch(() => ({ song, result: null }))
                ));
                for (const { result } of results) {
                  if (selectedTracks.length >= songCount) break;
                  if (!result) continue;
                  const { track } = result;
                  if (seenTrackIds.has(track.id)) continue;
                  if (!allowExplicit && track.explicit) continue;
                  // Hard constraint: excluded artists — gap fill bypasses validateAndAdd so we enforce here
                  {
                    const _gfExcludedNorms = (genreData.artistConstraints?.excludedArtists || []).map(a => a.toLowerCase().replace(/[^a-z0-9]/g, ''));
                    if (_gfExcludedNorms.length > 0) {
                      const _gfTrackArtistNorms = (track.artists || []).map(a => (a.name || '').toLowerCase().replace(/[^a-z0-9]/g, ''));
                      const _gfArtistExcluded = _gfExcludedNorms.some(exNorm =>
                        _gfTrackArtistNorms.some(an => an && exNorm && (an === exNorm || an.startsWith(exNorm) || exNorm.startsWith(an)))
                      );
                      if (_gfArtistExcluded) {
                        console.log(`🚫 [GAP-EXCLUDED] "${track.name}" by ${track.artists?.[0]?.name} — artist in exclusion list`);
                        continue;
                      }
                    }
                  }
                  const gfMaxPerArtist = genreData.trackConstraints?.artistDiversity?.maxPerArtist;
                  if (gfMaxPerArtist !== null && gfMaxPerArtist !== undefined) {
                    const ak = (track.artists?.[0]?.name || track.artist || '').toLowerCase();
                    if ((artistTrackCount.get(ak) || 0) >= gfMaxPerArtist) continue;
                    artistTrackCount.set(ak, (artistTrackCount.get(ak) || 0) + 1);
                  }
                  // Apply catalog context overrides before accepting gap fill track
                  const _gfKey = `${(track.artists?.[0]?.name || track.artist || '').toLowerCase()}::${(track.name || '').toLowerCase()}`;
                  const _gfOverride = TRACK_CONTEXT_OVERRIDES[_gfKey];
                  if (_gfOverride) {
                    const _gfMoodOk = !genreData.mood || _gfOverride.requiredMoods.includes(genreData.mood);
                    const _gfEnergyOk = !genreData.energyTarget || _gfOverride.requiredEnergies.includes(genreData.energyTarget);
                    const _gfUcBlocked = _gfUseCase && (_gfOverride.blockedUseCases || []).includes(_gfUseCase);
                    if (_gfUcBlocked || !_gfMoodOk || !_gfEnergyOk) {
                      console.log(`🚫 [CATALOG-OVERRIDE/GAP] Skipping "${track.name}" by ${track.artists?.[0]?.name || track.artist} — ${_gfOverride.reason}`);
                      continue;
                    }
                  }
                  const _gfNormKey = `${_normTitle(track.name)}::${_normArtist(track.artists?.[0]?.name || track.artist || '')}`;
                  if (seenNormKeys.has(_gfNormKey)) continue;
                  seenNormKeys.add(_gfNormKey);
                  seenTrackIds.add(track.id);
                  selectedTracks.push({
                    id: track.id, name: track.name,
                    artist: track.artists?.[0]?.name || track.artist || 'Unknown',
                    uri: track.uri,
                    album: track.album?.name || track.album,
                    image: track.album?.images?.[0]?.url || null,
                    previewUrl: track.preview_url,
                    externalUrl: track.url || track.external_urls?.spotify ||
                      (platform === 'apple' ? `https://music.apple.com/us/song/${track.id}` : null),
                    explicit: track.explicit || false, genres: []
                  });
                }
              }
              console.log(`🔄 After gap fill: ${selectedTracks.length}/${songCount} tracks`);
            } catch (gapErr) {
              console.log('Gap fill failed:', gapErr.message);
            }
          }

          // Post-gap-fill constraint filter — gap fill tracks also bypass the main vibe check,
          // same contamination risk as supplement (e.g. "As It Was" entering via top_songs).
          const _gfNewCount = selectedTracks.length - _preGapFillCount;
          {
            const _gfVocalGender = genreData.artistConstraints?.vocalGender;
            const _gfConstraintRules = [];
            if (_gfUseCase && _useCaseVibeRules[_gfUseCase]) _gfConstraintRules.push(_useCaseVibeRules[_gfUseCase]);
            if (_gfVocalGender === 'female') _gfConstraintRules.push('GENDER HARD RULE: REMOVE any track by a male solo artist, male rapper, or male-fronted band. Only female artists allowed. Examples to REMOVE: The Weeknd, Drake, GIVĒON, James Blake, dvsn, J. Cole.');
            if (_gfVocalGender === 'male') _gfConstraintRules.push('GENDER HARD RULE: REMOVE any track by a female solo artist or female-fronted band. Only male artists allowed.');
            if (_gfConstraintRules.length > 0 && _gfNewCount > 0) {
              const gfNewTracks = selectedTracks.slice(_preGapFillCount);
              console.log(`🔍 Post-gap-fill filter: checking ${gfNewTracks.length} new tracks (${_gfConstraintRules.length} rules)...`);
              try {
                const _gfFilterResp = await anthropic.messages.create({
                  model: 'claude-haiku-4-5-20251001',
                  max_tokens: 300,
                  messages: [{
                    role: 'user',
                    content: `Rules (ALL must be enforced):\n${_gfConstraintRules.map((r, i) => `${i + 1}. ${r}`).join('\n')}

Tracks to check:
${gfNewTracks.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist}`).join('\n')}

List the NUMBER of every track that violates ANY rule. If all tracks pass, respond "NONE".
IMPORTANT: Output ONLY comma-separated numbers or "NONE". No explanations, no track names, no reasoning. Examples of valid responses: "NONE" or "2" or "1, 3, 4".`
                  }]
                });
                const _gfFilterText = _gfFilterResp.content[0]?.text?.trim() || 'NONE';
                console.log(`🔍 Post-gap-fill filter: ${_gfFilterText}`);
                if (_gfFilterText.toUpperCase() !== 'NONE') {
                  // Use regex to extract standalone numbers — avoids picking up list markers like "1." or "2."
                  const _gfBadNums = (_gfFilterText.match(/(?<![.\d])(\d+)(?![.\d])/g) || []).map(n => parseInt(n)).filter(n => !isNaN(n) && n >= 1 && n <= gfNewTracks.length);
                  if (_gfBadNums.length > 0) {
                    const _gfBadIndices = new Set(_gfBadNums.map(n => _preGapFillCount + n - 1));
                    const _gfRemovedNames = [..._gfBadIndices].map(i => selectedTracks[i]).filter(Boolean).map(t => `"${t.name}" by ${t.artist}`);
                    console.log(`🔍 Post-gap-fill: removing ${_gfBadIndices.size} off-constraint tracks: ${_gfRemovedNames.join(', ')}`);
                    selectedTracks = selectedTracks.filter((_, i) => !_gfBadIndices.has(i));
                  }
                }
              } catch (gfFilterErr) {
                console.log('Post-gap-fill filter failed (non-fatal):', gfFilterErr.message);
              }
            }
          }

          // Final dedup: remove sped-up/live/remix variants that slipped in across passes
          const normTrackTitle = (t) => (t || '').toLowerCase()
            .replace(/\s*[\(\[].*?[\)\]]/g, '')
            .replace(/\s*-\s*(remix|edit|mix|version|live|acoustic|instrumental|sped.?up|slowed|karaoke|radio|extended|remaster).*$/i, '')
            .replace(/\s+/g, ' ').trim();
          // Normalize artist to primary only — strips "& Remixer" or "feat. X" so
          // "KATSEYE & JULiA LEWiS" and "KATSEYE" both reduce to "katseye"
          const normArtist = (a) => (a || '').toLowerCase()
            .split(/\s*(?:feat\.|ft\.|featuring)\s*/i)[0]
            .split(/\s*&\s*/)[0]
            .trim();
          const seenFinal = new Set();
          selectedTracks = selectedTracks.filter(t => {
            const key = `${normTrackTitle(t.name)}::${normArtist(t.artist)}`;
            if (seenFinal.has(key)) return false;
            seenFinal.add(key);
            return true;
          });

          // Update song history and playlist.tracks so future refreshes anchor to the new track list.
          // Skip for internal auto-update calls — processPlaylistUpdate's syncAfterPush handles it.
          if (playlistId && userId && !internalCall) {
            try {
              const upa = userPlaylists.get(userId) || [];
              const upi = upa.findIndex(p => p.playlistId === playlistId);
              if (upi !== -1) {
                const pl = upa[upi];
                if (!pl.songHistory) pl.songHistory = [];
                pl.songHistory = [...pl.songHistory, ...selectedTracks.map(t => `${normalizeForHistory(t.name)}|||${(t.artist || '').toLowerCase()}`)];
                if (pl.songHistory.length > 150) pl.songHistory = pl.songHistory.slice(-150);
                // Update playlist.tracks so the refresh anchor reflects the new track list
                pl.tracks = selectedTracks;
                pl.trackUris = selectedTracks.map(t => t.uri).filter(Boolean);
                userPlaylists.set(userId, upa);
                await savePlaylist(userId, pl);
                console.log(`[MANUAL-REFRESH] Song history updated — now ${pl.songHistory.length} tracks`);
              }
            } catch (histErr) {
              console.log('[MANUAL-REFRESH] Failed to update song history:', histErr.message);
            }
          }

          res.json({
            playlistName: claudePlaylistName,
            description: claudePlaylistDescription,
            tracks: selectedTracks,
            trackCount: selectedTracks.length
          });
          const _topSongsArtists = [...new Set(soundChartsDiscoveredSongs.map(s => s.artistName).filter(Boolean))];
          drainEnrichmentQueue(_topSongsArtists);
          return; // Done
        }
        console.log(`⚠️ Only ${selectedTracks.length}/${songCount} tracks found, trying fallback...`);
      }
    }

    // Fallback: SoundCharts + Spotify found too few songs — use SoundCharts top songs by genre
    let needsFallback = allTracks.length < 5;

    if (needsFallback && process.env.SOUNDCHARTS_APP_ID) {
      console.log(`🔄 Fallback: Only ${allTracks.length} songs resolved. Expanding with SoundCharts top songs...`);
      try {
        // Build a genre+era query (no mood) using the new direct endpoint
        const fallbackGenreData = {
          primaryGenre: genreData.primaryGenre,
          atmosphere: [],
          era: genreData.era,
          trackConstraints: {},
          artistConstraints: { exclusiveMode: false, requestedArtists: [] }
        };
        const fallbackQuery = buildSoundchartsQuery(fallbackGenreData, false, allowExplicit);
        let topSongs = await executeSoundChartsStrategy(fallbackQuery, songCount * 2);
        console.log(`🔄 SoundCharts top songs: ${topSongs.length} candidates`);

        // Genre validation: cross-reference Spotify artist genres against the requested genre.
        // SC sometimes mislabels pop artists (e.g. Adele) as R&B. Spotify's genre tagging is
        // more accurate — filter out artists with no overlap with the requested genre family.
        if (genreData.primaryGenre && topSongs.length > 0) {
          const artistNames = [...new Set(topSongs.map(s => s.artistName).filter(Boolean))];
          const genreMap = await batchGetSpotifyArtistGenres(artistNames).catch(() => new Map());
          const before = topSongs.length;
          topSongs = topSongs.filter(s => {
            const spotifyGenres = genreMap.get((s.artistName || '').toLowerCase()) || null;
            const ok = isArtistInGenreFamily(spotifyGenres, genreData.primaryGenre);
            if (!ok) console.log(`🚫 Genre mismatch: "${s.artistName}" (${(spotifyGenres || []).join(', ')}) → not ${genreData.primaryGenre}`);
            return ok;
          });
          if (topSongs.length < before) {
            console.log(`🎯 Spotify genre filter: ${before} → ${topSongs.length} candidates (removed ${before - topSongs.length} off-genre songs)`);
          }
        }

        // Phase A: pre-fetch SC platform IDs for songs missing ISRC
        await prefetchPlatformIds(topSongs, platform === 'spotify' ? 'spotify' : 'applemusic');

        // Set up Apple Music instances once (reused across all batches)
        const fbStorefront = tokens.storefront || 'us';
        const fbAppleDevToken = platform === 'apple' ? generateAppleMusicToken() : null;
        const fbAppleApi = fbAppleDevToken ? new AppleMusicService(fbAppleDevToken) : null;
        const fbPlatformSvc = platform === 'apple' ? new PlatformService() : null;

        // Phase B: parallel batches of 10
        for (let fi = 0; fi < topSongs.length && allTracks.length < songCount * 3; fi += BATCH_SIZE) {
          const batch = topSongs.slice(fi, fi + BATCH_SIZE).filter(s => s.name?.trim());
          const batchResults = await Promise.all(batch.map(song =>
            findTrackOnPlatform(song, { storefront: fbStorefront, appleMusicApi: fbAppleApi, platformSvc: fbPlatformSvc })
              .then(result => ({ song, result }))
              .catch(() => ({ song, result: null }))
          ));
          for (const { result } of batchResults) {
            if (allTracks.length >= songCount * 3) break;
            if (!result) continue;
            const { track } = result;
            if (seenTrackIds.has(track.id)) continue;
            seenTrackIds.add(track.id);
            allTracks.push({
              id: track.id, name: track.name,
              artist: track.artists?.[0]?.name || track.artist || 'Unknown',
              uri: track.uri,
              album: track.album?.name || track.album,
              image: track.album?.images?.[0]?.url || null,
              previewUrl: track.preview_url,
              externalUrl: track.url || track.external_urls?.spotify ||
                (platform === 'apple' ? `https://music.apple.com/us/song/${track.id}` : null),
              explicit: track.explicit || false, genres: []
            });
          }
        }
        console.log(`🔄 After SoundCharts top-songs fallback: ${allTracks.length} tracks`);
        needsFallback = false; // Mark as handled
      } catch (scFallbackErr) {
        console.log('SoundCharts top-songs fallback failed:', scFallbackErr.message);
      }
    }

    if (needsFallback) {
      // Last resort: nothing worked, log and continue with what we have
      console.log(`⚠️ All discovery methods exhausted. Returning ${allTracks.length} tracks.`);
    }


    console.log(`Found ${allTracks.length} unique tracks before audio features filtering`);
    console.log('DEBUG: About to define normalizeArtistForComparison, genreData exists:', typeof genreData !== 'undefined');

    // Helper function to normalize artist names (handles accents like GIVĒON -> GIVEON)
    // Defined at top level so it's available in all scopes
    const normalizeArtistForComparison = (name) => {
      if (!name) return '';
      return name
        .toLowerCase()
        .normalize('NFD') // Decompose accented characters (ē -> e + combining accent)
        .replace(/[\u0300-\u036f]/g, '') // Remove diacritics/accents
        .trim();
    };

    // Log artist breakdown, especially for requested artists
    if (genreData.artistConstraints.requestedArtists && genreData.artistConstraints.requestedArtists.length > 0) {

      const artistCounts = new Map();
      allTracks.forEach(track => {
        const artist = track.artist;
        artistCounts.set(artist, (artistCounts.get(artist) || 0) + 1);
      });

      console.log('\nArtist breakdown in search results:');
      const requestedArtists = genreData.artistConstraints.requestedArtists;

      // Check if requested artists were found
      const foundRequestedArtists = requestedArtists.filter(reqArtist => {
        // Check with Unicode normalization to handle accents
        return Array.from(artistCounts.keys()).some(foundArtist =>
          normalizeArtistForComparison(foundArtist) === normalizeArtistForComparison(reqArtist)
        );
      });

      console.log(`Requested artists: ${requestedArtists.join(', ')}`);
      console.log(`Exclusive mode: ${genreData.artistConstraints.exclusiveMode ? 'YES (only these artists)' : 'NO (similar vibe mix)'}`);
      console.log(`Found in results: ${foundRequestedArtists.length > 0 ? foundRequestedArtists.join(', ') : 'NONE'}`);

      if (foundRequestedArtists.length === 0) {
        console.warn('⚠️  WARNING: None of the requested artists were found in search results!');
        console.log('This could mean:');
        console.log('  1. These artists don\'t exist on Apple Music');
        console.log('  2. Artist names are spelled differently on Apple Music');
        console.log('  3. Artists have very limited catalogs');
      }

      // Show top artists found
      const sortedArtists = Array.from(artistCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);
      console.log(`Top 10 artists in results:`);
      sortedArtists.forEach(([artist, count]) => {
        const isRequested = requestedArtists.some(req => normalizeArtistForComparison(req) === normalizeArtistForComparison(artist));
        console.log(`  ${isRequested ? '✓' : ' '} ${artist}: ${count} tracks`);
      });
      console.log('');

      // For non-exclusive mode, limit tracks per artist to maintain discovery balance
      if (!genreData.artistConstraints.exclusiveMode) {
        const maxTracksPerArtist = genreData.trackConstraints?.artistDiversity?.maxPerArtist ?? 3;

        // Group tracks by normalized artist name (simple case/punctuation dedup — no Claude call needed)
        const artistTrackMap = new Map();

        allTracks.forEach(track => {
          const finalNormalizedArtist = normalizeArtistForComparison(track.artist);

          if (!artistTrackMap.has(finalNormalizedArtist)) {
            artistTrackMap.set(finalNormalizedArtist, []);
          }
          artistTrackMap.get(finalNormalizedArtist).push(track);
        });

        // Filter to keep only first N tracks per artist
        const limitedTracks = [];
        artistTrackMap.forEach((tracks, artist) => {
          const isRequestedArtist = requestedArtists.some(req => normalizeArtistForComparison(req) === artist);
          const limit = isRequestedArtist ? maxTracksPerArtist : maxTracksPerArtist;

          if (tracks.length > limit) {
            console.log(`  ✂️  Limiting ${tracks[0].artist} from ${tracks.length} to ${limit} tracks`);
          }

          limitedTracks.push(...tracks.slice(0, limit));
        });

        const beforeCount = allTracks.length;
        allTracks.splice(0, allTracks.length, ...limitedTracks);
        console.log(`\n📊 Artist diversity enforcement: ${beforeCount} -> ${allTracks.length} tracks (max ${maxTracksPerArtist} per artist)\n`);
      }

    }

    // Step 2.5: Apply metadata-based filters (year, duration, version exclusions, language, album diversity)
    // Note: Spotify's audio features API (BPM/energy/valence) is deprecated — those filters are not applied.
    let tracksForSelection = allTracks;
    const hasMetadataFilters =
      (genreData.era.yearRange.min !== null || genreData.era.yearRange.max !== null) ||
      (genreData.trackConstraints.duration.min !== null || genreData.trackConstraints.duration.max !== null) ||
      genreData.trackConstraints.excludeVersions.length > 0 ||
      genreData.artistConstraints.excludeFeatures ||
      genreData.trackConstraints.albumDiversity.maxPerAlbum !== null;

    if (hasMetadataFilters && allTracks.length > 0) {
      const albumTrackCount = {};

      tracksForSelection = allTracks.filter(track => {
        // Year range
        if (genreData.era.yearRange.min !== null || genreData.era.yearRange.max !== null) {
          if (track.album?.release_date) {
            const releaseYear = parseInt(track.album.release_date.substring(0, 4));
            if (releaseYear < (genreData.era.yearRange.min || 0) || releaseYear > (genreData.era.yearRange.max || 9999)) return false;
          }
        }

        // Duration
        if (genreData.trackConstraints.duration.min !== null || genreData.trackConstraints.duration.max !== null) {
          const durationSec = track.duration_ms / 1000;
          if (durationSec < (genreData.trackConstraints.duration.min || 0) || durationSec > (genreData.trackConstraints.duration.max || 999999)) return false;
        }

        // Version exclusions (live, remix, acoustic, etc.)
        if (genreData.trackConstraints.excludeVersions.length > 0) {
          const nameLower = track.name.toLowerCase();
          if (genreData.trackConstraints.excludeVersions.some(v => nameLower.includes(v.toLowerCase()))) return false;
        }

        // Exclude features/collabs
        if (genreData.artistConstraints.excludeFeatures) {
          const nameLower = track.name.toLowerCase();
          if (nameLower.includes('feat.') || nameLower.includes('ft.') || nameLower.includes(' with ') || nameLower.includes('featuring')) return false;
        }

        // Album diversity
        const albumKey = track.album?.id || (track.album?.name && track.artist ? `${track.album.name}::${track.artist}` : null);
        if (genreData.trackConstraints.albumDiversity.maxPerAlbum !== null && albumKey) {
          const count = albumTrackCount[albumKey] || 0;
          if (count >= genreData.trackConstraints.albumDiversity.maxPerAlbum) return false;
          albumTrackCount[albumKey] = count + 1;
        }

        return true;
      });

      if (tracksForSelection.length === 0) tracksForSelection = allTracks;
    }


    // ── Scoring: rank tracks by requested-artist match + popularity alignment ─
    // Only re-sorts when there's a meaningful signal (requested artists, event mode,
    // or underground pref). For all other playlists the SC stream-rank order stands.
    const _reqArtistNorms = new Set(
      (genreData.artistConstraints?.requestedArtists || []).map(a => a.toLowerCase().replace(/[^a-z0-9]/g, ''))
    );
    const _popPref = genreData.trackConstraints?.popularity?.preference;
    const _needsScoring = _reqArtistNorms.size > 0 || _popPref === 'underground' || _isEventMode || _isSuperlativeMode;
    if (_needsScoring && tracksForSelection.length > 0) {
      tracksForSelection.sort((a, b) => {
        const scoreTrack = (t) => {
          let s = 0;
          const an = (t.artist || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          if (_reqArtistNorms.has(an)) s += 100; // requested artist always surfaces first
          const pop = t.popularity !== undefined ? t.popularity : 50;
          if (_isSuperlativeMode)        s += pop * 1.5;                     // "best ever" → rank by popularity
          else if (_popPref === 'underground') s += Math.max(0, 40 - pop) * 0.5;
          else if (_isEventMode)          s += Math.max(0, pop - 60) * 0.4;
          return s;
        };
        return scoreTrack(b) - scoreTrack(a);
      });
      console.log(`📊 Tracks re-scored (requestedArtists=${_reqArtistNorms.size}, eventMode=${_isEventMode}, underground=${_popPref === 'underground'}, superlative=${_isSuperlativeMode})`);
    }

    // SoundCharts already ranked songs by streams — take the top N directly.
    // Request 20% more if vibe check will run (it may trim some tracks).
    const hasVibeRequirements = genreData.atmosphere.length > 0 || genreData.contextClues.useCase || genreData.era.decade || genreData.subgenre || genreData.trackConstraints.popularity.preference === 'underground' || genreData.energyTarget || genreData.mood || (genreData.contextClues.avoidances || []).length > 0 || genreData.genreAccessibility === 'newcomer' || (genreData.artistConstraints?.vocalGender && genreData.artistConstraints.vocalGender !== 'any');
    const selectionTarget = hasVibeRequirements && !_phases ? Math.ceil(songCount * 1.2) : songCount;

    // Multi-phase: select proportionally from each phase's track pool
    let selectedTracks;
    if (_phases) {
      const byPhase = new Map(_phases.map(p => [p.label, []]));
      tracksForSelection.forEach(t => {
        if (t._phaseLabel && byPhase.has(t._phaseLabel)) byPhase.get(t._phaseLabel).push(t);
      });
      selectedTracks = [];
      for (const phase of _phases) {
        const phaseTracks = byPhase.get(phase.label) || [];
        const phaseTarget = Math.max(1, Math.round(songCount * phase.fraction));
        selectedTracks.push(...phaseTracks.slice(0, phaseTarget));
        console.log(`📊 Phase "${phase.label}": ${Math.min(phaseTracks.length, phaseTarget)}/${phaseTarget} tracks selected`);
      }
      console.log(`📋 Multi-phase total: ${selectedTracks.length} tracks across ${_phases.length} phases`);
    } else {
      // ── Familiarity ratio split (80% hits / 20% deep cuts, etc.) ���────────────
      const _famRatio = genreData.discoveryBalance?.familiarityRatio;
      const _hitsFraction = _famRatio?.hits;
      const _deepFraction = _famRatio?.deepCuts;
      if (_hitsFraction && _deepFraction && (_hitsFraction + _deepFraction) >= 0.9) {
        const hitsTarget = Math.round(songCount * _hitsFraction);
        const deepTarget = Math.max(1, songCount - hitsTarget);
        // Hits = high popularity (≥65), deep cuts = lower popularity (<65)
        // Sort desc by popularity so we pick the most popular hits first
        const hitPool = [...tracksForSelection].filter(t => (t.popularity ?? 50) >= 65)
          .sort((a, b) => (b.popularity ?? 50) - (a.popularity ?? 50));
        const deepPool = [...tracksForSelection].filter(t => (t.popularity ?? 50) < 65)
          .sort((a, b) => (a.popularity ?? 50) - (b.popularity ?? 50)); // least popular first for discovery
        const hitsSelected = hitPool.slice(0, hitsTarget);
        const deepSelected = deepPool.slice(0, deepTarget);
        // Interleave: roughly every Nth track is a deep cut so they're spread through the playlist
        selectedTracks = [];
        const deepEveryN = Math.max(2, Math.round(songCount / Math.max(deepSelected.length, 1)));
        let deepIdx = 0, hitIdx = 0, pos = 0;
        while (selectedTracks.length < songCount) {
          if (deepIdx < deepSelected.length && pos > 0 && pos % deepEveryN === 0) {
            selectedTracks.push(deepSelected[deepIdx++]);
          } else if (hitIdx < hitsSelected.length) {
            selectedTracks.push(hitsSelected[hitIdx++]);
          } else if (deepIdx < deepSelected.length) {
            selectedTracks.push(deepSelected[deepIdx++]);
          } else break;
          pos++;
        }
        console.log(`🎯 Familiarity ratio ${Math.round(_hitsFraction*100)}/${Math.round(_deepFraction*100)}: ${hitsSelected.length} hits + ${deepSelected.length} deep cuts = ${selectedTracks.length} tracks`);
      } else {
        selectedTracks = tracksForSelection.slice(0, selectionTarget);
        console.log(`📋 Using top ${selectedTracks.length} tracks (${hasVibeRequirements ? 'vibe check will run' : 'no vibe check needed'})`);
      }
    }

    // Step 3.5: Catalog context overrides — deterministic filter for known false positives.
    // Runs before the vibe check (no LLM call) to remove tracks whose sonic profile has been
    // confirmed as incompatible with specific energy/mood contexts across multiple test cycles.
    if (selectedTracks.length > 0) {
      const _ctxMood = genreData.mood;
      const _ctxEnergy = genreData.energyTarget;
      const _ctxUseCase = (genreData.contextClues?.useCase || '').toLowerCase();
      const beforeOverride = selectedTracks.length;
      selectedTracks = selectedTracks.filter(track => {
        const key = `${(track.artist || '').toLowerCase()}::${(track.name || '').toLowerCase()}`;
        const override = TRACK_CONTEXT_OVERRIDES[key];
        if (!override) return true;
        const moodOk = !_ctxMood || override.requiredMoods.includes(_ctxMood);
        const energyOk = !_ctxEnergy || override.requiredEnergies.includes(_ctxEnergy);
        // blockedUseCases: deterministic block regardless of whether mood/energy was extracted
        const useCaseBlocked = _ctxUseCase && (override.blockedUseCases || []).includes(_ctxUseCase);
        if (useCaseBlocked || !moodOk || !energyOk) {
          console.log(`🚫 [CATALOG-OVERRIDE] Removing "${track.name}" by ${track.artist} — ${override.reason}`);
          return false;
        }
        return true;
      });
      if (selectedTracks.length < beforeOverride) {
        console.log(`🚫 [CATALOG-OVERRIDE] Removed ${beforeOverride - selectedTracks.length} track(s) via context overrides`);
      }
    }

    // Step 4: VIBE CHECK - Review the selected tracks for coherence
    // This addresses the #1 complaint: AI missing the "vibe" even when genres match
    // Also filters out mainstream artists when underground preference is detected
    // Skipped for multi-phase playlists — each phase was already fetched with phase-specific
    // energy/mood filters, so a single-vibe check would incorrectly remove cross-phase tracks.
    if (selectedTracks.length > 0 && !_phases && hasVibeRequirements) {
      console.log('Running vibe check on selected tracks...');

      // Build use-case and audience hard constraint rules for the vibe check
      const _uc = (genreData.contextClues.useCase || '').toLowerCase();
      const _audience = genreData.contextClues.audience || [];
      const _promptLower = prompt.toLowerCase();
      const _avoidances = genreData.contextClues.avoidances || [];
      const _vibeHardRules = [];

      // Use-case hard constraint rules — useCase values are canonical (see extraction schema)
      if (_uc === 'workout') {
        _vibeHardRules.push('WORKOUT — HARD RULE: REMOVE any slow, emotional, sad, mellow, or mid-tempo songs. Every track must feel pump-up and high energy. Think: does this make you want to sprint? If no, cut it. Examples to REMOVE: SZA "30 For 30" (slow emotional duet), SZA "20 Something" (introspective slow R&B), Khalid "8TEEN" (coming-of-age mid-tempo), Khalid "Young Dumb & Broke" (mid-tempo), The Weeknd "A Lesser Man" (slow R&B), The Weeknd "Call Out My Name" (slow ballad), Sia "3 Minutes \'Til New Years" (slow ballad), Dua Lipa "Anything For Love" (mid-tempo ballad), Camila Cabello "Am I Wrong" (slow pop), Akon "Mama Africa" (slow world pop), Lady Gaga "1000 Doves" (power ballad), 50 Cent "21 Questions" (slow R&B), benny blanco "Bad Decisions" (mid-tempo pop) — all WRONG for workout. Keep high-energy tracks like: Eminem "Till I Collapse", Macklemore "Ain\'t Gonna Die Tonight", Marshmello dance tracks, Imagine Dragons up-tempo rock.');
      }
      if (_uc === 'focus') {
        _vibeHardRules.push('FOCUS/STUDY — HARD RULE: REMOVE any high-energy, hype, aggressive, or distracting songs. No heavy bass drops, intense rap verses, or anything that would pull attention away from deep work. Only calm, background-friendly music that blends into the background.');
      }
      if (_uc === 'sleep') {
        _vibeHardRules.push('SLEEP — HARD RULE: REMOVE anything with a strong beat, energetic production, or that could keep someone awake. Only the most soothing, minimal, ultra-calm tracks.');
      }
      if (_uc === 'party') {
        _vibeHardRules.push('PARTY/PREGAME — HARD RULE: REMOVE any track that is mid-tempo, emotional, melancholic, introspective, or would not work on a dancefloor — even if the artist is generally associated with upbeat music. The test is: would a DJ play this to keep a crowd dancing and hyped? If not, remove it. This means removing the slow/soft cuts from otherwise upbeat artists too — e.g. Sia "Elastic Heart" (mid-tempo emotional, WRONG), Dua Lipa "Bad Together" or "Anything For Love" (ballads, WRONG), Camila Cabello "All These Years" or "Am I Wrong" (slow, WRONG), Lin-Manuel Miranda charity/film cuts (WRONG), SZA slow R&B ("30 For 30", "2AM", "20 Something" — WRONG), Khalid ("8TEEN", "Young Dumb & Broke" — WRONG), The Weeknd R&B ballads ("A Lonely Night", "A Lesser Man" — WRONG), Rihanna ("Unfaithful", "Stay" — WRONG), slow Kanye ("30 Hours" — WRONG), benny blanco mid-tempo pop ("Bad Decisions" — WRONG). Every track must be something a DJ would play to keep a crowd moving.');
      }
      if (_uc === 'summer') {
        _vibeHardRules.push('SUMMER VIBES — HARD RULE: This playlist is for warm, bright, carefree summer energy. REMOVE any track that is slow, mellow, low-energy, melancholic, anxious, or emotionally heavy — regardless of season. No breakup ballads, no late-night sad R&B, no emotionally heavy slow jams. "A Lonely Night" (The Weeknd), "30 For 30" (SZA), "All I Want" (Olivia Rodrigo), "Slut! (Taylor\'s Version)", "2AM" (SZA), "All This Madness" (Sam Smith) — all WRONG for this context. Every track should feel like it belongs on a beach or a summer road trip.');
      }
      // Explicit user avoidances
      if (_avoidances.some(a => a.toLowerCase().includes('slow')) || _promptLower.includes('no slow')) {
        _vibeHardRules.push('NO SLOW SONGS — HARD RULE: The user explicitly said no slow songs. REMOVE any track that is slow, mellow, or would be classified as a ballad.');
      }
      if (_avoidances.some(a => a.toLowerCase().includes('loud')) || _avoidances.some(a => a.toLowerCase().includes('distracting'))) {
        _vibeHardRules.push('NO LOUD/DISTRACTING SONGS — HARD RULE: REMOVE any high-energy, heavy, or intense tracks.');
      }

      // Hard BPM constraint
      const _bpmMin = genreData.bpmConstraint?.min;
      const _bpmMax = genreData.bpmConstraint?.max;
      if (_bpmMin || _bpmMax) {
        const bpmDesc = _bpmMin && _bpmMax
          ? `between ${_bpmMin} and ${_bpmMax} BPM`
          : _bpmMin ? `above ${_bpmMin} BPM` : `below ${_bpmMax} BPM`;
        _vibeHardRules.push(`BPM CONSTRAINT — HARD RULE: The user explicitly requested songs ${bpmDesc}. REMOVE any track that sounds significantly slower or faster than this range. Use your knowledge of typical BPM ranges per genre: EDM/techno ~128-150+, fast hip-hop ~90-100+, ballads ~60-80, etc.`);
      }

      // Explicit content
      if (!allowExplicit) {
        _vibeHardRules.push('CLEAN/EXPLICIT — HARD RULE: REMOVE any track with explicit language, profanity, or mature content. No exceptions — the user has requested clean music only.');
      }

      // Mood / valence constraints
      const _mood = genreData.mood;
      if (_mood === 'positive') {
        _vibeHardRules.push('POSITIVE MOOD — HARD RULE: REMOVE sad, melancholic, gloomy, or somber tracks. This playlist should feel pleasant and uplifting. "Calm" does NOT mean "sad" — only keep tracks that feel warm, neutral-to-positive, or happy. Phoebe Bridgers, Sufjan Stevens, and similar artists known for sadness should be removed unless the specific song is clearly upbeat.');
      } else if (_mood === 'melancholic') {
        _vibeHardRules.push('MELANCHOLIC MOOD — HARD RULE: REMOVE hype, aggressive, or party-energy tracks. Keep emotionally resonant, introspective, or bittersweet songs. Avoid angry or toxic energy — sad and peaceful, not sad and hostile.');
      }

      // Excluded artists — vibe check reinforces the hard filter in validateAndAdd
      const _excludedInVibe = genreData.artistConstraints?.excludedArtists || [];
      if (_excludedInVibe.length > 0) {
        _vibeHardRules.push(`EXCLUDED ARTISTS — HARD RULE: The user explicitly banned the following artists: ${_excludedInVibe.join(', ')}. REMOVE any track by these artists or any track that is directly associated with them (e.g. collab tracks, features). No exceptions.`);
      }

      // "No mainstream" / underground preference
      const _maxPopForVibeRule = genreData.trackConstraints?.popularity?.max;
      if (_popPref === 'underground' || (_maxPopForVibeRule !== null && _maxPopForVibeRule !== undefined && _maxPopForVibeRule <= 60)) {
        _vibeHardRules.push('NO MAINSTREAM HITS — HARD RULE: The user explicitly requested underground/deep cuts only. REMOVE any artist with radio hits, chart success, major label backing, or household-name recognition. Travis Scott, Kanye West, Drake, The Weeknd, Rihanna, Ariana Grande, and similar mainstream acts must be REMOVED even if their sound matches the genre. Only keep artists who are genuinely underground, indie, or niche.');
      }

      // Gender constraint
      const _vocalGender = genreData.artistConstraints?.vocalGender;
      if (_vocalGender === 'female') {
        _vibeHardRules.push('GENDER — HARD RULE: The user requested FEMALE artists only. REMOVE any track by a male solo artist, male rapper, or male-fronted band. Only female solo artists, female rappers, and female-fronted groups are allowed. Examples to REMOVE: The Weeknd, Drake, J. Cole, dvsn, Big Sean, James Blake, Metro Boomin, Kendrick Lamar — ALL must be removed. No exceptions even if the song sounds perfect for the vibe.');
      } else if (_vocalGender === 'male') {
        _vibeHardRules.push('GENDER — HARD RULE: The user requested MALE artists only. REMOVE any track by a female solo artist, female rapper, or female-fronted band. No exceptions.');
      }

      // Cohesion / smooth-transitions request
      const _wantsCohesion = genreData.discoveryBalance?.preference === 'cohesive' ||
        ['no skips', 'smooth transition', 'consistent vibe', 'walks away', 'walk away', 'background music', 'no jarring', 'no whiplash'].some(s => _promptLower.includes(s));
      if (_wantsCohesion) {
        _vibeHardRules.push('COHESION — HARD RULE: This playlist must feel like one continuous listening experience. REMOVE any track that would create an abrupt tonal shift — mismatched genres (e.g. industrial electronic next to indie-pop), extreme energy jumps (e.g. ambient drone then trap banger), or artists whose overall sonic identity is clearly out of place with the rest of the playlist. If a track belongs to a completely different sonic world than 80% of the others, cut it.');
      }

      // Audience safety constraints
      const _isChristian = _audience.includes('christian') || _promptLower.includes('christian') || _promptLower.includes('church') || _promptLower.includes('worship') || _promptLower.includes('gospel');
      const _isFamily    = _audience.includes('family') || _audience.includes('clean') || _promptLower.includes('family') || _promptLower.includes('kids') || _promptLower.includes('children');
      const _isYouth     = _audience.includes('youth') || _promptLower.includes('youth retreat') || _promptLower.includes('youth group');
      if (_isChristian) {
        _vibeHardRules.push('CHRISTIAN/RELIGIOUS CONTEXT — HARD RULE: ONLY keep explicitly Christian, worship, gospel, or faith-based music. REMOVE all secular artists — even if the music sounds "positive" or "uplifting," secular pop/rock/hip-hop does NOT belong here. Artists like TobyMac, Crowder, Lauren Daigle, Chris Tomlin, Hillsong, Lecrae are appropriate. Artists like Three Days Grace, Falling In Reverse, Imagine Dragons, or any secular act must be REMOVED.');
      } else if (_isFamily || _isYouth) {
        _vibeHardRules.push('CLEAN/FAMILY/YOUTH CONTEXT — HARD RULE: REMOVE any songs or artists associated with dark themes, aggression, sexual content, explicit language, or inappropriate messaging. Keep it positive and safe for all ages.');
      }

      // Genre accessibility — newcomer
      if (genreData.genreAccessibility === 'newcomer') {
        _vibeHardRules.push(`GENRE NEWCOMER — HARD RULE: The user is new to this genre and asked to be eased in. REMOVE any artist or track that requires genre expertise to appreciate: avant-garde works, dense bebop, free jazz, atonal classical, extreme metal subgenres, or anything that would intimidate a first-time listener. Keep only approachable, melodic, widely-loved entry-point tracks.`);
      }

      const vibeCheckPrompt = `You are reviewing a playlist to ensure it has a COHERENT VIBE and emotional atmosphere.

Original user request: "${prompt}"

REQUIRED VIBE/CONTEXT:
- Target atmosphere: ${genreData.atmosphere.join(', ') || 'not specified'}
- Use case: ${genreData.contextClues.useCase || 'not specified'}
- Subgenre: ${genreData.subgenre || 'not specified'}
- Era/decade: ${genreData.era.decade || 'not specified'}
- Avoid: ${genreData.contextClues.avoidances.join('; ') || 'nothing'}
- Popularity preference: ${genreData.trackConstraints.popularity.preference || 'not specified'}${genreData.trackConstraints.popularity.preference === 'underground' ? ' ← CRITICAL: STRICTLY remove ALL mainstream/radio/chart artists' : ''}
- Genre accessibility: ${genreData.genreAccessibility || 'not specified'}
${_vibeHardRules.length > 0 ? `
⚠️  HARD CONSTRAINTS (non-negotiable — enforce these BEFORE anything else):
${_vibeHardRules.map(r => `• ${r}`).join('\n')}
` : ''}
Selected tracks:
${selectedTracks.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist || 'Unknown Artist'}`).join('\n')}

Review this track list and identify any songs that are TECHNICALLY correct (right genre) but EMOTIONALLY WRONG (don't fit the vibe/atmosphere/context).

For example:
- If use case is "focus" or "study", songs that are too intense/distracting should be removed
- If atmosphere is "melancholic" or "dreamy", upbeat party songs should be removed
- If era is "90s", songs from 2020s should be removed
- If subgenre is "neo-soul", trap songs should be removed even if both are R&B
- If popularity preference is "underground", BE EXTREMELY STRICT - remove ANY artist that:
  * Has had radio hits or chart success (Top 40, Hot 100, etc.)
  * Has millions of monthly listeners on streaming platforms
  * Is signed to a major label (RCA, Columbia, Atlantic, Interscope, Def Jam, etc.)
  * Has collaborated with mainstream artists (Drake, The Weeknd, Travis Scott, etc.)
  * Is commonly known outside underground/indie circles
  * Has any songs with 100M+ streams

  Examples to REMOVE: SZA, Miguel, Khalid, Daniel Caesar, H.E.R., Summer Walker, Brent Faiyaz, Drake, The Weeknd, Jhené Aiko, Kehlani, Frank Ocean, Tyler the Creator, Steve Lacy, Kali Uchis, Tinashe, Normani, 6LACK, Giveon, Ari Lennox, Ella Mai, Snoh Aalegra, Michael Jackson, Usher, Chris Brown, Cassie, 112, Ginuwine, Ty Dolla $ign, Sonder, Jorja Smith, etc.

  KEEP ONLY: True underground/indie artists with minimal mainstream recognition, like the requested artists in the prompt.

Respond ONLY with valid JSON:
{
  "vibeIssues": [
    {"index": 1, "trackName": "Song Name", "reason": "why it doesn't fit the vibe"},
    ...
  ],
  "keepIndices": [list of indices (1-based) of songs that DO fit the vibe and should be kept]
}

Be EXTREMELY strict about vibe coherence, especially for underground preference and any hard constraints listed above. When in doubt, REMOVE the track.

DO NOT include any text outside the JSON.`;

      try {
        const vibeCheckResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: vibeCheckPrompt
          }]
        });

        let vibeCheckText = vibeCheckResponse.content[0].text.trim();
        // Handle markdown code blocks
        if (vibeCheckText.startsWith('```json')) {
          vibeCheckText = vibeCheckText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
        } else if (vibeCheckText.startsWith('```')) {
          vibeCheckText = vibeCheckText.replace(/^```\n?/, '').replace(/\n?```$/, '');
        }
        const vibeCheckData = JSON.parse(vibeCheckText);

        if (vibeCheckData.vibeIssues && vibeCheckData.vibeIssues.length > 0) {
          console.log(`Vibe check found ${vibeCheckData.vibeIssues.length} tracks that don't fit the vibe:`);
          vibeCheckData.vibeIssues.forEach(issue => {
            const _issuedTrack = selectedTracks[issue.index - 1];
            const _issueSrc = _issuedTrack?._source || 'unknown-source';
            const _issueEnergy = _issuedTrack?._scEnergy != null ? ` energy: ${_issuedTrack._scEnergy.toFixed(2)}` : ' energy: n/a';
            console.log(`  ❌ VIBE_CHECK removed: "${issue.trackName}" [source: ${_issueSrc},${_issueEnergy}] — ${issue.reason}`);
          });

          // Filter to only keep tracks that passed the vibe check
          const tracksAfterVibeCheck = vibeCheckData.keepIndices
            .map(index => selectedTracks[index - 1])
            .filter(track => track !== undefined);

          console.log(`After vibe check: ${tracksAfterVibeCheck.length} tracks remain (removed ${selectedTracks.length - tracksAfterVibeCheck.length} tracks)`);

          // If vibe check was too aggressive (removed more than half), fall back to
          // the pre-vibe-check selection so we don't end up with far too few songs.
          if (tracksAfterVibeCheck.length < songCount / 2 && tracksAfterVibeCheck.length < selectedTracks.length) {
            console.warn(`Vibe check too aggressive (${tracksAfterVibeCheck.length}/${songCount}), reverting to pre-vibe-check selection`);
            selectedTracks = selectedTracks.slice(0, songCount);
          } else if (tracksAfterVibeCheck.length > songCount) {
            selectedTracks = tracksAfterVibeCheck.slice(0, songCount);
            console.log(`Trimmed to target count: ${selectedTracks.length} songs (${tracksAfterVibeCheck.length - selectedTracks.length} extra removed)`);
          } else if (tracksAfterVibeCheck.length < songCount) {
            // If still below target after vibe check, try to backfill from remaining pool
            console.log(`Below target count (${tracksAfterVibeCheck.length}/${songCount}), attempting to backfill from remaining tracks...`);

            // Exclude both surviving tracks AND vibe-check-rejected tracks from backfill pool.
            // Only backfill from tracks that were never evaluated (not in the original selection).
            const vibeCheckedIds = new Set(selectedTracks.map(t => t.id));
            const remainingTracks = tracksForSelection.filter(t => {
              if (vibeCheckedIds.has(t.id)) return false;
              // Apply catalog context overrides — override-filtered tracks are not in vibeCheckedIds
              // so they would otherwise re-enter here from the full tracksForSelection pool.
              const _bfKey = `${(t.artist || '').toLowerCase()}::${(t.name || '').toLowerCase()}`;
              const _bfOverride = TRACK_CONTEXT_OVERRIDES[_bfKey];
              if (_bfOverride) {
                const _bfMoodOk = !genreData.mood || _bfOverride.requiredMoods.includes(genreData.mood);
                const _bfEnergyOk = !genreData.energyTarget || _bfOverride.requiredEnergies.includes(genreData.energyTarget);
                if (!_bfMoodOk || !_bfEnergyOk) {
                  console.log(`🚫 [CATALOG-OVERRIDE/BACKFILL] Skipping "${t.name}" by ${t.artist} — ${_bfOverride.reason}`);
                  return false;
                }
              }
              return true;
            });

            if (remainingTracks.length > 0) {
              const neededCount = songCount - tracksAfterVibeCheck.length;
              console.log(`Need ${neededCount} more tracks, ${remainingTracks.length} available in pool`);

              // Take more tracks than needed to allow for filtering
              const backfillCandidates = remainingTracks.slice(0, neededCount * 3);

              // If underground preference, run vibe check on backfill candidates to filter mainstream artists
              if (genreData.trackConstraints.popularity.preference === 'underground' && backfillCandidates.length > 0) {
                console.log(`Underground preference detected, running vibe check on ${backfillCandidates.length} backfill candidates...`);

                const backfillVibeCheckPrompt = `You are filtering backfill tracks for an underground/indie playlist.

Original user request: "${prompt}"

The user requested artists like "Pete Bailey" and "Energy Shift Radio" - these are PURE INDIE/UNDERGROUND artists with minimal mainstream recognition.

Backfill candidate tracks:
${backfillCandidates.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist || 'Unknown Artist'}`).join('\n')}

CRITICAL FILTERING RULES:
1. REMOVE any artist that:
   - Has had ANY radio hits or chart success (Top 40, Hot 100, etc.)
   - Has millions of monthly Spotify listeners
   - Is signed to a major label (RCA, Columbia, Atlantic, Interscope, Def Jam, etc.)
   - Has collaborated with mainstream artists (Drake, The Weeknd, Travis Scott, etc.)
   - Is commonly known outside of underground/indie R&B circles
   - Has any songs with over 100M streams

2. KEEP ONLY artists that:
   - Are truly underground/indie like Pete Bailey, Energy Shift Radio
   - Have minimal mainstream recognition
   - Are independent or on small indie labels
   - Would be considered "deep cuts" or "hidden gems"

3. BE EXTREMELY STRICT: When in doubt, REMOVE the track. We prefer 5 true underground tracks over 15 tracks with ANY mainstream artists.

Examples of artists to REMOVE (not exhaustive): SZA, Miguel, Khalid, Daniel Caesar, H.E.R., Summer Walker, Brent Faiyaz, Drake, The Weeknd, Jhené Aiko, Kehlani, Frank Ocean, Tyler the Creator, Steve Lacy, Kali Uchis, Tinashe, Normani, 6LACK, Giveon, Ari Lennox, Ella Mai, Snoh Aalegra, Michael Jackson, Usher, Chris Brown, Cassie, 112, Ginuwine, Ty Dolla $ign, Sonder, Jorja Smith, etc.

Return ONLY a valid JSON array of track numbers to KEEP (underground tracks only). Example: [1, 3, 5]`;

                try {
                  const backfillVibeResponse = await anthropic.messages.create({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 2000,
                    temperature: 0.3,
                    messages: [{
                      role: 'user',
                      content: backfillVibeCheckPrompt
                    }]
                  });

                  const backfillVibeContent = backfillVibeResponse.content[0].text.trim()
                    .replace(/^```json\n?/, '').replace(/\n?```$/, '')
                    .replace(/^```\n?/, '').replace(/\n?```$/, '');

                  // Match empty array [] or array with numbers [1, 2, 3]
                  const backfillJsonMatch = backfillVibeContent.match(/\[([\d,\s]*)\]/);

                  if (backfillJsonMatch) {
                    const backfillKeepIndices = JSON.parse(backfillJsonMatch[0]);

                    // If Claude returned empty array, it means ALL tracks are mainstream - don't add any
                    if (backfillKeepIndices.length === 0) {
                      console.log(`Backfill vibe check: Claude found NO underground tracks in ${backfillCandidates.length} candidates - all are mainstream`);
                      console.log(`Not adding any backfill tracks to preserve underground-only playlist`);
                    } else {
                      const backfillFilteredTracks = backfillKeepIndices
                        .map(idx => backfillCandidates[idx - 1])
                        .filter(track => track !== undefined)
                        .slice(0, neededCount); // Take only what we need

                      console.log(`Backfill vibe check: kept ${backfillFilteredTracks.length}/${backfillCandidates.length} underground tracks`);
                      tracksAfterVibeCheck.push(...backfillFilteredTracks);
                      console.log(`Backfilled ${backfillFilteredTracks.length} underground tracks to reach ${tracksAfterVibeCheck.length} total`);
                    }
                  } else {
                    // Fallback: for underground preference, don't add unfiltered tracks
                    console.log(`Backfill vibe check failed to parse. Response was: ${backfillVibeContent.substring(0, 500)}`);
                    if (genreData.trackConstraints.popularity.preference !== 'underground') {
                      const backfillTracks = backfillCandidates.slice(0, neededCount);
                      tracksAfterVibeCheck.push(...backfillTracks);
                      console.log(`Backfill vibe check failed to parse, added ${backfillTracks.length} tracks without filtering`);
                    } else {
                      console.log(`Underground preference: not adding unfiltered mainstream tracks`);
                    }
                  }
                } catch (error) {
                  console.error('Error during backfill vibe check:', error.message);
                  // For underground preference, don't add unfiltered tracks on error
                  if (genreData.trackConstraints.popularity.preference !== 'underground') {
                    const backfillTracks = backfillCandidates.slice(0, neededCount);
                    tracksAfterVibeCheck.push(...backfillTracks);
                    console.log(`Backfill vibe check error, added ${backfillTracks.length} tracks without filtering`);
                  } else {
                    console.log(`Underground preference: not adding unfiltered tracks after error`);
                  }
                }
              } else {
                // No underground preference, just backfill normally
                const backfillTracks = backfillCandidates.slice(0, neededCount);
                tracksAfterVibeCheck.push(...backfillTracks);
                console.log(`Backfilled ${backfillTracks.length} tracks to reach ${tracksAfterVibeCheck.length} total`);
              }
            }

            selectedTracks = tracksAfterVibeCheck;
          } else {
            // Exactly at target
            selectedTracks = tracksAfterVibeCheck;
          }
        } else {
          console.log('Vibe check passed - all tracks fit the intended atmosphere');
        }
      } catch (vibeCheckError) {
        console.log('Vibe check failed or could not parse, keeping original selection:', vibeCheckError.message);
        // Continue with original selection if vibe check fails
      }
    } else {
      console.log('Skipping vibe check (no specific atmosphere/context requirements)');
    }

    // ── Fix 2: Force-include 1-2 songs from each explicitly requested artist ──
    // If the user named specific artists in their prompt but none of their songs
    // survived the pool/vibe-check pipeline, inject them now.
    // Platform-aware: uses Spotify catalog for Spotify users, Apple Music catalog for Apple users.
    try {
      const requestedArtists = (genreData.artistConstraints?.requestedArtists || [])
        .filter(a => a && typeof a === 'string');

      const canForceInclude = requestedArtists.length > 0 &&
        (platform !== 'apple' ? !!appSpotify : !!AppleMusicService);

      if (canForceInclude) {
        const normalizeArtist = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

        // Apple Music search service (only needed for apple platform)
        let appleMusicApiForForce = null;
        if (platform === 'apple') {
          const devToken = generateAppleMusicToken();
          if (devToken) appleMusicApiForForce = new AppleMusicService(devToken);
        }

        // Build a set of artist names already in the playlist
        const presentArtists = new Set(
          selectedTracks.map(t => normalizeArtist(t.artist || ''))
        );

        const targetCount = genreData.songCount || songCount || 20;
        const existingIds = new Set(selectedTracks.map(t => t.id).filter(Boolean));

        for (const artistName of requestedArtists) {
          const normName = normalizeArtist(artistName);
          if (presentArtists.has(normName)) continue; // already represented

          console.log(`[FORCE-INCLUDE] "${artistName}" not in playlist — searching for top track`);
          try {
            let match = null;

            if (platform === 'apple' && appleMusicApiForForce) {
              // Apple Music: search by artist name, pick first result that matches artist
              const storefront = tokens?.storefront || 'us';
              const candidates = await appleMusicApiForForce.searchTracks(`${artistName}`, storefront, 10);
              match = candidates.find(track => {
                const primaryArtist = normalizeArtist(track.artists?.[0]?.name || '');
                return primaryArtist === normName ||
                  primaryArtist.includes(normName) ||
                  normName.includes(primaryArtist);
              });
            } else if (appSpotify) {
              // Spotify: use artist: filter for precision
              const searchResult = await appSpotify.searchTracks(`artist:${artistName}`, { limit: 10, market: 'US' });
              const candidates = searchResult?.tracks?.items || [];
              match = candidates.find(track => {
                const primaryArtist = normalizeArtist(track.artists?.[0]?.name || '');
                return primaryArtist === normName ||
                  primaryArtist.includes(normName) ||
                  normName.includes(primaryArtist);
              });
            }

            // Skip explicit tracks if user wants clean content
            if (match && !allowExplicit && match.explicit) {
              console.log(`[FORCE-INCLUDE] Skipping explicit track "${match.name}" (clean mode)`);
              match = null;
            }

            if (match && !existingIds.has(match.id)) {
              const injectTrack = platform === 'apple' ? {
                id: match.id,
                name: match.name,
                artist: match.artists?.[0]?.name || artistName,
                album: match.album?.name || '',
                uri: match.uri, // already 'apple:track:...'
                source: 'force_include',
              } : {
                id: match.id,
                name: match.name,
                artist: match.artists.map(a => a.name).join(', '),
                album: match.album?.name || '',
                uri: match.uri, // 'spotify:track:...'
                popularity: match.popularity,
                source: 'force_include',
              };
              if (selectedTracks.length >= targetCount) {
                selectedTracks[selectedTracks.length - 1] = injectTrack;
                console.log(`[FORCE-INCLUDE] Replaced last track with "${match.name}" by ${injectTrack.artist}`);
              } else {
                selectedTracks.push(injectTrack);
                console.log(`[FORCE-INCLUDE] Appended "${match.name}" by ${injectTrack.artist}`);
              }
              existingIds.add(match.id);
              presentArtists.add(normName);
            } else {
              console.log(`[FORCE-INCLUDE] No suitable match found for "${artistName}"`);
            }
          } catch (forceErr) {
            console.log(`[FORCE-INCLUDE] Search failed for "${artistName}":`, forceErr.message);
          }
        }
      }
    } catch (forceIncludeErr) {
      console.log('[FORCE-INCLUDE] Skipped due to error:', forceIncludeErr.message);
    }

    // ── Final excluded-artist sweep ─��──────────────────────────��───────────────���
    // Hard-remove any track by an excluded artist — runs AFTER force-include so
    // a force-include can never smuggle in a banned artist.
    const _finalExcludedNorms = (genreData.artistConstraints?.excludedArtists || [])
      .map(a => a.toLowerCase().replace(/[^a-z0-9]/g, ''))
      .filter(Boolean);
    if (_finalExcludedNorms.length > 0) {
      const beforeSweep = selectedTracks.length;
      selectedTracks = selectedTracks.filter(t => {
        // Check all credited artists, not just primary
        const _norms = [
          ...(t.artists || []).map(a => (a.name || '').toLowerCase().replace(/[^a-z0-9]/g, '')),
          (t.artist || '').toLowerCase().replace(/[^a-z0-9]/g, ''),
        ].filter(Boolean);
        return !_finalExcludedNorms.some(ex => _norms.some(n => n === ex || n.includes(ex) || ex.includes(n)));
      });
      const removed = beforeSweep - selectedTracks.length;
      if (removed > 0) {
        console.log(`🚫 Final excluded-artist sweep removed ${removed} track(s) for: ${genreData.artistConstraints.excludedArtists.join(', ')}`);
      }
    }

    // ── Multi-phase transition smoothing ────────────────────────────────────────
    // Reorder the 2-3 tracks around each phase boundary so energy shifts gradually
    // rather than cutting abruptly. A single Haiku call handles all boundaries.
    if (_phases && selectedTracks.length >= _phases.length * 2) {
      try {
        const phaseDesc = _phases.map(p => `"${p.label}" (${p.energy} energy${p.mood ? ', ' + p.mood : ''})`).join(' → ');
        const trackList = selectedTracks.map((t, i) =>
          `${i + 1}. "${t.name}" by ${t.artist} [phase: ${t._phaseLabel || 'unknown'}]`
        ).join('\n');
        const smoothRes = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 600,
          temperature: 0,
          messages: [{
            role: 'user',
            content: `Multi-phase playlist: ${phaseDesc}\n\nTrack list:\n${trackList}\n\nReorder to smooth energy transitions between phases:\n- Keep all same-phase tracks grouped together (never mix phases)\n- At each phase boundary, reorder the last 2 tracks of the outgoing phase and first 2 tracks of the incoming phase so energy shifts gradually (bridge tracks at end of phase A blend toward phase B energy, entry tracks at start of phase B start softer)\n\nReturn ONLY a JSON array of 1-based track numbers in the new order.`
          }]
        });
        const smoothText = smoothRes.content[0].text.trim()
          .replace(/^```json\n?/, '').replace(/\n?```$/, '');
        const smoothMatch = smoothText.match(/\[[\d,\s]+\]/);
        if (smoothMatch) {
          const order = JSON.parse(smoothMatch[0]);
          const reordered = order.map(idx => selectedTracks[idx - 1]).filter(Boolean);
          if (reordered.length >= Math.ceil(selectedTracks.length * 0.8)) {
            selectedTracks = reordered;
            console.log(`🌊 Phase transitions smoothed across ${_phases.length - 1} boundaries`);
          }
        }
      } catch (smoothErr) {
        console.log('[PHASE-SMOOTH] Transition smoothing skipped:', smoothErr.message);
      }
    }

    // ── Energy progression sequencing ──────────────────────────────────────────
    // For "build from chill → hype" or "peak then wind down" prompts, ask Claude
    // to reorder the final tracks by energy. Uses Haiku for speed.
    // Skipped for multi-phase — transition smoothing above handles sequencing.
    if (genreData.energyProgression && !_phases && selectedTracks.length >= 4) {
      try {
        const direction = genreData.energyProgression === 'ramp_up'
          ? 'low to high energy (chill/mellow first, intense/hype last)'
          : 'high to low energy (intense/hype first, chill/mellow last)';
        const trackList = selectedTracks.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist}`).join('\n');
        const seqResponse = await anthropic.messages.create({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 400,
          temperature: 0,
          messages: [{
            role: 'user',
            content: `Reorder these playlist tracks from ${direction}. Return ONLY a JSON array of the 1-based original track numbers in the new order. No explanation.\n\n${trackList}`
          }]
        });
        const seqText = seqResponse.content[0].text.trim()
          .replace(/^```json\n?/, '').replace(/\n?```$/, '');
        const seqMatch = seqText.match(/\[[\d,\s]+\]/);
        if (seqMatch) {
          const order = JSON.parse(seqMatch[0]);
          const reordered = order
            .map(idx => selectedTracks[idx - 1])
            .filter(Boolean);
          if (reordered.length >= Math.ceil(selectedTracks.length * 0.8)) {
            selectedTracks = reordered;
            console.log(`🎚️ Sequenced tracks ${genreData.energyProgression}: ${direction}`);
          }
        }
      } catch (seqErr) {
        console.log('[SEQUENCING] Skipped due to error:', seqErr.message);
      }
    }

    // Track artists from generated playlist to database for future filtering
    if (platformUserId && selectedTracks.length > 0) {
      try {
        const artistNames = [...new Set(selectedTracks.map(t => t.artist))];
        await db.trackArtists(platformUserId, artistNames);
        console.log(`✓ Tracked ${artistNames.length} artists from generated playlist to database`);
        // Invalidate artist recommendations cache so newly-heard artists are excluded on next load
        await db.deleteCachedArtists(platformUserId);
        console.log('✓ Invalidated artist recommendations cache after playlist generation');
      } catch (trackError) {
        console.log('Could not track artists to database:', trackError.message);
        // Don't block playlist generation if tracking fails
      }
    }

    // Update song history and playlist.tracks so future refreshes anchor to the new track list.
    // Skip for internal auto-update calls — processPlaylistUpdate's syncAfterPush handles it.
    if (playlistId && userId && !internalCall) {
      try {
        const upa = userPlaylists.get(userId) || [];
        const upi = upa.findIndex(p => p.playlistId === playlistId);
        if (upi !== -1) {
          const pl = upa[upi];
          if (!pl.songHistory) pl.songHistory = [];
          pl.songHistory = [...pl.songHistory, ...selectedTracks.map(t => `${normalizeForHistory(t.name)}|||${(t.artist || '').toLowerCase()}`)];
          if (pl.songHistory.length > 150) pl.songHistory = pl.songHistory.slice(-150);
          // Update playlist.tracks so the refresh anchor reflects the new track list
          pl.tracks = selectedTracks;
          pl.trackUris = selectedTracks.map(t => t.uri).filter(Boolean);
          userPlaylists.set(userId, upa);
          await savePlaylist(userId, pl);
          console.log(`[MANUAL-REFRESH] Song history updated — now ${pl.songHistory.length} tracks`);
        }
      } catch (histErr) {
        console.log('[MANUAL-REFRESH] Failed to update song history:', histErr.message);
      }
    }

    res.json({
      playlistName: claudePlaylistName,
      description: claudePlaylistDescription,
      tracks: selectedTracks,
      trackCount: selectedTracks.length
    });
    const _topSongsArtists = [...new Set(soundChartsDiscoveredSongs.map(s => s.artistName).filter(Boolean))];
    drainEnrichmentQueue(_topSongsArtists);

  } catch (error) {
    console.error('Error generating playlist:', error);
    res.status(500).json({ 
      error: 'Failed to generate playlist',
      details: error.message 
    });
  }
});

// Create playlist on Spotify
app.post('/api/create-playlist', async (req, res) => {
  try {
    let { userId, playlistName, description, trackUris, updateFrequency, updateMode, isPublic, prompt, chatMessages, excludedSongs, genreData } = req.body;

    console.log('Create playlist request:', {
      userId,
      playlistName,
      trackCount: trackUris?.length,
      updateFrequency,
      updateMode,
      isPublic
    });

    // Check if PlatformService loaded successfully
    if (!PlatformService) {
      console.error('PlatformService not available - service failed to load at startup');
      return res.status(500).json({
        error: 'Platform service is not available',
        details: 'The service failed to load. Please contact support.'
      });
    }

    // If userId is email-based, resolve to platform userId
    let platformUserId = userId;
    let platform = null;

    if (isEmailBasedUserId(userId)) {
      // Check which platform is actively connected
      const user = await db.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Use the actively connected platform (check Apple Music first for consistency with other endpoints)
      if (user.connectedPlatforms?.apple) {
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        platform = 'apple';
        console.log('Creating playlist on Apple Music for user:', platformUserId);
      } else if (user.connectedPlatforms?.spotify) {
        platformUserId = await resolvePlatformUserId(userId, 'spotify');
        platform = 'spotify';
        console.log('Creating playlist on Spotify for user:', platformUserId);
      }

      if (!platformUserId) {
        return res.status(404).json({ error: 'No music platform connected' });
      }
    } else {
      // For old platform-specific userIds, detect platform from prefix
      const platformService = new PlatformService();
      platform = platformService.getPlatform(platformUserId);
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      console.error('No tokens found for platformUserId:', platformUserId);
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log(`Creating playlist on ${platform}...`);

    // Create playlist using platform service
    const platformService = new PlatformService();
    const playlistResult = await platformService.createPlaylist(
      platformUserId,
      playlistName,
      description,
      trackUris,
      tokens,
      isPublic
    );

    console.log('Playlist created successfully!', playlistResult);

    // Store playlist in history
    const playlistRecord = {
      playlistId: playlistResult.id,
      playlistName: playlistResult.name,
      description: description,
      trackUris: trackUris,
      trackCount: trackUris.length,
      createdAt: new Date().toISOString(),
      spotifyUrl: platform === 'spotify' ? playlistResult.url : null,
      appleMusicUrl: platform === 'apple' ? playlistResult.url : null,
      platform: platform,
      image: null, // Can be populated later
      updateFrequency: updateFrequency || 'never',
      updateMode: updateMode || 'append',
      isPublic: isPublic !== undefined ? isPublic : true,
      originalPrompt: prompt,
      genreData: genreData, // Save genre data to preserve requested artists and constraints
      chatMessages: chatMessages || [],
      refinementInstructions: [],
      excludedSongs: excludedSongs || [],
      excludedArtists: [],
      lastUpdated: null,
      nextUpdate: updateFrequency && updateFrequency !== 'never' ? calculateNextUpdate(updateFrequency, playlistResult.id) : null,
      tracks: []
    };

    // Save playlist to database (use email userId for user-facing data)
    // Convert platform userId to email if needed
    const emailUserId = await getEmailUserIdFromPlatform(userId);
    console.log(`Saving playlist for userId: ${userId}, resolved to email: ${emailUserId}`);
    await savePlaylist(emailUserId, playlistRecord);

    console.log('Playlist saved to history');

    res.json({
      success: true,
      playlistUrl: playlistResult.url,
      playlistId: playlistResult.id,
      platform: platform
    });

  } catch (error) {
    console.error('Error creating playlist:', error);
    console.error('Error details:', {
      message: error.message,
      status: error.status
    });
    res.status(500).json({
      error: 'Failed to create playlist',
      details: error.message
    });
  }
});

// Save draft playlist (auto-save before creating in Spotify)
app.post('/api/drafts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { draftData } = req.body;

    // Use existing draft-* ID if present; otherwise generate a new one.
    // NEVER reuse a live playlist ID (e.g. a Spotify/Apple playlist ID that doesn't start
    // with "draft-") as the DB key — doing so upserts over the live record with isDraft:true
    // and causes the playlist to vanish from the playlists page.
    const existingDraftId = draftData.draftId;
    const draftId = (existingDraftId && existingDraftId.startsWith('draft-'))
      ? existingDraftId
      : `draft-${Date.now()}`;

    // Save draft to database
    await savePlaylist(userId, {
      ...draftData,
      playlistId: draftId,
      isDraft: true
    });

    console.log(`Saved draft ${draftId} for user ${userId}`);

    res.json({
      success: true,
      draftId,
      message: 'Draft saved successfully'
    });
  } catch (error) {
    console.error('Error saving draft:', error);
    res.status(500).json({
      error: 'Failed to save draft',
      details: error.message
    });
  }
});

// Get user's draft playlists
app.get('/api/drafts/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    console.log(`[DRAFTS] Loading drafts for user ${userId}`);

    let allPlaylists;

    if (usePostgres) {
      // PostgreSQL: Load from database to ensure cross-device sync
      allPlaylists = await db.getUserPlaylists(userId);
    } else {
      // SQLite: Load from in-memory Map
      allPlaylists = userPlaylists.get(userId) || [];
    }

    console.log(`[DRAFTS] Retrieved ${allPlaylists.length} total playlists`);

    // Filter for drafts only - handle cases where isDraft might be undefined
    const drafts = allPlaylists.filter(p => p && p.isDraft === true);

    console.log(`[DRAFTS] Filtered to ${drafts.length} drafts for user ${userId}`);

    res.json({ drafts });
  } catch (error) {
    console.error('[DRAFTS] Error retrieving drafts:', error);
    console.error('[DRAFTS] Error stack:', error.stack);
    res.status(500).json({
      error: 'Failed to retrieve drafts',
      details: error.message,
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Delete draft playlist
app.delete('/api/drafts/:userId/:draftId', async (req, res) => {
  try {
    const { userId, draftId } = req.params;

    // Safety guard: only delete records whose DB key is a draft-* ID.
    // A live playlist ID (Spotify/Apple) should never be deletable via this endpoint.
    if (!draftId.startsWith('draft-')) {
      console.warn(`[DRAFTS] Refusing to delete non-draft ID "${draftId}" via drafts endpoint`);
      return res.status(400).json({ error: 'Invalid draft ID — can only delete draft-* records via this endpoint' });
    }

    const userPlaylistHistory = userPlaylists.get(userId) || [];
    const updatedPlaylists = userPlaylistHistory.filter(p => p.playlistId !== draftId);
    userPlaylists.set(userId, updatedPlaylists);

    // Also delete from database
    await db.deletePlaylist(userId, draftId);

    console.log(`Deleted draft ${draftId} for user ${userId}`);

    res.json({ success: true, message: 'Draft deleted successfully' });
  } catch (error) {
    console.error('Error deleting draft:', error);
    res.status(500).json({
      error: 'Failed to delete draft',
      details: error.message
    });
  }
});

// Get user's playlist history
app.get('/api/playlists/:userId', async (req, res) => {
  try {
    let { userId } = req.params;

    let allPlaylists;

    if (usePostgres) {
      // PostgreSQL: Load from database to ensure cross-device sync
      allPlaylists = await db.getUserPlaylists(userId);
      console.log(`Loaded ${allPlaylists.length} playlists from database for user: ${userId}`);
    } else {
      // SQLite: Load from in-memory Map
      allPlaylists = userPlaylists.get(userId) || [];
      console.log(`Loaded ${allPlaylists.length} playlists from memory for user: ${userId}`);
    }

    // Filter out drafts - only return playlists that have been published to platform
    const userPlaylistHistory = allPlaylists.filter(p => p && p.isDraft !== true);
    console.log(`After filtering drafts: ${userPlaylistHistory.length} playlists`);

    // Determine which platform the user is connected to based on their active platform setting
    let platformUserId = userId;
    let platform = null;

    if (isEmailBasedUserId(userId)) {
      // Check which platform is actively connected
      const user = await db.getUser(userId);
      if (!user) {
        console.log('User not found for email:', userId);
        return res.json({ playlists: [] });
      }

      // Use the actively connected platform
      if (user.connectedPlatforms?.apple) {
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        platform = 'apple';
        console.log('User has Apple Music active, resolved to:', platformUserId);
      } else if (user.connectedPlatforms?.spotify) {
        platformUserId = await resolvePlatformUserId(userId, 'spotify');
        platform = 'spotify';
        console.log('User has Spotify active, resolved to:', platformUserId);
      }

      if (!platformUserId) {
        // User doesn't have any platform connected — return stored playlists in read-only mode
        console.log('No music platform connection found for email:', userId, '— returning stored playlists as read-only');
        const readOnlyPlaylists = userPlaylistHistory.map(playlist => ({
          ...playlist,
          tracks: [],
          trackCount: playlist.trackCount || 0,
          isReadOnly: true,
          readOnlyReason: 'Connect a music platform to view and manage this playlist.'
        }));
        return res.json({ playlists: readOnlyPlaylists });
      }
    } else {
      // Direct platform userId
      if (userId.startsWith('spotify_')) {
        platform = 'spotify';
      } else if (userId.startsWith('apple_music_')) {
        platform = 'apple';
      }
    }

    // Get user tokens
    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    let playlistsWithDetails;

    if (platform === 'spotify') {
      // Spotify: Fetch playlists using Spotify API
      const userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);

      // Refresh token if needed
      try {
        const refreshData = await userSpotifyApi.refreshAccessToken();
        const newAccessToken = refreshData.body.access_token;
        userSpotifyApi.setAccessToken(newAccessToken);
        tokens.access_token = newAccessToken;
        userTokens.set(platformUserId, tokens);
        // Save updated token to database
        await db.updateAccessToken(platformUserId, newAccessToken);
      } catch (refreshError) {
        console.log('Token refresh failed or not needed:', refreshError.message);
      }

      // Fetch detailed track info for each playlist
      playlistsWithDetails = await Promise.all(
        userPlaylistHistory.map(async (playlist) => {
          // Check if this playlist matches the active platform
          if (playlist.platform && playlist.platform !== 'spotify') {
            // This is a playlist from a different platform (e.g., Apple Music)
            // Return it in read-only mode with stored information
            console.log(`Playlist ${playlist.playlistId} is from ${playlist.platform}, showing in read-only mode`);
            return {
              ...playlist,
              tracks: [],
              trackCount: playlist.trackCount || 0,
              isReadOnly: true,
              readOnlyReason: `This playlist is from ${playlist.platform === 'apple' ? 'Apple Music' : playlist.platform}. Connect to ${playlist.platform === 'apple' ? 'Apple Music' : playlist.platform} to view details.`
            };
          }

          try {
            // Get playlist details from Spotify
            const playlistDetails = await userSpotifyApi.getPlaylist(playlist.playlistId);

            // Create maps for quick lookup of reactions
            const likedSongsMap = new Map((playlist.likedSongs || []).map(s => [s.id, s]));
            const dislikedSongsMap = new Map((playlist.dislikedSongs || []).map(s => [s.id, s]));

            // Build excluded set (minus-button removes + dislikes) as safety net in case Spotify API removal failed
            const excludedSongsSet = new Set([
              ...(playlist.excludedSongs || []).map(s => s.id || s),
              ...Array.from(dislikedSongsMap.keys()),
            ]);

            const tracks = playlistDetails.body.tracks.items
              .filter(item => item.track && !excludedSongsSet.has(item.track.id))
              .map(item => {
                const trackId = item.track.id;
                const reaction = likedSongsMap.has(trackId) ? 'thumbsUp' : null;

                return {
                  id: trackId,
                  name: item.track.name,
                  artist: item.track.artists[0].name,
                  uri: item.track.uri,
                  album: item.track.album.name,
                  image: item.track.album.images[0]?.url,
                  externalUrl: item.track.external_urls.spotify,
                  explicit: item.track.explicit,
                  platform: 'spotify',
                  reaction: reaction
                };
              });

            return {
              ...playlist,
              tracks: tracks,
              trackCount: tracks.length,
              image: playlistDetails.body.images?.length > 0 ? playlistDetails.body.images[0].url : playlist.image
            };
          } catch (error) {
            console.error(`Error fetching Spotify playlist ${playlist.playlistId}:`, error.message);
            // Return playlist without detailed tracks if fetch fails
            return {
              ...playlist,
              tracks: [],
              error: 'Could not fetch current tracks',
              fetchError: error.message
            };
          }
        })
      );
    } else if (platform === 'apple') {
      // Apple Music: Fetch playlists using Apple Music API
      if (!AppleMusicService) {
        console.error('Apple Music service not available');
        return res.status(500).json({ error: 'Apple Music service not available' });
      }

      const appleMusicDevToken = generateAppleMusicToken();
      if (!appleMusicDevToken) {
        console.error('Failed to generate Apple Music developer token');
        return res.status(500).json({ error: 'Apple Music service unavailable' });
      }

      const appleMusicApi = new AppleMusicService(appleMusicDevToken);

      // Fetch detailed track info for each Apple Music playlist
      playlistsWithDetails = await Promise.all(
        userPlaylistHistory.map(async (playlist) => {
          // Check if this playlist matches the active platform
          if (playlist.platform && playlist.platform !== 'apple') {
            // This is a playlist from a different platform (e.g., Spotify)
            // Return it in read-only mode with stored information
            console.log(`Playlist ${playlist.playlistId} is from ${playlist.platform}, showing in read-only mode`);
            return {
              ...playlist,
              tracks: [],
              trackCount: playlist.trackCount || 0,
              isReadOnly: true,
              readOnlyReason: `This playlist is from ${playlist.platform === 'spotify' ? 'Spotify' : playlist.platform}. Connect to ${playlist.platform === 'spotify' ? 'Spotify' : playlist.platform} to view details.`
            };
          }

          try {
            // If playlist doesn't have an image, fetch playlist details to get it
            let playlistImage = playlist.image;
            if (!playlistImage) {
              try {
                const playlistDetails = await appleMusicApi.getPlaylist(tokens.access_token, playlist.playlistId);
                playlistImage = playlistDetails.image;
                // Update the stored playlist with the image
                if (playlistImage) {
                  playlist.image = playlistImage;
                  await savePlaylist(userId, playlist);
                }
              } catch (imageError) {
                console.log(`Could not fetch image for playlist ${playlist.playlistId}:`, imageError.message);
              }
            }

            // Get playlist tracks from Apple Music
            const tracks = await appleMusicApi.getPlaylistTracks(tokens.access_token, playlist.playlistId);

            // Create maps for quick lookup of reactions
            const likedSongsMap = new Map((playlist.likedSongs || []).map(s => [s.id, s]));
            const dislikedSongsMap = new Map((playlist.dislikedSongs || []).map(s => [s.id, s]));

            // Build excluded songs set (from both minus-button removes and dislike)
            const excludedSongsSet = new Set([
              ...(playlist.excludedSongs || []).map(s => s.id || s),
              ...Array.from(dislikedSongsMap.keys()),
            ]);

            const tracksWithDetails = tracks
              .filter(track => !excludedSongsSet.has(track.id)) // hide disliked/removed songs (can't remove via API)
              .map(track => {
                const trackId = track.id;
                const reaction = likedSongsMap.has(trackId) ? 'thumbsUp' : null;

                return {
                  id: trackId,
                  name: track.name,
                  artist: track.artists[0].name,
                  uri: track.uri,
                  album: track.album.name,
                  image: track.album.images?.[0]?.url || null,
                  externalUrl: track.url || null,
                  explicit: track.explicit,
                  platform: 'apple',
                  reaction: reaction
                };
              });

            return {
              ...playlist,
              tracks: tracksWithDetails,
              trackCount: tracksWithDetails.length,
              image: playlistImage || null
            };
          } catch (error) {
            console.error(`Error fetching Apple Music playlist ${playlist.playlistId}:`, error.message);
            // Return playlist without detailed tracks if fetch fails
            return {
              ...playlist,
              tracks: [],
              error: 'Could not fetch current tracks',
              fetchError: error.message
            };
          }
        })
      );
    }

    res.json({ playlists: playlistsWithDetails });
  } catch (error) {
    console.error('Error fetching playlists:', error);
    res.status(500).json({
      error: 'Failed to fetch playlists',
      details: error.message
    });
  }
});

// Get user's Spotify playlists for import
// Platform-agnostic get playlists from music service
app.get('/api/platform-playlists/:userId', async (req, res) => {
  try {
    let { userId } = req.params;

    // Check if PlatformService loaded successfully
    if (!PlatformService) {
      console.error('PlatformService not available - service failed to load at startup');
      return res.status(500).json({
        error: 'Platform service is not available',
        details: 'The service failed to load. Please contact support.'
      });
    }

    // If userId is email-based, resolve to platform userId based on which platform is actively connected
    let platformUserId = userId;
    if (isEmailBasedUserId(userId)) {
      // Check which platform is actively connected
      const user = await db.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Use the actively connected platform
      if (user.connectedPlatforms?.apple) {
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        console.log('User has Apple Music active, resolved to:', platformUserId);
      } else if (user.connectedPlatforms?.spotify) {
        platformUserId = await resolvePlatformUserId(userId, 'spotify');
        console.log('User has Spotify active, resolved to:', platformUserId);
      }

      if (!platformUserId) {
        return res.status(404).json({ error: 'No music platform connected' });
      }
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const platformService = new PlatformService();
    const platform = platformService.getPlatform(platformUserId);

    // Get playlists using platform service
    const playlists = await platformService.getPlaylists(platformUserId, tokens);

    res.json({ playlists, platform });
  } catch (error) {
    console.error('Error fetching playlists:', error.message || error);
    res.status(500).json({
      error: 'Failed to fetch playlists',
      details: error.message || 'Unknown error'
    });
  }
});

// Legacy Spotify playlists endpoint (kept for backwards compatibility)
app.get('/api/spotify-playlists/:userId', async (req, res) => {
  try {
    let { userId } = req.params;

    // If userId is email-based, resolve to Spotify platform userId
    let platformUserId = userId;
    if (isEmailBasedUserId(userId)) {
      platformUserId = await resolvePlatformUserId(userId, 'spotify');
      if (!platformUserId) {
        return res.status(404).json({ error: 'Spotify not connected' });
      }
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const userSpotifyApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
    });
    userSpotifyApi.setAccessToken(tokens.access_token);
    userSpotifyApi.setRefreshToken(tokens.refresh_token);

    // Refresh token if needed
    try {
      const refreshData = await userSpotifyApi.refreshAccessToken();
      const newAccessToken = refreshData.body.access_token;
      userSpotifyApi.setAccessToken(newAccessToken);
      tokens.access_token = newAccessToken;
      userTokens.set(platformUserId, tokens);
      await db.updateAccessToken(platformUserId, newAccessToken);
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
    }

    // Get user's playlists from Spotify
    const playlistsData = await userSpotifyApi.getUserPlaylists({ limit: 50 });

    const playlists = playlistsData.body.items.map(playlist => ({
      id: playlist.id,
      name: playlist.name,
      description: playlist.description,
      trackCount: playlist.tracks.total,
      image: playlist.images?.length > 0 ? playlist.images[0].url : null,
      spotifyUrl: playlist.external_urls.spotify,
      owner: playlist.owner.display_name,
      isOwner: playlist.owner.id === platformUserId.replace('spotify_', '')
    }));

    res.json({ playlists });
  } catch (error) {
    console.error('Error fetching Spotify playlists:', error.message || error);
    res.status(500).json({
      error: 'Failed to fetch Spotify playlists',
      details: error.message || 'Unknown error'
    });
  }
});

// Import a Spotify playlist
app.post('/api/import-playlist', async (req, res) => {
  try {
    let { userId, playlistId } = req.body;

    // Determine which platform the user is connected to
    let platformUserId = userId;
    let platform = null;

    if (isEmailBasedUserId(userId)) {
      // Check which platform is actively connected
      const user = await db.getUser(userId);
      if (!user) {
        return res.status(404).json({ error: 'User not found' });
      }

      // Use the actively connected platform
      if (user.connectedPlatforms?.apple) {
        platformUserId = await resolvePlatformUserId(userId, 'apple');
        platform = 'apple';
        console.log('Importing from Apple Music for user:', platformUserId);
      } else if (user.connectedPlatforms?.spotify) {
        platformUserId = await resolvePlatformUserId(userId, 'spotify');
        platform = 'spotify';
        console.log('Importing from Spotify for user:', platformUserId);
      }

      if (!platformUserId) {
        return res.status(404).json({ error: 'No music platform connected' });
      }
    } else {
      // Direct platform userId
      if (userId.startsWith('spotify_')) {
        platform = 'spotify';
      } else if (userId.startsWith('apple_music_')) {
        platform = 'apple';
      }
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    let playlistRecord;

    if (platform === 'spotify') {
      // Spotify import
      const userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);

      // Refresh token if needed
      try {
        const refreshData = await userSpotifyApi.refreshAccessToken();
        const newAccessToken = refreshData.body.access_token;
        userSpotifyApi.setAccessToken(newAccessToken);
        tokens.access_token = newAccessToken;
        userTokens.set(platformUserId, tokens);
        await db.updateAccessToken(platformUserId, newAccessToken);
      } catch (refreshError) {
        console.log('Token refresh failed or not needed:', refreshError.message);
      }

      // Get playlist details from Spotify
      const playlistDetails = await userSpotifyApi.getPlaylist(playlistId);
      const importedTracks = playlistDetails.body.tracks.items
        .filter(item => item.track && item.track.id)
        .map(item => ({
          id: item.track.id,
          name: item.track.name,
          artist: item.track.artists[0]?.name || 'Unknown',
          uri: item.track.uri,
          album: item.track.album?.name || '',
          image: item.track.album?.images?.[0]?.url || null,
          externalUrl: item.track.external_urls?.spotify || null,
          explicit: item.track.explicit || false
        }));
      const trackUris = importedTracks.map(t => t.uri);

      playlistRecord = {
        playlistId: playlistId,
        playlistName: playlistDetails.body.name,
        description: playlistDetails.body.description || '',
        image: playlistDetails.body.images?.length > 0 ? playlistDetails.body.images[0].url : null,
        tracks: importedTracks,
        trackUris: trackUris,
        trackCount: trackUris.length,
        createdAt: new Date().toISOString(),
        spotifyUrl: playlistDetails.body.external_urls.spotify,
        platform: 'spotify',
        imported: true
      };
    } else if (platform === 'apple') {
      // Apple Music import
      if (!AppleMusicService) {
        console.error('Apple Music service not available');
        return res.status(500).json({ error: 'Apple Music service not available' });
      }

      const appleMusicDevToken = generateAppleMusicToken();
      if (!appleMusicDevToken) {
        console.error('Failed to generate Apple Music developer token');
        return res.status(500).json({ error: 'Apple Music service unavailable' });
      }

      const appleMusicApi = new AppleMusicService(appleMusicDevToken);

      // Get playlist details and tracks from Apple Music
      const playlistDetails = await appleMusicApi.getPlaylist(tokens.access_token, playlistId);
      const tracks = await appleMusicApi.getPlaylistTracks(tokens.access_token, playlistId);
      const trackUris = tracks.map(track => track.uri);

      playlistRecord = {
        playlistId: playlistId,
        playlistName: playlistDetails.name,
        description: playlistDetails.description || '',
        image: playlistDetails.image || null,
        tracks: tracks,
        trackUris: trackUris,
        trackCount: trackUris.length,
        createdAt: new Date().toISOString(),
        appleMusicUrl: null,
        platform: 'apple',
        imported: true
      };
    }

    const userPlaylistHistory = userPlaylists.get(userId) || [];

    // Check if already imported
    const alreadyImported = userPlaylistHistory.some(p => p.playlistId === playlistId);
    if (alreadyImported) {
      return res.status(400).json({ error: 'Playlist already imported' });
    }

    userPlaylistHistory.push(playlistRecord);
    userPlaylists.set(userId, userPlaylistHistory);
    await savePlaylist(userId, playlistRecord);

    console.log(`${platform === 'apple' ? 'Apple Music' : 'Spotify'} playlist imported:`, playlistId);

    res.json({ success: true, playlist: playlistRecord });
  } catch (error) {
    console.error('Error importing playlist:', error);
    res.status(500).json({
      error: 'Failed to import playlist',
      details: error.message
    });
  }
});

// Get current tracks for a playlist from Spotify
app.get('/api/playlists/:playlistId/tracks', async (req, res) => {
  try {
    const { playlistId } = req.params;
    let { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    // If userId is email-based, resolve to Spotify platform userId
    let platformUserId = userId;
    if (isEmailBasedUserId(userId)) {
      platformUserId = await resolvePlatformUserId(userId, 'spotify');
      if (!platformUserId) {
        return res.status(404).json({ error: 'Spotify not connected' });
      }
    }

    const tokens = await getUserTokens(platformUserId);
    if (!tokens) {
      return res.status(401).json({ error: 'User not authenticated' });
    }

    const userSpotifyApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
    });
    userSpotifyApi.setAccessToken(tokens.access_token);
    userSpotifyApi.setRefreshToken(tokens.refresh_token);

    // Refresh token if needed
    try {
      const refreshData = await userSpotifyApi.refreshAccessToken();
      const newAccessToken = refreshData.body.access_token;
      userSpotifyApi.setAccessToken(newAccessToken);
      tokens.access_token = newAccessToken;
      userTokens.set(platformUserId, tokens);
      // Save updated token to database
      await db.updateAccessToken(platformUserId, newAccessToken);
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
    }

    // Get playlist details from Spotify
    const playlistDetails = await userSpotifyApi.getPlaylist(playlistId);
    const tracks = playlistDetails.body.tracks.items.map(item => ({
      id: item.track.id,
      name: item.track.name,
      artist: item.track.artists[0].name,
      uri: item.track.uri,
      album: item.track.album.name,
      image: item.track.album.images[0]?.url,
      externalUrl: item.track.external_urls.spotify,
      explicit: item.track.explicit
    }));

    res.json({ tracks });
  } catch (error) {
    console.error('Error fetching playlist tracks:', error);
    res.status(500).json({
      error: 'Failed to fetch playlist tracks',
      details: error.message
    });
  }
});

// Update playlist (add/remove tracks)
app.post('/api/playlists/:playlistId/update', async (req, res) => {
  try {
    const { playlistId } = req.params;
    let { userId, tracksToAdd, tracksToRemove } = req.body;

    console.log('Update playlist endpoint:', {
      playlistId,
      tracksToRemove: tracksToRemove?.length || 0,
      tracksToAdd: tracksToAdd?.length || 0,
      removeSample: tracksToRemove?.slice(0, 2),
      addSample: tracksToAdd?.slice(0, 2)
    });

    // Determine the playlist's platform
    const emailUserId = isEmailBasedUserId(userId) ? userId : await getEmailUserIdFromPlatform(userId);
    const playlistRecord = emailUserId ? await db.getPlaylist(emailUserId, playlistId) : null;
    const playlistPlatform = playlistRecord?.platform || 'spotify';

    if (playlistPlatform === 'apple') {
      // ── Apple Music update ──────────────────────────────────────
      let applePlatformUserId = userId;
      if (isEmailBasedUserId(userId)) {
        applePlatformUserId = await resolvePlatformUserId(userId, 'apple');
        if (!applePlatformUserId) {
          return res.status(404).json({ error: 'Apple Music not connected' });
        }
      }
      const appleTokens = await getUserTokens(applePlatformUserId);
      if (!appleTokens) {
        return res.status(401).json({ error: 'Apple Music not authenticated' });
      }
      const appleMusicDevToken = generateAppleMusicToken();
      if (!appleMusicDevToken) {
        return res.status(500).json({ error: 'Apple Music service unavailable' });
      }
      const appleMusicApiInstance = new AppleMusicService(appleMusicDevToken);

      // Guard: never destructively remove tracks when there are no new tracks to add.
      if ((!tracksToAdd || tracksToAdd.length === 0) && tracksToRemove && tracksToRemove.length > 0) {
        console.log(`⚠️  [UPDATE-GUARD] Skipping removal of ${tracksToRemove.length} tracks (Apple Music) — no new tracks to add. Aborting update.`);
        return res.json({ success: true, skipped: true, reason: 'no_tracks_to_add' });
      }

      if (tracksToRemove && tracksToRemove.length > 0) {
        const urisToRemove = tracksToRemove.map(t => t.uri || t);
        await appleMusicApiInstance.deleteTracksFromPlaylist(appleTokens.access_token, playlistId, urisToRemove);
        console.log(`Removed ${tracksToRemove.length} track(s) from Apple Music playlist ${playlistId}`);
      }

      if (tracksToAdd && tracksToAdd.length > 0) {
        // Convert apple:track:ID URIs to plain IDs
        const trackIds = tracksToAdd.map(uri =>
          typeof uri === 'string' && uri.startsWith('apple:track:') ? uri.replace('apple:track:', '') : uri
        ).filter(Boolean);
        if (trackIds.length > 0) {
          await appleMusicApiInstance.addTracksToPlaylist(appleTokens.access_token, playlistId, trackIds);
          console.log(`Added ${trackIds.length} tracks to Apple Music playlist ${playlistId}`);
        }
      }
    } else {
      // ── Spotify update ──────────────────────────────────────────
      let platformUserId = userId;
      if (isEmailBasedUserId(userId)) {
        platformUserId = await resolvePlatformUserId(userId, 'spotify');
        if (!platformUserId) {
          return res.status(404).json({ error: 'Spotify not connected' });
        }
      }

      const tokens = await getUserTokens(platformUserId);
      if (!tokens) {
        return res.status(401).json({ error: 'User not authenticated' });
      }

      const userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);

      // Refresh token if needed
      try {
        const refreshData = await userSpotifyApi.refreshAccessToken();
        const newAccessToken = refreshData.body.access_token;
        userSpotifyApi.setAccessToken(newAccessToken);
        tokens.access_token = newAccessToken;
        userTokens.set(platformUserId, tokens);
        await db.updateAccessToken(platformUserId, newAccessToken);
      } catch (refreshError) {
        console.log('Token refresh failed or not needed:', refreshError.message);
      }

      // Guard: never destructively remove tracks when there are no new tracks to add.
      // This prevents a bad auto-update from wiping a playlist when 0 songs were generated.
      if ((!tracksToAdd || tracksToAdd.length === 0) && tracksToRemove && tracksToRemove.length > 0) {
        console.log(`⚠️  [UPDATE-GUARD] Skipping removal of ${tracksToRemove.length} tracks — no new tracks to add. Aborting update.`);
        return res.json({ success: true, skipped: true, reason: 'no_tracks_to_add' });
      }

      // If we're both removing and adding tracks, use replace API for better performance
      if (tracksToRemove && tracksToRemove.length > 0 && tracksToAdd && tracksToAdd.length > 0) {
        const validTracksToAdd = tracksToAdd.filter(isValidSpotifyTrackUri);
        if (validTracksToAdd.length > 0) {
          console.log(`Replacing all tracks in playlist ${playlistId} with ${validTracksToAdd.length} new tracks`);
          try {
            await userSpotifyApi.replaceTracksInPlaylist(playlistId, validTracksToAdd);
            console.log(`Successfully replaced tracks in playlist ${playlistId}`);
          } catch (replaceErr) {
            console.error(`Error replacing tracks: ${replaceErr.message}`);
            throw replaceErr;
          }
        }
      } else {
        // Separate remove and add operations
        if (tracksToRemove && tracksToRemove.length > 0) {
          const validTracksToRemove = tracksToRemove.filter(track =>
            track && track.uri && isValidSpotifyTrackUri(track.uri)
          );
          if (validTracksToRemove.length > 0) {
            console.log(`Removing ${validTracksToRemove.length} tracks from playlist ${playlistId}`);
            try {
              await userSpotifyApi.removeTracksFromPlaylist(playlistId, validTracksToRemove);
              console.log(`Removed ${validTracksToRemove.length} tracks from playlist ${playlistId}`);
            } catch (removeErr) {
              console.error(`Error removing tracks: ${removeErr.message}`);
              throw removeErr;
            }
          }
        }

        if (tracksToAdd && tracksToAdd.length > 0) {
          const validTracksToAdd = tracksToAdd.filter(isValidSpotifyTrackUri);
          if (validTracksToAdd.length > 0) {
            try {
              await userSpotifyApi.addTracksToPlaylist(playlistId, validTracksToAdd);
              console.log(`Added ${validTracksToAdd.length} tracks to playlist ${playlistId}`);
            } catch (addErr) {
              console.error(`Error adding tracks: ${addErr.message}`);
              throw addErr;
            }
          }
        }
      }
    }

    // Update the updatedAt and lastUpdated timestamps in playlists data
    // Setting lastUpdated creates a 24-hour cooldown for auto-updates
    const userPlaylistsArray = userPlaylists.get(userId) || [];
    const playlistIndex = userPlaylistsArray.findIndex(p => p.playlistId === playlistId);
    if (playlistIndex !== -1) {
      const now = new Date().toISOString();
      userPlaylistsArray[playlistIndex].updatedAt = now;
      userPlaylistsArray[playlistIndex].lastUpdated = now;
      userPlaylists.set(userId, userPlaylistsArray);
      await savePlaylist(userId, userPlaylistsArray[playlistIndex]);
      console.log(`Updated timestamp for playlist ${playlistId} - 24hr cooldown started`);
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error updating playlist:', error);
    res.status(500).json({
      error: 'Failed to update playlist',
      details: error.message
    });
  }
});

// Apply a refinement result to an existing playlist:
// replaces Spotify/Apple tracks in-place and updates the stored record.
// Called when the user refines an existing playlist from MyPlaylists and clicks "Create".
app.post('/api/playlists/:playlistId/apply-refinement', async (req, res) => {
  try {
    const { playlistId } = req.params;
    let { userId, tracks, trackUris, chatMessages, excludedSongs, draftId } = req.body;

    if (!userId || !tracks || !trackUris) {
      return res.status(400).json({ error: 'Missing required fields: userId, tracks, trackUris' });
    }

    console.log(`[APPLY-REFINEMENT] Applying refinement to playlist ${playlistId} for user ${userId} — ${trackUris.length} new tracks`);

    // Resolve to platform userId
    const emailUserId = isEmailBasedUserId(userId) ? userId : await getEmailUserIdFromPlatform(userId);
    const userPlaylistsArray = userPlaylists.get(emailUserId || userId) || [];
    const storedPlaylist = userPlaylistsArray.find(p => p.playlistId === playlistId);

    const platform = storedPlaylist?.platform || 'spotify';
    const isApple = platform === 'apple';

    if (isApple) {
      let applePlatformUserId = userId;
      if (isEmailBasedUserId(userId)) {
        applePlatformUserId = await resolvePlatformUserId(userId, 'apple');
        if (!applePlatformUserId) return res.status(404).json({ error: 'Apple Music not connected' });
      }
      const appleTokens = await getUserTokens(applePlatformUserId);
      if (!appleTokens) return res.status(401).json({ error: 'Apple Music not authenticated' });
      const appleMusicDevToken = generateAppleMusicToken();
      if (!appleMusicDevToken) return res.status(500).json({ error: 'Apple Music service unavailable' });
      const appleMusicApiInstance = new AppleMusicService(appleMusicDevToken);
      // Apple Music doesn't support track removal — add new tracks to playlist
      const trackIds = trackUris
        .map(uri => typeof uri === 'string' && uri.startsWith('apple:track:') ? uri.replace('apple:track:', '') : uri)
        .filter(Boolean);
      if (trackIds.length > 0) {
        await appleMusicApiInstance.addTracksToPlaylist(appleTokens.access_token, playlistId, trackIds);
        console.log(`[APPLY-REFINEMENT] Added ${trackIds.length} tracks to Apple Music playlist`);
      }
    } else {
      // Spotify: replace all tracks
      let platformUserId = userId;
      if (isEmailBasedUserId(userId)) {
        platformUserId = await resolvePlatformUserId(userId, 'spotify');
        if (!platformUserId) return res.status(404).json({ error: 'Spotify not connected' });
      }
      const tokens = await getUserTokens(platformUserId);
      if (!tokens) return res.status(401).json({ error: 'Spotify not authenticated' });

      const userSpotifyApi = new SpotifyWebApi({
        clientId: process.env.SPOTIFY_CLIENT_ID,
        clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
        redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback',
      });
      userSpotifyApi.setAccessToken(tokens.access_token);
      userSpotifyApi.setRefreshToken(tokens.refresh_token);
      try {
        const data = await userSpotifyApi.refreshAccessToken();
        userSpotifyApi.setAccessToken(data.body.access_token);
      } catch (_) {}

      const validUris = trackUris.filter(isValidSpotifyTrackUri);
      if (validUris.length > 0) {
        await userSpotifyApi.replaceTracksInPlaylist(playlistId, validUris);
        console.log(`[APPLY-REFINEMENT] Replaced tracks in Spotify playlist — ${validUris.length} tracks`);
      }
    }

    // Update the stored playlist record with new track data, chat messages, etc.
    const resolvedUserId = emailUserId || userId;
    const upa = userPlaylists.get(resolvedUserId) || [];
    const idx = upa.findIndex(p => p.playlistId === playlistId);
    if (idx !== -1) {
      const now = new Date().toISOString();
      upa[idx] = {
        ...upa[idx],
        tracks: tracks,
        trackUris: trackUris,
        trackCount: tracks.length,
        chatMessages: chatMessages || upa[idx].chatMessages || [],
        excludedSongs: excludedSongs || upa[idx].excludedSongs || [],
        updatedAt: now,
        lastUpdated: now,
      };
      userPlaylists.set(resolvedUserId, upa);
      await savePlaylist(resolvedUserId, upa[idx]);
      console.log(`[APPLY-REFINEMENT] Updated stored record for playlist ${playlistId}`);
    } else {
      console.warn(`[APPLY-REFINEMENT] Playlist ${playlistId} not found in stored records — track data not persisted`);
    }

    // Delete the draft (fire-and-forget)
    if (draftId && draftId.startsWith('draft-')) {
      try {
        const resolvedId = resolvedUserId;
        const upa2 = userPlaylists.get(resolvedId) || [];
        const filtered = upa2.filter(p => p.playlistId !== draftId);
        userPlaylists.set(resolvedId, filtered);
        await db.deletePlaylist(resolvedId, draftId);
        console.log(`[APPLY-REFINEMENT] Deleted draft ${draftId}`);
      } catch (draftErr) {
        console.warn(`[APPLY-REFINEMENT] Failed to delete draft ${draftId}: ${draftErr.message}`);
      }
    }

    res.json({ success: true, platform, playlistName: storedPlaylist?.playlistName });
  } catch (error) {
    console.error('[APPLY-REFINEMENT] Error:', error);
    res.status(500).json({ error: 'Failed to apply refinement', details: error.message });
  }
});

// Update playlist settings (auto-update frequency, mode, and privacy)
app.put('/api/playlists/:playlistId/settings', async (req, res) => {
  try {
    const { playlistId } = req.params;
    let { userId, updateFrequency, updateMode, isPublic, updateTime, songCount } = req.body;

    console.log('Update settings request:', { playlistId, userId, updateFrequency, updateMode, isPublic, updateTime, songCount });

    // Get user's playlist history
    const userPlaylistHistory = userPlaylists.get(userId) || [];

    // Find the playlist
    const playlistIndex = userPlaylistHistory.findIndex(p => p.playlistId === playlistId);
    if (playlistIndex === -1) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // If isPublic setting changed, update it on the platform
    if (isPublic !== undefined && isPublic !== userPlaylistHistory[playlistIndex].isPublic) {
      const playlistPlatform = userPlaylistHistory[playlistIndex].platform || 'spotify';

      // Apple Music library playlists are always private, cannot be made public
      if (playlistPlatform === 'apple') {
        console.log('Apple Music playlists are always private, skipping privacy update');
        // Don't update isPublic for Apple Music - keep it as false
        isPublic = false;
      } else if (playlistPlatform === 'spotify') {
        // Handle Spotify privacy update
        let platformUserId = userId;
        if (isEmailBasedUserId(userId)) {
          platformUserId = await resolvePlatformUserId(userId, 'spotify');
          if (!platformUserId) {
            return res.status(404).json({ error: 'Spotify not connected' });
          }
        }

        const tokens = await getUserTokens(platformUserId);
        if (tokens) {
          const userSpotifyApi = new SpotifyWebApi({
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
          });
          userSpotifyApi.setAccessToken(tokens.access_token);
          userSpotifyApi.setRefreshToken(tokens.refresh_token);

          try {
            // Refresh token if needed
            const refreshData = await userSpotifyApi.refreshAccessToken();
            const newAccessToken = refreshData.body.access_token;
            userSpotifyApi.setAccessToken(newAccessToken);
            tokens.access_token = newAccessToken;
            userTokens.set(platformUserId, tokens);
            saveTokens();
          } catch (refreshError) {
            console.log('Token refresh failed or not needed:', refreshError.message);
          }

          try {
            // Update playlist privacy on Spotify
            await userSpotifyApi.changePlaylistDetails(playlistId, {
              public: isPublic
            });
            console.log('Updated playlist privacy on Spotify to:', isPublic ? 'public' : 'private');
          } catch (spotifyError) {
            console.error('Failed to update playlist privacy on Spotify:', spotifyError);
            // Continue anyway - we'll still update our local record
          }
        }
      }
    }

    // Detect user's timezone from their IP for scheduling
    const detectedTimezone = getTimezoneFromRequest(req);
    console.log(`[SCHEDULE] Detected timezone from IP: ${detectedTimezone}`);

    // Update the playlist settings
    userPlaylistHistory[playlistIndex].updateFrequency = updateFrequency || 'never';
    userPlaylistHistory[playlistIndex].updateMode = 'replace';
    if (songCount && songCount >= 5 && songCount <= 50) {
      userPlaylistHistory[playlistIndex].requestedSongCount = songCount;
      userPlaylistHistory[playlistIndex].trackCount = songCount;
    }
    if (isPublic !== undefined) {
      userPlaylistHistory[playlistIndex].isPublic = isPublic;
    }
    // Store detected timezone so scheduler can use it for future recalculations
    userPlaylistHistory[playlistIndex].updateTime = updateFrequency && updateFrequency !== 'never'
      ? { timezone: detectedTimezone }
      : null;
    userPlaylistHistory[playlistIndex].lastUpdated = null;
    userPlaylistHistory[playlistIndex].nextUpdate = updateFrequency && updateFrequency !== 'never'
      ? calculateNextUpdate(updateFrequency, playlistId, { timezone: detectedTimezone })
      : null;

    // Save updated playlists
    userPlaylists.set(userId, userPlaylistHistory);
    await savePlaylist(userId, userPlaylistHistory[playlistIndex]);

    console.log('Playlist settings updated successfully');

    res.json({
      success: true,
      playlist: userPlaylistHistory[playlistIndex]
    });
  } catch (error) {
    console.error('Error updating playlist settings:', error);
    res.status(500).json({
      error: 'Failed to update playlist settings',
      details: error.message
    });
  }
});

// Add or remove refinement instructions for a playlist
app.post('/api/playlists/:playlistId/refine', async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userId, instruction, action } = req.body;

    if (!userId || !instruction || !action) {
      return res.status(400).json({ error: 'Missing required fields: userId, instruction, action' });
    }

    if (action !== 'add' && action !== 'remove') {
      return res.status(400).json({ error: 'Action must be either "add" or "remove"' });
    }

    // Get user's playlists
    const userPlaylistsArray = userPlaylists.get(userId) || [];
    if (userPlaylistsArray.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);
    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Initialize refinementInstructions array if it doesn't exist
    if (!playlist.refinementInstructions) {
      playlist.refinementInstructions = [];
    }

    if (action === 'add') {
      // Add instruction if it's not already in the array
      if (!playlist.refinementInstructions.includes(instruction)) {
        playlist.refinementInstructions.push(instruction);
        console.log(`[REFINE] Added instruction to ${playlist.playlistName}: "${instruction}"`);
      }
    } else if (action === 'remove') {
      // Remove instruction from array
      const index = playlist.refinementInstructions.indexOf(instruction);
      if (index > -1) {
        playlist.refinementInstructions.splice(index, 1);
        console.log(`[REFINE] Removed instruction from ${playlist.playlistName}: "${instruction}"`);
      }
    }

    // Save the updated playlists
    userPlaylists.set(userId, userPlaylistsArray);
    await savePlaylist(userId, playlist);

    res.json({
      success: true,
      refinementInstructions: playlist.refinementInstructions
    });

  } catch (error) {
    console.error('Error updating refinement instructions:', error);
    res.status(500).json({
      error: 'Failed to update refinement instructions',
      details: error.message
    });
  }
});

// Toggle lock on a track (locked tracks survive auto-update and manual refresh)
app.post('/api/playlists/:playlistId/toggle-lock', async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userId, trackId } = req.body;
    if (!userId || !trackId) return res.status(400).json({ error: 'userId and trackId required' });

    const userPlaylistsArray = userPlaylists.get(userId) || [];
    const idx = userPlaylistsArray.findIndex(p => p.playlistId === playlistId);
    if (idx === -1) return res.status(404).json({ error: 'Playlist not found' });

    const playlist = userPlaylistsArray[idx];
    if (!playlist.lockedTracks) playlist.lockedTracks = [];

    const alreadyLocked = playlist.lockedTracks.includes(trackId);
    if (alreadyLocked) {
      playlist.lockedTracks = playlist.lockedTracks.filter(id => id !== trackId);
    } else {
      playlist.lockedTracks.push(trackId);
    }

    userPlaylists.set(userId, userPlaylistsArray);
    await savePlaylist(userId, playlist);

    res.json({ locked: !alreadyLocked, lockedTracks: playlist.lockedTracks });
  } catch (err) {
    console.error('toggle-lock error:', err);
    res.status(500).json({ error: 'Failed to toggle lock' });
  }
});

// Exclude a song from playlist (immediate removal + learning)
app.post('/api/playlists/:playlistId/exclude-song', async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userId, trackId, trackUri, artistName } = req.body;

    if (!userId || !trackId) {
      return res.status(400).json({ error: 'Missing required fields: userId, trackId' });
    }

    // Get user's playlists — fall back to DB if not in memory (e.g. after server restart)
    let userPlaylistsArray = userPlaylists.get(userId) || [];
    let playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);

    if (!playlist && usePostgres) {
      console.log(`[EXCLUDE-SONG] Not in memory, loading from DB for userId=${userId}`);
      const dbPlaylists = await db.getUserPlaylists(userId);
      userPlaylists.set(userId, dbPlaylists);
      userPlaylistsArray = dbPlaylists;
      playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);
    }

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Initialize exclusion arrays if they don't exist
    if (!playlist.excludedSongs) playlist.excludedSongs = [];
    if (!playlist.excludedArtists) playlist.excludedArtists = [];
    if (!playlist.tracks) playlist.tracks = [];

    // Add to excluded songs list (store trackId for permanent exclusion)
    if (!playlist.excludedSongs.includes(trackId)) {
      playlist.excludedSongs.push(trackId);
      console.log(`[EXCLUDE] Added song to exclusion list: ${trackId}`);
    }

    // Remove from current playlist tracks
    const trackIndex = playlist.tracks.findIndex(t => t.id === trackId);
    if (trackIndex > -1) {
      playlist.tracks.splice(trackIndex, 1);
      console.log(`[EXCLUDE] Removed song from playlist tracks`);
    }

    // Remove from trackUris array
    if (trackUri && playlist.trackUris) {
      const uriIndex = playlist.trackUris.indexOf(trackUri);
      if (uriIndex > -1) {
        playlist.trackUris.splice(uriIndex, 1);
        playlist.trackCount = playlist.trackUris.length;
      }
    }

    // Smart artist exclusion: if user has excluded multiple songs from same artist, auto-exclude the artist
    if (artistName) {
      const artistLower = artistName.toLowerCase();
      const songsFromArtistExcluded = playlist.excludedSongs.filter(songId => {
        // Check if this excluded song is from the same artist
        const track = playlist.tracks.find(t => t.id === songId);
        return track && track.artists && track.artists.some(a => a.name.toLowerCase() === artistLower);
      }).length;

      // If user excluded 3+ songs from same artist, auto-exclude the artist
      if (songsFromArtistExcluded >= 3 && !playlist.excludedArtists.some(a => a.toLowerCase() === artistLower)) {
        playlist.excludedArtists.push(artistName);
        console.log(`[EXCLUDE] Auto-excluded artist after ${songsFromArtistExcluded} song exclusions: ${artistName}`);
      }
    }

    // Save changes
    userPlaylists.set(userId, userPlaylistsArray);
    await savePlaylist(userId, playlist);

    // Also remove from the platform playlist if it exists there
    try {
      // If userId is email-based, resolve to platform userId for API calls
      let platformUserId = userId;
      const excludePlatformService = new PlatformService();
      let excludePlatform;
      try {
        excludePlatform = excludePlatformService.getPlatform(userId);
      } catch (platformErr) {
        // Email-based userId — need to resolve to a platform userId
        excludePlatform = null;
      }

      if (!excludePlatform) {
        // Try Spotify first, then Apple
        const spotifyUserId = await resolvePlatformUserId(userId, 'spotify');
        const appleUserId = await resolvePlatformUserId(userId, 'apple');
        platformUserId = spotifyUserId || appleUserId;
        if (!platformUserId) {
          console.log('No platform connection found for email:', userId);
          return res.json({
            success: true,
            excludedSongs: playlist.excludedSongs,
            excludedArtists: playlist.excludedArtists,
            remainingTracks: playlist.tracks.length
          });
        }
        excludePlatform = excludePlatformService.getPlatform(platformUserId);
      }

      const tokens = await getUserTokens(platformUserId);
      if (tokens && trackUri) {
        if (excludePlatform === 'spotify') {
          const userSpotifyApi = new SpotifyWebApi({
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
          });
          userSpotifyApi.setAccessToken(tokens.access_token);
          userSpotifyApi.setRefreshToken(tokens.refresh_token);

          // Refresh token if needed
          try {
            const refreshData = await userSpotifyApi.refreshAccessToken();
            userSpotifyApi.setAccessToken(refreshData.body.access_token);
            tokens.access_token = refreshData.body.access_token;
            userTokens.set(platformUserId, tokens);
            await db.updateAccessToken(platformUserId, refreshData.body.access_token);
          } catch (refreshError) {
            console.log('Token refresh not needed:', refreshError.message);
          }

          // Remove track from Spotify playlist
          await userSpotifyApi.removeTracksFromPlaylist(playlistId, [{ uri: trackUri }]);
          console.log(`[EXCLUDE] Removed track from Spotify playlist`);
        } else if (excludePlatform === 'apple') {
          // Apple Music: replace playlist with remaining tracks
          const remainingUris = (playlist.trackUris || []).filter(u => u !== trackUri);
          await excludePlatformService.replacePlaylistTracks(platformUserId, playlistId, remainingUris, tokens);
          console.log(`[EXCLUDE] Replaced Apple Music playlist tracks (removed 1 track)`);
        }
      }
    } catch (platformError) {
      console.error('Error removing from platform playlist (non-critical):', platformError.message);
      // Don't fail the request if platform removal fails
    }

    res.json({
      success: true,
      excludedSongs: playlist.excludedSongs,
      excludedArtists: playlist.excludedArtists,
      remainingTracks: playlist.tracks.length
    });

  } catch (error) {
    console.error('Error excluding song:', error);
    res.status(500).json({
      error: 'Failed to exclude song',
      details: error.message
    });
  }
});

// React to a song (thumbs up/down for feedback)
app.post('/api/playlists/:playlistId/react-to-song', async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userId, trackId, trackUri, trackName, artistName, reaction, image } = req.body;

    console.log(`[REACTION] Request received: playlistId=${playlistId}, userId=${userId}, trackId=${trackId}, reaction=${reaction}`);

    if (!userId || !trackId) {
      return res.status(400).json({ error: 'Missing required fields: userId, trackId' });
    }

    // Validate reaction value
    if (reaction !== null && reaction !== 'thumbsUp' && reaction !== 'thumbsDown') {
      return res.status(400).json({ error: 'Invalid reaction value. Must be "thumbsUp", "thumbsDown", or null' });
    }

    // Get user's playlists — check in-memory first, fall back to DB on cache miss
    let userPlaylistsArray = userPlaylists.get(userId) || [];
    let playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);

    if (!playlist && usePostgres) {
      // In-memory cache may be stale after server restart — reload from DB
      const dbPlaylists = await db.getUserPlaylists(userId);
      userPlaylists.set(userId, dbPlaylists);
      userPlaylistsArray = dbPlaylists;
      playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);
    }

    if (!playlist) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // Initialize reaction arrays if they don't exist
    if (!playlist.likedSongs) playlist.likedSongs = [];
    if (!playlist.dislikedSongs) playlist.dislikedSongs = [];

    // Remove from both arrays first (in case they're changing from one to another)
    playlist.likedSongs = playlist.likedSongs.filter(s => s.id !== trackId);
    playlist.dislikedSongs = playlist.dislikedSongs.filter(s => s.id !== trackId);

    // Add to appropriate array based on new reaction
    if (reaction === 'thumbsUp') {
      playlist.likedSongs.push({
        id: trackId,
        uri: trackUri,
        name: trackName,
        artist: artistName,
        image: image || null,
        reactedAt: new Date().toISOString()
      });
      console.log(`[REACTION] User liked song: ${trackName} by ${artistName}`);
    } else if (reaction === 'thumbsDown') {
      playlist.dislikedSongs.push({
        id: trackId,
        uri: trackUri,
        name: trackName,
        artist: artistName,
        image: image || null,
        reactedAt: new Date().toISOString()
      });
      // Remove from playlist.tracks so it doesn't reappear on page reload
      if (playlist.tracks) {
        const trackIdx = playlist.tracks.findIndex(t => t.id === trackId || t.uri === trackUri);
        if (trackIdx > -1) playlist.tracks.splice(trackIdx, 1);
      }
      if (trackUri && playlist.trackUris) {
        const uriIdx = playlist.trackUris.indexOf(trackUri);
        if (uriIdx > -1) {
          playlist.trackUris.splice(uriIdx, 1);
          playlist.trackCount = playlist.trackUris.length;
        }
      }
      console.log(`[REACTION] User disliked song: ${trackName} by ${artistName}`);
    } else {
      console.log(`[REACTION] Removed reaction from song: ${trackName}`);
    }

    // Save changes
    userPlaylists.set(userId, userPlaylistsArray);
    console.log(`[REACTION] Saving playlist with ${playlist.likedSongs.length} liked, ${playlist.dislikedSongs.length} disliked songs`);
    await savePlaylist(userId, playlist);
    console.log(`[REACTION] Successfully saved reaction for ${trackName}`);

    // Remove thumbed-down song from the platform playlist — resolve email to platform userId
    if (reaction === 'thumbsDown' && trackUri && playlist.playlistId) {
      try {
        const reactionPlatform = playlist.platform || 'spotify';
        let reactionPlatformUserId = userId;
        if (isEmailBasedUserId(userId)) {
          reactionPlatformUserId = await resolvePlatformUserId(userId, reactionPlatform);
          if (!reactionPlatformUserId && reactionPlatform === 'spotify') {
            reactionPlatformUserId = await resolvePlatformUserId(userId, 'apple');
          }
        }
        if (reactionPlatformUserId) {
          const reactionTokens = await db.getToken(reactionPlatformUserId);
          if (reactionTokens) {
            const platformService = new PlatformService();
            if (reactionPlatform === 'apple') {
              const appleMusicApiReact = platformService.getAppleMusicApi(reactionTokens);
              await appleMusicApiReact.deleteTracksFromPlaylist(reactionTokens.access_token, playlist.playlistId, [trackUri]);
            } else {
              await platformService.removeTracksFromPlaylist(reactionPlatformUserId, playlist.playlistId, [trackUri], reactionTokens);
            }
            console.log(`[REACTION] Removed "${trackName}" from platform playlist`);
          }
        }
      } catch (removeErr) {
        // Non-critical — the in-app removal already happened; log and continue
        console.log(`[REACTION] Could not remove from platform playlist: ${removeErr.message}`);
      }
    }

    res.json({
      success: true,
      reaction: reaction,
      likedSongsCount: playlist.likedSongs.length,
      dislikedSongsCount: playlist.dislikedSongs.length
    });

  } catch (error) {
    console.error('Error saving song reaction:', error);
    res.status(500).json({
      error: 'Failed to save song reaction',
      details: error.message
    });
  }
});

// Remove a track from a playlist without disliking it
app.post('/api/playlists/:playlistId/remove-track', async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userId, trackId, trackUri } = req.body;

    console.log(`[REMOVE-TRACK] userId=${userId} trackId=${trackId} trackUri=${trackUri} playlistId=${playlistId}`);

    if (!userId || !trackId) {
      return res.status(400).json({ error: 'Missing required fields: userId, trackId' });
    }

    // Get playlist from cache or DB
    let userPlaylistsArray = userPlaylists.get(userId) || [];
    let playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);

    if (!playlist && usePostgres) {
      console.log(`[REMOVE-TRACK] Not in memory, loading from DB for userId=${userId}`);
      const dbPlaylists = await db.getUserPlaylists(userId);
      userPlaylists.set(userId, dbPlaylists);
      userPlaylistsArray = dbPlaylists;
      playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);
    }

    if (!playlist) {
      console.log(`[REMOVE-TRACK] Playlist ${playlistId} not found for userId=${userId}`);
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const tracksBefore = playlist.tracks?.length ?? 0;

    // Remove from playlist.tracks — match by id OR uri (same splice approach as exclude-song)
    if (playlist.tracks) {
      const trackIndex = playlist.tracks.findIndex(t => t.id === trackId || t.uri === trackUri);
      console.log(`[REMOVE-TRACK] findIndex=${trackIndex} for id=${trackId} | uri=${trackUri} | first track id=${playlist.tracks[0]?.id} uri=${playlist.tracks[0]?.uri}`);
      if (trackIndex > -1) {
        playlist.tracks.splice(trackIndex, 1);
      }
    }
    // Remove from trackUris array
    if (trackUri && playlist.trackUris) {
      const uriIndex = playlist.trackUris.indexOf(trackUri);
      if (uriIndex > -1) {
        playlist.trackUris.splice(uriIndex, 1);
        playlist.trackCount = playlist.trackUris.length;
      }
    }
    // Remove from lockedTracks if it was locked
    if (playlist.lockedTracks) {
      playlist.lockedTracks = playlist.lockedTracks.filter(id => id !== trackId);
    }
    // Add to excludedSongs so refresh/auto-update won't re-add this track
    // (does NOT affect dislikedSongs or artist exclusions — just prevents the specific song from returning)
    // Store as { id, uri } object so both the frontend manual-refresh path (maps song.uri)
    // and the backend auto-update path (maps s.uri || s) can read it correctly.
    if (!playlist.excludedSongs) playlist.excludedSongs = [];
    const alreadyExcluded = playlist.excludedSongs.some(s => (s.id || s) === trackId || (s.uri || '') === (trackUri || ''));
    if (!alreadyExcluded) {
      playlist.excludedSongs.push({ id: trackId, uri: trackUri });
    }

    console.log(`[REMOVE-TRACK] tracks ${tracksBefore} → ${playlist.tracks?.length ?? 0}, excludedSongs now ${playlist.excludedSongs.length}`);

    userPlaylists.set(userId, userPlaylistsArray);
    await savePlaylist(userId, playlist);
    console.log(`[REMOVE-TRACK] Saved successfully for playlist ${playlistId}`);

    // Remove from platform playlist — resolve email to platform userId for token lookup
    if (trackUri) {
      try {
        let removePlatformUserId = userId;
        const removePlatform = playlist.platform || 'spotify';
        if (isEmailBasedUserId(userId)) {
          removePlatformUserId = await resolvePlatformUserId(userId, removePlatform);
          if (!removePlatformUserId && removePlatform === 'spotify') {
            removePlatformUserId = await resolvePlatformUserId(userId, 'apple');
          }
        }
        if (removePlatformUserId) {
          const removeTokens = await db.getToken(removePlatformUserId);
          if (removeTokens) {
            const platformService = new PlatformService();
            if (removePlatform === 'apple') {
              const appleMusicApiRemove = platformService.getAppleMusicApi(removeTokens);
              await appleMusicApiRemove.deleteTracksFromPlaylist(removeTokens.access_token, playlist.playlistId, [trackUri]);
            } else {
              await platformService.removeTracksFromPlaylist(removePlatformUserId, playlist.playlistId, [trackUri], removeTokens);
            }
            console.log(`[REMOVE-TRACK] Removed track ${trackId} from platform playlist ${playlistId}`);
          }
        }
      } catch (removeErr) {
        console.log(`[REMOVE-TRACK] Could not remove from platform playlist: ${removeErr.message}`);
      }
    }

    res.json({ success: true });
  } catch (error) {
    console.error('Error removing track:', error);
    res.status(500).json({ error: 'Failed to remove track', details: error.message });
  }
});

// Get all liked/disliked songs across all playlists for a user
app.get('/api/reactions/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    let userPlaylistsArray = userPlaylists.get(userId) || [];
    if (userPlaylistsArray.length === 0 && usePostgres) {
      userPlaylistsArray = await db.getUserPlaylists(userId);
      userPlaylists.set(userId, userPlaylistsArray);
    }

    const likedSongs = [];
    const dislikedSongs = [];

    for (const playlist of userPlaylistsArray) {
      const playlistName = playlist.playlistName || 'Untitled Playlist';
      const playlistId = playlist.playlistId;

      // Build a quick lookup for album art from the tracks array (populated by auto-update)
      const trackImageMap = {};
      (playlist.tracks || []).forEach(t => {
        if (t.id && t.image) trackImageMap[t.id] = t.image;
      });

      for (const song of (playlist.likedSongs || [])) {
        likedSongs.push({ ...song, playlistName, playlistId, image: song.image || trackImageMap[song.id] || null });
      }
      for (const song of (playlist.dislikedSongs || [])) {
        dislikedSongs.push({ ...song, playlistName, playlistId, image: song.image || trackImageMap[song.id] || null });
      }
    }

    // Backfill missing images from Spotify (covers old reactions saved before image support)
    const songsWithoutImages = [...likedSongs, ...dislikedSongs].filter(s => !s.image && s.id);
    if (songsWithoutImages.length > 0) {
      try {
        const platformUserId = isEmailBasedUserId(userId)
          ? await resolvePlatformUserId(userId, 'spotify')
          : (userId.startsWith('spotify_') ? userId : null);

        if (platformUserId) {
          const tokens = await getUserTokens(platformUserId);
          if (tokens) {
            const userSpotifyApi = new SpotifyWebApi({
              clientId: process.env.SPOTIFY_CLIENT_ID,
              clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            });
            userSpotifyApi.setAccessToken(tokens.access_token);

            // Spotify getTracks supports up to 50 IDs at once
            const uniqueIds = [...new Set(songsWithoutImages.map(s => s.id))].slice(0, 50);
            const tracksRes = await userSpotifyApi.getTracks(uniqueIds);

            const spotifyImageMap = {};
            (tracksRes.body.tracks || []).forEach(t => {
              if (t && t.id && t.album?.images?.[0]?.url) {
                spotifyImageMap[t.id] = t.album.images[0].url;
              }
            });

            likedSongs.forEach(s => { if (!s.image && spotifyImageMap[s.id]) s.image = spotifyImageMap[s.id]; });
            dislikedSongs.forEach(s => { if (!s.image && spotifyImageMap[s.id]) s.image = spotifyImageMap[s.id]; });
          }
        }
      } catch (imageErr) {
        // Non-critical — return what we have without images
        console.log('[REACTIONS] Could not backfill images from Spotify:', imageErr.message);
      }
    }

    // Sort by most recently reacted
    likedSongs.sort((a, b) => new Date(b.reactedAt) - new Date(a.reactedAt));
    dislikedSongs.sort((a, b) => new Date(b.reactedAt) - new Date(a.reactedAt));

    res.json({ likedSongs, dislikedSongs });
  } catch (error) {
    console.error('Error fetching reactions:', error);
    res.status(500).json({ error: 'Failed to fetch reactions' });
  }
});

// Search for users and playlists
app.post('/api/search', async (req, res) => {
  try {
    const { query, userId } = req.body;

    if (!query || !query.trim()) {
      return res.status(400).json({ error: 'Search query is required' });
    }

    const searchQuery = query.toLowerCase().trim();
    const results = {
      users: [],
      playlists: []
    };

    // Search through all users
    const userProfileData = loadUserProfiles();
    for (const [uid, profile] of userProfileData.entries()) {
      if (uid === userId) continue; // Skip current user

      const displayName = (profile.displayName || '').toLowerCase();
      if (displayName.includes(searchQuery)) {
        // Count public playlists for this user
        const playlists = userPlaylists.get(uid) || [];
        const publicPlaylists = playlists.filter(p => p.isPublic !== false);

        results.users.push({
          userId: uid,
          displayName: profile.displayName,
          image: profile.image,
          playlistCount: publicPlaylists.length
        });
      }
    }

    // Search through all public playlists
    for (const [uid, playlists] of userPlaylists.entries()) {
      const userProfile = userProfileData.get(uid);
      const creatorName = userProfile?.displayName || 'Unknown User';

      for (const playlist of playlists) {
        // Only include public playlists
        if (playlist.isPublic === false) continue;

        const playlistName = (playlist.playlistName || '').toLowerCase();
        const description = (playlist.description || '').toLowerCase();

        if (playlistName.includes(searchQuery) || description.includes(searchQuery)) {
          results.playlists.push({
            playlistId: playlist.playlistId,
            playlistName: playlist.playlistName,
            description: playlist.description,
            trackCount: playlist.trackCount,
            spotifyUrl: playlist.spotifyUrl,
            creatorId: uid,
            creatorName: creatorName
          });
        }
      }
    }

    // Limit results
    results.users = results.users.slice(0, 10);
    results.playlists = results.playlists.slice(0, 20);

    res.json(results);
  } catch (error) {
    console.error('Search error:', error);
    res.status(500).json({
      error: 'Failed to perform search',
      details: error.message
    });
  }
});

// React to playlist (thumbs up/down)
app.post('/api/playlists/:playlistId/react', async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userId, reaction } = req.body; // reaction: 'up' or 'down'

    if (!userId || !reaction) {
      return res.status(400).json({ error: 'User ID and reaction type are required' });
    }

    if (reaction !== 'up' && reaction !== 'down') {
      return res.status(400).json({ error: 'Reaction must be "up" or "down"' });
    }

    // Get or create reactions for this playlist
    let reactions = playlistReactions.get(playlistId) || { thumbsUp: [], thumbsDown: [] };

    // Remove user from both arrays first (to toggle or switch)
    reactions.thumbsUp = reactions.thumbsUp.filter(id => id !== userId);
    reactions.thumbsDown = reactions.thumbsDown.filter(id => id !== userId);

    // Add to appropriate array
    if (reaction === 'up') {
      reactions.thumbsUp.push(userId);
    } else {
      reactions.thumbsDown.push(userId);
    }

    playlistReactions.set(playlistId, reactions);
    saveReactions();

    res.json({
      success: true,
      reactions: {
        thumbsUp: reactions.thumbsUp.length,
        thumbsDown: reactions.thumbsDown.length,
        userReaction: reaction
      }
    });
  } catch (error) {
    console.error('React to playlist error:', error);
    res.status(500).json({
      error: 'Failed to react to playlist',
      details: error.message
    });
  }
});

// Remove reaction from playlist
app.delete('/api/playlists/:playlistId/react', async (req, res) => {
  try {
    const { playlistId} = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    let reactions = playlistReactions.get(playlistId) || { thumbsUp: [], thumbsDown: [] };

    // Remove user from both arrays
    reactions.thumbsUp = reactions.thumbsUp.filter(id => id !== userId);
    reactions.thumbsDown = reactions.thumbsDown.filter(id => id !== userId);

    playlistReactions.set(playlistId, reactions);
    saveReactions();

    res.json({
      success: true,
      reactions: {
        thumbsUp: reactions.thumbsUp.length,
        thumbsDown: reactions.thumbsDown.length,
        userReaction: null
      }
    });
  } catch (error) {
    console.error('Remove reaction error:', error);
    res.status(500).json({
      error: 'Failed to remove reaction',
      details: error.message
    });
  }
});

// Save playlist
app.post('/api/playlists/:playlistId/save', async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get user's saved playlists
    let savedPlaylists = userSavedPlaylists.get(userId) || [];

    // Check if already saved
    if (savedPlaylists.includes(playlistId)) {
      return res.status(400).json({ error: 'Playlist already saved' });
    }

    // Add to saved playlists
    savedPlaylists.push(playlistId);
    userSavedPlaylists.set(userId, savedPlaylists);
    saveSavedPlaylists();

    res.json({
      success: true,
      message: 'Playlist saved successfully'
    });
  } catch (error) {
    console.error('Save playlist error:', error);
    res.status(500).json({
      error: 'Failed to save playlist',
      details: error.message
    });
  }
});

// Unsave playlist
app.delete('/api/playlists/:playlistId/save', async (req, res) => {
  try {
    const { playlistId } = req.params;
    const { userId } = req.body;

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get user's saved playlists
    let savedPlaylists = userSavedPlaylists.get(userId) || [];

    // Remove from saved playlists
    savedPlaylists = savedPlaylists.filter(id => id !== playlistId);
    userSavedPlaylists.set(userId, savedPlaylists);
    saveSavedPlaylists();

    res.json({
      success: true,
      message: 'Playlist unsaved successfully'
    });
  } catch (error) {
    console.error('Unsave playlist error:', error);
    res.status(500).json({
      error: 'Failed to unsave playlist',
      details: error.message
    });
  }
});

// Get artist images using client credentials (no user auth needed — for product tour)
app.get('/api/artist-images', async (req, res) => {
  const { names } = req.query; // comma-separated artist names
  if (!names) return res.json({ images: {} });
  const artistNames = names.split(',').map(n => n.trim()).filter(Boolean);
  try {
    const token = await getSpotifyClientToken();
    const images = {};
    await Promise.all(artistNames.map(async (name) => {
      try {
        const resp = await axios.get('https://api.spotify.com/v1/search', {
          headers: { Authorization: `Bearer ${token}` },
          params: { q: name, type: 'artist', limit: 1 }
        });
        const artist = resp.data.artists?.items?.[0];
        images[name] = artist?.images?.[0]?.url || null;
      } catch { images[name] = null; }
    }));
    res.json({ images });
  } catch (err) {
    res.json({ images: {} });
  }
});

// Get track album art using client credentials (no user auth needed — for product tour)
app.get('/api/track-images', async (req, res) => {
  const { tracks } = req.query; // "TrackName|Artist,TrackName2|Artist2"
  if (!tracks) return res.json({ images: {} });
  const trackList = tracks.split(',').map(t => t.trim()).filter(Boolean);
  try {
    const token = await getSpotifyClientToken();
    const images = {};
    await Promise.all(trackList.map(async (entry) => {
      const [name, artist] = entry.split('|');
      try {
        const resp = await axios.get('https://api.spotify.com/v1/search', {
          headers: { Authorization: `Bearer ${token}` },
          params: { q: `track:${name} artist:${artist}`, type: 'track', limit: 1 }
        });
        const track = resp.data.tracks?.items?.[0];
        images[entry] = track?.album?.images?.[0]?.url || null;
      } catch { images[entry] = null; }
    }));
    res.json({ images });
  } catch {
    res.json({ images: {} });
  }
});

// Get trending playlists
app.get('/api/trending', async (req, res) => {
  try {
    const { userId } = req.query;
    const trendingPlaylists = [];

    // Calculate score for each public playlist based on reactions
    for (const [uid, playlists] of userPlaylists.entries()) {
      const userProfile = loadUserProfiles().get(uid);
      const creatorName = userProfile?.displayName || 'Unknown User';

      for (const playlist of playlists) {
        // Only include public playlists
        if (playlist.isPublic === false) continue;

        // Get reactions for this playlist
        const reactions = playlistReactions.get(playlist.playlistId) || { thumbsUp: [], thumbsDown: [] };
        const thumbsUpCount = reactions.thumbsUp.length;
        const thumbsDownCount = reactions.thumbsDown.length;

        // Calculate trending score (thumbs up - thumbs down)
        const score = thumbsUpCount - thumbsDownCount;

        // Get user's reaction if logged in
        let userReaction = null;
        let isSaved = false;
        if (userId) {
          if (reactions.thumbsUp.includes(userId)) {
            userReaction = 'up';
          } else if (reactions.thumbsDown.includes(userId)) {
            userReaction = 'down';
          }

          // Check if user has saved this playlist
          const saved = userSavedPlaylists.get(userId) || [];
          isSaved = saved.includes(playlist.playlistId);
        }

        trendingPlaylists.push({
          playlistId: playlist.playlistId,
          playlistName: playlist.playlistName,
          description: playlist.description,
          trackCount: playlist.trackCount,
          spotifyUrl: playlist.spotifyUrl,
          creatorId: uid,
          creatorName: creatorName,
          creatorImage: userProfile?.image,
          thumbsUp: thumbsUpCount,
          thumbsDown: thumbsDownCount,
          score: score,
          userReaction: userReaction,
          isSaved: isSaved,
          createdAt: playlist.createdAt
        });
      }
    }

    // Sort by score (descending) and limit to top 20
    trendingPlaylists.sort((a, b) => b.score - a.score);
    const topTrending = trendingPlaylists.slice(0, 20);

    res.json({ playlists: topTrending });
  } catch (error) {
    console.error('Get trending playlists error:', error);
    res.status(500).json({
      error: 'Failed to get trending playlists',
      details: error.message
    });
  }
});

// Delete a playlist
app.delete('/api/playlists/:playlistId', async (req, res) => {
  try {
    const playlistId = decodeURIComponent(req.params.playlistId);
    const { userId } = req.query;

    console.log('Delete request - playlistId:', playlistId, 'userId:', userId);

    if (!userId) {
      return res.status(400).json({ error: 'User ID is required' });
    }

    // Get user's playlists
    const userPlaylistHistory = userPlaylists.get(userId) || [];
    console.log('User playlists:', userPlaylistHistory.map(p => p.playlistId));

    // Find and remove the playlist
    const playlistIndex = userPlaylistHistory.findIndex(p => p.playlistId === playlistId);
    console.log('Playlist index found:', playlistIndex);

    if (playlistIndex === -1) {
      console.log('Playlist not found. Looking for ID:', playlistId);
      console.log('Available IDs:', userPlaylistHistory.map(p => p.playlistId));
      return res.status(404).json({ error: 'Playlist not found' });
    }

    const deletedPlaylist = userPlaylistHistory.splice(playlistIndex, 1)[0];
    userPlaylists.set(userId, userPlaylistHistory);
    await deletePlaylist(userId, playlistId);

    // Also delete from the platform if it exists there
    if (deletedPlaylist.platform === 'apple') {
      try {
        const emailUserId = isEmailBasedUserId(userId) ? userId : await getEmailUserIdFromPlatform(userId);
        const applePlatformUserId = emailUserId ? await resolvePlatformUserId(emailUserId, 'apple') : null;
        const appleTokens = applePlatformUserId ? await getUserTokens(applePlatformUserId) : null;
        const appleMusicDevToken = generateAppleMusicToken();
        if (appleTokens && appleMusicDevToken) {
          const appleMusicApiInstance = new AppleMusicService(appleMusicDevToken);
          await appleMusicApiInstance.deletePlaylist(appleTokens.access_token, playlistId);
          console.log(`Deleted Apple Music playlist ${playlistId} from user's library`);
        }
      } catch (platformErr) {
        // Non-critical — playlist is already removed from Fins
        console.log(`Could not delete Apple Music playlist from library: ${platformErr.message}`);
      }
    } else if (deletedPlaylist.platform === 'spotify' || !deletedPlaylist.platform) {
      try {
        const platformUserId = isEmailBasedUserId(userId)
          ? await resolvePlatformUserId(userId, 'spotify')
          : userId;
        console.log(`[DELETE] Spotify unfollow — userId=${userId}, platformUserId=${platformUserId}, playlistId=${playlistId}`);
        const tokens = platformUserId ? await getUserTokens(platformUserId) : null;
        if (tokens) {
          const userSpotifyApi = new SpotifyWebApi({
            clientId: process.env.SPOTIFY_CLIENT_ID,
            clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
            redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
          });
          userSpotifyApi.setAccessToken(tokens.access_token);
          userSpotifyApi.setRefreshToken(tokens.refresh_token);
          try {
            const refreshData = await userSpotifyApi.refreshAccessToken();
            userSpotifyApi.setAccessToken(refreshData.body.access_token);
          } catch (refreshErr) {
            console.warn(`[DELETE] Token refresh failed, using existing token: ${refreshErr.message}`);
          }
          await userSpotifyApi.unfollowPlaylist(playlistId);
          console.log(`[DELETE] Unfollowed Spotify playlist ${playlistId}`);
        } else {
          console.warn(`[DELETE] No tokens found for platformUserId=${platformUserId} — Spotify unfollow skipped`);
        }
      } catch (platformErr) {
        console.error(`[DELETE] Could not unfollow Spotify playlist ${playlistId}: ${platformErr.message}`);
      }
    }

    // Also remove from saved playlists if it exists there
    let savedPlaylists = userSavedPlaylists.get(userId) || [];
    savedPlaylists = savedPlaylists.filter(id => id !== playlistId);
    userSavedPlaylists.set(userId, savedPlaylists);
    saveSavedPlaylists();

    // Also remove any reactions to this playlist
    playlistReactions.delete(playlistId);
    saveReactions();

    console.log(`Playlist ${playlistId} deleted by user ${userId}`);

    res.json({
      success: true,
      message: `Playlist "${deletedPlaylist.playlistName}" has been deleted`
    });
  } catch (error) {
    console.error('Delete playlist error:', error);
    res.status(500).json({
      error: 'Failed to delete playlist',
      details: error.message
    });
  }
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Manual enrichment trigger — POST /api/admin/enrich-cache?secret=<ADMIN_SECRET>
// Kicks off the top-artists cache warmup job without requiring a redeploy.
app.post('/api/admin/enrich-cache', (req, res) => {
  const secret = req.query.secret || req.body?.secret;
  if (!secret || secret !== process.env.ADMIN_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  res.json({ message: 'Enrichment started', timestamp: new Date().toISOString() });
  setImmediate(() => enrichTopArtistsCache());
});

// Featured artists for login page background.
// Refreshes monthly from Spotify's Global Top 50 playlist.
// Persisted to disk so restarts don't trigger unnecessary re-fetches.
const FEATURED_CACHE_FILE = path.join(__dirname, 'cache', 'featured-artists.json');
const FEATURED_CACHE_TTL  = 30 * 24 * 60 * 60 * 1000; // 30 days
const featuredArtistsMemCache = { data: null, expiresAt: 0 };

app.get('/api/featured-artists', async (req, res) => {
  try {
    // 1. Memory cache (same process, fastest)
    if (featuredArtistsMemCache.data && Date.now() < featuredArtistsMemCache.expiresAt) {
      return res.json(featuredArtistsMemCache.data);
    }
    // 2. File cache (survives server restarts, valid for 30 days)
    try {
      const raw = fs.readFileSync(FEATURED_CACHE_FILE, 'utf8');
      const { artists, cachedAt } = JSON.parse(raw);
      if (artists?.length > 0 && Date.now() - cachedAt < FEATURED_CACHE_TTL) {
        const payload = { artists };
        featuredArtistsMemCache.data = payload;
        featuredArtistsMemCache.expiresAt = cachedAt + FEATURED_CACHE_TTL;
        console.log(`[featured-artists] Serving from file cache (age: ${Math.round((Date.now() - cachedAt) / 86400000)}d)`);
        return res.json(payload);
      }
    } catch (e) { /* cache file missing or corrupt — fetch fresh */ }

    // 3. Fetch live from Spotify
    console.log('[featured-artists] Cache expired or missing — fetching from Spotify...');
    const ccData = await spotifyApi.clientCredentialsGrant();
    const appSp = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
    });
    appSp.setAccessToken(ccData.body.access_token);

    // Try several well-known public playlists in order until one works
    const CANDIDATE_PLAYLISTS = [
      '37i9dQZEVXbMDoHDwVN2tF', // Today's Top Hits
      '37i9dQZEVXbNG5zvRrkjzn', // Global Top 50
      '37i9dQZF1DXcBWIGoYBM5M', // Hot Hits USA
      '37i9dQZF1DX0XUsuxWHRQd', // RapCaviar
    ];

    let tracks = [];
    for (const plId of CANDIDATE_PLAYLISTS) {
      try {
        const playlistRes = await appSp.getPlaylistTracks(plId, { limit: 50, market: 'US' });
        tracks = playlistRes.body.items || [];
        if (tracks.length > 0) {
          console.log(`[featured-artists] Got ${tracks.length} tracks from playlist ${plId}`);
          break;
        }
      } catch (e) {
        console.log(`[featured-artists] Playlist ${plId} failed: ${e.message}`);
      }
    }

    // Collect unique lead artist IDs (up to 21)
    const seen = new Set();
    const artistIds = [];
    for (const item of tracks) {
      const id = item.track?.artists?.[0]?.id;
      if (id && !seen.has(id)) {
        seen.add(id);
        artistIds.push(id);
        if (artistIds.length === 30) break;
      }
    }

    // Fallback: well-known artist IDs so the background is never empty
    const FALLBACK_IDS = [
      '06HL4z0CvFAxyc27GXpf02', // Taylor Swift
      '3TVXtAsR1Inumwj472S9r4', // Drake
      '1uNFoZAHBGtllmzznpCI3s', // Justin Bieber
      '6eUKZXaKkcviH0Ku9w2n3V', // Ed Sheeran
      '4q3ewBCX7sLwd24euuV69X', // Bad Bunny
      '1McMsnEElThX1knmY4oliG', // Olivia Rodrigo
      '246dkjvS1zLTtiykXe5h60', // Post Malone
      '5K4W6rqBFWDnAN6FQUkS6x', // Kanye West
      '7dGJo4pcD2V6oG8kP0tJRR', // Eminem
      '4dpARuHxo51G3z768sgnrY', // Adele
      '0du5cEVh5yTK9QJze8zA0C', // Bruno Mars
      '0C8ZW7ezQVs4URX5aX7Kqx', // Selena Gomez
      '3Nrfpe0tUJi4K4DXYWgMUX', // BTS
      '1Xyo4u8uXC1ZmMpatF05PJ', // The Weeknd
      '6jJ0s89eD6GaHleKKya26X', // Peso Pluma
      '7jVv8c5Fj3E9VhNjxT4snq', // Lil Nas X
      '66CXWjxzNUsdJxJ2JdwvnR', // Ariana Grande
      '5he5w2lnU9x7JFhnwcekXX', // Rihanna
      '7CajNmpBOzvAGYd6v7Q6y6', // Chris Brown
      '2h93pZq0e7k5yf4dywlkpM', // Khalid
      '0hCNtLu0JehylgoiP8L4Gh', // Nicki Minaj
    ];

    if (artistIds.length < 12) {
      console.log('[featured-artists] Too few artists from playlists, using fallback IDs');
      const fallbackRes = await appSp.getArtists(FALLBACK_IDS);
      const fallbackArtists = (fallbackRes.body.artists || [])
        .filter(a => a?.images?.[0])
        .map(a => ({ name: a.name, image: a.images[0].url }));
      const payload = { artists: fallbackArtists };
      featuredArtistsMemCache.data = payload;
      featuredArtistsMemCache.expiresAt = Date.now() + FEATURED_CACHE_TTL;
      try {
        fs.mkdirSync(path.dirname(FEATURED_CACHE_FILE), { recursive: true });
        fs.writeFileSync(FEATURED_CACHE_FILE, JSON.stringify({ artists: fallbackArtists, cachedAt: Date.now() }));
      } catch (e) { console.log('[featured-artists] Could not write cache file:', e.message); }
      return res.json(payload);
    }

    // Batch-fetch full artist objects (needed for high-res images)
    const artistsRes = await appSp.getArtists(artistIds);
    const artists = (artistsRes.body.artists || [])
      .filter(a => a?.images?.[0])
      .map(a => ({ name: a.name, image: a.images[0].url }));

    console.log(`[featured-artists] Fetched ${artists.length} artists`);
    const payload = { artists };

    // Persist to memory + file
    featuredArtistsMemCache.data = payload;
    featuredArtistsMemCache.expiresAt = Date.now() + FEATURED_CACHE_TTL;
    try {
      fs.mkdirSync(path.dirname(FEATURED_CACHE_FILE), { recursive: true });
      fs.writeFileSync(FEATURED_CACHE_FILE, JSON.stringify({ artists, cachedAt: Date.now() }));
    } catch (e) { console.log('[featured-artists] Could not write cache file:', e.message); }

    res.json(payload);
  } catch (err) {
    console.log('[featured-artists] Fetch failed:', err.message);
    // Return stale memory cache rather than empty on error
    if (featuredArtistsMemCache.data) return res.json(featuredArtistsMemCache.data);
    res.json({ artists: [] });
  }
});

// ── Auto-update queue ─────────────────────────────────────────────────────────
// Playlists due for update are enqueued here and processed MAX_CONCURRENT at a time,
// so a burst of 500 simultaneous schedules doesn't hammer APIs all at once.
const autoUpdateQueue = []; // { userId, playlist }
const MAX_CONCURRENT_UPDATES = 5;
let activeUpdateCount = 0;

async function processPlaylistUpdate(userId, playlist) {
  console.log(`[AUTO-UPDATE] Updating playlist: ${playlist.playlistName} (${playlist.playlistId})`);
  try {
    // Prompt is rebuilt from originalPrompt + stored refinements inside generate-playlist
    // (same pre-flight logic as manual refresh). For imported playlists with no originalPrompt,
    // build context from existing track artists so Claude knows the genre.
    // Build prompt: originalPrompt for AI-generated playlists, name-based for imports.
    // Always enrich with description and top-5 artists — the backend generate-playlist
    // endpoint will also do this rebuild, but including it here ensures the correct
    // playlist name surfaces in logs and any pre-flight checks.
    const autoDesc = (playlist.description || '').trim();
    let prompt;
    if (playlist.originalPrompt) {
      prompt = playlist.originalPrompt;
    } else if (autoDesc) {
      prompt = `Generate a playlist`;
    } else {
      prompt = `Generate songs similar to the playlist "${playlist.playlistName}"`;
    }
    if (autoDesc) prompt += `\n\nPlaylist description: ${autoDesc}`;
    // Always include key artists — they help Claude find similar artists on SoundCharts.
    // If their SC genres contradict the description, the genre-inconsistency check will
    // exclude their songs from the candidate pool downstream.
    if (playlist.tracks?.length > 0) {
      const autoArtists = [...new Set(playlist.tracks.map(t => t.artist).filter(Boolean))].slice(0, 5);
      if (autoArtists.length > 0) prompt += `\n\nKey artists in this playlist: ${autoArtists.join(', ')}.`;
    }
    console.log(`[AUTO-UPDATE] Prompt for "${playlist.playlistName}": "${prompt.substring(0, 150)}${prompt.length > 150 ? '...' : ''}"`);
    if (!playlist.tracks) playlist.tracks = [];

    // Resolve platform user ID
    const playlistPlatform = playlist.platform || 'spotify';
    let platformUserId = userId;
    if (isEmailBasedUserId(userId)) {
      platformUserId = await resolvePlatformUserId(userId, playlistPlatform);
      if (!platformUserId) {
        console.log(`[AUTO-UPDATE] No ${playlistPlatform} connection for user ${userId}, skipping ${playlist.playlistName}`);
        return;
      }
    }

    // Generate tracks
    let newTrackUris = [];
    let tracksForHistory = [];
    let returnedTracksData = [];
    try {
      console.log(`[AUTO-UPDATE] Calling generate-playlist for ${playlist.playlistName}...`);
      const PORT = process.env.PORT || 3001;
      const isReplaceMode = playlist.updateMode === 'replace';
      const genResult = await axios.post(`http://localhost:${PORT}/api/generate-playlist`, {
        prompt,
        userId,
        platform: playlistPlatform,
        allowExplicit: true,
        songCount: playlist.requestedSongCount || 30,
        // In replace mode, don't exclude current tracks — they can be re-selected freely
        // (excluding them on a niche-genre playlist can starve the pool and return far fewer songs).
        // In append mode, exclude them to avoid duplicates.
        excludeTrackUris: isReplaceMode
          ? (playlist.excludedSongs || []).map(s => s.uri || s).filter(Boolean)
          : [
              ...(playlist.trackUris || playlist.tracks.map(t => t.uri)).filter(Boolean),
              ...(playlist.excludedSongs || []).map(s => s.uri || s).filter(Boolean),
            ],
        playlistId: playlist.playlistId,
        internalCall: true,
      }, { timeout: 180000 });

      returnedTracksData = genResult.data.tracks || [];
      newTrackUris = returnedTracksData.map(t => t.uri).filter(Boolean);
      tracksForHistory = returnedTracksData.map(t => ({ name: t.name, artist: t.artist }));
      console.log(`[AUTO-UPDATE] Generated ${newTrackUris.length} tracks for ${playlist.playlistName}`);
    } catch (generationError) {
      console.error(`[AUTO-UPDATE] Track generation failed for ${playlist.playlistName}:`, generationError.message);
    }

    // Push tracks to platform (Spotify or Apple Music)
    let tracksWereAdded = false;

    // Shared: sync DB record and song history after a successful push
    const syncAfterPush = (newTracksForRecord, newUris) => {
      if (playlist.updateMode === 'replace') {
        playlist.tracks = newTracksForRecord;
        playlist.trackUris = newUris;
        // Anchor to requestedSongCount (set when user saves settings). Fall back to the
        // number actually returned — never carry forward an inflated append-mode count.
        playlist.trackCount = playlist.requestedSongCount || newUris.length;
      } else {
        if (!playlist.tracks) playlist.tracks = [];
        if (!playlist.trackUris) playlist.trackUris = [];
        playlist.tracks = [...playlist.tracks, ...newTracksForRecord];
        playlist.trackUris = [...playlist.trackUris, ...newUris];
        playlist.trackCount = playlist.trackUris.length;
      }
      console.log(`[AUTO-UPDATE] Synced playlist.tracks: ${playlist.trackCount} total tracks`);

      if (tracksForHistory.length > 0) {
        if (!playlist.songHistory) playlist.songHistory = [];
        playlist.songHistory = [
          ...playlist.songHistory,
          ...tracksForHistory.map(t => `${normalizeForHistory(t.name)}|||${t.artist.toLowerCase()}`)
        ];
        if (playlist.songHistory.length > 150) {
          playlist.songHistory = playlist.songHistory.slice(-150);
        }
        console.log(`[AUTO-UPDATE] Song history updated for ${playlist.playlistName} - now contains ${playlist.songHistory.length} tracks`);
      }
    };

    if (playlistPlatform === 'apple') {
      // ── Apple Music ──────────────────────────────────────────────
      const appleTokens = await getUserTokens(platformUserId);
      const appleMusicDevToken = generateAppleMusicToken();
      if (appleTokens && appleMusicDevToken && newTrackUris.length > 0) {
        const appleMusicApiInstance = new AppleMusicService(appleMusicDevToken);
        // Apple Music URIs are "apple:track:{id}" — extract the raw ID
        const trackIds = newTrackUris
          .map(uri => (typeof uri === 'string' && uri.startsWith('apple:track:') ? uri.replace('apple:track:', '') : uri))
          .filter(Boolean);
        try {
          if (playlist.updateMode === 'replace') {
            console.log(`[AUTO-UPDATE] Apple replace mode: replacing all tracks in ${playlist.playlistName}`);
            await appleMusicApiInstance.replacePlaylistTracks(appleTokens.access_token, playlist.playlistId, trackIds);
            console.log(`[AUTO-UPDATE] Successfully replaced tracks in Apple Music playlist ${playlist.playlistName}`);
            tracksWereAdded = true;
          } else {
            // Apple Music append mode in auto-update is intentionally skipped to prevent unbounded
            // accumulation of tracks. Users can explicitly add songs via manual refresh ("Add Songs").
            console.log(`[AUTO-UPDATE] Apple Music: skipping auto-append for ${playlist.playlistName} — use manual refresh to add songs`);
          }
          const newTracksForRecord = returnedTracksData.map(t => ({
            id: t.id || null,
            name: t.name,
            artist: t.artist || 'Unknown',
            uri: t.uri,
            album: t.album || '',
            image: t.image || null,
            externalUrl: t.externalUrl || null,
            explicit: t.explicit || false
          }));
          syncAfterPush(newTracksForRecord, newTrackUris);
        } catch (updateError) {
          console.error(`[AUTO-UPDATE] Failed to update Apple Music playlist ${playlist.playlistName}:`, updateError.message);
        }
      } else {
        console.log(`[AUTO-UPDATE] Apple Music: missing tokens or dev token for ${playlist.playlistName}, skipping push`);
      }
    } else {
      // ── Spotify ──────────────────────────────────────────────────
      const tokens = await getUserTokens(platformUserId);
      if (tokens && newTrackUris.length > 0) {
        const userSpotifyApi = new SpotifyWebApi({
          clientId: process.env.SPOTIFY_CLIENT_ID,
          clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
          redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
        });
        userSpotifyApi.setAccessToken(tokens.access_token);
        userSpotifyApi.setRefreshToken(tokens.refresh_token);

        try {
          if (playlist.updateMode === 'replace') {
            console.log(`[AUTO-UPDATE] Replace mode: Getting current tracks for ${playlist.playlistName}`);
            const currentPlaylistData = await userSpotifyApi.getPlaylist(playlist.playlistId);
            const validUriRegex = /^spotify:track:[0-9a-zA-Z]{22}$/;
            const allTrackItems = currentPlaylistData.body.tracks.items;
            const invalidTracks = allTrackItems.filter(item => !item.track || !item.track.uri || !validUriRegex.test(item.track.uri));
            if (invalidTracks.length > 0) {
              console.log(`[AUTO-UPDATE] Warning: Found ${invalidTracks.length} invalid/null tracks in playlist, skipping them`);
              invalidTracks.forEach((item, idx) => {
                console.log(`[AUTO-UPDATE]   ${idx + 1}. "${item.track?.name || 'Unknown'}" - URI: ${item.track?.uri || 'null'}`);
              });
            }
            const lockedUris = new Set(
              (playlist.lockedTracks || [])
                .map(id => (playlist.tracks || []).find(t => t.id === id)?.uri)
                .filter(Boolean)
            );
            const currentTrackUris = allTrackItems
              .filter(item => item.track && item.track.uri && validUriRegex.test(item.track.uri) && !lockedUris.has(item.track.uri))
              .map(item => item.track.uri);
            if (lockedUris.size > 0) console.log(`[AUTO-UPDATE] Keeping ${lockedUris.size} locked tracks in ${playlist.playlistName}`);
            console.log(`[AUTO-UPDATE] Removing ${currentTrackUris.length} valid tracks from ${playlist.playlistName}`);
            if (currentTrackUris.length > 0) {
              try {
                await userSpotifyApi.removeTracksFromPlaylist(playlist.playlistId, currentTrackUris.map(uri => ({ uri })));
              } catch (removeError) {
                console.error(`[AUTO-UPDATE] Error removing tracks:`, removeError.message);
                throw removeError;
              }
            }
            await userSpotifyApi.addTracksToPlaylist(playlist.playlistId, newTrackUris);
            console.log(`[AUTO-UPDATE] Successfully replaced all tracks in ${playlist.playlistName} with ${newTrackUris.length} new tracks`);
          } else {
            await userSpotifyApi.addTracksToPlaylist(playlist.playlistId, newTrackUris);
            console.log(`[AUTO-UPDATE] Successfully appended ${newTrackUris.length} tracks to ${playlist.playlistName}`);
          }
          tracksWereAdded = true;
          const newTracksForRecord = returnedTracksData.map(t => ({
            id: t.id || null,
            name: t.name,
            artist: t.artist || 'Unknown',
            uri: t.uri,
            album: t.album || '',
            image: t.image || null,
            externalUrl: t.externalUrl || null,
            explicit: t.explicit || false
          }));
          syncAfterPush(newTracksForRecord, newTrackUris);
        } catch (updateError) {
          console.error(`[AUTO-UPDATE] Failed to update ${playlist.playlistName}:`, updateError.message);
        }
      }
    }

    const nowIso = new Date().toISOString();
    if (tracksWereAdded) {
      playlist.lastUpdated = nowIso;
      playlist.updatedAt = nowIso;
    } else {
      console.log(`[AUTO-UPDATE] No tracks added to ${playlist.playlistName} — skipping lastUpdated to avoid false cooldown`);
    }
    await savePlaylist(userId, playlist);
  } catch (err) {
    console.error(`[AUTO-UPDATE] Error updating playlist ${playlist.playlistName}:`, err.message);
    await savePlaylist(userId, playlist);
  }
}

function enqueuePlaylistUpdate(userId, playlist) {
  // Avoid duplicate entries for the same playlist
  if (autoUpdateQueue.some(item => item.playlist.playlistId === playlist.playlistId)) {
    console.log(`[QUEUE] "${playlist.playlistName}" already queued, skipping`);
    return;
  }
  autoUpdateQueue.push({ userId, playlist });
  console.log(`[QUEUE] Enqueued "${playlist.playlistName}" (queue depth: ${autoUpdateQueue.length})`);
}

function drainUpdateQueue() {
  while (autoUpdateQueue.length > 0 && activeUpdateCount < MAX_CONCURRENT_UPDATES) {
    const item = autoUpdateQueue.shift();
    activeUpdateCount++;
    console.log(`[QUEUE] Starting "${item.playlist.playlistName}" (active: ${activeUpdateCount}/${MAX_CONCURRENT_UPDATES}, remaining: ${autoUpdateQueue.length})`);
    processPlaylistUpdate(item.userId, item.playlist)
      .catch(err => console.error(`[QUEUE] Unhandled error for "${item.playlist.playlistName}":`, err.message))
      .finally(() => {
        activeUpdateCount--;
        drainUpdateQueue(); // pick up the next item as soon as a slot opens
      });
  }
}

// Daily proactive cache enrichment — fetches and caches full catalogs for today's top
// artists across all major genres. Warms Phase 3b so users hit the fast vibe-filtered
// cache path instead of the slow cold-fetch path. Uses setImmediate internally so it
// never blocks the request loop.
async function enrichTopArtistsCache() {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) return;

  console.log('🔥 [ENRICHMENT] Starting daily top-artists cache warm...');
  const sort = { type: 'metric', platform: 'spotify', metricType: 'streams', period: 'month', sortBy: 'total', order: 'desc' };
  // All SC genre slugs from SOUNDCHARTS_GENRE_MAP
  const SC_ENRICHMENT_GENRES = ['pop', 'hip hop', 'r&b', 'rock', 'alternative', 'electro', 'country', 'latin', 'african', 'jazz', 'classical', 'metal', 'reggae', 'blues'];

  // Step 1: collect unique artist names from top 1000 songs per genre (2 pages × 500)
  const artistQueue = new Map(); // lowerName -> { name, genre }
  for (const scGenre of SC_ENRICHMENT_GENRES) {
    try {
      for (let page = 0; page < 2; page++) {
        await throttleSoundCharts();
        const resp = await axios.post(
          'https://customer.api.soundcharts.com/api/v2/top/songs',
          { sort, filters: [{ type: 'songGenres', data: { values: [scGenre], operator: 'in' } }] },
          { headers: { 'x-app-id': appId, 'x-api-key': apiKey, 'Content-Type': 'application/json' }, params: { offset: page * 500, limit: 500 }, timeout: 15000 }
        );
        const items = resp.data?.items || [];
        for (const item of items) {
          const name = item.song?.creditName;
          if (name && !artistQueue.has(name.toLowerCase())) {
            artistQueue.set(name.toLowerCase(), { name, genre: scGenre });
          }
        }
        if (items.length < 500) break; // no more pages
      }
      console.log(`🔥 [ENRICHMENT] ${scGenre}: ${artistQueue.size} unique artists so far`);
    } catch (err) {
      console.log(`⚠️  [ENRICHMENT] top/songs fetch failed for "${scGenre}": ${err.message}`);
    }
  }

  // Step 2: for each artist not already cached, fetch + store full catalog
  let enriched = 0, skipped = 0, failed = 0;
  for (const [, { name, genre }] of artistQueue) {
    try {
      const artistInfo = await getSoundChartsArtistInfo(name, genre);
      if (!artistInfo?.uuid) { skipped++; continue; }

      // Skip if catalog is already cached (freshness check still runs inside getArtistFullCatalogFromSC)
      const catalogKey = `full_catalog:${artistInfo.uuid}`;
      const cached = db.getCachedSC(catalogKey);
      if (cached?.songs?.length > 0) { skipped++; continue; }

      await getArtistFullCatalogFromSC(artistInfo.uuid, name, genre);
      enriched++;
    } catch (err) {
      failed++;
      console.log(`⚠️  [ENRICHMENT] Failed for "${name}": ${err.message}`);
    }
  }
  console.log(`✅ [ENRICHMENT] Done — ${enriched} enriched, ${skipped} already cached, ${failed} failed`);
}

// Auto-update scheduler - checks every minute for playlists that need updating.
// Uses setInterval instead of node-cron to avoid spurious "missed execution" warnings
// on shared Railway infrastructure.
const scheduleAutoUpdates = () => {
  // Drain the queue every 10 seconds (picks up items when all slots were busy)
  setInterval(drainUpdateQueue, 10000);

  const checkDuePlaylists = () => {
    try {
      const allUsers = Array.from(userPlaylists.entries());
      const now = new Date();
      const savePromises = [];

      for (const [userId, playlists] of allUsers) {
        const autoUpdatePlaylists = playlists.filter(p =>
          p.updateFrequency && p.updateFrequency !== 'never' && p.nextUpdate
        );

        for (const playlist of autoUpdatePlaylists) {
          if (now < new Date(playlist.nextUpdate)) continue;

          // Advance nextUpdate immediately so the next tick doesn't re-enqueue this playlist
          playlist.nextUpdate = calculateNextUpdate(playlist.updateFrequency, playlist.playlistId, playlist.updateTime);
          savePromises.push(savePlaylist(userId, playlist));

          enqueuePlaylistUpdate(userId, playlist);
        }
      }

      if (savePromises.length > 0) {
        Promise.all(savePromises).catch(err => console.error('[AUTO-UPDATE] Save error:', err.message));
      }

      if (autoUpdateQueue.length > 0) {
        console.log(`[QUEUE] ${autoUpdateQueue.length} playlist(s) queued, ${activeUpdateCount}/${MAX_CONCURRENT_UPDATES} slots active`);
        drainUpdateQueue();
      }
    } catch (error) {
      console.error('[AUTO-UPDATE] Scheduler error:', error);
    }
  };

  setInterval(checkDuePlaylists, 60000); // check every minute
};

// Debug endpoint: check auto-update status for a user's playlists
app.get('/api/debug/auto-update/:userId', async (req, res) => {
  const { userId } = req.params;
  const userPlaylistsArray = userPlaylists.get(userId) || [];
  const now = new Date();
  const summary = userPlaylistsArray.map(p => ({
    name: p.playlistName,
    playlistId: p.playlistId,
    updateFrequency: p.updateFrequency || 'never',
    updateMode: p.updateMode || 'append',
    nextUpdate: p.nextUpdate || null,
    nextUpdateIn: p.nextUpdate ? `${Math.round((new Date(p.nextUpdate) - now) / 60000)} min` : 'N/A',
    lastUpdated: p.lastUpdated || null,
    isDue: p.nextUpdate ? now >= new Date(p.nextUpdate) : false,
    songHistoryCount: (p.songHistory || []).length,
    genreData: p.genreData ? { primaryGenre: p.genreData.primaryGenre, seedArtists: p.genreData.artistConstraints?.suggestedSeedArtists } : null,
  }));
  res.json({ now: now.toISOString(), userId, playlists: summary });
});

// Error logging endpoint
app.post('/api/log-error', async (req, res) => {
  try {
    const { errorLog } = req.body;

    if (!errorLog) {
      return res.status(400).json({ error: 'Error log is required' });
    }

    // Handle the critical error (log to file and send email if needed)
    await handleCriticalError(errorLog);

    res.status(200).json({ success: true, message: 'Error logged successfully' });
  } catch (error) {
    console.error('Error in error logging endpoint:', error);
    res.status(500).json({ error: 'Failed to log error' });
  }
});

// ─── Stripe Endpoints ────────────────────────────────────────────────────���───

// POST /api/stripe/create-checkout-session
app.post('/api/stripe/create-checkout-session', async (req, res) => {
  try {
    const { userId, billingPeriod, trial } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const email = isEmailBasedUserId(userId) ? userId : await getEmailUserIdFromPlatform(userId);
    if (!email) return res.status(400).json({ error: 'User not found' });

    // Trial always uses annual price
    const effectivePeriod = trial ? 'annual' : billingPeriod;
    const priceId = effectivePeriod === 'annual'
      ? process.env.STRIPE_PRICE_ANNUAL
      : process.env.STRIPE_PRICE_MONTHLY;
    if (!priceId) return res.status(500).json({ error: 'Stripe price not configured' });

    // Prevent double-trials
    if (trial) {
      const userRecord = await db.getUser(email);
      if (userRecord?.trialUsed) {
        return res.status(400).json({ error: 'Free trial already used' });
      }
    }

    // Create or reuse Stripe customer
    const stripe = getStripe();
    const userRecord = await db.getUser(email);
    let stripeCustomerId = userRecord?.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ email, metadata: { email } });
      stripeCustomerId = customer.id;
      await db.updateStripeCustomer(email, stripeCustomerId);
    }

    const frontendUrl = FRONTEND_URL;

    const sessionParams = {
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/?payment=success`,
      cancel_url: `${frontendUrl}/pricing`,
      metadata: { email },
    };

    if (trial) {
      sessionParams.subscription_data = { trial_period_days: 7 };
      // Mark trial as used immediately to prevent double-clicks
      await db.markTrialUsed(email);
    }

    const session = await stripe.checkout.sessions.create(sessionParams);
    res.json({ url: session.url });
  } catch (error) {
    console.error('Stripe create-checkout-session error:', error);
    res.status(500).json({ error: 'Failed to create checkout session' });
  }
});

// POST /api/stripe/webhook
app.post('/api/stripe/webhook', async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    const stripe = getStripe();
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Stripe webhook signature error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    if (event.type === 'checkout.session.completed') {
      const session = event.data.object;
      const email = session.metadata?.email;
      if (email) {
        const subscriptionId = session.subscription;
        // Also save stripeCustomerId — the checkout session always has it
        if (session.customer) {
          await db.updateStripeCustomer(email, session.customer);
        }
        await db.updateSubscription(email, { subscriptionId, status: 'active', endsAt: null, plan: 'paid' });
        console.log(`✓ Stripe: upgraded ${email} to paid (customer: ${session.customer})`);
      }
    } else if (event.type === 'customer.subscription.updated') {
      const sub = event.data.object;
      const user = await db.getUserByStripeCustomerId(sub.customer);
      if (user) {
        const status = sub.status;
        const plan = (status === 'active' || status === 'trialing') ? 'paid' : 'free';
        const endsAt = sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null;
        await db.updateSubscription(user.email, { subscriptionId: sub.id, status, endsAt, plan });
      }
    } else if (event.type === 'customer.subscription.deleted') {
      const sub = event.data.object;
      const user = await db.getUserByStripeCustomerId(sub.customer);
      if (user) {
        await db.updateSubscription(user.email, { subscriptionId: null, status: 'canceled', endsAt: null, plan: 'free' });
        // Anyone who had a paid subscription (trial or direct) can't start a new free trial
        await db.markTrialUsed(user.email);
        console.log(`✓ Stripe: downgraded ${user.email} to free`);
      }
    }
    res.json({ received: true });
  } catch (error) {
    console.error('Stripe webhook handler error:', error);
    res.status(500).json({ error: 'Webhook handler failed' });
  }
});

// GET /api/stripe/billing-portal/:userId
app.get('/api/stripe/billing-portal/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    console.log(`[BILLING-PORTAL] Request for userId: ${userId}`);
    const email = isEmailBasedUserId(userId) ? userId : await getEmailUserIdFromPlatform(userId);
    if (!email) {
      console.error(`[BILLING-PORTAL] Could not resolve email for userId: ${userId}`);
      return res.status(400).json({ error: 'User not found' });
    }

    const userRecord = await db.getUser(email);
    let stripeCustomerId = userRecord?.stripeCustomerId;

    // Recovery: if no stripeCustomerId in DB, look up Stripe customer by email
    if (!stripeCustomerId) {
      console.warn(`[BILLING-PORTAL] No stripeCustomerId in DB for ${email} (plan: ${userRecord?.plan}). Attempting Stripe lookup...`);
      try {
        const stripe = getStripe();
        const customers = await stripe.customers.list({ email, limit: 1 });
        if (customers.data.length > 0) {
          stripeCustomerId = customers.data[0].id;
          await db.updateStripeCustomer(email, stripeCustomerId);
          console.log(`[BILLING-PORTAL] Recovered stripeCustomerId: ${stripeCustomerId} for ${email}`);
        }
      } catch (lookupErr) {
        console.error(`[BILLING-PORTAL] Stripe customer lookup failed:`, lookupErr.message);
      }
    }

    if (!stripeCustomerId) {
      console.error(`[BILLING-PORTAL] No Stripe customer found for email: ${email}`);
      return res.status(400).json({ error: 'No billing account found. Please contact support.' });
    }

    console.log(`[BILLING-PORTAL] Creating portal session for ${email}, customer: ${stripeCustomerId}`);
    const stripe = getStripe();
    const frontendUrl = FRONTEND_URL;
    const portalSession = await stripe.billingPortal.sessions.create({
      customer: stripeCustomerId,
      return_url: `${frontendUrl}/`,
    });

    console.log(`[BILLING-PORTAL] Portal session created successfully for ${email}`);
    res.json({ url: portalSession.url });
  } catch (error) {
    console.error('Stripe billing portal error:', error.message, error.type || '');
    // Detect "portal not configured" Stripe error
    const isPortalNotConfigured = error.message?.includes('No customer portal settings');
    const clientMsg = isPortalNotConfigured
      ? 'Billing portal is not yet configured. Please contact support.'
      : 'Failed to open billing portal. Please try again.';
    res.status(500).json({ error: clientMsg });
  }
});

// ──────────────────��──────────��────────��──────────────────────────────────────

// Initialize database and start server
async function startServer() {
  try {
    // Initialize PostgreSQL if using it
    if (usePostgres) {
      console.log('Initializing PostgreSQL database...');
      await db.initialize();
      console.log('✓ PostgreSQL database initialized');
    }

    // Load playlists from database or file
    console.log('Loading playlists...');
    userPlaylists = await loadPlaylistsFromDB();
    console.log('✓ Playlists loaded');

    app.listen(PORT, () => {
      console.log(`🎵 AI Playlist Creator Backend running on port ${PORT}`);
      console.log(`📝 Make sure to set up your .env file with API credentials`);

      // Start the auto-update scheduler
      scheduleAutoUpdates();
      console.log(`⏰ Auto-update scheduler started`);

      // Proactive cache warm — triggered manually via POST /api/admin/enrich-cache
      // or automatically daily at 3 AM when ENRICH_TOP_ARTISTS=true in env.
      if (process.env.ENRICH_TOP_ARTISTS === 'true') {
        cron.schedule('0 3 * * *', () => enrichTopArtistsCache());
        console.log(`🔥 Top-artists enrichment scheduled (daily at 3 AM)`);
      }

      // Clean up expired artist cache every hour
      setInterval(() => {
        try {
          db.cleanExpiredArtistCache();
          console.log('🧹 Cleaned up expired artist cache entries');
        } catch (error) {
          console.error('Error cleaning artist cache:', error.message);
        }
      }, 60 * 60 * 1000); // Run every hour
      console.log(`🧹 Artist cache cleanup scheduler started (runs hourly)`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();

// Prevent unhandled rejections/exceptions from crashing the process
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
});
