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
async function searchSoundChartsArtist(artistName, expectedGenre = null) {
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
async function getSoundChartsArtistInfo(artistName, expectedGenre = null) {
  const artist = await searchSoundChartsArtist(artistName, expectedGenre);
  if (!artist) {
    console.log(`🔍 SoundCharts: "${artistName}" not found`);
    return null;
  }

  console.log(`🔍 SoundCharts: Found "${artist.name}" (${artist.careerStage || 'unknown stage'})`);

  // Extract genres
  const genres = artist.genres?.map(g => g.root) || [];
  const subgenres = artist.genres?.flatMap(g => g.sub || []) || [];

  // Get similar artists
  const similarArtists = await getSoundChartsSimilarArtists(artist.uuid, 10);

  const result = {
    name: artist.name,
    uuid: artist.uuid,
    genres: [...new Set([...genres, ...subgenres])],
    similarArtists: similarArtists.map(a => a.name),
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

async function searchSoundChartsSong(title, artist) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) return null;

  const cacheKey = `songsearch:${title.toLowerCase()}:${artist.toLowerCase()}`;
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;

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
      const artistUuid = match.artists?.[0]?.uuid || null;
      const artistName = match.artists?.[0]?.name || match.creditName;
      console.log(`🔍 SoundCharts song search: "${match.name}" by ${artistName} → artist UUID ${artistUuid}`);
      const result = { songUuid: match.uuid, artistUuid, artistName };
      setSCCache(cacheKey, result);
      return result;
    }

    // Log what artists were returned to help diagnose misses
    const returnedArtists = (response.data?.items || []).map(s => s.artists?.[0]?.name || s.creditName || '?').join(', ');
    console.log(`🔍 SoundCharts song search: no title match for "${title}" by "${artist}". Artists in results: [${returnedArtists}]`);

    // Fallback: search artist candidates by name, then check each one's songs for the reference title
    // This handles cases where song-title search doesn't credit the right artist (features, compilations, etc.)
    console.log(`🔍 SoundCharts song search: trying artist-candidate fallback for "${artist}"...`);
    try {
      const artistSearchResp = await axios.get(
        `https://customer.api.soundcharts.com/api/v2/artist/search/${encodeURIComponent(artist)}`,
        {
          headers: { 'x-app-id': appId, 'x-api-key': apiKey },
          params: { offset: 0, limit: 10 },
          timeout: 10000
        }
      );
      const candidates = (artistSearchResp.data?.items || []).filter(
        a => a.name.toLowerCase() === artist.toLowerCase()
      );
      const titleNorm = title.toLowerCase().replace(/[^a-z0-9]/g, '');
      for (const candidate of candidates) {
        await throttleSoundCharts();
        const songs = await getSoundChartsArtistSongs(candidate.uuid, 50);
        const songMatch = songs.find(s => {
          const sNorm = s.name.toLowerCase().replace(/[^a-z0-9]/g, '');
          return sNorm === titleNorm || sNorm.startsWith(titleNorm) || titleNorm.startsWith(sNorm);
        });
        if (songMatch) {
          console.log(`✓ SoundCharts artist-fallback: "${candidate.name}" has "${songMatch.name}" → UUID ${candidate.uuid}`);
          const result = { songUuid: songMatch.uuid, artistUuid: candidate.uuid, artistName: candidate.name };
          setSCCache(cacheKey, result);
          return result;
        }
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

// Map lyrical theme labels → SoundCharts themes filter values
const SOUNDCHARTS_THEME_MAP = {
  'love': 'Love', 'romance': 'Love', 'romantic': 'Love',
  'heartbreak': 'Heartbreak', 'breakup': 'Heartbreak', 'heartbroken': 'Heartbreak',
  'party': 'Party', 'club': 'Party', 'nightlife': 'Party',
  'motivational': 'Motivation', 'motivation': 'Motivation', 'empowerment': 'Motivation',
  'workout': 'Sport', 'fitness': 'Sport', 'sport': 'Sport', 'gym': 'Sport',
  'road trip': 'Travel', 'travel': 'Travel',
  'nostalgia': 'Nostalgia', 'nostalgic': 'Nostalgia',
  'summer': 'Summer', 'beach': 'Summer',
  'friendship': 'Friendship', 'friends': 'Friendship',
  'introspective': 'Introspection', 'self-reflection': 'Introspection',
  'money': 'Success', 'success': 'Success', 'hustle': 'Success',
  'spiritual': 'Spirituality', 'faith': 'Spirituality',
  'protest': 'Social Issues', 'social': 'Social Issues',
};

// Build a SoundCharts query from Claude-extracted genreData.
// Used by executeSoundChartsStrategy() to replace the old similarity-tree approach.
function buildSoundchartsQuery(genreData, allowExplicit = true) {
  const isExclusive = genreData.artistConstraints.exclusiveMode === true ||
                      genreData.artistConstraints.exclusiveMode === 'true';
  const requestedArtists = genreData.artistConstraints.requestedArtists || [];
  const suggestedSeeds = genreData.artistConstraints.suggestedSeedArtists || [];
  // requestedArtists = explicitly named by the user ("I want songs like Daniel J and Dre Dior")
  // suggestedSeedArtists = Claude's inferred seeds from overall playlist context
  // Always include requestedArtists first (they're the explicit ask), then fill with
  // suggestedSeedArtists. Never let suggestedSeedArtists silently replace requestedArtists.
  const seedArtists = isExclusive
    ? requestedArtists
    : [...new Set([...requestedArtists, ...suggestedSeeds])];

  // Strategy selection:
  // - exclusive mode → artist_songs (only those specific artists)
  // - seed artists available → artist_songs + expandToSimilar (SoundCharts similar-artist graph
  //   finds artists with a matching sound, far more precise than genre top-songs)
  // - no seed artists → top_songs filtered by genre (last resort)
  const strategy = isExclusive
    ? 'artist_songs'
    : (seedArtists.length > 0 ? 'artist_songs' : 'top_songs');

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

  const scMoods = [...new Set(moodLabels.map(l => SOUNDCHARTS_MOOD_MAP[l]).filter(Boolean))];
  if (scMoods.length > 0) {
    filters.push({ type: 'moods', data: { values: scMoods, operator: 'in' } });
    console.log(`🎭 SoundCharts mood filter: [${scMoods.join(', ')}]`);
  }

  // Audio feature filters — only applied when using top_songs (no seed artists).
  // With seed artists the artist graph already constrains the sound; stacking audio
  // feature ranges on top would shrink the pool too aggressively.
  if (strategy === 'top_songs') {
    // Merge feature ranges from all matched labels, taking the most permissive overlap
    // (highest min, lowest max) so we don't over-filter on conflicting signals.
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

    // Skip any feature where min > max (contradictory signals, e.g. "energetic" + "chill")
    for (const [feature, range] of Object.entries(featureRanges)) {
      if (range.min !== undefined && range.max !== undefined && range.min > range.max) {
        console.log(`⚠️  Skipping contradictory ${feature} filter (min ${range.min} > max ${range.max})`);
        continue;
      }
      const filterData = {};
      if (range.min !== undefined) filterData.min = range.min;
      if (range.max !== undefined) filterData.max = range.max;
      filters.push({ type: feature, data: filterData });
      console.log(`🎛️  SoundCharts audio filter: ${feature} ${JSON.stringify(filterData)}`);
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
    if (scSubgenre) {
      filters.push({ type: 'songSubGenres', data: { values: [scSubgenre], operator: 'in' } });
      console.log(`🎸 SoundCharts subgenre filter: ${scSubgenre}`);
    }
  }

  // Lyrical themes filter — from Claude-extracted lyricalContent.themes + useCase
  const themeLabels = [
    ...(genreData.lyricalContent?.themes || []),
    genreData.contextClues?.useCase || '',
  ].map(l => l.toLowerCase().trim()).filter(Boolean);
  const scThemes = [...new Set(themeLabels.map(l => SOUNDCHARTS_THEME_MAP[l]).filter(Boolean))];
  if (scThemes.length > 0) {
    filters.push({ type: 'themes', data: { values: scThemes, operator: 'in' } });
    console.log(`📝 SoundCharts themes filter: [${scThemes.join(', ')}]`);
  }

  // Artist career stage filter — maps popularity preference to career stage
  const popPref = genreData.trackConstraints?.popularity?.preference;
  const popMax = genreData.trackConstraints?.popularity?.max;
  if (popPref === 'underground' || (popMax !== null && popMax !== undefined && popMax <= 40)) {
    filters.push({ type: 'artistCareerStages', data: { values: ['long_tail', 'developing'], operator: 'in' } });
    console.log(`🎤 SoundCharts career stage filter: underground (long_tail, developing)`);
  } else if (popPref === 'mainstream' || (genreData.trackConstraints?.popularity?.min !== null &&
             genreData.trackConstraints?.popularity?.min !== undefined &&
             genreData.trackConstraints?.popularity?.min >= 70)) {
    filters.push({ type: 'artistCareerStages', data: { values: ['mainstream', 'superstar'], operator: 'in' } });
    console.log(`🎤 SoundCharts career stage filter: mainstream/superstar`);
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

  return {
    strategy,
    artists: seedArtists,
    expandToSimilar: !isExclusive,
    seedArtists,
    soundchartsFilters: filters,
    soundchartsSort: { type: 'metric', platform: 'spotify', metricType: 'streams', period: 'month', sortBy: 'total', order: 'desc' },
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
// executeSoundChartsStrategy — direct attribute-based song discovery.
// ─────────────────────────────────────────────────────────────────────────────

// Cached flag: once we know top/songs returns 403 on this plan, skip the call.
async function executeSoundChartsStrategy(query, fetchCount, confirmedArtistUuids = {}, minArtists = 0) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) return [];

  const { strategy, artists = [], soundchartsFilters = [], soundchartsSort } = query;

  // ── top_songs / trending ─────────────────────────────────────────────────
  if (strategy === 'top_songs' || strategy === 'trending') {
    const sort = soundchartsSort || {
      type: 'metric', platform: 'spotify', metricType: 'streams',
      period: strategy === 'trending' ? 'week' : 'month',
      sortBy: 'total', order: 'desc'
    };
    const body = { sort, ...(soundchartsFilters.length > 0 ? { filters: soundchartsFilters } : {}) };
    console.log(`🎵 SoundCharts ${strategy}: filters=[${soundchartsFilters.map(f => f.type).join(', ')}]`);
    try {
      await throttleSoundCharts();
      const response = await axios.post(
        'https://customer.api.soundcharts.com/api/v2/top/songs',
        body,
        {
          headers: { 'x-app-id': appId, 'x-api-key': apiKey, 'Content-Type': 'application/json' },
          params: { offset: 0, limit: Math.min(fetchCount, 200) },
          timeout: 15000
        }
      );
      const items = response.data?.items || [];
      console.log(`✓ SoundCharts returned ${items.length} songs`);

      // If a genre filter returned 0 results, the genre slug may be unsupported.
      // Prefer artist_songs with seed artists (stays genre-relevant) over stripping the filter
      // (which returns unfiltered global top songs that may be completely off-genre).
      const genreFilters = soundchartsFilters.filter(f => f.type === 'songGenres');
      if (items.length === 0 && genreFilters.length > 0) {
        const seeds = query.seedArtists || [];
        if (seeds.length > 0) {
          console.log(`⚠️  SoundCharts genre filter returned 0 — falling back to artist_songs with seeds [${seeds.join(', ')}]`);
          return executeSoundChartsStrategy(
            { ...query, strategy: 'artist_songs', artists: seeds, expandToSimilar: true },
            fetchCount,
            confirmedArtistUuids
          );
        }
        // No seed artists — last resort: retry without genre filter
        const filtersWithoutGenre = soundchartsFilters.filter(f => f.type !== 'songGenres');
        console.log(`⚠️  SoundCharts genre filter returned 0 and no seed artists — retrying without genre filter`);
        return executeSoundChartsStrategy(
          { ...query, soundchartsFilters: filtersWithoutGenre },
          fetchCount,
          confirmedArtistUuids
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
          source: strategy
        }));
      if (mappedItems.length < items.length) {
        console.log(`⚠️  Dropped ${items.length - mappedItems.length} SoundCharts items with missing song name`);
      }
      return mappedItems;
    } catch (err) {
      if (err.response?.status === 403) {
        console.log('⚠️  SoundCharts top/songs: 403 — falling back to artist-based discovery');
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
      confirmedArtistUuids
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
      const similarNames = [];
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
          similarNames.push(simName);
          added++;
        }
      }
      // Derive expected genres from the seed artists' actual SoundCharts genres — much more
      // reliable than Claude's extraction for underground/niche artists Claude may not know.
      // Fall back to Claude's extracted genre (from soundchartsFilters) only when seeds have
      // no genre metadata at all.
      const seedActualGenres = [...new Set(seedInfos.flatMap(s => (s.genres || []).map(g => g.toLowerCase())))];
      const genreFilter = soundchartsFilters.find(f => f.type === 'songGenres');
      const claudeGenres = (genreFilter?.data?.values || []).map(g => g.toLowerCase());
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

      for (const simName of similarNames) {
        try {
          const simInfo = await getSoundChartsArtistInfo(simName);
          if (!simInfo?.uuid) continue;
          const artistGenres = (simInfo.genres || []).map(g => g.toLowerCase());

          // 1. Must include the expected genre (e.g. r&b) — prevents genre drift.
          // Exception: if the artist has NO genre tags at all (common for long_tail/underground
          // artists on SoundCharts), don't skip — missing metadata ≠ wrong genre.
          if (expectedGenres.length > 0 && artistGenres.length > 0 && !expectedGenres.some(g => artistHasGenre(artistGenres, g))) {
            console.log(`⏭️  Skipping "${simInfo.name}" — missing expected genre [${expectedGenres.join(', ')}]`);
            continue;
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
      console.log(`🎨 Artist pool: ${seedInfos.length} seeds + ${allArtistInfos.length - seedInfos.length} similar = ${allArtistInfos.length} artists`);
    }

    // Phase 3: fetch songs.
    // Strategy: run top_songs with the genre filter and keep only songs whose credited
    // artist is in the pool. This gives popular, Spotify-findable tracks from relevant
    // artists instead of alphabetically-sorted deep cuts from the SoundCharts song list.
    // For artists that don't appear in top_songs (underground/niche), supplement with
    // direct artist song fetches.
    let songs = [];
    const poolNames = new Set(allArtistInfos.map(a => a.name.toLowerCase()));

    // 3a: top_songs pass — popular songs from artists in the pool
    const genreFilterForSongs = soundchartsFilters.find(f => f.type === 'songGenres');
    if (genreFilterForSongs) {
      try {
        const sort = soundchartsSort || { type: 'metric', platform: 'spotify', metricType: 'streams', period: 'month', sortBy: 'total', order: 'desc' };
        const body = { sort, filters: [genreFilterForSongs] };
        await throttleSoundCharts();
        const resp = await axios.post(
          'https://customer.api.soundcharts.com/api/v2/top/songs',
          body,
          { headers: { 'x-app-id': appId, 'x-api-key': apiKey, 'Content-Type': 'application/json' }, params: { offset: 0, limit: 200 }, timeout: 15000 }
        );
        const topItems = resp.data?.items || [];
        const poolMatches = topItems.filter(item => {
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
              source: 'artist_pool_top'
            });
          }
        }
        console.log(`🎯 Artist pool top_songs: ${poolMatches.length} songs matched from pool of ${allArtistInfos.length} artists`);
      } catch (err) {
        console.log(`⚠️  Artist pool top_songs fetch failed: ${err.message}`);
      }
    }

    // 3b: direct artist songs for artists not represented in top_songs results
    const representedArtists = new Set(songs.map(s => s.artistName.toLowerCase()));
    const unrepresented = allArtistInfos.filter(a => !representedArtists.has(a.name.toLowerCase()));
    const songsPerArtist = Math.max(Math.ceil(fetchCount / Math.max(unrepresented.length, 1)), 10);
    for (const artistInfo of unrepresented) {
      try {
        const artistSongs = await getSoundChartsArtistSongs(artistInfo.uuid, songsPerArtist);
        // Skip obvious variants (live, remix, bonus, karaoke) to improve Spotify hit rate
        const mainSongs = artistSongs.filter(s => !/\b(live|remix|karaoke|instrumental|bonus|interlude|skit|intro|outro)\b/i.test(s.name));
        for (const song of (mainSongs.length > 0 ? mainSongs : artistSongs).slice(0, songsPerArtist)) {
          songs.push({ ...song, artistName: artistInfo.name, source: 'artist_songs' });
        }
        if (mainSongs.length > 0) console.log(`✓ Got ${mainSongs.length} songs from ${artistInfo.name} (direct)`);
      } catch (err) {
        console.log(`⚠️  Error fetching songs for "${artistInfo.name}": ${err.message}`);
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
    const resetLink = `${process.env.FRONTEND_URL || 'http://localhost:3000'}/reset-password?token=${resetToken}`;

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
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}?userId=${userEmail}&spotifyUserId=${spotifyPlatformUserId}&email=${encodeURIComponent(userEmail)}&success=true&spotify=connected`;
    console.log('Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error getting tokens:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?error=auth_failed`);
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
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?error=${error}`);
    }

    if (!code) {
      return res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?error=missing_code`);
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
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}?userId=${userEmail}&appleMusicUserId=${userId}&email=${encodeURIComponent(userEmail)}&success=true&apple=connected`;
    console.log('Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error in Apple Music callback:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?error=apple_auth_failed&message=${encodeURIComponent(error.message)}`);
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

// ─── Mix Analyzer helpers ────────────────────────────────────────────────────

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
    let videoTitle = '', videoDescription = '', videoDuration = 0;

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
    const titleMatches = (searchTitle, resultTitle) => {
      if (hasNonAscii(searchTitle)) {
        // For non-ASCII titles (Japanese, Korean, etc.), only accept if the result
        // also contains non-ASCII characters — an English result for a Japanese
        // search is always a wrong match.
        return hasNonAscii(resultTitle);
      }
      const qWords = sigWords(searchTitle);
      if (qWords.length === 0) return true; // too short to check
      const rWords = new Set(sigWords(resultTitle));
      return qWords.some(w => rWords.has(w));
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
        if (track && !titleMatches(title, track.name)) {
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

    // For refreshes/refinements: rebuild prompt from originalPrompt + stored refinements
    // BEFORE Claude extraction so genreData comes from the user's actual intent, not a
    // frontend-built track list that drifts every refresh.
    if (playlistId && userId) {
      const userPlaylistsArray = userPlaylists.get(userId) || [];
      const storedPlaylist = userPlaylistsArray.find(p => p.playlistId === playlistId);
      if (storedPlaylist?.originalPrompt) {
        const storedRefinements = [];
        if (storedPlaylist.chatMessages?.length > 0) {
          storedRefinements.push(...storedPlaylist.chatMessages.filter(m => m.role === 'user').map(m => m.content));
        }
        if (storedPlaylist.refinementInstructions?.length > 0) {
          storedRefinements.push(...storedPlaylist.refinementInstructions);
        }
        prompt = storedPlaylist.originalPrompt;
        if (storedRefinements.length > 0) {
          prompt += `. Refinements: ${storedRefinements.join('. ')}`;
        }
        console.log(`[REFRESH] Rebuilt prompt from stored data: "${prompt}"`);
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
    "useCase": "intended use or null",
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
    "exclusiveMode": boolean (true if user wants ONLY these specific artists, false for "similar vibe" mix),
    "suggestedSeedArtists": ["3-5 well-known artists that exemplify the requested genre/mood - REQUIRED if no requestedArtists"] or []
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
    "preference": "cohesive/varied/unexpected" or null
  },
  "songCount": integer (5-100) or null,
  "referenceSongs": [{ "title": "song title", "artist": "artist name" }] or []
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

SONG LENGTH:
- "short songs", "under 3 minutes": max: 180
- "longer tracks", "over 5 minutes": min: 300
- "no songs over 4 minutes": max: 240
- Convert minutes to seconds

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

SONG COUNT:
- Explicit numbers: "50 songs", "25 tracks", "30 pop songs", "give me 40" → extract that number
- Vague quantities: "a few songs" = 10, "a handful" = 10, "a couple" = 6, "a lot of songs" = 50, "loads of tracks" = 50, "a ton of music" = 60
- Duration-based: "an hour of music" = 15, "a 30-minute playlist" = 8, "a 2-hour mix" = 30
- Size descriptors: "short playlist" = 10, "quick playlist" = 10, "big playlist" = 50, "massive playlist" = 75, "full playlist" = 30
- If no count is implied at all → null

LANGUAGE (culturalContext.language):
- "I want Spanish songs", "Spanish music", "songs in Spanish" → prefer: ["Spanish"], exclude: []
- "English songs only", "English only" → prefer: ["English"], exclude: []
- "no English songs", "not in English" → prefer: [], exclude: ["English"]
- "Korean pop", "K-pop" → prefer: ["Korean"], exclude: []
- "French music" → prefer: ["French"], exclude: []
- If no language is implied → prefer: [], exclude: []

REFERENCE SONGS:
If the user mentions a specific song title + artist (e.g. "songs like Take It Slow by Dante", "similar to Need My Baby by Reo Xander"), extract them into referenceSongs. These are used to confirm the correct artist identity.
- "songs like Take It Slow by Dante" → referenceSongs: [{ "title": "Take It Slow", "artist": "Dante" }]
- "songs similar to Need My Baby by Reo Xander" → referenceSongs: [{ "title": "Need My Baby", "artist": "Reo Xander" }]
- "songs like Dante and Ansel King" (no specific song title) → referenceSongs: []
- Only extract when the user clearly names BOTH a song title AND an artist.

SEED ARTISTS (CRITICAL):
These are used to find similar artists and build the playlist.
- When the prompt includes "Current songs include: ...", "Reference tracks: ...", or "Key artists in this playlist: ...", extract up to 5 of the most representative artists from those lists into suggestedSeedArtists. Prefer variety (different artists over repeats).
- When the user explicitly names artists ("artists like X", "similar to Y"), put them in requestedArtists.
- When neither of the above apply, YOU MUST suggest 3-5 seed artists that exemplify the requested genre/mood.
Examples (no reference tracks):
- "top pop songs" → suggestedSeedArtists: ["Taylor Swift", "Dua Lipa", "The Weeknd", "Harry Styles"]
- "r&b for when I'm in my feels" → suggestedSeedArtists: ["SZA", "Daniel Caesar", "H.E.R.", "Brent Faiyaz"]
- "underground hip-hop" → suggestedSeedArtists: ["JID", "Denzel Curry", "Freddie Gibbs", "EARTHGANG"]
- "chill lo-fi beats" → suggestedSeedArtists: ["Nujabes", "J Dilla", "Uyama Hiroto", "Fat Jon"]
- "2000s rock hits" → suggestedSeedArtists: ["Linkin Park", "Green Day", "Fall Out Boy", "My Chemical Romance"]
Choose artists that match the popularity level implied (mainstream vs underground).

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
        preference: null
      },
      songCount: null
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

    // Step 0.3: Look up reference songs FIRST to confirm artist identity before any name-based lookups.
    // This prevents the wrong-artist disambiguation problem (e.g. Spanish "Dante" vs R&B "Dante").
    // referenceSongs come from the user prompt: "songs similar to Ain't No One by Dante"
    const confirmedArtistUuids = {};      // { artistNameLower: uuid | 'INVALID' | 'NOSIMILAR:<uuid>' }
    const confirmedSpotifyArtistIds = {}; // { artistNameLower: spotifyArtistId }

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
      for (const refSong of referenceSongs0) {
        // SoundCharts UUID confirmation (existing)
        try {
          const result = await searchSoundChartsSong(refSong.title, refSong.artist);
          if (result?.artistUuid) {
            confirmedArtistUuids[refSong.artist.toLowerCase()] = result.artistUuid;
            console.log(`✓ Confirmed "${result.artistName}" via "${refSong.title}" — UUID: ${result.artistUuid}`);
          } else {
            console.log(`⚠ Could not confirm "${refSong.artist}" via song "${refSong.title}" — will fall back to name search`);
          }
        } catch (refErr) {
          console.log(`⚠ Reference song lookup failed for "${refSong.title}": ${refErr.message}`);
        }

        // Spotify artist ID confirmation (new) — find the exact Spotify artist behind this reference song.
        // Storing the ID lets us later verify song matches by ID, not just name string,
        // catching cases like two different artists sharing the name "Dante".
        if (appSpotify) {
          try {
            const q = `track:${refSong.title.replace(/'/g, '')} artist:${refSong.artist}`;
            const searchRes = await appSpotify.searchTracks(q, { limit: 5 });
            const tracks = searchRes.body.tracks?.items || [];
            const artistNorm = refSong.artist.toLowerCase().replace(/[^a-z0-9]/g, '');
            const match = tracks.find(t =>
              (t.artists?.[0]?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '') === artistNorm
            );
            if (match?.artists?.[0]?.id) {
              confirmedSpotifyArtistIds[refSong.artist.toLowerCase()] = match.artists[0].id;
              console.log(`✓ Confirmed Spotify artist ID for "${refSong.artist}": ${match.artists[0].id}`);
            }
          } catch (err) { /* ignore — song matching will fall back to name check */ }
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
                if (!match?.genres?.length) continue;
                spotifyGenres = match.genres.map(g => g.toLowerCase());
              }
              if (!spotifyGenres.length) continue;
              const scIsElectroOnly = scGenres.some(g => ELECTRO.some(e => g.includes(e)))
                                   && !scGenres.some(g => RNB_HH.some(r => g.includes(r)));
              const spotifyIsRnbHh  = spotifyGenres.some(g => RNB_HH.some(r => g.includes(r)));
              if (scIsElectroOnly && spotifyIsRnbHh) {
                console.log(`⚠️  "${artistName}" SC genre mismatch: SC=[${scGenres.slice(0,2).join(',')}] vs Spotify=[${spotifyGenres.slice(0,2).join(',')}] — keeping UUID for song fetch, using Spotify genres, dropping SC similar artists`);
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

      if (existingPlaylistData) {
        console.log(`✓ Found existing playlist: "${existingPlaylistData.playlistName || 'Untitled'}"`);
      } else {
        console.log(`⚠️  Playlist ${playlistId} not found in memory cache`);
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
    if (process.env.SOUNDCHARTS_APP_ID) {
      const scQuery = buildSoundchartsQuery(genreData, allowExplicit);
      const fetchCount = Math.min(songCount * 3, 200);
      // When maxPerArtist is set, ensure the artist pool is large enough to cover songCount unique artists
      const minArtistsNeeded = maxPerArtist ? Math.min(Math.ceil(songCount / maxPerArtist * 1.5), 40) : 0;
      console.log(`🎵 SoundCharts strategy: "${scQuery.strategy}" (fetching ${fetchCount} candidates for ${songCount} target${minArtistsNeeded ? `, min ${minArtistsNeeded} artists` : ''})`);
      console.log(`   Filters: [${scQuery.soundchartsFilters.map(f => f.type).join(', ')}]`);
      try {
        soundChartsDiscoveredSongs = await executeSoundChartsStrategy(scQuery, fetchCount, confirmedArtistUuids, minArtistsNeeded);
        console.log(`✓ SoundCharts returned ${soundChartsDiscoveredSongs.length} songs`);
      } catch (scErr) {
        console.log(`⚠️  SoundCharts strategy failed: ${scErr.message}`);
      }
    } else {
      console.log('⚠️  SOUNDCHARTS_APP_ID not configured - skipping SoundCharts discovery');
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
        source: 'soundcharts'
      }));

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

    // Load song history if playlistId is provided (for manual refresh)
    let playlistSongHistory = new Set();
    if (playlistId && userId) {
      const userPlaylistsArray = userPlaylists.get(userId) || [];
      const playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);
      if (playlist && playlist.songHistory && playlist.songHistory.length > 0) {
        playlistSongHistory = new Set(playlist.songHistory);
        console.log(`[MANUAL-REFRESH] Loaded ${playlistSongHistory.size} tracks from song history to filter out repeats`);
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

    // ── Shared Phase A helper — pre-fetch SC platform IDs for a song pool ──
    const prefetchPlatformIds = async (pool, scPlatformCode) => {
      if (!process.env.SOUNDCHARTS_APP_ID) return;
      const needing = pool.filter(s => !s.isrc && s.uuid && !s.platformId);
      if (needing.length === 0) return;
      console.log(`🔍 [Phase A] Pre-fetching SC identifiers for ${needing.length} songs...`);
      let consecFails = 0;
      for (const song of needing) {
        song.platformId = await getSoundChartsSongPlatformId(song.uuid, scPlatformCode);
        if (song.platformId) { consecFails = 0; }
        else if (++consecFails >= 2) {
          console.log(`🔍 [Phase A] Stopping early — 2 consecutive misses`);
          break;
        }
      }
      console.log(`🔍 [Phase A] Got IDs for ${needing.filter(s => s.platformId).length}/${needing.length} songs`);
    };

    // Scale batch size with song count so Phase B lookup time stays roughly constant
    const BATCH_SIZE = Math.min(Math.max(10, Math.ceil(songCount / 3)), 25);

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

      // ── Shared platform track finder — used by main, supplement, and fallback loops ──
      // Tries (1) ISRC, (2) pre-fetched platform ID, (3) text search.
      // Returns { track, usedExact } or null. Safe to run in parallel (read-only).
      const findTrackOnPlatform = async (song, opts = {}) => {
        const { storefront = 'us', appleMusicApi = null, platformSvc = null } = opts;
        const artistName = song.artistName || song.artist || '';

        if (platform === 'spotify') {
          // 1. ISRC
          if (song.isrc) {
            const r = await Promise.race([
              userSpotifyApi.searchTracks(`isrc:${song.isrc}`, { limit: 5 }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
            ]);
            const items = r.body.tracks.items;
            if (items.length > 0) return { track: items[0], usedExact: true };
          }
          // 2. SC platform ID (pre-fetched)
          if (song.platformId) {
            const r = await Promise.race([
              userSpotifyApi.getTrack(song.platformId),
              new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
            ]);
            if (r.body?.id) return { track: r.body, usedExact: true };
          }
          // 3. Text search
          const r = await Promise.race([
            userSpotifyApi.searchTracks(`track:${song.name} artist:${artistName}`, { limit: 5 }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 5000))
          ]);
          const items = r.body.tracks.items;
          if (items.length === 0) return null;
          const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
          const reqNorm = norm(artistName);
          for (const t of items) {
            const fn = norm(t.artists?.[0]?.name);
            if (reqNorm.length < 6 ? fn === reqNorm : fn === reqNorm || fn.startsWith(reqNorm) || reqNorm.startsWith(fn))
              return { track: t, usedExact: false };
          }
          return null;

        } else if (platform === 'apple') {
          // 1. ISRC
          if (song.isrc && appleMusicApi) {
            try {
              const result = await appleMusicApi.lookupByIsrc(song.isrc, storefront);
              if (result) return { track: result, usedExact: true };
            } catch (_) { /* fall through */ }
          }
          // 2. SC platform ID (pre-fetched)
          if (song.platformId && appleMusicApi) {
            try {
              const result = await appleMusicApi.getTrack(song.platformId, storefront);
              if (result) return { track: result, usedExact: true };
            } catch (_) { /* fall through */ }
          }
          // 3. Text search
          if (platformSvc) {
            const results = await platformSvc.searchTracks(platformUserId, `${song.name} ${artistName}`, tokens, storefront, 5);
            const norm = (s) => (s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
            const reqNorm = norm(artistName);
            for (const t of (results || [])) {
              const fn = norm(t.artists?.[0]?.name || t.artist);
              const nameLower = (t.name || '').toLowerCase();
              if (nameLower.includes(' / ') || /\[slowed|\(slowed|karaoke|orchestra version|\(mixed\)/i.test(t.name)) continue;
              if (reqNorm.length < 6 ? fn === reqNorm : fn === reqNorm || fn.startsWith(reqNorm) || reqNorm.startsWith(fn))
                return { track: t, usedExact: false };
            }
          }
          return null;
        }
        return null;
      };

      // ── Shared post-lookup validator (runs sequentially after each parallel batch) ──
      // Returns true and mutates allTracks/seenTrackIds/seenSongSignatures if track passes all checks.
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
        if (!allowExplicit && track.explicit) {
          console.log(`Skipping explicit track: "${track.name}" by ${track.artists?.[0]?.name || track.artist}`);
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
          externalUrl
        });
        console.log(`✓ Found: "${track.name}" by ${track.artists?.[0]?.name || track.artist}`);
        return true;
      };

      if (platform === 'spotify') {

        // Per-song Spotify lookup (runs in parallel within each batch)
        const findSpotifyTrack = async (recommendedSong) => {
          // 1st: ISRC exact match
          if (recommendedSong.isrc) {
            const result = await Promise.race([
              userSpotifyApi.searchTracks(`isrc:${recommendedSong.isrc}`, { limit: 5 }),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), 5000))
            ]);
            const items = result.body.tracks.items;
            if (items.length > 0) return { track: items[0], usedExact: true };
          }

          // 2nd: direct Spotify ID from SC identifiers (pre-fetched in Phase A)
          if (recommendedSong.platformId) {
            const result = await Promise.race([
              userSpotifyApi.getTrack(recommendedSong.platformId),
              new Promise((_, reject) => setTimeout(() => reject(new Error('Track lookup timeout')), 5000))
            ]);
            if (result.body?.id) {
              console.log(`🎯 SC identifiers match: "${recommendedSong.track}" by ${recommendedSong.artist} → ${recommendedSong.platformId}`);
              return { track: result.body, usedExact: true };
            }
          }

          // 3rd: text search fallback
          const result = await Promise.race([
            userSpotifyApi.searchTracks(`track:${recommendedSong.track} artist:${recommendedSong.artist}`, { limit: 5 }),
            new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), 5000))
          ]);
          const items = result.body.tracks.items;
          if (items.length === 0) return null;

          // Text search: find a track that matches the requested artist
          const requestedArtistNorm = recommendedSong.artist.toLowerCase().replace(/[^a-z0-9]/g, '');
          for (const t of items) {
            const foundArtistNorm = (t.artists?.[0]?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
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

        // ── Phase B: batched parallel Spotify lookups ──
        for (let i = 0; i < recommendedTracks.length && allTracks.length < songCount; i += BATCH_SIZE) {
          const batch = recommendedTracks.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(batch.map(async (recommendedSong) => {
            try {
              const found = await findSpotifyTrack(recommendedSong);
              return { recommendedSong, found };
            } catch (err) {
              console.log(`Error searching for "${recommendedSong.track}": ${err.message}`);
              return { recommendedSong, found: null };
            }
          }));

          for (const { recommendedSong, found } of batchResults) {
            if (allTracks.length >= songCount) break;
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
            if (allTracks.length >= songCount) { console.log(`🎯 Early stop: reached ${songCount} matched Spotify tracks`); break; }
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
        for (let i = 0; i < recommendedTracks.length && allTracks.length < songCount; i += BATCH_SIZE) {
          const batch = recommendedTracks.slice(i, i + BATCH_SIZE);
          const batchResults = await Promise.all(batch.map(async (recommendedSong) => {
            try {
              const found = await findAppleTrack(recommendedSong);
              return { recommendedSong, found };
            } catch (err) {
              console.log(`Error searching for "${recommendedSong.track}": ${err.message}`);
              return { recommendedSong, found: null };
            }
          }));

          for (const { recommendedSong, found } of batchResults) {
            if (allTracks.length >= songCount) break;
            if (!found) { console.log(`✗ Could not find: "${recommendedSong.track}" by ${recommendedSong.artist}`); continue; }

            if (!await validateAndAdd(found.track, recommendedSong, 'apple')) continue;
            if (allTracks.length >= songCount) { console.log(`🎯 Early stop: reached ${songCount} matched Apple Music tracks`); break; }
          }
        }
      }

      console.log(`📊 Successfully found ${allTracks.length} out of ${recommendedTracks.length} SoundCharts-discovered songs`);

      if (allTracks.length >= 5) {
        let selectedTracks = [...allTracks];

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
        if (eraMin || eraMax) {
          const eraDesc = eraMin && eraMax ? `${eraMin}–${eraMax}` : eraMin ? `${eraMin} or later` : `${eraMax} or earlier`;
          constraintLines.push(`Era: songs must be from ${eraDesc}. REMOVE any song originally recorded/released outside this range, even if it was recently repackaged or re-released.`);
        }
        if (hasAvoidances) constraintLines.push(`AVOID: ${genreData.contextClues.avoidances.join(', ')}`);
        if (wantsUndergroundFilter) constraintLines.push(`Popularity: UNDERGROUND/INDIE only — remove mainstream chart artists`);

        const seedArtistNames = hasRequestedArtists && !genreData.artistConstraints.exclusiveMode
          ? genreData.artistConstraints.requestedArtists
          : [];
        if (seedArtistNames.length > 0) {
          constraintLines.push(`Reference artists: ${seedArtistNames.join(', ')}. Remove any artist who clearly does not belong in the same musical scene (different era, unrelated genre, or totally different sound world).`);
        }

        // Attach known release year to each track entry so Claude can verify era constraints
        const trackLines = selectedTracks.map((t, i) => {
          const yr = t.releaseYear || (t.album?.release_date ? parseInt(t.album.release_date.substring(0, 4)) : null);
          return `${i + 1}. "${t.name}" by ${t.artist}${yr ? ` (${yr})` : ''}`;
        });

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

            // Never remove more than 25% of tracks — prevents over-filtering
            const minKeep = Math.ceil(selectedTracks.length * 0.75);
            const finalTracks = filteredTracks.length >= minKeep
              ? filteredTracks
              : selectedTracks.slice(0, Math.max(filteredTracks.length, minKeep));
            if (finalTracks.length >= 5) {
              const removed = selectedTracks.length - finalTracks.length;
              if (removed > 0) {
                console.log(`✂️ Vibe check removed ${removed} mismatched tracks`);
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
          // Supplement with more songs if short of target.
          if (selectedTracks.length < songCount && process.env.SOUNDCHARTS_APP_ID) {
            const needed = songCount - selectedTracks.length;
            console.log(`🔁 Supplementing: need ${needed} more tracks to reach ${songCount}`);
            try {
              // Re-run artist-similarity discovery with relaxed constraints (no mood/theme filters)
              // to pull in more songs that weren't surfaced by the stricter primary pass.
              const seedArtistsForSupplement = genreData.artistConstraints.requestedArtists?.length > 0
                ? genreData.artistConstraints.requestedArtists
                : genreData.artistConstraints.suggestedSeedArtists || [];

              // Build a relaxed query (genre + era only, no mood) using the new direct endpoint.
              // Include suggestedSeedArtists so the 403 fallback has artists to pull from.
              const supplementGenreData = {
                primaryGenre: genreData.primaryGenre,
                atmosphere: [],          // relaxed — no mood filter
                era: genreData.era,
                trackConstraints: {},    // relaxed — no popularity filter
                artistConstraints: {
                  exclusiveMode: false,
                  requestedArtists: [],
                  suggestedSeedArtists: seedArtistsForSupplement
                }
              };
              const supplementQuery = buildSoundchartsQuery(supplementGenreData, allowExplicit);

              // Request a larger pool so we have more candidates to match against
              const suppMinArtists = maxPerArtist ? Math.min(Math.ceil(needed / maxPerArtist * 1.5), 40) : 0;
              const supplementPool = await executeSoundChartsStrategy(supplementQuery, Math.max(needed * 4, 60), confirmedArtistUuids, suppMinArtists);
              console.log(`🔁 Supplement pool: ${supplementPool.length} songs`);

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
                  const suppMaxPerArtist = genreData.trackConstraints?.artistDiversity?.maxPerArtist;
                  if (suppMaxPerArtist !== null && suppMaxPerArtist !== undefined) {
                    const ak = (track.artists?.[0]?.name || track.artist || '').toLowerCase();
                    if ((artistTrackCount.get(ak) || 0) >= suppMaxPerArtist) continue;
                    artistTrackCount.set(ak, (artistTrackCount.get(ak) || 0) + 1);
                  }
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

          // Gap fill: if still short after supplement, pull from top_songs (different pool)
          if (selectedTracks.length < songCount && process.env.SOUNDCHARTS_APP_ID) {
            const gapNeeded = songCount - selectedTracks.length;
            console.log(`🔄 Gap fill: need ${gapNeeded} more tracks from top_songs`);
            try {
              const gapGenreData = {
                primaryGenre: genreData.primaryGenre,
                atmosphere: [],
                era: genreData.era,
                // Preserve popularity preference so career stage filter applies
                // (prevents unrelated mainstream artists like Ed Sheeran appearing)
                trackConstraints: { popularity: genreData.trackConstraints?.popularity },
                artistConstraints: { exclusiveMode: false, requestedArtists: [] }
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
                  const gfMaxPerArtist = genreData.trackConstraints?.artistDiversity?.maxPerArtist;
                  if (gfMaxPerArtist !== null && gfMaxPerArtist !== undefined) {
                    const ak = (track.artists?.[0]?.name || track.artist || '').toLowerCase();
                    if ((artistTrackCount.get(ak) || 0) >= gfMaxPerArtist) continue;
                    artistTrackCount.set(ak, (artistTrackCount.get(ak) || 0) + 1);
                  }
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

          // Update song history so auto-update excludes these tracks too
          if (playlistId && userId) {
            try {
              const upa = userPlaylists.get(userId) || [];
              const upi = upa.findIndex(p => p.playlistId === playlistId);
              if (upi !== -1) {
                const pl = upa[upi];
                if (!pl.songHistory) pl.songHistory = [];
                pl.songHistory = [...pl.songHistory, ...selectedTracks.map(t => `${normalizeForHistory(t.name)}|||${(t.artist || '').toLowerCase()}`)];
                if (pl.songHistory.length > 500) pl.songHistory = pl.songHistory.slice(-500);
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
        const topSongs = await executeSoundChartsStrategy(fallbackQuery, songCount * 2);
        console.log(`🔄 SoundCharts top songs: ${topSongs.length} candidates`);

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


    // SoundCharts already ranked songs by streams — take the top N directly.
    // Request 20% more if vibe check will run (it may trim some tracks).
    const hasVibeRequirements = genreData.atmosphere.length > 0 || genreData.contextClues.useCase || genreData.era.decade || genreData.subgenre || genreData.trackConstraints.popularity.preference === 'underground';
    const selectionTarget = hasVibeRequirements ? Math.ceil(songCount * 1.2) : songCount;
    let selectedTracks = tracksForSelection.slice(0, selectionTarget);
    console.log(`📋 Using top ${selectedTracks.length} tracks (${hasVibeRequirements ? 'vibe check will run' : 'no vibe check needed'})`);

    // Step 4: VIBE CHECK - Review the selected tracks for coherence
    // This addresses the #1 complaint: AI missing the "vibe" even when genres match
    // Also filters out mainstream artists when underground preference is detected
    if (selectedTracks.length > 0 && (genreData.atmosphere.length > 0 || genreData.contextClues.useCase || genreData.era.decade || genreData.subgenre || genreData.trackConstraints.popularity.preference === 'underground')) {
      console.log('Running vibe check on selected tracks...');

      const vibeCheckPrompt = `You are reviewing a playlist to ensure it has a COHERENT VIBE and emotional atmosphere.

Original user request: "${prompt}"

REQUIRED VIBE/CONTEXT:
- Target atmosphere: ${genreData.atmosphere.join(', ') || 'not specified'}
- Use case: ${genreData.contextClues.useCase || 'not specified'}
- Subgenre: ${genreData.subgenre || 'not specified'}
- Era/decade: ${genreData.era.decade || 'not specified'}
- Avoid: ${genreData.contextClues.avoidances.join('; ') || 'nothing'}
- Popularity preference: ${genreData.trackConstraints.popularity.preference || 'not specified'}${genreData.trackConstraints.popularity.preference === 'underground' ? ' ← CRITICAL: STRICTLY remove ALL mainstream/radio/chart artists' : ''}

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

Be EXTREMELY strict about vibe coherence, especially for underground preference. When in doubt, REMOVE the track.

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
            console.log(`  - "${issue.trackName}": ${issue.reason}`);
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
            const remainingTracks = tracksForSelection.filter(t => !vibeCheckedIds.has(t.id));

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

    // Update song history so auto-update excludes these tracks too
    if (playlistId && userId) {
      try {
        const upa = userPlaylists.get(userId) || [];
        const upi = upa.findIndex(p => p.playlistId === playlistId);
        if (upi !== -1) {
          const pl = upa[upi];
          if (!pl.songHistory) pl.songHistory = [];
          pl.songHistory = [...pl.songHistory, ...selectedTracks.map(t => `${normalizeForHistory(t.name)}|||${(t.artist || '').toLowerCase()}`)];
          if (pl.songHistory.length > 500) pl.songHistory = pl.songHistory.slice(-500);
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

            const tracks = playlistDetails.body.tracks.items.map(item => {
              const trackId = item.track.id;
              let reaction = null;
              if (likedSongsMap.has(trackId)) {
                reaction = 'thumbsUp';
              } else if (dislikedSongsMap.has(trackId)) {
                reaction = 'thumbsDown';
              }

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

            const tracksWithDetails = tracks.map(track => {
              const trackId = track.id;
              let reaction = null;
              if (likedSongsMap.has(trackId)) {
                reaction = 'thumbsUp';
              } else if (dislikedSongsMap.has(trackId)) {
                reaction = 'thumbsDown';
              }

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
      // Note: Apple Music API does not support removing tracks from playlists
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

// Update playlist settings (auto-update frequency, mode, and privacy)
app.put('/api/playlists/:playlistId/settings', async (req, res) => {
  try {
    const { playlistId } = req.params;
    let { userId, updateFrequency, updateMode, isPublic, updateTime } = req.body;

    console.log('Update settings request:', { playlistId, userId, updateFrequency, updateMode, isPublic, updateTime });

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

    // Get user's playlists
    const userPlaylistsArray = userPlaylists.get(userId) || [];
    const playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);

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
      console.log(`[REACTION] User disliked song: ${trackName} by ${artistName}`);
    } else {
      console.log(`[REACTION] Removed reaction from song: ${trackName}`);
    }

    // Save changes
    userPlaylists.set(userId, userPlaylistsArray);
    console.log(`[REACTION] Saving playlist with ${playlist.likedSongs.length} liked, ${playlist.dislikedSongs.length} disliked songs`);
    await savePlaylist(userId, playlist);
    console.log(`[REACTION] Successfully saved reaction for ${trackName}`);

    // Remove thumbed-down song from the platform playlist
    if (reaction === 'thumbsDown' && trackUri && playlist.playlistId) {
      try {
        const reactionTokens = await db.getToken(userId);
        if (reactionTokens) {
          const platformService = new PlatformService();
          const reactionPlatform = platformService.getPlatform(userId);
          if (reactionPlatform === 'apple') {
            // Apple Music doesn't support individual track removal; use replace flow instead
            // Build the remaining track URI list from in-app playlist state
            const remainingUris = (playlist.trackUris || []).filter(u => u !== trackUri);
            await platformService.replacePlaylistTracks(userId, playlist.playlistId, remainingUris, reactionTokens);
          } else {
            await platformService.removeTracksFromPlaylist(userId, playlist.playlistId, [trackUri], reactionTokens);
          }
          console.log(`[REACTION] Removed "${trackName}" from platform playlist`);
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
    // (same pre-flight logic as manual refresh). Just pass the originalPrompt as a fallback
    // for imported playlists that have no stored originalPrompt — generate-playlist will use
    // it as-is since there's nothing to restore.
    const prompt = playlist.originalPrompt || `Generate songs similar to: ${playlist.playlistName}`;
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
      const genResult = await axios.post(`http://localhost:${PORT}/api/generate-playlist`, {
        prompt,
        userId,
        platform: playlistPlatform,
        allowExplicit: true,
        songCount: playlist.requestedSongCount || playlist.trackCount || 30,
        // In replace mode, don't exclude current tracks — they can be re-selected freely
        // (excluding them on a niche-genre playlist can starve the pool and return far fewer songs).
        // In append mode, exclude them to avoid duplicates.
        excludeTrackUris: playlist.updateMode === 'replace'
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
        // Preserve the requested count so future updates don't shrink if this run was short
        playlist.trackCount = playlist.requestedSongCount || Math.max(playlist.trackCount || 0, newUris.length);
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
        if (playlist.songHistory.length > 200) {
          playlist.songHistory = playlist.songHistory.slice(-200);
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
          } else {
            await appleMusicApiInstance.addTracksToPlaylist(appleTokens.access_token, playlist.playlistId, trackIds);
            console.log(`[AUTO-UPDATE] Successfully appended ${trackIds.length} tracks to Apple Music playlist ${playlist.playlistName}`);
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

// ─── Stripe Endpoints ────────────────────────────────────────────────────────

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

    let frontendUrl = process.env.FRONTEND_URL || 'https://tryfins.com';
    if (!frontendUrl.startsWith('http')) frontendUrl = 'https://' + frontendUrl;

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
    let frontendUrl = process.env.FRONTEND_URL || 'https://tryfins.com';
    if (!frontendUrl.startsWith('http')) frontendUrl = 'https://' + frontendUrl;
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

// ─────────────────────────────────────────────────────────────────────────────

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
