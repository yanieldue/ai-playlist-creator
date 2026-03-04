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
const crypto = require('crypto');
const sgMail = require('@sendgrid/mail');
const nodemailer = require('nodemailer');
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

// Middleware
// Configure CORS for production and development
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
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
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;

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
            setSCCache(cacheKey, null);
            return null;
          }
        }
      }

      // If only one viable candidate, return it directly
      if (viableCandidates.length === 1) {
        console.log(`🔍 SoundCharts: "${viableCandidates[0].name}" matched (genres: ${(viableCandidates[0].genres || []).map(g => g.root).join(', ') || 'unknown'})`);
        setSCCache(cacheKey, viableCandidates[0]);
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
            setSCCache(cacheKey, null);
            return null;
          }
        }

        const best = genreRanked[0].artist;
        console.log(`🔍 SoundCharts: "${best.name}" selected from ${viableCandidates.length} matches by genre (${expectedGenre}); genres: ${(best.genres || []).map(g => g.root).join(', ') || 'unknown'}`);
        setSCCache(cacheKey, best);
        return best;
      }

      // No genre hint — return first viable result (SoundCharts sorts by relevance)
      console.log(`🔍 SoundCharts: "${viableCandidates[0].name}" matched (first of ${viableCandidates.length}; no genre hint)`);
      setSCCache(cacheKey, viableCandidates[0]);
      return viableCandidates[0];
    }
    setSCCache(cacheKey, null);
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
  const cached = getSCCache(cacheKey);
  if (cached !== undefined) return cached;

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
      setSCCache(cacheKey, result);
      return result;
    }
    setSCCache(cacheKey, []);
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
const SOUNDCHARTS_GENRE_MAP = {
  'pop': 'pop', 'dance pop': 'pop', 'synth-pop': 'pop', 'electropop': 'pop',
  'hip hop': 'hip-hop', 'hip-hop': 'hip-hop', 'rap': 'hip-hop', 'trap': 'hip-hop',
  'drill': 'hip-hop', 'underground hip hop': 'hip-hop',
  'r&b': 'r-b', 'rnb': 'r-b', 'neo soul': 'r-b', 'soul': 'r-b',
  'rock': 'rock', 'indie rock': 'rock', 'pop rock': 'rock',
  'alternative': 'alternative', 'indie': 'indie', 'indie pop': 'indie',
  'electronic': 'electronic', 'edm': 'electronic', 'house': 'electronic',
  'techno': 'electronic', 'dance': 'electronic',
  'country': 'country', 'country pop': 'country',
  'latin': 'latin', 'reggaeton': 'latin', 'latin pop': 'latin',
  'jazz': 'jazz', 'funk': 'funk',
  'metal': 'metal', 'punk': 'punk', 'classical': 'classical',
  'k-pop': 'k-pop', 'afrobeats': 'afrobeats', 'afro pop': 'afrobeats',
  'lo-fi': 'lo-fi', 'ambient': 'ambient',
  'reggae': 'reggae', 'blues': 'blues', 'gospel': 'gospel',
};

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
};

// Discover top songs by genre/mood using SoundCharts POST /api/v2/top/songs
// Used when no seed artists are specified — replaces the old hardcoded artist list
async function discoverSongsViaSoundChartsTop(criteria, limit = 50, offset = 0) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;
  if (!appId || !apiKey) return [];

  const filters = [];

  // Genre filter — map Claude genre name to SoundCharts slug
  if (criteria.genre) {
    const genreLower = criteria.genre.toLowerCase().trim();
    let scGenre = SOUNDCHARTS_GENRE_MAP[genreLower];
    // Partial match if no exact match
    if (!scGenre) {
      for (const [key, val] of Object.entries(SOUNDCHARTS_GENRE_MAP)) {
        if (genreLower.includes(key) || key.includes(genreLower)) { scGenre = val; break; }
      }
    }
    if (scGenre) {
      filters.push({ type: 'songGenres', data: { values: [scGenre], operator: 'in' } });
    }
  }

  // Mood filter — map atmosphere labels to SoundCharts mood values
  if (criteria.targetMoods && criteria.targetMoods.length > 0) {
    const scMoods = [...new Set(
      criteria.targetMoods
        .map(m => SOUNDCHARTS_MOOD_MAP[m.toLowerCase()] || m)
        .filter(Boolean)
    )];
    if (scMoods.length > 0) {
      filters.push({ type: 'moods', data: { values: scMoods, operator: 'in' } });
    }
  }

  // Release year filter
  if (criteria.releaseYear?.min || criteria.releaseYear?.max) {
    const dateFilter = { type: 'releaseDate', data: {} };
    if (criteria.releaseYear.min) dateFilter.data.min = `${criteria.releaseYear.min}-01-01`;
    if (criteria.releaseYear.max) dateFilter.data.max = `${criteria.releaseYear.max}-12-31`;
    filters.push(dateFilter);
  }

  // Sort by monthly Spotify streams (most popular first)
  const sort = {
    type: 'metric',
    platform: 'spotify',
    metricType: 'streams',
    sortBy: 'total',
    period: 'month',
    order: 'desc'
  };

  const body = { sort, ...(filters.length > 0 ? { filters } : {}) };
  console.log(`   SoundCharts top songs: genre=${criteria.genre || 'any'}, moods=${criteria.targetMoods?.join(',') || 'any'}`);

  try {
    await throttleSoundCharts();
    const response = await axios.post(
      'https://customer.api.soundcharts.com/api/v2/top/songs',
      body,
      {
        headers: { 'x-app-id': appId, 'x-api-key': apiKey, 'Content-Type': 'application/json' },
        params: { offset, limit: Math.min(limit, 100) },
        timeout: 15000
      }
    );

    const items = response.data?.items || [];
    console.log(`   SoundCharts top songs returned ${items.length} results`);
    return items.map(song => ({
      uuid: song.uuid,
      name: song.name,
      artistName: song.artists?.[0]?.name || song.creditName || 'Unknown',
      releaseDate: song.releaseDate,
      isrc: song.isrc?.value || song.isrc || null,
    }));
  } catch (error) {
    console.log(`⚠️  SoundCharts top songs error: ${error.response?.status} ${error.message}`);
    return [];
  }
}

// Helper function to discover songs via SoundCharts based on criteria
// Strategy 1 (seed artists): similarity tree — seed → similar → similar-of-similar
// Strategy 2 (no seed artists): top songs filtered by genre/mood, sorted by streams
async function discoverSongsViaSoundCharts(criteria, limit = 50, knownArtistsSet = null) {
  const appId = process.env.SOUNDCHARTS_APP_ID;
  const apiKey = process.env.SOUNDCHARTS_API_KEY;

  if (!appId || !apiKey) {
    console.log('⚠️  SoundCharts not configured, skipping song discovery');
    return [];
  }

  console.log('🎵 Discovering songs via SoundCharts...');
  console.log(`   Criteria: ${JSON.stringify(criteria)}`);

  const discoveredSongs = [];
  const processedArtists = new Set();
  const hasSeedArtists = !!(criteria.seedArtists && criteria.seedArtists.length > 0);

  // Strategy 1: If we have seed artists, get their songs + similar artists' songs
  // Dynamic approach: balance variety across all artists (seed and similar)
  if (hasSeedArtists) {
    const isExclusive = criteria.exclusiveMode === true;
    const numSeedArtists = Math.min(criteria.seedArtists.length, 5);

    // Dynamic calculation for balanced variety
    // Goal: Get songs from many artists with even distribution
    // Target ~15-20 unique artists total for good variety

    if (isExclusive) {
      // Exclusive mode: only seed artists, distribute songs evenly
      const songsPerArtist = Math.ceil(limit / numSeedArtists);
      console.log(`   Mode: EXCLUSIVE - ${numSeedArtists} artists, ~${songsPerArtist} songs each`);

      for (const artistName of criteria.seedArtists.slice(0, 5)) {
        if (processedArtists.has(artistName.toLowerCase())) continue;
        processedArtists.add(artistName.toLowerCase());

        const confirmedUuidExcl = criteria.confirmedArtistUuids?.[artistName.toLowerCase()];
        const artistInfo = confirmedUuidExcl
          ? await getSoundChartsArtistInfoByUuid(confirmedUuidExcl, artistName)
          : await getSoundChartsArtistInfo(artistName, criteria.genre);
        if (!artistInfo) continue;

        const songs = await getSoundChartsArtistSongs(artistInfo.uuid, songsPerArtist);
        for (const song of songs) {
          discoveredSongs.push({
            ...song,
            artistName: artistInfo.name,
            source: 'seed_artist'
          });
        }
      }
    } else {
      // Similar vibe mode: build a discovery tree for maximum variety
      // Level 0: Seed artists (Pete Bailey, Ansel King, Tyree Thomas)
      // Level 1: Similar to seeds (CALLMEJB, Scars, Kayvion...)
      // Level 2: Similar to level 1 (even more discovery)

      const targetTotalArtists = Math.max(20, Math.ceil(limit / 2.5)); // ~2-3 songs per artist for max variety
      const songsPerArtist = Math.max(2, Math.min(4, Math.ceil(limit / targetTotalArtists)));

      console.log(`   Mode: SIMILAR VIBE - targeting ${targetTotalArtists} artists, ~${songsPerArtist} songs each`);

      // Collect artists at each level
      const allArtists = []; // { name, uuid, source, level }
      const level1Artists = []; // Track level 1 for getting their similar artists

      // Level 0: Add seed artists
      for (const artistName of criteria.seedArtists.slice(0, 5)) {
        if (processedArtists.has(artistName.toLowerCase())) continue;
        processedArtists.add(artistName.toLowerCase());

        // Use confirmed UUID from SoundCharts reference-song lookup if available; otherwise search by name
        const confirmedUuid = criteria.confirmedArtistUuids?.[artistName.toLowerCase()];
        const artistInfo = confirmedUuid
          ? await getSoundChartsArtistInfoByUuid(confirmedUuid, artistName)
          : await getSoundChartsArtistInfo(artistName, criteria.genre);
        if (!artistInfo) continue;

        allArtists.push({
          name: artistInfo.name,
          uuid: artistInfo.uuid,
          source: 'seed_artist',
          level: 0
        });

        // Level 1: Add similar artists to seeds (~40% of target from this level)
        const level1Count = Math.ceil((targetTotalArtists * 0.4) / numSeedArtists);
        for (const similarArtist of artistInfo.similarArtists.slice(0, level1Count)) {
          if (processedArtists.has(similarArtist.toLowerCase())) continue;
          processedArtists.add(similarArtist.toLowerCase());

          const similarInfo = await searchSoundChartsArtist(similarArtist, criteria.genre);
          if (!similarInfo) continue;

          const artistData = {
            name: similarInfo.name || similarArtist,
            uuid: similarInfo.uuid,
            source: 'similar_artist',
            level: 1
          };
          allArtists.push(artistData);
          level1Artists.push(artistData);
        }
      }

      console.log(`   Level 0 (seeds): ${numSeedArtists} artists`);
      console.log(`   Level 1 (similar to seeds): ${level1Artists.length} artists`);

      // Level 2: Get similar artists of level 1 artists for even more variety
      const remainingNeeded = targetTotalArtists - allArtists.length;
      if (remainingNeeded > 0 && level1Artists.length > 0) {
        const level2PerArtist = Math.ceil(remainingNeeded / Math.min(level1Artists.length, 5));

        // Pick a subset of level 1 artists to expand (shuffle for variety)
        const artistsToExpand = level1Artists.sort(() => Math.random() - 0.5).slice(0, 5);

        for (const level1Artist of artistsToExpand) {
          if (allArtists.length >= targetTotalArtists) break;

          // Get similar artists for this level 1 artist
          const level1Similar = await getSoundChartsSimilarArtists(level1Artist.uuid, level2PerArtist);

          for (const similar of level1Similar) {
            if (processedArtists.has(similar.name.toLowerCase())) continue;
            processedArtists.add(similar.name.toLowerCase());

            allArtists.push({
              name: similar.name,
              uuid: similar.uuid,
              source: 'discovery',
              level: 2
            });

            if (allArtists.length >= targetTotalArtists) break;
          }
        }

        const level2Count = allArtists.length - numSeedArtists - level1Artists.length;
        console.log(`   Level 2 (similar to similar): ${level2Count} artists`);
      }

      // Level 3: When newArtistsOnly is active, levels 1+2 may be mostly known artists.
      // Go one level deeper to find more obscure/unknown artists.
      if (knownArtistsSet && knownArtistsSet.size > 0) {
        const level2Artists = allArtists.filter(a => a.level === 2);
        const unknownLevel2 = level2Artists.filter(a => !knownArtistsSet.has(a.name.toLowerCase()));
        const artistsToExpandL3 = unknownLevel2.sort(() => Math.random() - 0.5).slice(0, 4);

        for (const l2Artist of artistsToExpandL3) {
          if (allArtists.length >= targetTotalArtists * 1.5) break;
          const l3Similar = await getSoundChartsSimilarArtists(l2Artist.uuid, 5);
          for (const similar of l3Similar) {
            if (processedArtists.has(similar.name.toLowerCase())) continue;
            processedArtists.add(similar.name.toLowerCase());
            allArtists.push({ name: similar.name, uuid: similar.uuid, source: 'discovery', level: 3 });
          }
        }
        const level3Count = allArtists.filter(a => a.level === 3).length;
        if (level3Count > 0) console.log(`   Level 3 (deeper discovery): ${level3Count} artists`);
      }

      console.log(`   Total: ${allArtists.length} unique artists to pull songs from`);


      // Get songs from each artist with even distribution
      // In non-exclusive (similar-vibe) mode: prioritize similar/discovery artists over seed artists
      // Seed artists appear last so similar artists fill the pool first.
      // This prevents seed artists from dominating when similar artists fail Spotify lookup.
      const seedArtistList = allArtists.filter(a => a.level === 0);
      const nonSeedArtists = allArtists.filter(a => a.level > 0).sort(() => Math.random() - 0.5);
      const orderedArtists = [...nonSeedArtists, ...seedArtistList];

      // Seed artists get fewer songs (they're the reference point, not the focus)
      // Similar/discovery artists get full songsPerArtist allocation
      const seedSongsPerArtist = Math.min(2, songsPerArtist);

      for (const artist of orderedArtists) {
        // When newArtistsOnly: skip song-fetching for known artists (but we still traversed them
        // for similar artists, so they contributed to the tree). Always fetch seed artists' songs
        // as they're the reference point, not the target of newArtistsOnly filtering.
        if (knownArtistsSet && knownArtistsSet.size > 0 && artist.level > 0) {
          if (knownArtistsSet.has(artist.name.toLowerCase())) {
            console.log(`[NEW-ARTISTS] Skipping songs from known artist: ${artist.name}`);
            continue;
          }
        }

        const artistSongLimit = artist.level === 0 ? seedSongsPerArtist : songsPerArtist;
        const songs = await getSoundChartsArtistSongs(artist.uuid, artistSongLimit);
        for (const song of songs) {
          discoveredSongs.push({
            ...song,
            artistName: artist.name,
            source: artist.source
          });
        }

        // Stop if we have enough songs (with buffer for filtering)
        if (discoveredSongs.length >= limit * 1.5) break;
      }
    }
  }

  // Strategy 2: No seed artists — use SoundCharts top songs filtered by genre/mood/streams
  if (!hasSeedArtists && discoveredSongs.length < limit) {
    const topSongs = await discoverSongsViaSoundChartsTop(criteria, limit);
    for (const song of topSongs) {
      discoveredSongs.push({ ...song, source: 'top_songs' });
    }
  }

  console.log(`   Discovered ${discoveredSongs.length} songs from SoundCharts`);

  // Apply release year filter if specified (pure metadata — no extra API calls needed)
  if (criteria.releaseYear && (criteria.releaseYear.min || criteria.releaseYear.max)) {
    const before = discoveredSongs.length;
    const filtered = discoveredSongs.filter(song => {
      if (!song.releaseDate) return true; // keep if unknown
      const year = new Date(song.releaseDate).getFullYear();
      if (criteria.releaseYear.min && year < criteria.releaseYear.min) return false;
      if (criteria.releaseYear.max && year > criteria.releaseYear.max) return false;
      return true;
    });
    if (filtered.length < before) console.log(`   Release year filter: ${before} → ${filtered.length} songs`);
    return filtered.slice(0, limit);
  }

  return discoveredSongs.slice(0, limit);
}

// Helper function to detect if userId is email-based (new format) or platform-specific (old format)
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

    // Record all artists from this playlist so newArtistsOnly has a growing history
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

// Calculate next update date based on frequency
// Converts user's selected time and timezone to UTC for scheduling
function calculateNextUpdate(frequency, playlistId = null, updateTime = null) {
  const now = new Date();
  let next = new Date();

  // If updateTime is provided, use it to calculate the exact time
  if (updateTime) {
    const { hour, minute, period, timezone } = updateTime;

    // Convert 12-hour format to 24-hour
    let hour24 = parseInt(hour);
    if (period === 'PM' && hour24 !== 12) {
      hour24 += 12;
    } else if (period === 'AM' && hour24 === 12) {
      hour24 = 0;
    }

    // Create a date string in the user's timezone using ISO 8601 format
    // Get current date components in the user's timezone
    const nowInTz = new Date().toLocaleString('en-US', {
      timeZone: timezone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });

    const [month, day, year] = nowInTz.split('/');
    // Build ISO string: YYYY-MM-DDTHH:MM:SS
    const isoString = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')}T${hour24.toString().padStart(2, '0')}:${minute.toString().padStart(2, '0')}:00`;

    // Parse this as a local time, then get UTC equivalent
    // We need to account for the timezone offset
    const tempDate = new Date(isoString);
    const utcString = tempDate.toLocaleString('en-US', { timeZone: 'UTC' });
    const tzString = tempDate.toLocaleString('en-US', { timeZone: timezone });

    // Calculate the offset in milliseconds
    const utcTime = new Date(utcString).getTime();
    const tzTime = new Date(tzString).getTime();
    const offsetMs = utcTime - tzTime;

    // Apply offset to get correct UTC time
    next = new Date(tempDate.getTime() - offsetMs);

  } else if (playlistId) {
    // Fall back to hash-based time slot if no updateTime specified
    let hash = 0;
    for (let i = 0; i < playlistId.length; i++) {
      hash = ((hash << 5) - hash) + playlistId.charCodeAt(i);
      hash = hash & hash;
    }
    const hourOffset = Math.abs(hash) % 24;
    next.setUTCHours(hourOffset, 0, 0, 0);
  } else {
    // Default to midnight UTC
    next.setUTCHours(0, 0, 0, 0);
  }

  // Adjust based on frequency
  switch (frequency) {
    case 'daily':
      // If we've already passed this time today, schedule for tomorrow
      // Use < instead of <= to allow updates scheduled for the current minute
      if (next < now) {
        next.setDate(next.getDate() + 1);
      }
      break;
    case 'weekly':
      // Schedule for next week
      next.setDate(next.getDate() + 7);
      if (next <= now) {
        next.setDate(next.getDate() + 7);
      }
      break;
    case 'monthly':
      // Schedule for next month
      next.setMonth(next.getMonth() + 1);
      if (next <= now) {
        next.setMonth(next.getMonth() + 1);
      }
      break;
    default:
      return null;
  }
  return next.toISOString();
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

    // Cache the results for 24 hours (expires at next 12 AM UTC)
    if (formattedArtists.length > 0) {
      try {
        await db.setCachedArtists(platformUserId, formattedArtists);
        console.log('✓ Cached artist recommendations for user');
      } catch (cacheError) {
        console.error('Failed to cache artists:', cacheError.message);
        // Don't fail the request if caching fails
      }
    }

    res.json({ artists: formattedArtists, cached: false });
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
    let { prompt, userId, platform = 'spotify', allowExplicit = true, newArtistsOnly = false, songCount = 30, excludeTrackUris = [], playlistId = null } = req.body;

    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }

    // Weekly generation limit for free users
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

    // Get user's listening history if newArtistsOnly is enabled
    let knownArtists = new Set();
    if (newArtistsOnly && platform === 'spotify') {
      try {
        console.log('Fetching user listening history to filter out known artists...');

        // 1. Load artist history from our database (builds over time, unlimited)
        try {
          const artistHistory = await db.getArtistHistory(platformUserId);
          artistHistory.forEach(artist => {
            knownArtists.add(artist.artistName.toLowerCase());
          });
          console.log(`Loaded ${artistHistory.length} artists from database history`);
        } catch (dbError) {
          console.log('Could not load artist history from database:', dbError.message);
        }

        // 2. Get user's top artists from Spotify (all time, last 6 months, last 4 weeks)
        const timeRanges = ['long_term', 'medium_term', 'short_term'];
        for (const timeRange of timeRanges) {
          try {
            const topArtistsData = await userSpotifyApi.getMyTopArtists({
              time_range: timeRange,
              limit: 50
            });
            topArtistsData.body.items.forEach(artist => {
              knownArtists.add(artist.name.toLowerCase());
            });
          } catch (err) {
            console.log(`Failed to get top artists for ${timeRange}:`, err.message);
          }
        }

        // 3. Get user's recently played tracks from Spotify
        try {
          const recentlyPlayed = await userSpotifyApi.getMyRecentlyPlayedTracks({ limit: 50 });
          recentlyPlayed.body.items.forEach(item => {
            item.track.artists.forEach(artist => {
              knownArtists.add(artist.name.toLowerCase());
            });
          });
        } catch (err) {
          console.log('Failed to get recently played tracks:', err.message);
        }

        // 4. Get artists from user's liked/saved songs (up to 200 tracks = 4 pages)
        // Catches artists the user has heard but who don't appear in top artists
        try {
          let savedOffset = 0;
          const savedLimit = 50;
          const savedPages = 4; // 200 saved tracks max to keep it fast
          for (let page = 0; page < savedPages; page++) {
            const savedData = await userSpotifyApi.getMySavedTracks({ limit: savedLimit, offset: savedOffset });
            const items = savedData.body.items || [];
            items.forEach(item => {
              item.track?.artists?.forEach(artist => {
                knownArtists.add(artist.name.toLowerCase());
              });
            });
            if (items.length < savedLimit) break; // no more pages
            savedOffset += savedLimit;
          }
        } catch (err) {
          console.log('Failed to get saved tracks:', err.message);
        }

        // 5. Get artists the user follows explicitly
        try {
          const followedData = await userSpotifyApi.getFollowedArtists({ limit: 50 });
          (followedData.body.artists?.items || []).forEach(artist => {
            knownArtists.add(artist.name.toLowerCase());
          });
        } catch (err) {
          console.log('Failed to get followed artists:', err.message);
        }

        console.log(`Found ${knownArtists.size} total known artists to filter out`);
      } catch (error) {
        console.error('Error fetching listening history:', error);
        // Continue anyway - we'll just not filter
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
    "albumDiversity": { "maxPerAlbum": number or null, "preferDeepCuts": boolean, "preferSingles": boolean }
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
- "90s", "2000s", "2010s": Extract decade
- "past 5 years", "last 3 years", "recent": Calculate from ${new Date().getFullYear()} (e.g., "last 5 years" = ${new Date().getFullYear() - 5}-${new Date().getFullYear()})
- "from 2015 to 2020": Set min/max
- "only 2020 songs": Set both min and max to same year
- "contemporary", "modern": Set min to ${new Date().getFullYear() - 5}

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
  * exclusiveMode: true if user says "only [artist]", "just [artist]", "all songs from [artist]", "exclusively [artist]"
  * exclusiveMode: false for "like [artist]", "similar to [artist]", "vibes of [artist]", "artists like [artist]"
- Examples:
  * "artists like C.LACY or Tyree Thomas" → requestedArtists: ["C.LACY", "Tyree Thomas"], exclusiveMode: false
  * "i only want songs from drake" → requestedArtists: ["Drake"], exclusiveMode: true
  * "just Taylor Swift songs" → requestedArtists: ["Taylor Swift"], exclusiveMode: true
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
When the user doesn't mention specific artists, YOU MUST suggest 3-5 seed artists that exemplify the requested genre/mood.
These are used to find similar artists and build the playlist.
Examples:
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
        albumDiversity: { maxPerAlbum: null, preferDeepCuts: false, preferSingles: false }
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
    const confirmedArtistUuids = {}; // { artistNameLower: uuid }
    const referenceSongs0 = genreData.referenceSongs || [];
    if (referenceSongs0.length > 0 && process.env.SOUNDCHARTS_APP_ID) {
      console.log(`🎯 Looking up ${referenceSongs0.length} reference song(s) on SoundCharts to confirm artist identity...`);
      for (const refSong of referenceSongs0) {
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

        // Use SoundCharts to get genres, similar artists, and career stage (for popularity detection)
        console.log('🔍 Checking SoundCharts for artist info and similar artists...');
        const artistCareerStages = [];
        for (const artistName of genreData.artistConstraints.requestedArtists) {
          // If we already confirmed this artist's UUID via reference song lookup, use it directly
          // to avoid name-based disambiguation picking the wrong artist (e.g. Spanish Dante vs R&B Dante)
          const confirmedUuid = confirmedArtistUuids[artistName.toLowerCase()];
          const soundChartsInfo = confirmedUuid
            ? await getSoundChartsArtistInfoByUuid(confirmedUuid, artistName)
            : await getSoundChartsArtistInfo(artistName);
          if (soundChartsInfo) {
            if (soundChartsInfo.genres.length > 0) {
              artistGenres.push(...soundChartsInfo.genres);
            }
            if (soundChartsInfo.similarArtists.length > 0) {
              allSimilarArtists.push(...soundChartsInfo.similarArtists);
            }
            if (soundChartsInfo.careerStage) {
              artistCareerStages.push(soundChartsInfo.careerStage);
            }
          }
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

      // For refinements/refreshes, restore the FULL original genreData to prevent the
      // refinement message from accidentally shifting genre/style. E.g. "add more chill songs"
      // should not turn a hip-hop playlist into lofi — the refinement message text only guides
      // song selection, not the core musical DNA captured in the stored genreData.
      if (existingPlaylistData && existingPlaylistData.genreData) {
        console.log('Restoring full original genre data for refinement consistency');
        genreData = JSON.parse(JSON.stringify(existingPlaylistData.genreData));
        if (genreData.artistConstraints?.requestedArtists?.length) {
          console.log(`Preserved requested artists: ${genreData.artistConstraints.requestedArtists.join(', ')} (exclusive: ${genreData.artistConstraints.exclusiveMode})`);
        }
        if (genreData.primaryGenre) {
          console.log(`Preserved genre: ${genreData.primaryGenre} / ${genreData.subgenre}`);
        }
      }

      // Also restore the original prompt so the AI call doesn't see a frontend-built prompt
      // that references stale (possibly wrong-genre) tracks or concatenated refinement text.
      // The original prompt is the clearest signal of the user's intent.
      if (existingPlaylistData && existingPlaylistData.originalPrompt) {
        console.log(`Restoring original prompt for AI: "${existingPlaylistData.originalPrompt}"`);
        prompt = existingPlaylistData.originalPrompt;
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

    // Strategy 1: Use SoundCharts to discover songs via similar artists
    // This is the primary discovery method - uses seed artists (requested or suggested) to find similar music
    let soundChartsDiscoveredSongs = [];
    const seedArtists = genreData.artistConstraints.requestedArtists?.length > 0
      ? genreData.artistConstraints.requestedArtists
      : genreData.artistConstraints.suggestedSeedArtists || [];

    // confirmedArtistUuids already populated in Step 0.3 (before genre inference)
    // so the correct artist UUID is available for song discovery too.

    if (process.env.SOUNDCHARTS_APP_ID) {
      console.log('🎵 Using SoundCharts for song discovery...');
      if (seedArtists.length > 0) {
        console.log(`   Seed artists: ${seedArtists.join(', ')}`);
      } else {
        console.log('   No seed artists — will use genre/mood-based top songs discovery');
      }

      // Map user mood/atmosphere to SoundCharts moods
      const moodMapping = {
        'sad': ['Melancholic', 'Sad', 'Somber'],
        'happy': ['Joyful', 'Euphoric', 'Uplifting'],
        'chill': ['Calm', 'Relaxed', 'Peaceful'],
        'energetic': ['Energetic', 'Euphoric', 'Powerful'],
        'romantic': ['Romantic', 'Sensual', 'Intimate'],
        'party': ['Joyful', 'Euphoric', 'Playful'],
        'melancholic': ['Melancholic', 'Sad', 'Wistful'],
        'in my feels': ['Melancholic', 'Emotional', 'Introspective']
      };

      // Map atmosphere to target moods
      let targetMoods = [];
      if (genreData.atmosphere && genreData.atmosphere.length > 0) {
        for (const atmos of genreData.atmosphere) {
          const atmosLower = atmos.toLowerCase();
          for (const [key, moods] of Object.entries(moodMapping)) {
            if (atmosLower.includes(key)) {
              targetMoods.push(...moods);
            }
          }
        }
        targetMoods = [...new Set(targetMoods)]; // Dedupe
      }

      // Map lyrical themes
      let targetThemes = [];
      if (genreData.lyricalContent?.themes?.length > 0) {
        targetThemes = genreData.lyricalContent.themes.map(t => t.charAt(0).toUpperCase() + t.slice(1));
      }

      const criteria = {
        seedArtists: seedArtists,
        genre: genreData.primaryGenre,
        targetMoods: targetMoods.length > 0 ? targetMoods : null,
        targetThemes: targetThemes.length > 0 ? targetThemes : null,
        popularity: genreData.trackConstraints?.popularity?.min || genreData.trackConstraints?.popularity?.max ? {
          min: genreData.trackConstraints.popularity.min,
          max: genreData.trackConstraints.popularity.max
        } : null,
        releaseYear: genreData.era?.yearRange?.min || genreData.era?.yearRange?.max ? {
          min: genreData.era.yearRange.min,
          max: genreData.era.yearRange.max
        } : null,
        exclusiveMode: genreData.artistConstraints.exclusiveMode === true || genreData.artistConstraints.exclusiveMode === 'true',
        // Confirmed artist UUIDs from SoundCharts reference-song lookup (skips artist name search)
        confirmedArtistUuids: Object.keys(confirmedArtistUuids).length > 0 ? confirmedArtistUuids : null
      };

      // newArtistsOnly has its own dedicated path after name generation — skip discovery here.
      if (!newArtistsOnly) {
        soundChartsDiscoveredSongs = await discoverSongsViaSoundCharts(criteria, 60);
      }

      if (soundChartsDiscoveredSongs.length > 0) {
        console.log(`✓ SoundCharts discovered ${soundChartsDiscoveredSongs.length} songs`);
      } else {
        console.log('⚠️  SoundCharts returned 0 songs - will fall back to search queries');
      }
    } else {
      console.log('⚠️  SOUNDCHARTS_APP_ID not configured - skipping SoundCharts discovery');
    }

    // Variables for playlist metadata
    var claudePlaylistName = null;
    var claudePlaylistDescription = null;

    // Helper variables for constraints
    const hasRequestedArtists = genreData.artistConstraints.requestedArtists &&
                                 genreData.artistConstraints.requestedArtists.length > 0;
    const isExclusiveArtistMode = genreData.artistConstraints.exclusiveMode === true || genreData.artistConstraints.exclusiveMode === 'true';

    // Step 2: Generate playlist name and description with Claude (songs come from SoundCharts only)
    console.log('🎵 Generating playlist name and description...');

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
${genreData.artistConstraints.requestedArtists.length > 0 ? `Artists mentioned: ${genreData.artistConstraints.requestedArtists.join(', ')}` : ''}
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
      console.log('Playlist description:', claudePlaylistDescription);
    } catch (error) {
      // Fallback name
      claudePlaylistName = genreData.primaryGenre
        ? `${genreData.primaryGenre} Vibes`
        : (hasRequestedArtists ? `${genreData.artistConstraints.requestedArtists[0]} Mix` : 'My Playlist');
      claudePlaylistDescription = hasRequestedArtists
        ? `Songs similar to ${genreData.artistConstraints.requestedArtists.join(', ')}`
        : `A curated ${genreData.primaryGenre || 'music'} playlist`;
      console.log('Using fallback playlist name:', claudePlaylistName);
    }

    // ─────────────────────────────────────────────────────────────────
    // NEW ARTISTS ONLY — dedicated simple path
    // Find up to 12 unknown artists from the similarity tree, get their
    // songs, search Spotify. No sanity check needed — the tree already
    // constrains by genre, and we trust it more than false-positive removal.
    // ─────────────────────────────────────────────────────────────────
    if (newArtistsOnly && seedArtists.length > 0 && knownArtists.size > 0 && process.env.SOUNDCHARTS_APP_ID) {
      console.log('🎯 New Artists mode: finding unknown artists from similarity tree...');

      const targetNewArtists = 12;
      const newArtistList = []; // { name, uuid }
      const seenNewArtists = new Set();

      // Level 1: similar artists of each seed
      for (const seedName of seedArtists.slice(0, 3)) {
        if (newArtistList.length >= targetNewArtists) break;
        const confirmedUuid = confirmedArtistUuids[seedName.toLowerCase()];
        const seedInfo = confirmedUuid
          ? await getSoundChartsArtistInfoByUuid(confirmedUuid, seedName)
          : await getSoundChartsArtistInfo(seedName, genreData.primaryGenre);
        if (!seedInfo?.uuid) continue;

        for (const similarName of (seedInfo.similarArtists || [])) {
          if (newArtistList.length >= targetNewArtists) break;
          const lowerName = similarName.toLowerCase();
          if (seenNewArtists.has(lowerName) || knownArtists.has(lowerName)) continue;
          seenNewArtists.add(lowerName);
          const artistInfo = await searchSoundChartsArtist(similarName, genreData.primaryGenre);
          if (!artistInfo?.uuid) continue;
          newArtistList.push({ name: artistInfo.name || similarName, uuid: artistInfo.uuid });
        }
      }

      // Level 2: expand from first 5 found if still short
      if (newArtistList.length < targetNewArtists) {
        for (const artist of newArtistList.slice(0, 5)) {
          if (newArtistList.length >= targetNewArtists) break;
          const level2 = await getSoundChartsSimilarArtists(artist.uuid, 10);
          for (const similar of level2) {
            if (newArtistList.length >= targetNewArtists) break;
            const lowerName = similar.name.toLowerCase();
            if (seenNewArtists.has(lowerName) || knownArtists.has(lowerName)) continue;
            seenNewArtists.add(lowerName);
            newArtistList.push({ name: similar.name, uuid: similar.uuid });
          }
        }
      }

      console.log(`🎯 Found ${newArtistList.length} new artists`);

      if (newArtistList.length > 0) {
        const songsPerArtist = Math.ceil(songCount / newArtistList.length) + 3;
        const newArtistTracks = [];
        const seenNewIds = new Set();

        for (const artist of newArtistList) {
          if (newArtistTracks.length >= songCount) break;
          const songs = await getSoundChartsArtistSongs(artist.uuid, songsPerArtist);
          for (const song of songs) {
            if (newArtistTracks.length >= songCount) break;
            try {
              const searchQuery = song.isrc ? `isrc:${song.isrc}` : `track:${song.name} artist:${artist.name}`;
              if (platform === 'spotify') {
                const result = await userSpotifyApi.searchTracks(searchQuery, { limit: 1 });
                const track = result.body.tracks?.items?.[0];
                if (track && !seenNewIds.has(track.id)) {
                  if (!allowExplicit && track.explicit) continue;
                  seenNewIds.add(track.id);
                  newArtistTracks.push({
                    id: track.id, name: track.name,
                    artist: track.artists?.[0]?.name || 'Unknown',
                    uri: track.uri, album: track.album?.name,
                    image: track.album?.images?.[0]?.url,
                    previewUrl: track.preview_url,
                    externalUrl: track.external_urls?.spotify,
                    explicit: track.explicit, genres: []
                  });
                }
              } else if (platform === 'apple') {
                const platformService = new PlatformService();
                const appleResults = await platformService.searchTracks(
                  platformUserId, `${song.name} ${artist.name}`, tokens, tokens.storefront || 'us', 1
                );
                if (appleResults?.[0] && !seenNewIds.has(appleResults[0].id)) {
                  if (!allowExplicit && appleResults[0].explicit) continue;
                  seenNewIds.add(appleResults[0].id);
                  newArtistTracks.push(appleResults[0]);
                }
              }
            } catch (err) { /* skip */ }
          }
        }

        console.log(`🎯 New Artists path: returning ${newArtistTracks.length}/${songCount} tracks`);

        if (newArtistTracks.length >= Math.min(songCount, 10)) {
          return res.json({
            playlistName: claudePlaylistName,
            description: claudePlaylistDescription,
            tracks: newArtistTracks,
            trackCount: newArtistTracks.length
          });
        }
        console.log('⚠️ New Artists path found too few tracks, falling through to standard path');
      }
    }
    // ─────────────────────────────────────────────────────────────────

    // Use SoundCharts discovered songs as the ONLY source
    let recommendedTracks = [];

    if (soundChartsDiscoveredSongs && soundChartsDiscoveredSongs.length > 0) {
      console.log(`📀 Using ${soundChartsDiscoveredSongs.length} songs from SoundCharts`);
      for (const scSong of soundChartsDiscoveredSongs) {
        recommendedTracks.push({
          track: scSong.name,
          artist: scSong.artistName,
          source: 'soundcharts'
        });
      }
    }

    console.log(`📋 Total songs to search: ${recommendedTracks.length} from SoundCharts`);

    // Step 3: Search for recommended songs on the user's platform
    const allTracks = [];
    const seenTrackIds = new Set(); // To prevent exact duplicates
    const seenSongSignatures = new Map(); // To prevent same song by same artist from different albums
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

    // If we have songs from SoundCharts, search for them on the user's platform
    if (recommendedTracks.length > 0) {
      console.log(`🔍 Searching ${platform} for ${recommendedTracks.length} SoundCharts-discovered songs...`);

      if (platform === 'spotify') {
        // Search Spotify for each recommended song
        for (const recommendedSong of recommendedTracks) {
          try {
            // Prefer ISRC lookup (exact match) — fall back to text search
            const searchQuery = recommendedSong.isrc
              ? `isrc:${recommendedSong.isrc}`
              : `track:${recommendedSong.track} artist:${recommendedSong.artist}`;
            const searchPromise = userSpotifyApi.searchTracks(searchQuery, { limit: 5 });
            const searchResult = await Promise.race([
              searchPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), 5000))
            ]);
            const tracks = searchResult.body.tracks.items;

            if (tracks.length > 0) {
              let matchedTrack = tracks[0]; // ISRC search returns exact match; text search needs artist check

              if (!recommendedSong.isrc) {
                // Text search: find a track that matches the requested artist
                const requestedArtistNorm = recommendedSong.artist.toLowerCase().replace(/[^a-z0-9]/g, '');
                matchedTrack = null;
                for (const track of tracks) {
                  const foundArtistNorm = (track.artists?.[0]?.name || '').toLowerCase().replace(/[^a-z0-9]/g, '');
                  if (requestedArtistNorm.length < 6) {
                    if (foundArtistNorm === requestedArtistNorm) { matchedTrack = track; break; }
                  } else {
                    if (foundArtistNorm === requestedArtistNorm ||
                        foundArtistNorm.startsWith(requestedArtistNorm) ||
                        requestedArtistNorm.startsWith(foundArtistNorm)) { matchedTrack = track; break; }
                  }
                }
              }

              if (!matchedTrack) {
                console.log(`✗ Could not find: "${recommendedSong.track}" by ${recommendedSong.artist} (artist mismatch)`);
                continue;
              }

              const track = matchedTrack;

              // Check if we already have this track
              if (seenTrackIds.has(track.id)) {
                console.log(`Skipping duplicate: "${track.name}" by ${track.artists[0].name}`);
                continue;
              }

              // Skip tracks that are already in the playlist (for replace mode)
              if (excludeTrackIds.has(track.id)) {
                console.log(`Skipping "${track.name}" by ${track.artists[0].name} (already in playlist)`);
                continue;
              }

              // Skip tracks from song history (for manual refresh)
              if (playlistSongHistory.size > 0 && playlistSongHistory.has(track.id)) {
                console.log(`[MANUAL-REFRESH] Skipping "${track.name}" by ${track.artists[0].name} (previously in playlist)`);
                continue;
              }

              // Check for explicit content if needed
              if (!allowExplicit && track.explicit) {
                console.log(`Skipping explicit track: "${track.name}" by ${track.artists[0].name}`);
                continue;
              }

              // Check song signature (artist + normalized track name)
              const normalizedName = normalizeTrackName(track.name);
              const songSignature = `${track.artists[0].name.toLowerCase()}:${normalizedName}`;

              if (seenSongSignatures.has(songSignature)) {
                if (!isUniqueVariation(track.name)) {
                  console.log(`Skipping duplicate song: "${track.name}" by ${track.artists[0].name} (same as "${seenSongSignatures.get(songSignature)}")`);
                  continue;
                }
              }

              // Skip known artists when newArtistsOnly mode is active
              if (newArtistsOnly && knownArtists.size > 0) {
                const primaryArtist = (track.artists?.[0]?.name || '').toLowerCase();
                if (knownArtists.has(primaryArtist)) {
                  console.log(`[NEW-ARTISTS] Skipping "${track.name}" by ${track.artists[0].name} (known artist)`);
                  continue;
                }
              }

              seenTrackIds.add(track.id);
              seenSongSignatures.set(songSignature, track.name);
              // Normalize track format to have 'artist', 'image', and 'externalUrl' properties for consistency
              // For Apple Music, construct URL from track ID if not provided
              const trackExternalUrl = track.url || track.external_urls?.spotify ||
                (track.platform === 'apple' ? `https://music.apple.com/us/song/${track.id}` : null);
              allTracks.push({
                ...track,
                artist: track.artists?.[0]?.name || track.artist || 'Unknown Artist',
                image: track.album?.images?.[0]?.url || null,
                externalUrl: trackExternalUrl
              });
              console.log(`✓ Found: "${track.name}" by ${track.artists?.[0]?.name || track.artist}`);
            } else {
              console.log(`✗ Could not find: "${recommendedSong.track}" by ${recommendedSong.artist}`);
            }
          } catch (error) {
            console.log(`Error searching for "${recommendedSong.track}": ${error.message}`);
          }
        }
      } else if (platform === 'apple') {
        // For Apple Music users, search Apple Music for recommended songs
        const platformService = new PlatformService();
        const storefront = tokens.storefront || 'us';

        for (const recommendedSong of recommendedTracks) {
          try {
            const searchQuery = `${recommendedSong.track} ${recommendedSong.artist}`;
            const tracks = await platformService.searchTracks(platformUserId, searchQuery, tokens, storefront, 5);

            if (tracks.length > 0) {
              // Find a track that matches the requested artist (not just any track with similar name)
              const requestedArtistNorm = recommendedSong.artist.toLowerCase().replace(/[^a-z0-9]/g, '');

              let matchedTrack = null;
              for (const track of tracks) {
                const foundArtistNorm = (track.artists?.[0]?.name || track.artist || '').toLowerCase().replace(/[^a-z0-9]/g, '');

                // For short artist names (< 6 chars normalized), require exact match to avoid false positives
                // e.g., "dante" should not match "dante1981" or "dantesco"
                if (requestedArtistNorm.length < 6) {
                  if (foundArtistNorm === requestedArtistNorm) {
                    matchedTrack = track;
                    break;
                  }
                } else {
                  // For longer names, allow partial matches but be careful
                  // Only match if one is a substring at a word boundary (start/end)
                  if (foundArtistNorm === requestedArtistNorm ||
                      foundArtistNorm.startsWith(requestedArtistNorm) ||
                      requestedArtistNorm.startsWith(foundArtistNorm)) {
                    matchedTrack = track;
                    break;
                  }
                }
              }

              if (!matchedTrack) {
                console.log(`✗ Could not find: "${recommendedSong.track}" by ${recommendedSong.artist} (artist mismatch)`);
                continue;
              }

              const track = matchedTrack;

              // Check if we already have this track
              if (seenTrackIds.has(track.id)) {
                console.log(`Skipping duplicate: "${track.name}" by ${track.artists[0].name}`);
                continue;
              }

              // Skip tracks that are already in the playlist (for replace mode)
              const trackUri = track.uri;
              if (excludeTrackUris.includes(trackUri)) {
                console.log(`Skipping "${track.name}" by ${track.artists[0].name} (already in playlist)`);
                continue;
              }

              // Skip tracks from song history (for manual refresh)
              if (playlistSongHistory.size > 0 && playlistSongHistory.has(track.id)) {
                console.log(`[MANUAL-REFRESH] Skipping "${track.name}" by ${track.artists[0].name} (previously in playlist)`);
                continue;
              }

              // Check for explicit content if needed
              if (!allowExplicit && track.explicit) {
                console.log(`Skipping explicit track: "${track.name}" by ${track.artists[0].name}`);
                continue;
              }

              // Check song signature (artist + normalized track name)
              const normalizedName = normalizeTrackName(track.name);
              const songSignature = `${track.artists[0].name.toLowerCase()}:${normalizedName}`;

              if (seenSongSignatures.has(songSignature)) {
                if (!isUniqueVariation(track.name)) {
                  console.log(`Skipping duplicate song: "${track.name}" by ${track.artists[0].name} (same as "${seenSongSignatures.get(songSignature)}")`);
                  continue;
                }
              }

              // Skip known artists when newArtistsOnly mode is active
              if (newArtistsOnly && knownArtists.size > 0) {
                const primaryArtist = (track.artists?.[0]?.name || track.artist || '').toLowerCase();
                if (knownArtists.has(primaryArtist)) {
                  console.log(`[NEW-ARTISTS] Skipping "${track.name}" by ${track.artist || track.artists?.[0]?.name} (known artist)`);
                  continue;
                }
              }

              seenTrackIds.add(track.id);
              seenSongSignatures.set(songSignature, track.name);
              // Normalize track format to have 'artist', 'image', and 'externalUrl' properties for consistency
              // For Apple Music, construct URL from track ID if not provided
              const appleTrackUrl = track.url || `https://music.apple.com/us/song/${track.id}`;
              allTracks.push({
                ...track,
                artist: track.artists?.[0]?.name || track.artist || 'Unknown Artist',
                image: track.album?.images?.[0]?.url || null,
                externalUrl: appleTrackUrl
              });
              console.log(`✓ Found: "${track.name}" by ${track.artists?.[0]?.name || track.artist}`);
            } else {
              console.log(`✗ Could not find: "${recommendedSong.track}" by ${recommendedSong.artist}`);
            }
          } catch (error) {
            console.log(`Error searching for "${recommendedSong.track}": ${error.message}`);
          }
        }
      }

      console.log(`📊 Successfully found ${allTracks.length} out of ${recommendedTracks.length} SoundCharts-discovered songs`);

      // Quick sanity check - remove obvious mismatches (e.g., Lil Baby in an underground R&B playlist)
      if (allTracks.length >= 5) {
        let selectedTracks = [...allTracks]; // Pass ALL tracks to sanity check, slice after filtering

        // Run quick filter if we have genre, seed artists, explicit avoidances, or underground preference
        const hasAvoidances = genreData.contextClues.avoidances && genreData.contextClues.avoidances.length > 0;
        // Note: must check for null/undefined before comparing, as null <= 50 is true in JS
        const wantsUndergroundFilter = genreData.trackConstraints.popularity.preference === 'underground' ||
                                        (genreData.trackConstraints.popularity.max !== null &&
                                         genreData.trackConstraints.popularity.max !== undefined &&
                                         genreData.trackConstraints.popularity.max <= 50);
        if (genreData.primaryGenre || hasAvoidances || wantsUndergroundFilter || hasRequestedArtists) {
          console.log(`🔍 Running quick sanity check on ${selectedTracks.length} tracks...`);

          // Build seed artist instruction for "similar to X" playlists
          const seedArtistNames = hasRequestedArtists && !isExclusiveArtistMode
            ? genreData.artistConstraints.requestedArtists
            : [];
          const seedArtistInstruction = seedArtistNames.length > 0
            ? `- Reference artists: ${seedArtistNames.join(', ')}. These songs were discovered by a music similarity algorithm that can have false positives. REMOVE any song whose artist clearly does not belong in the same musical scene as ${seedArtistNames.join(' and ')} (different era, unrelated genre, or totally different sound world).`
            : '';

          // When seed artists are provided, be strict — the algorithm can return false positives.
          // Otherwise be lenient to avoid filtering too aggressively.
          const leniencyInstruction = seedArtistNames.length > 0
            ? `Be STRICT about artist fit — the discovery algorithm can produce false positives. If you don't recognize an artist or they clearly don't belong in the same world as ${seedArtistNames.join(', ')}, REMOVE them. A playlist with fewer but correct songs beats one with off-scene songs.`
            : `Be LENIENT — only remove songs that clearly don't fit. When in doubt, KEEP the song.`;

          try {
            const sanityCheckResponse = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1000,
              messages: [{
                role: 'user',
                content: `You are filtering a playlist to ensure all songs match the user's request.

User's request: "${prompt}"

The user wants songs that are:
- Genre: ${genreData.primaryGenre || 'not specified'}
${genreData.style ? `- Style/Vibe: ${genreData.style}` : ''}
${genreData.atmosphere && genreData.atmosphere.length > 0 ? `- Atmosphere: ${genreData.atmosphere.join(', ')}` : ''}
${genreData.contextClues.useCase ? `- Use case: ${genreData.contextClues.useCase}` : ''}
${hasAvoidances ? `- AVOID: ${genreData.contextClues.avoidances.join(', ')}` : ''}
${wantsUndergroundFilter ? `- Popularity: UNDERGROUND/INDIE only - remove mainstream artists` : ''}

Songs to review:
${selectedTracks.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist}`).join('\n')}

Return ONLY a JSON array of indices to KEEP.

KEEP songs that match the vibe, mood, and style the user requested.
REMOVE songs that:
- Don't fit the requested vibe/atmosphere (e.g., upbeat party song in a "chill late night" playlist)
- Are clearly the wrong genre
${hasAvoidances ? `- Match what the user wants to AVOID` : ''}
${wantsUndergroundFilter ? `- Are from mainstream artists with chart hits` : ''}
${seedArtistInstruction}

${leniencyInstruction}

Example response: [1, 2, 3, 4, 5, 6, 7, 8, ...]`
              }]
            });

            const sanityContent = sanityCheckResponse.content[0].text.trim()
              .replace(/^```json\n?/, '').replace(/\n?```$/, '')
              .replace(/^```\n?/, '').replace(/\n?```$/, '');

            const keepMatch = sanityContent.match(/\[([\d,\s]*)\]/);
            if (keepMatch) {
              const keepIndices = JSON.parse(keepMatch[0]);
              const filteredTracks = keepIndices
                .map(idx => selectedTracks[idx - 1])
                .filter(t => t !== undefined);

              if (filteredTracks.length >= 5) {
                const removed = selectedTracks.length - filteredTracks.length;
                if (removed > 0) {
                  console.log(`✂️ Sanity check removed ${removed} mismatched tracks`);
                }
                selectedTracks = filteredTracks;
              }
            }
          } catch (error) {
            console.log('Sanity check failed, using tracks as-is:', error.message);
          }
        }


        // Return the final tracks
        selectedTracks = selectedTracks.slice(0, songCount);
        console.log(`🎯 Returning ${selectedTracks.length} tracks`);

        // Only take the early return if we have enough tracks — otherwise fall through to fallback
        if (selectedTracks.length >= Math.min(songCount, 15)) {
          // Supplement with more songs if short of target.
          // Artist-first approach: fetch top songs by genre to get a pool of artists,
          // skip known artists up-front, then fetch songs per new artist.
          // This avoids wasted Spotify lookups on songs from artists the user already knows.
          if (selectedTracks.length < songCount && process.env.SOUNDCHARTS_APP_ID) {
            const needed = songCount - selectedTracks.length;
            console.log(`🔁 Supplementing: need ${needed} more tracks to reach ${songCount}`);
            try {
              const supplementCriteria = {
                seedArtists: [],
                genre: genreData.primaryGenre,
                targetMoods: null,
                targetThemes: null,
                popularity: null,
                releaseYear: (genreData.era?.yearRange?.min || genreData.era?.yearRange?.max) ? {
                  min: genreData.era.yearRange.min,
                  max: genreData.era.yearRange.max
                } : null,
                exclusiveMode: false
              };

              // Single call at offset 50 — skips the top-50 most popular artists
              // (a genre power-user almost certainly knows them) and lands on mid-tier
              // artists who are good quality but less widely known.
              // discoverSongsViaSoundChartsTop already returns song name + ISRC, so we
              // search Spotify directly — no extra SoundCharts calls per artist.
              const topSongsPool = await discoverSongsViaSoundChartsTop(supplementCriteria, 100, 50);
              console.log(`🔁 Top-songs pool (offset=50): ${topSongsPool.length} songs`);

              const seenSupplementArtists = new Set();
              for (const song of topSongsPool) {
                if (selectedTracks.length >= songCount) break;
                const artistLower = (song.artistName || '').toLowerCase();
                if (newArtistsOnly && knownArtists.size > 0 && knownArtists.has(artistLower)) continue;
                try {
                  const searchQuery = song.isrc
                    ? `isrc:${song.isrc}`
                    : `track:${song.name} artist:${song.artistName}`;
                  if (platform === 'spotify') {
                    const result = await userSpotifyApi.searchTracks(searchQuery, { limit: 1 });
                    const track = result.body.tracks?.items?.[0];
                    if (track && !seenTrackIds.has(track.id)) {
                      if (!allowExplicit && track.explicit) continue;
                      seenTrackIds.add(track.id);
                      seenSupplementArtists.add(artistLower);
                      selectedTracks.push({
                        id: track.id, name: track.name,
                        artist: track.artists?.[0]?.name || 'Unknown',
                        uri: track.uri, album: track.album?.name,
                        image: track.album?.images?.[0]?.url,
                        previewUrl: track.preview_url,
                        externalUrl: track.external_urls?.spotify,
                        explicit: track.explicit, genres: []
                      });
                    }
                  } else if (platform === 'apple') {
                    const platformService = new PlatformService();
                    const appleResults = await platformService.searchTracks(
                      platformUserId, `${song.name} ${song.artistName}`, tokens, tokens.storefront || 'us', 1
                    );
                    if (appleResults?.[0] && !seenTrackIds.has(appleResults[0].id)) {
                      if (!allowExplicit && appleResults[0].explicit) continue;
                      seenTrackIds.add(appleResults[0].id);
                      selectedTracks.push(appleResults[0]);
                    }
                  }
                } catch (songErr) { /* skip individual song errors */ }
              }
              console.log(`🔁 After supplement: ${selectedTracks.length}/${songCount} tracks (${seenSupplementArtists.size} new artists added)`);
            } catch (suppFetchErr) {
              console.log('Top-songs supplement failed:', suppFetchErr.message);
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
        // Build criteria from genreData for top-songs discovery
        const fallbackCriteria = {
          seedArtists: [],
          genre: genreData.primaryGenre,
          targetMoods: null,
          targetThemes: null,
          popularity: null,
          releaseYear: (genreData.era?.yearRange?.min || genreData.era?.yearRange?.max) ? {
            min: genreData.era.yearRange.min,
            max: genreData.era.yearRange.max
          } : null,
          exclusiveMode: false
        };
        const topSongs = await discoverSongsViaSoundChartsTop(fallbackCriteria, songCount * 2);
        console.log(`🔄 SoundCharts top songs: ${topSongs.length} candidates`);
        for (const song of topSongs) {
          if (allTracks.length >= songCount * 3) break;
          try {
            const searchQuery = song.isrc
              ? `isrc:${song.isrc}`
              : `track:${song.name} artist:${song.artistName}`;
            if (platform === 'spotify') {
              const result = await userSpotifyApi.searchTracks(searchQuery, { limit: 1 });
              const track = result.body.tracks?.items?.[0];
              if (track && !seenTrackIds.has(track.id)) {
                seenTrackIds.add(track.id);
                allTracks.push({
                  id: track.id, name: track.name,
                  artist: track.artists?.[0]?.name || 'Unknown',
                  uri: track.uri, album: track.album?.name,
                  image: track.album?.images?.[0]?.url,
                  previewUrl: track.preview_url,
                  externalUrl: track.external_urls?.spotify,
                  explicit: track.explicit, genres: []
                });
              }
            } else if (platform === 'apple') {
              const platformService = new PlatformService();
              const appleResults = await platformService.searchTracks(
                platformUserId, `${song.name} ${song.artistName}`, tokens, tokens.storefront || 'us', 1
              );
              if (appleResults?.[0] && !seenTrackIds.has(appleResults[0].id)) {
                seenTrackIds.add(appleResults[0].id);
                allTracks.push(appleResults[0]);
              }
            }
          } catch (searchErr) { /* skip individual song errors */ }
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
        const maxTracksPerArtist = 3; // Allow max 3 tracks per artist

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
      (genreData.culturalContext?.language?.prefer?.length > 0 || genreData.culturalContext?.language?.exclude?.length > 0) ||
      genreData.trackConstraints.albumDiversity.maxPerAlbum !== null;

    if (hasMetadataFilters && allTracks.length > 0) {
      const albumTrackCount = {};
      const languageToMarkets = {
        'english': ['US', 'GB', 'CA', 'AU', 'NZ', 'IE'],
        'spanish': ['ES', 'MX', 'AR', 'CO', 'CL', 'PE'],
        'french': ['FR', 'CA', 'BE', 'CH'],
        'german': ['DE', 'AT', 'CH'],
        'italian': ['IT'],
        'portuguese': ['PT', 'BR'],
        'japanese': ['JP'],
        'korean': ['KR'],
        'chinese': ['CN', 'TW', 'HK']
      };

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

        // Language (market-based)
        const langPrefs = genreData.culturalContext?.language;
        if (langPrefs?.prefer?.length > 0) {
          const preferredMarkets = langPrefs.prefer.flatMap(l => languageToMarkets[l.toLowerCase()] || []);
          if (preferredMarkets.length > 0 && track.available_markets && !preferredMarkets.some(m => track.available_markets.includes(m))) return false;
        }
        if (langPrefs?.exclude?.length > 0) {
          const excludedMarkets = langPrefs.exclude.flatMap(l => languageToMarkets[l.toLowerCase()] || []);
          if (excludedMarkets.length > 0 && track.available_markets && track.available_markets.every(m => excludedMarkets.includes(m))) return false;
        }

        // Album diversity
        if (genreData.trackConstraints.albumDiversity.maxPerAlbum !== null && track.album?.id) {
          const count = albumTrackCount[track.album.id] || 0;
          if (count >= genreData.trackConstraints.albumDiversity.maxPerAlbum) return false;
          albumTrackCount[track.album.id] = count + 1;
        }

        return true;
      });

      if (tracksForSelection.length === 0) tracksForSelection = allTracks;
    }

    // Step 2.75: Apply strict genre validation if a primary genre is specified
    // This is the same validation used in auto-update to prevent off-genre tracks
    let genreValidatedTracks = tracksForSelection;
    if (genreData.primaryGenre && genreData.primaryGenre !== 'not specified' && tracksForSelection.length > 0) {
      try {
        console.log(`Applying strict genre validation for "${genreData.primaryGenre}" genre...`);

        // Build track list with genre information for validation
        const trackListForValidation = tracksForSelection.map(t => {
          const artistGenres = t.genres && t.genres.length > 0 ? ` [API genres: ${t.genres.join(', ')}]` : '';
          return `${t.name} by ${t.artist || 'Unknown Artist'}${artistGenres}`;
        }).join('\n');

        const genreValidationResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: `You are a music genre expert. Filter out tracks that clearly do not belong in a "${genreData.primaryGenre}" playlist. When in doubt, keep the track.

CRITICAL: The user's playlist description is: "${prompt}"

IMPORTANT DISTINCTION:
- The playlist DESCRIPTION (like "focus while working" or "chill vibes") is about the MOOD/USE CASE
- The GENRE requirement ("${genreData.primaryGenre}") is about the MUSICAL STYLE
- DO NOT reject songs based on title keywords that match the description!
- Example: For an R&B playlist with description "music to focus while working", only reject "Focus" by Ariana Grande if it is clearly not R&B

YOUR KNOWLEDGE BASE:
- Use your comprehensive training data about artists, genres, musical styles, and song classifications
- API genre tags (when provided) are hints, but NOT definitive - use your own knowledge as primary source
- Consider the artist's full discography, typical style, and the specific song's characteristics
- Account for artists who cross genres - evaluate each SONG individually, not just the artist

Below is a list of tracks with API genre tags when available. Reject only obvious genre mismatches — it is worse to have too few tracks than to include a borderline case.

RULES FOR "${genreData.primaryGenre}" PLAYLISTS:
- If the genre is Pop: ACCEPT dance-pop, indie pop, electropop, pop-R&B, synth-pop, and mainstream crossover artists. Only REJECT tracks that are clearly classical, jazz, heavy metal, or pure hip-hop with no pop elements.
- If the genre is R&B: ACCEPT R&B-pop, neo-soul, and soul. REJECT only pure jazz, smooth jazz, and classical.
- If the genre is Hip-Hop: ACCEPT rap-pop and hip-hop-R&B crossovers. REJECT classical, jazz, and rock with no hip-hop elements.
- If the genre is Rock: ACCEPT pop-rock, indie rock, and alternative rock. REJECT classical, jazz, and pure pop with no rock elements.
- REJECT study music, ambient focus instrumentals, and background music ONLY if the requested genre is not ambient/instrumental.
- DO NOT over-reject — keep borderline tracks; the AI selection step will refine further.

Examples of REJECTIONS for R&B playlists (only truly off-genre):
- "Soulful" by Cal Harris Jr. (this is JAZZ, not R&B)
- Any track that is clearly classical or smooth jazz with no R&B elements
- "Pieces of Me" by Smooth Jazz All Stars (this is SMOOTH JAZZ, not R&B)

Tracks to evaluate:
${trackListForValidation}

Respond with valid JSON:
{
  "validTracks": ["track 1 by artist 1", "track 2 by artist 2", ...],
  "rejectedCount": <number of tracks rejected>
}

Be STRICT. Only include tracks that are genuinely, unambiguously "${genreData.primaryGenre}" GENRE. Use your extensive music knowledge to make accurate determinations. Ignore title-based matches to the mood/description. DO NOT include any text outside the JSON.`
          }]
        });

        try {
          let validationText = genreValidationResponse.content[0].text.trim();
          // Handle markdown code blocks
          if (validationText.startsWith('```json')) {
            validationText = validationText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
          } else if (validationText.startsWith('```')) {
            validationText = validationText.replace(/^```\n?/, '').replace(/\n?```$/, '');
          }
          const validationData = JSON.parse(validationText);
          const validTrackNames = new Set(validationData.validTracks || []);

          // Filter tracks based on validation
          genreValidatedTracks = tracksForSelection.filter(track => {
            const trackString = `${track.name} by ${track.artist}`;
            return validTrackNames.has(trackString);
          });

          console.log(`Genre validation: ${tracksForSelection.length} tracks -> ${genreValidatedTracks.length} valid ${genreData.primaryGenre} tracks (rejected ${validationData.rejectedCount})`);

          if (genreValidatedTracks.length === 0) {
            console.warn('Warning: No tracks passed genre validation, falling back to original tracks');
            genreValidatedTracks = tracksForSelection;
          } else if (genreValidatedTracks.length < songCount) {
            // Not enough validated tracks — keep all validated ones at the front,
            // then append unvalidated tracks to fill the gap (selection AI will pick best).
            const validatedIds = new Set(genreValidatedTracks.map(t => t.id));
            const unvalidatedTracks = tracksForSelection.filter(t => !validatedIds.has(t.id));
            console.warn(`Warning: Genre validation left only ${genreValidatedTracks.length} tracks (needed ${songCount}), supplementing with ${unvalidatedTracks.length} unvalidated tracks`);
            genreValidatedTracks = [...genreValidatedTracks, ...unvalidatedTracks];
          }
        } catch (parseError) {
          console.log('Could not parse genre validation response:', parseError.message);
          genreValidatedTracks = tracksForSelection; // Fall back to all tracks
        }
      } catch (validationError) {
        console.log('Genre validation failed:', validationError.message);
        genreValidatedTracks = tracksForSelection; // Fall back to all tracks
      }

      // Update tracksForSelection to use genre-validated tracks
      tracksForSelection = genreValidatedTracks;
    }

    // Step 3: Use Claude to select the best songs from the results
    // Detect if this is a single-artist or multi-artist playlist (specific artists mentioned)
    const isSingleArtistPlaylist = prompt.toLowerCase().includes('greatest hits') ||
                                    prompt.toLowerCase().includes('best of') ||
                                    prompt.toLowerCase().includes('top songs');

    // Detect if specific artists are mentioned vs. similarity requests
    const lowerPrompt = prompt.toLowerCase();

    // "like", "similar to", "inspired by" = similarity mode (flexible, various artists)
    const isSimilarityRequest = lowerPrompt.includes('like ') ||
                                 lowerPrompt.includes('similar to') ||
                                 lowerPrompt.includes('similar') ||
                                 lowerPrompt.includes('inspired by') ||
                                 lowerPrompt.includes('vibes of') ||
                                 lowerPrompt.includes('sound like');

    // Strict artist mode: specific artist keywords WITHOUT similarity indicators
    // Note: ' songs', ' tracks', ' music' intentionally excluded — they match song-count
    // phrases like "50 songs of hip hop" and incorrectly trigger artist-only mode.
    const artistKeywords = [
      'songs by', 'tracks by', 'music by',
      'playlist with songs from',
    ];
    const hasSpecificArtists = !isSimilarityRequest && (
      artistKeywords.some(keyword => lowerPrompt.includes(keyword)) ||
      // Only treat "by X" / "from X" as artist indicators when followed by a word (not end of sentence)
      /\bby\s+[A-Z]/.test(prompt) ||
      /\bfrom\s+[A-Z]/.test(prompt) ||
      isSingleArtistPlaylist // Greatest hits/best of also counts
    );

    // Request more songs than target to account for vibe check filtering
    // Vibe check typically removes 10-20% of songs that don't fit the atmosphere
    const hasVibeRequirements = genreData.atmosphere.length > 0 || genreData.contextClues.useCase || genreData.era.decade || genreData.subgenre;
    const selectionTarget = hasVibeRequirements ? Math.ceil(songCount * 1.2) : songCount; // Request 20% more if vibe check will run
    const hasAudioFeatureFilters = false; // Audio feature pre-filtering not currently used
    console.log(`Selection target: ${selectionTarget} songs (${songCount} requested, ${hasVibeRequirements ? 'will run vibe check' : 'no vibe check'})`);

    const trackSelectionPrompt = `From the following list of songs, select ${isSingleArtistPlaylist || hasSpecificArtists ? 'UP TO' : 'approximately'} ${selectionTarget} BEST songs that match this playlist theme: "${prompt}"

PLAYLIST REQUIREMENTS:

GENRE & STYLE:
- Primary Genre: ${genreData.primaryGenre || 'Not specified'}
- Subgenre: ${genreData.subgenre || 'Not specified'} ${genreData.subgenre ? '← MUST match this specific subgenre' : ''}
- Secondary Genres: ${genreData.secondaryGenres.join(', ') || 'None'}
- Key Characteristics: ${genreData.keyCharacteristics.join(', ') || 'Not specified'}
- Style: ${genreData.style || 'Not specified'}

VIBE & ATMOSPHERE:
- Target Atmosphere: ${genreData.atmosphere.join(', ') || 'Not specified'} ${genreData.atmosphere.length > 0 ? '← Songs MUST match these emotional vibes' : ''}
- Use Case: ${genreData.contextClues.useCase || 'Not specified'} ${genreData.contextClues.useCase ? '← CRITICAL: Select songs appropriate for this context' : ''}
- Avoid: ${genreData.contextClues.avoidances.join('; ') || 'Nothing specified'}

ERA & CULTURAL CONTEXT:
- Decade: ${genreData.era.decade || 'Not specified'} ${genreData.era.decade ? '← ONLY select songs from this era' : ''}
- Year Range: ${genreData.era.yearRange.min || genreData.era.yearRange.max ? `${genreData.era.yearRange.min || 'any'} to ${genreData.era.yearRange.max || 'current'}` : 'Not specified'}
- Cultural Region: ${genreData.culturalContext.region || 'Not specified'} ${genreData.culturalContext.region ? '← Prefer artists from this region' : ''}
- Language: ${genreData.culturalContext.language?.prefer?.join(', ') || 'Not specified'} ${genreData.culturalContext.language?.exclude?.length ? `(Avoid: ${genreData.culturalContext.language.exclude.join(', ')})` : ''}
- Movement: ${genreData.culturalContext.movement || 'Not specified'}
- Scene: ${genreData.culturalContext.scene || 'Not specified'}

TRACK PREFERENCES:
- Popularity Level: ${genreData.trackConstraints.popularity.preference || (genreData.trackConstraints.popularity.min || genreData.trackConstraints.popularity.max) ? `${genreData.trackConstraints.popularity.min || 0}-${genreData.trackConstraints.popularity.max || 100}` : 'Not specified'} ${genreData.trackConstraints.popularity.preference === 'mainstream' ? '← Prefer well-known hits' : genreData.trackConstraints.popularity.preference === 'underground' ? '← Prefer lesser-known tracks' : ''}
- Song Length: ${genreData.trackConstraints.duration.min || genreData.trackConstraints.duration.max ? `${genreData.trackConstraints.duration.min || 0}s to ${genreData.trackConstraints.duration.max || 600}s` : 'Not specified'}
- Album Diversity: ${genreData.trackConstraints.albumDiversity.maxPerAlbum ? `Max ${genreData.trackConstraints.albumDiversity.maxPerAlbum} songs per album` : 'Not specified'} ${genreData.trackConstraints.albumDiversity.preferDeepCuts ? '(Prefer album deep cuts)' : genreData.trackConstraints.albumDiversity.preferSingles ? '(Prefer singles/hits)' : ''}

ARTIST & VOCAL PREFERENCES:
- Vocal Gender: ${genreData.artistConstraints.vocalGender || 'Not specified'} ${genreData.artistConstraints.vocalGender ? '← IMPORTANT: Prefer artists with this vocal type' : ''}
- Artist Type: ${genreData.artistConstraints.artistType || 'Not specified'} ${genreData.artistConstraints.artistType ? '← Select based on artist type (solo, band, etc.)' : ''}
- Features/Collaborations: ${genreData.artistConstraints.excludeFeatures ? 'NO collaborations/featured artists' : 'Allowed'}

PRODUCTION & SOUND:
- Production Style: ${genreData.productionStyle.preference || 'Not specified'} ${genreData.productionStyle.preference === 'acoustic' ? '← Prefer acoustic/unplugged versions' : genreData.productionStyle.preference === 'electronic' ? '← Prefer electronic production' : genreData.productionStyle.preference === 'live' ? '← Prefer live recordings' : genreData.productionStyle.preference === 'raw' ? '← Prefer raw/lo-fi production' : ''}
- Auto-Tune: ${genreData.productionStyle.avoidAutoTune ? 'AVOID heavily auto-tuned vocals' : 'No restriction'}

LYRICAL CONTENT:
- Themes: ${genreData.lyricalContent.themes.join(', ') || 'Not specified'} ${genreData.lyricalContent.themes.length > 0 ? '← Prefer songs about these topics' : ''}
- Avoid Themes: ${genreData.lyricalContent.avoid.join(', ') || 'Nothing'} ${genreData.lyricalContent.avoid.length > 0 ? '← IMPORTANT: Exclude songs about these topics' : ''}

DISCOVERY BALANCE:
- ${genreData.discoveryBalance.preference === 'familiar' ? 'PRIORITIZE well-known favorites and popular tracks' : genreData.discoveryBalance.preference === 'discovery' ? 'PRIORITIZE lesser-known artists and hidden gems for discovery' : genreData.discoveryBalance.preference === 'balanced' ? 'MIX both familiar favorites and new discoveries' : 'No specific preference'}

${hasAudioFeatureFilters ? `AUDIO FEATURES:
- These songs have already been pre-filtered to match the requested audio characteristics (BPM, energy, danceability, etc.)` : ''}

Songs available:
${tracksForSelection.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist || 'Unknown Artist'} (Album: ${t.album || 'Unknown Album'})${t.audioFeatures ? ` [BPM: ${t.audioFeatures.bpm}, Energy: ${t.audioFeatures.energy}, Dance: ${t.audioFeatures.danceability}]` : ''} [Artist genres: ${(t.genres || []).join(', ') || 'Unknown'}]`).join('\n')}

Respond ONLY with a JSON array of the indices (1-based) of the songs you select.

TARGET: Select as close to ${selectionTarget} songs as possible. If the pool has enough quality tracks, aim for exactly ${selectionTarget} songs.

Select songs that:
${isSingleArtistPlaylist || hasSpecificArtists
  ? `- ONLY include songs by the EXACT artists mentioned in the prompt
- Read the prompt carefully to identify which artists are requested
- For example, if the prompt says "Justin Bieber and One Direction", ONLY select songs where the artist is "Justin Bieber" or "One Direction"
- DO NOT include songs by related or similar artists (e.g., no Harry Styles if only One Direction is requested, no Ariana Grande if only Justin Bieber is requested)
- STRICTLY filter by artist name - the artist field MUST exactly match one of the requested artists
- Aim for exactly ${selectionTarget} songs if available from the specified artists`
  : `- STRICTLY match the genre and style indicated in the playlist prompt
- Provide good variety in artists and tempo
- Have strong thematic coherence with the playlist`}
- Are high quality and well-known tracks
- AVOID selecting multiple versions of the same song (e.g., don't include both "Song Title" and "Song Title - Live Version" or "Song Title - A COLORS SHOW")

IMPORTANT: Prioritize reaching the target of ${selectionTarget} songs while maintaining quality. Only select fewer songs if there genuinely aren't enough quality matches in the pool.

${isSingleArtistPlaylist || hasSpecificArtists
  ? `CRITICAL: This is a specific-artist playlist. ONLY select songs where the artist name EXACTLY matches one of the artists mentioned in the prompt: "${prompt}". DO NOT include similar artists, related artists, or artists from the same genre. Be extremely strict about artist matching.`
  : 'Use the theme, era, and characteristics above to guide your selection. Prioritize reaching the target count.'}

Example format: [1, 5, 8, 12, ...]

DO NOT include any text outside the JSON array.`;
    
    const selectionResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 1000,
      messages: [{
        role: 'user',
        content: trackSelectionPrompt
      }]
    });
    
    let selectedIndices;
    try {
      const selectionText = selectionResponse.content[0].text.trim();
      selectedIndices = JSON.parse(selectionText);
    } catch (parseError) {
      console.error('Failed to parse selection response, using all tracks');
      selectedIndices = tracksForSelection.map((_, i) => i + 1).slice(0, songCount);
    }

    // Get selected tracks
    let selectedTracks = selectedIndices
      .map(index => tracksForSelection[index - 1])
      .filter(track => track !== undefined);

    console.log(`Selected ${selectedTracks.length} tracks for playlist`);

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

          // Trim to target songCount if we have more than needed
          if (tracksAfterVibeCheck.length > songCount) {
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
      } catch (trackError) {
        console.log('Could not track artists to database:', trackError.message);
        // Don't block playlist generation if tracking fails
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

    // Generate a unique draft ID if not provided
    const draftId = draftData.draftId || `draft-${Date.now()}`;

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
      const trackUris = playlistDetails.body.tracks.items.map(item => item.track.uri);

      playlistRecord = {
        playlistId: playlistId,
        playlistName: playlistDetails.body.name,
        description: playlistDetails.body.description || '',
        image: playlistDetails.body.images?.length > 0 ? playlistDetails.body.images[0].url : null,
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

    // Update the playlist settings
    userPlaylistHistory[playlistIndex].updateFrequency = updateFrequency || 'never';
    userPlaylistHistory[playlistIndex].updateMode = updateMode || 'append';
    if (isPublic !== undefined) {
      userPlaylistHistory[playlistIndex].isPublic = isPublic;
    }
    if (updateTime) {
      userPlaylistHistory[playlistIndex].updateTime = updateTime;
    }
    userPlaylistHistory[playlistIndex].lastUpdated = null;
    userPlaylistHistory[playlistIndex].nextUpdate = updateFrequency && updateFrequency !== 'never'
      ? calculateNextUpdate(updateFrequency, playlistId, updateTime)
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

    // Also remove from Spotify if the playlist exists there
    try {
      // If userId is email-based, resolve to Spotify platform userId for API calls
      let platformUserId = userId;
      if (isEmailBasedUserId(userId)) {
        platformUserId = await resolvePlatformUserId(userId, 'spotify');
        if (!platformUserId) {
          console.log('No Spotify connection found for email:', userId);
          // Skip Spotify removal but don't fail
          return res.json({
            success: true,
            excludedSongs: playlist.excludedSongs,
            excludedArtists: playlist.excludedArtists,
            remainingTracks: playlist.tracks.length
          });
        }
      }

      const tokens = await getUserTokens(platformUserId);
      if (tokens && trackUri) {
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
      }
    } catch (spotifyError) {
      console.error('Error removing from Spotify (non-critical):', spotifyError.message);
      // Don't fail the request if Spotify removal fails
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
        const tokens = await db.getTokens(userId);
        if (tokens) {
          const platformService = new PlatformService();
          await platformService.removeTracksFromPlaylist(userId, playlist.playlistId, [trackUri], tokens);
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

      // Build a quick lookup for album art from the tracks array
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

// Auto-update scheduler - runs every minute to check for playlists that need updating
const scheduleAutoUpdates = () => {
  cron.schedule('*/1 * * * *', async () => {
    try {
      const allUsers = Array.from(userPlaylists.entries());
      const now = new Date();

      for (const [userId, playlists] of allUsers) {
        // Only consider playlists that have auto-update enabled
        const autoUpdatePlaylists = playlists.filter(p =>
          p.updateFrequency && p.updateFrequency !== 'never' && p.nextUpdate
        );

        for (const playlist of autoUpdatePlaylists) {
          const nextUpdateTime = new Date(playlist.nextUpdate);

            // If the scheduled time has passed, trigger the update
            if (now >= nextUpdateTime) {
              // Check 24-hour cooldown - skip if manually refreshed within last 24 hours
              if (playlist.lastUpdated) {
                const lastUpdatedTime = new Date(playlist.lastUpdated);
                const hoursSinceLastUpdate = (now - lastUpdatedTime) / (1000 * 60 * 60);

                if (hoursSinceLastUpdate < 24) {
                  console.log(`[AUTO-UPDATE] Skipping ${playlist.playlistName} - manual refresh ${hoursSinceLastUpdate.toFixed(1)} hours ago (24hr cooldown)`);

                  // Calculate next update time and save it
                  playlist.nextUpdate = calculateNextUpdate(playlist.updateFrequency, playlist.playlistId, playlist.updateTime);
                  const updatedPlaylists = userPlaylists.get(userId);
                  userPlaylists.set(userId, updatedPlaylists);
                  await savePlaylist(userId, playlist);

                  continue; // Skip this playlist and move to the next one
                }
              }

              console.log(`[AUTO-UPDATE] Updating playlist: ${playlist.playlistName} (${playlist.playlistId})`);

              try {
                // Get the playlist's original prompt or use the name as fallback
                let prompt = playlist.originalPrompt || `Generate songs similar to: ${playlist.playlistName}`;

                // Add description to maintain playlist vibe
                if (playlist.description) {
                  prompt += `. Description: ${playlist.description}`;
                }

                // Combine all refinements from both chat history and refinement instructions
                const allRefinements = [];

                // Add cumulative refinements from chat history (from initial generation modal)
                if (playlist.chatMessages && playlist.chatMessages.length > 0) {
                  const chatRefinements = playlist.chatMessages
                    .filter(msg => msg.role === 'user')
                    .map(msg => msg.content);
                  allRefinements.push(...chatRefinements);
                }

                // Add refinements from Edit Playlist modal
                if (playlist.refinementInstructions && playlist.refinementInstructions.length > 0) {
                  allRefinements.push(...playlist.refinementInstructions);
                }

                // Add all refinements to prompt
                if (allRefinements.length > 0) {
                  prompt += `. Refinements: ${allRefinements.join('. ')}`;
                  console.log(`[AUTO-UPDATE] Applied ${allRefinements.length} total refinement(s)`);
                }

                // Ensure tracks array exists
                if (!playlist.tracks) {
                  playlist.tracks = [];
                }

                // Build context from liked/disliked songs for auto-update
                let userFeedbackContext = '';
                const likedSongs = playlist.likedSongs || [];
                const dislikedSongs = playlist.dislikedSongs || [];

                if (likedSongs.length > 0 || dislikedSongs.length > 0) {
                  if (likedSongs.length > 0) {
                    const likedTrackNames = likedSongs.slice(0, 5).map(s => `"${s.name}" by ${s.artist}`).join(', ');
                    userFeedbackContext += ` User liked: ${likedTrackNames}.`;
                    console.log(`[AUTO-UPDATE] Incorporating ${likedSongs.length} liked song(s) into prompt`);
                  }
                  if (dislikedSongs.length > 0) {
                    const dislikedTrackNames = dislikedSongs.slice(0, 5).map(s => `"${s.name}" by ${s.artist}`).join(', ');
                    userFeedbackContext += ` User disliked: ${dislikedTrackNames}.`;
                    console.log(`[AUTO-UPDATE] Avoiding songs similar to ${dislikedSongs.length} disliked song(s)`);
                  }
                }

                // If we have current tracks, enhance the prompt to make sure new songs are similar
                if (playlist.tracks.length > 0) {
                  const topTracks = playlist.tracks.slice(0, 5).map(t => t.name).join(', ');
                  prompt = `${prompt}. Reference tracks: ${topTracks}`;
                }

                // Add user feedback context to prompt
                if (userFeedbackContext) {
                  prompt += userFeedbackContext;
                }

                // Generate new tracks using the same AI-based generation logic as the main endpoint
                let newTrackUris = [];
                let tracksForHistory = []; // Store tracks to add to history after successful Spotify update
                const playlistPlatform = playlist.platform || 'spotify';
                let platformUserId = userId;

                try {
                  // Use stored genreData from the original playlist — this is more accurate than
                  // re-extracting genre from the combined prompt (which can be polluted by
                  // refinement phrasing like "add chill songs" drifting the genre to lofi).
                  // Fall back to AI extraction only for older playlists without stored genreData.
                  let genreData = { primaryGenre: null, secondaryGenres: [], keyCharacteristics: [], style: '' };
                  if (playlist.genreData && playlist.genreData.primaryGenre) {
                    genreData = playlist.genreData;
                    console.log(`[AUTO-UPDATE] Using stored genre data: ${genreData.primaryGenre}`);
                  } else {
                    console.log('[AUTO-UPDATE] No stored genre data — extracting from prompt');
                    const genreExtractionResponse = await anthropic.messages.create({
                      model: 'claude-sonnet-4-20250514',
                      max_tokens: 500,
                      messages: [{
                        role: 'user',
                        content: `Extract the primary genre and key musical characteristics from this playlist prompt.

Prompt: "${prompt}"

Respond ONLY with valid JSON in this format:
{
  "primaryGenre": "the main genre (e.g., R&B, hip-hop, pop, rock, etc.) or null if not specified",
  "secondaryGenres": ["related genres"],
  "keyCharacteristics": ["soulful", "upbeat", "melancholic", etc.],
  "style": "The overall vibe/style (e.g., contemporary, vintage, indie, mainstream, etc.)"
}

DO NOT include any text outside the JSON.`
                      }]
                    });

                    try {
                      let genreText = genreExtractionResponse.content[0].text.trim();
                      // Remove markdown code blocks if present
                      if (genreText.startsWith('```json')) {
                        genreText = genreText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                      } else if (genreText.startsWith('```')) {
                        genreText = genreText.replace(/^```\n?/, '').replace(/\n?```$/, '');
                      }
                      genreData = JSON.parse(genreText);
                    } catch (parseError) {
                      console.log('Could not parse genre extraction in auto-update:', parseError.message);
                    }
                  }

                  // No Spotify/Apple search queries — SoundCharts is the only song source.
                  // All discovery goes through SoundCharts seed-artist similarity.

                  // Determine platform and resolve platformUserId
                  if (playlistPlatform === 'apple') {
                    // ── Apple Music auto-update ──────────────────────────────
                    if (isEmailBasedUserId(userId)) {
                      platformUserId = await resolvePlatformUserId(userId, 'apple');
                      if (!platformUserId) {
                        console.log(`[AUTO-UPDATE] No Apple Music connection for user ${userId}, skipping playlist ${playlist.playlistName}`);
                        playlist.nextUpdate = calculateNextUpdate(playlist.updateFrequency, playlist.playlistId, playlist.updateTime);
                        await savePlaylist(userId, playlist);
                        continue;
                      }
                    }

                    const appleTokens = await getUserTokens(platformUserId);
                    if (appleTokens && searchQueries.length > 0) {
                      const appleMusicDevToken = generateAppleMusicToken();
                      if (appleMusicDevToken) {
                        const appleMusicApiInstance = new AppleMusicService(appleMusicDevToken);
                        const platformServiceInstance = new PlatformService();
                        const storefront = appleTokens.storefront || 'us';
                        const desiredCount = playlist.requestedSongCount || 30;

                        // Build history set for deduplication
                        const historicalTrackKeys = new Set(playlist.songHistory || []);
                        const seenIds = new Set();
                        const seenNormalizedAppleNames = new Set();
                        const uniqueAppleTracks = [];

                        for (const query of searchQueries) {
                          if (uniqueAppleTracks.length >= desiredCount) break;
                          try {
                            const results = await platformServiceInstance.searchTracks(platformUserId, query, appleTokens, storefront, 15);
                            for (const track of results) {
                              if (uniqueAppleTracks.length >= desiredCount) break;
                              if (seenIds.has(track.id)) continue;
                              const normalizedName = (track.name || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
                              const trackKey = `${normalizedName}|||${(track.artists?.[0]?.name || track.artist || '').toLowerCase()}`;
                              if (seenNormalizedAppleNames.has(trackKey)) continue;
                              if (historicalTrackKeys.has(trackKey)) continue;
                              seenIds.add(track.id);
                              seenNormalizedAppleNames.add(trackKey);
                              uniqueAppleTracks.push(track);
                            }
                          } catch (appleSearchErr) {
                            console.log(`[AUTO-UPDATE] Apple Music search failed for "${query}":`, appleSearchErr.message);
                          }
                        }

                        console.log(`[AUTO-UPDATE] Found ${uniqueAppleTracks.length} Apple Music tracks for ${playlist.playlistName}`);

                        if (uniqueAppleTracks.length > 0) {
                          const newAppleTrackIds = uniqueAppleTracks.map(t => t.id);
                          try {
                            // Apple Music API doesn't support removing tracks — always append new songs
                            await appleMusicApiInstance.addTracksToPlaylist(appleTokens.access_token, playlist.playlistId, newAppleTrackIds);
                            console.log(`[AUTO-UPDATE] Added ${newAppleTrackIds.length} tracks to Apple Music playlist ${playlist.playlistName}`);

                            // Update song history
                            if (!playlist.songHistory) playlist.songHistory = [];
                            const newAppleHistoryEntries = uniqueAppleTracks.map(track => {
                              const normalizedName = (track.name || '').toLowerCase().replace(/[^\w\s]/g, '').replace(/\s+/g, ' ').trim();
                              return `${normalizedName}|||${(track.artists?.[0]?.name || track.artist || '').toLowerCase()}`;
                            });
                            playlist.songHistory = [...playlist.songHistory, ...newAppleHistoryEntries].slice(-200);
                            console.log(`[AUTO-UPDATE] Song history updated for ${playlist.playlistName} — ${playlist.songHistory.length} tracks`);
                          } catch (appleUpdateError) {
                            console.error(`[AUTO-UPDATE] Failed to update Apple Music playlist ${playlist.playlistName}:`, appleUpdateError.message);
                          }
                        } else {
                          console.log(`[AUTO-UPDATE] No new Apple Music tracks found for ${playlist.playlistName}`);
                        }
                      } else {
                        console.error('[AUTO-UPDATE] Failed to generate Apple Music developer token');
                      }
                    }
                  } else {
                  // ── Spotify auto-update ───────────────────────────────────
                  const allSearchResults = [];

                  // If userId is email-based, resolve to Spotify platform userId
                  if (isEmailBasedUserId(userId)) {
                    platformUserId = await resolvePlatformUserId(userId, 'spotify');
                    if (!platformUserId) {
                      console.log(`[AUTO-UPDATE] No Spotify connection for user ${userId}, skipping playlist ${playlist.playlistName}`);
                      // Advance nextUpdate so the scheduler doesn't retry every minute
                      playlist.nextUpdate = calculateNextUpdate(playlist.updateFrequency, playlist.playlistId, playlist.updateTime);
                      await savePlaylist(userId, playlist);
                      continue; // Skip to next playlist
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

                    // Refresh token before making API calls - CRITICAL for auto-update
                    // Use retry logic with exponential backoff to handle transient failures
                    let tokenRefreshSuccess = false;
                    const maxRetries = 3;
                    for (let attempt = 1; attempt <= maxRetries; attempt++) {
                      try {
                        console.log(`[AUTO-UPDATE] Refreshing Spotify access token for user ${userId} (attempt ${attempt}/${maxRetries})...`);
                        const refreshData = await userSpotifyApi.refreshAccessToken();
                        const newAccessToken = refreshData.body.access_token;
                        userSpotifyApi.setAccessToken(newAccessToken);
                        tokens.access_token = newAccessToken;
                        userTokens.set(platformUserId, tokens);
                        saveTokens();
                        console.log('[AUTO-UPDATE] Token refresh successful');
                        tokenRefreshSuccess = true;
                        break; // Success - exit retry loop
                      } catch (refreshError) {
                        console.error(`[AUTO-UPDATE] Token refresh attempt ${attempt}/${maxRetries} failed:`, refreshError.message);

                        if (attempt < maxRetries) {
                          // Wait before retrying (exponential backoff: 2s, 4s)
                          const waitTime = Math.pow(2, attempt) * 1000;
                          console.log(`[AUTO-UPDATE] Waiting ${waitTime}ms before retry...`);
                          await new Promise(resolve => setTimeout(resolve, waitTime));
                        }
                      }
                    }

                    if (!tokenRefreshSuccess) {
                      console.error('[AUTO-UPDATE] CRITICAL: All token refresh attempts failed');
                      console.error('[AUTO-UPDATE] Skipping playlist update - cannot proceed without valid token');
                      throw new Error('Token refresh failed after 3 attempts');
                    }

                    // Strategy 1: Use SoundCharts to discover songs via similar artists
                    // This is the primary discovery method for auto-updates
                    let soundChartsDiscoveredSongs = [];
                    let soundChartsCriteria = null;
                    const seedArtists = genreData.artistConstraints?.requestedArtists?.length > 0
                      ? genreData.artistConstraints.requestedArtists
                      : genreData.artistConstraints?.suggestedSeedArtists || [];

                    if (process.env.SOUNDCHARTS_APP_ID) {
                      console.log('[AUTO-UPDATE] 🎵 Using SoundCharts for song discovery...');
                      if (seedArtists.length > 0) {
                        console.log(`[AUTO-UPDATE]    Seed artists: ${seedArtists.join(', ')}`);
                      } else {
                        console.log('[AUTO-UPDATE]    No seed artists — will use genre/mood-based top songs discovery');
                      }

                      // Map user mood/atmosphere to SoundCharts moods
                      const moodMapping = {
                        'sad': ['Melancholic', 'Sad', 'Somber'],
                        'happy': ['Joyful', 'Euphoric', 'Uplifting'],
                        'chill': ['Calm', 'Relaxed', 'Peaceful'],
                        'energetic': ['Energetic', 'Euphoric', 'Powerful'],
                        'romantic': ['Romantic', 'Sensual', 'Intimate'],
                        'party': ['Joyful', 'Euphoric', 'Playful'],
                        'melancholic': ['Melancholic', 'Sad', 'Wistful'],
                        'in my feels': ['Melancholic', 'Emotional', 'Introspective']
                      };

                      // Map atmosphere to target moods
                      let targetMoods = [];
                      if (genreData.atmosphere && genreData.atmosphere.length > 0) {
                        for (const atmos of genreData.atmosphere) {
                          const atmosLower = atmos.toLowerCase();
                          for (const [key, moods] of Object.entries(moodMapping)) {
                            if (atmosLower.includes(key)) {
                              targetMoods.push(...moods);
                            }
                          }
                        }
                        targetMoods = [...new Set(targetMoods)]; // Dedupe
                      }

                      // Map lyrical themes
                      let targetThemes = [];
                      if (genreData.lyricalContent?.themes?.length > 0) {
                        targetThemes = genreData.lyricalContent.themes.map(t => t.charAt(0).toUpperCase() + t.slice(1));
                      }

                      soundChartsCriteria = {
                        seedArtists: seedArtists,
                        genre: genreData.primaryGenre,
                        targetMoods: targetMoods.length > 0 ? targetMoods : null,
                        targetThemes: targetThemes.length > 0 ? targetThemes : null,
                        popularity: genreData.trackConstraints?.popularity?.min || genreData.trackConstraints?.popularity?.max ? {
                          min: genreData.trackConstraints.popularity.min,
                          max: genreData.trackConstraints.popularity.max
                        } : null,
                        releaseYear: genreData.era?.yearRange?.min || genreData.era?.yearRange?.max ? {
                          min: genreData.era.yearRange.min,
                          max: genreData.era.yearRange.max
                        } : null,
                        // Pass exclusive mode for proper artist discovery balance
                        exclusiveMode: genreData.artistConstraints?.exclusiveMode === true || genreData.artistConstraints?.exclusiveMode === 'true'
                      };

                      try {
                        soundChartsDiscoveredSongs = await discoverSongsViaSoundCharts(soundChartsCriteria, 60);
                        if (soundChartsDiscoveredSongs.length > 0) {
                          console.log(`[AUTO-UPDATE] ✓ SoundCharts discovered ${soundChartsDiscoveredSongs.length} songs`);

                          // Convert SoundCharts songs to Spotify tracks by searching for them
                          for (const scSong of soundChartsDiscoveredSongs.slice(0, 30)) {
                            try {
                              const searchQuery = scSong.isrc
                                ? `isrc:${scSong.isrc}`
                                : `track:${scSong.name} artist:${scSong.artistName}`;
                              const results = await userSpotifyApi.searchTracks(searchQuery, { limit: 1 });
                              if (results.body.tracks && results.body.tracks.items.length > 0) {
                                allSearchResults.push(results.body.tracks.items[0]);
                              }
                            } catch (searchError) {
                              // Silently skip songs that can't be found on Spotify
                            }
                          }
                          console.log(`[AUTO-UPDATE] Found ${allSearchResults.length} SoundCharts songs on Spotify`);
                        }
                      } catch (scError) {
                        console.log('[AUTO-UPDATE] SoundCharts discovery failed:', scError.message);
                      }
                    }

                    // If SoundCharts returned too few songs, expand with top songs by genre/mood
                    const targetCount = playlist.trackCount || (playlist.updateMode === 'replace' ? 30 : 10);
                    if (allSearchResults.length < targetCount && process.env.SOUNDCHARTS_APP_ID) {
                      console.log(`[AUTO-UPDATE] Only ${allSearchResults.length}/${targetCount} songs — expanding with SoundCharts top songs...`);
                      try {
                        const expandCriteria = {
                          seedArtists: [],
                          genre: genreData.primaryGenre,
                          targetMoods: soundChartsCriteria?.targetMoods || null,
                          targetThemes: null,
                          popularity: null,
                          releaseYear: soundChartsCriteria?.releaseYear || null,
                          exclusiveMode: false
                        };
                        const topSongs = await discoverSongsViaSoundChartsTop(expandCriteria, targetCount * 2);
                        console.log(`[AUTO-UPDATE] SoundCharts top songs: ${topSongs.length} candidates`);
                        for (const song of topSongs) {
                          if (allSearchResults.length >= targetCount * 2) break;
                          try {
                            const searchQuery = song.isrc
                              ? `isrc:${song.isrc}`
                              : `track:${song.name} artist:${song.artistName}`;
                            const results = await userSpotifyApi.searchTracks(searchQuery, { limit: 1 });
                            if (results.body.tracks?.items?.[0]) {
                              allSearchResults.push(results.body.tracks.items[0]);
                            }
                          } catch (searchErr) { /* skip */ }
                        }
                        console.log(`[AUTO-UPDATE] After top songs expansion: ${allSearchResults.length} total`);
                      } catch (expandErr) {
                        console.log('[AUTO-UPDATE] Top songs expansion failed:', expandErr.message);
                      }
                    }


                    // Filter out tracks that don't match the primary genre (if specified)
                    let genreFilteredResults = allSearchResults;
                    if (genreData.primaryGenre && genreData.primaryGenre !== 'not specified') {
                      try {
                        // Use Claude to validate genre matching - validate ALL tracks, not just first 50
                        // Include artist genre information when available, but also leverage Claude's built-in music knowledge
                        // This approach is platform-agnostic and works for Spotify, Apple Music, Amazon Music, etc.
                        const trackListForValidation = allSearchResults.map(t => {
                          const artistGenres = t.genres && t.genres.length > 0 ? ` [API genres: ${t.genres.join(', ')}]` : '';
                          return `${t.name} by ${t.artists[0]?.name || 'Unknown'}${artistGenres}`;
                        }).join('\n');

                        const genreValidationResponse = await anthropic.messages.create({
                          model: 'claude-sonnet-4-20250514',
                          max_tokens: 4000,
                          messages: [{
                            role: 'user',
                            content: `You are a music genre expert. Filter out tracks that clearly do not belong in a "${genreData.primaryGenre}" playlist. When in doubt, keep the track.

CRITICAL: The user's playlist description is: "${prompt}"

IMPORTANT DISTINCTION:
- The playlist DESCRIPTION (like "focus while working" or "chill vibes") is about the MOOD/USE CASE
- The GENRE requirement ("${genreData.primaryGenre}") is about the MUSICAL STYLE
- DO NOT reject songs based on title keywords that match the description!
- Example: For an R&B playlist with description "music to focus while working", only reject "Focus" by Ariana Grande if it is clearly not R&B

YOUR KNOWLEDGE BASE:
- Use your comprehensive training data about artists, genres, musical styles, and song classifications
- API genre tags (when provided) are hints, but NOT definitive - use your own knowledge as primary source
- Consider the artist's full discography, typical style, and the specific song's characteristics
- Account for artists who cross genres - evaluate each SONG individually, not just the artist

Below is a list of tracks with API genre tags when available. Reject only obvious genre mismatches — it is worse to have too few tracks than to include a borderline case.

RULES FOR "${genreData.primaryGenre}" PLAYLISTS:
- If the genre is Pop: ACCEPT dance-pop, indie pop, electropop, pop-R&B, synth-pop, and mainstream crossover artists. Only REJECT tracks that are clearly classical, jazz, heavy metal, or pure hip-hop with no pop elements.
- If the genre is R&B: ACCEPT R&B-pop, neo-soul, and soul. REJECT only pure jazz, smooth jazz, and classical.
- If the genre is Hip-Hop: ACCEPT rap-pop and hip-hop-R&B crossovers. REJECT classical, jazz, and rock with no hip-hop elements.
- If the genre is Rock: ACCEPT pop-rock, indie rock, and alternative rock. REJECT classical, jazz, and pure pop with no rock elements.
- REJECT study music, ambient focus instrumentals, and background music ONLY if the requested genre is not ambient/instrumental.
- DO NOT over-reject — keep borderline tracks; the AI selection step will refine further.

Examples of REJECTIONS for R&B playlists (only truly off-genre):
- "Soulful" by Cal Harris Jr. (this is JAZZ, not R&B)
- Any track that is clearly classical or smooth jazz with no R&B elements
- "Pieces of Me" by Smooth Jazz All Stars (this is SMOOTH JAZZ, not R&B)

Tracks to evaluate:
${trackListForValidation}

Respond with valid JSON:
{
  "validTracks": ["track 1 by artist 1", "track 2 by artist 2", ...],
  "rejectedCount": <number of tracks rejected>
}

Only reject tracks that are genuinely off-genre. When uncertain, include the track. DO NOT include any text outside the JSON.`
                          }]
                        });

                        try {
                          let validationText = genreValidationResponse.content[0].text.trim();
                          if (validationText.startsWith('```json')) {
                            validationText = validationText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                          } else if (validationText.startsWith('```')) {
                            validationText = validationText.replace(/^```\n?/, '').replace(/\n?```$/, '');
                          }
                          const validationData = JSON.parse(validationText);
                          const validTrackNames = new Set(validationData.validTracks || []);

                          // Filter search results based on validation
                          genreFilteredResults = allSearchResults.filter(track => {
                            const trackString = `${track.name} by ${track.artists[0]?.name || 'Unknown'}`;
                            return validTrackNames.has(trackString);
                          });

                          console.log(`[AUTO-UPDATE] Genre validation: ${allSearchResults.length} tracks -> ${genreFilteredResults.length} valid ${genreData.primaryGenre} tracks`);
                        } catch (parseError) {
                          console.log('Could not parse genre validation:', parseError.message);
                          genreFilteredResults = allSearchResults; // Fall back to all results
                        }
                      } catch (validationError) {
                        console.log('Genre validation failed:', validationError.message);
                        genreFilteredResults = allSearchResults; // Fall back to all results
                      }
                    }

                    // Parse BOTH original prompt AND refinement instructions to extract constraints
                    let minYear = null;
                    let maxYear = null;
                    let excludedArtists = [];
                    const currentYear = new Date().getFullYear();

                    // Add explicitly excluded artists from user feedback
                    if (playlist.excludedArtists && playlist.excludedArtists.length > 0) {
                      excludedArtists = [...playlist.excludedArtists.map(a => a.toLowerCase())];
                      console.log(`[AUTO-UPDATE] User has excluded ${excludedArtists.length} artists via feedback: ${excludedArtists.join(', ')}`);
                    }

                    // Helper function to parse constraints from text
                    const parseConstraints = (text, source) => {
                      const lowerText = text.toLowerCase();

                      // Check for "last X years" or "past X years" pattern
                      const yearsMatch = lowerText.match(/(?:last|past|recent)\s+(\d+)\s+years?/);
                      if (yearsMatch) {
                        const years = parseInt(yearsMatch[1]);
                        const yearConstraint = currentYear - years;
                        if (minYear === null || yearConstraint > minYear) {
                          minYear = yearConstraint;
                          maxYear = currentYear; // Also set max year to current year
                          console.log(`[AUTO-UPDATE] Year filter from ${source}: only songs from ${minYear}-${maxYear} (last ${years} years)`);
                        }
                      }

                      // Check for specific year range "from YYYY to YYYY" or "YYYY-YYYY"
                      const rangeMatch = lowerText.match(/(?:from\s+)?(\d{4})(?:\s*(?:to|-)\s*(\d{4}))/);
                      if (rangeMatch) {
                        const startYear = parseInt(rangeMatch[1]);
                        const endYear = parseInt(rangeMatch[2]);
                        minYear = Math.min(startYear, endYear);
                        maxYear = Math.max(startYear, endYear);
                        console.log(`[AUTO-UPDATE] Year range from ${source}: ${minYear}-${maxYear}`);
                      }

                      // Check for decade patterns "90s", "2000s", "2010s"
                      const decadeMatch = lowerText.match(/\b(\d{2,4})s\b/);
                      if (decadeMatch) {
                        let decade = parseInt(decadeMatch[1]);
                        // Handle both "90s" (90) and "1990s" (1990)
                        if (decade < 100) {
                          decade = decade >= 20 ? 1900 + decade : 2000 + decade;
                        }
                        minYear = Math.floor(decade / 10) * 10;
                        maxYear = minYear + 9;
                        console.log(`[AUTO-UPDATE] Decade filter from ${source}: ${minYear}-${maxYear}`);
                      }

                      // Check for "only songs from YYYY" pattern
                      const singleYearMatch = lowerText.match(/(?:only|just)\s+(?:songs?|tracks?|music)\s+from\s+(\d{4})/);
                      if (singleYearMatch) {
                        const year = parseInt(singleYearMatch[1]);
                        minYear = year;
                        maxYear = year;
                        console.log(`[AUTO-UPDATE] Single year filter from ${source}: ${year}`);
                      }

                      // Popularity patterns
                      if (lowerText.match(/\b(mainstream|popular|well[- ]known|hits?|chart toppers?)\b/)) {
                        console.log(`[AUTO-UPDATE] Popularity preference from ${source}: mainstream`);
                      } else if (lowerText.match(/\b(underground|obscure|hidden gems?|lesser[- ]known|deep cuts?|indie)\b/)) {
                        console.log(`[AUTO-UPDATE] Popularity preference from ${source}: underground`);
                      }

                      // Duration patterns
                      const durationMatch = lowerText.match(/(?:songs?|tracks?)\s+(?:under|less than|shorter than|below)\s+(\d+)\s+(?:min(?:ute)?s?|seconds?)/);
                      if (durationMatch) {
                        const duration = parseInt(durationMatch[1]);
                        console.log(`[AUTO-UPDATE] Duration filter from ${source}: under ${duration} minutes`);
                      }

                      // Version exclusion patterns
                      if (lowerText.match(/\b(no|avoid|exclude|skip)\s+(live|acoustic|remix(?:es)?|cover|instrumental|edit)\s+(?:version|recording|track)?s?\b/)) {
                        console.log(`[AUTO-UPDATE] Version exclusion from ${source}: detected`);
                      }

                      // Vocal/gender patterns
                      if (lowerText.match(/\b(female|woman|women)\s+(?:vocal|singer|artist)s?\b/)) {
                        console.log(`[AUTO-UPDATE] Vocal preference from ${source}: female`);
                      } else if (lowerText.match(/\b(male|man|men)\s+(?:vocal|singer|artist)s?\b/)) {
                        console.log(`[AUTO-UPDATE] Vocal preference from ${source}: male`);
                      }

                      // Collaboration/feature patterns
                      if (lowerText.match(/\b(no|avoid|exclude)\s+(?:feature|feat|collaboration|collab)s?\b/)) {
                        console.log(`[AUTO-UPDATE] Feature exclusion from ${source}: detected`);
                      }

                      // Production style patterns
                      if (lowerText.match(/\b(acoustic|unplugged|stripped[- ]down|raw)\b/)) {
                        console.log(`[AUTO-UPDATE] Production preference from ${source}: acoustic`);
                      } else if (lowerText.match(/\b(electronic|synth|edm|produced)\b/)) {
                        console.log(`[AUTO-UPDATE] Production preference from ${source}: electronic`);
                      } else if (lowerText.match(/\b(live|concert|performance)\s+(?:recording|version)s?\b/)) {
                        console.log(`[AUTO-UPDATE] Production preference from ${source}: live`);
                      }

                      // Auto-tune patterns
                      if (lowerText.match(/\b(no|avoid|exclude|without)\s+auto[- ]?tune\b/)) {
                        console.log(`[AUTO-UPDATE] Auto-tune avoidance from ${source}: detected`);
                      }

                      // Lyrical content patterns
                      if (lowerText.match(/\b(?:about|themed?|focus(?:ed)? on)\s+([^,\.;]+)/)) {
                        console.log(`[AUTO-UPDATE] Lyrical theme from ${source}: detected`);
                      }
                      if (lowerText.match(/\b(?:no|avoid|exclude|skip)\s+(?:songs? about|lyrics about|themes? of)\s+([^,\.;]+)/)) {
                        console.log(`[AUTO-UPDATE] Lyrical avoidance from ${source}: detected`);
                      }

                      // Discovery balance patterns
                      if (lowerText.match(/\b(?:familiar|favorites?|classics?|well[- ]known|songs? I know)\b/)) {
                        console.log(`[AUTO-UPDATE] Discovery preference from ${source}: familiar`);
                      } else if (lowerText.match(/\b(?:discover(?:y)?|new|explore|hidden gems?|lesser[- ]known|artists? I don't know)\b/)) {
                        console.log(`[AUTO-UPDATE] Discovery preference from ${source}: discovery`);
                      }

                      // Language patterns
                      const languageMatch = lowerText.match(/\b(english|spanish|french|german|italian|portuguese|japanese|korean|chinese)\s+(?:songs?|music|language)\b/);
                      if (languageMatch) {
                        console.log(`[AUTO-UPDATE] Language preference from ${source}: ${languageMatch[1]}`);
                      }

                      // Album diversity patterns
                      const albumDiversityMatch = lowerText.match(/(?:no more than|max(?:imum)?|at most)\s+(\d+)\s+(?:songs?|tracks?)\s+(?:per|from each)\s+album/);
                      if (albumDiversityMatch) {
                        console.log(`[AUTO-UPDATE] Album diversity from ${source}: max ${albumDiversityMatch[1]} per album`);
                      }
                      if (lowerText.match(/\b(?:deep cuts?|album tracks?|b[- ]sides?)\b/)) {
                        console.log(`[AUTO-UPDATE] Album preference from ${source}: deep cuts`);
                      } else if (lowerText.match(/\b(?:singles?|hits?|chart)\b/)) {
                        console.log(`[AUTO-UPDATE] Album preference from ${source}: singles`);
                      }

                      // Check for "exclude [artist]" or "exclude [artist] songs" pattern
                      const excludeMatches = lowerText.matchAll(/exclude\s+([^,\.;]+?)(?:\s+(?:songs?|tracks?|music))?(?:[,\.;]|$)/gi);
                      for (const match of excludeMatches) {
                        const artist = match[1].trim().toLowerCase();
                        if (artist && !excludedArtists.includes(artist)) {
                          excludedArtists.push(artist);
                          console.log(`[AUTO-UPDATE] Excluding artist from ${source}: ${artist}`);
                        }
                      }
                    };

                    // Parse original prompt for constraints
                    if (playlist.originalPrompt) {
                      parseConstraints(playlist.originalPrompt, 'original prompt');
                    }

                    // Parse refinement instructions for additional constraints
                    if (playlist.refinementInstructions && playlist.refinementInstructions.length > 0) {
                      playlist.refinementInstructions.forEach(instruction => {
                        parseConstraints(instruction, 'refinement');
                      });
                    }

                    // Filter tracks based on year, artist exclusions, song exclusions, and disliked songs
                    const excludedSongIds = new Set((playlist.excludedSongs || []).map(s => s.id || s));
                    const dislikedSongIds = new Set((playlist.dislikedSongs || []).map(s => s.id));

                    if (minYear !== null || maxYear !== null || excludedArtists.length > 0 || excludedSongIds.size > 0 || dislikedSongIds.size > 0) {
                      const beforeFilter = genreFilteredResults.length;
                      genreFilteredResults = genreFilteredResults.filter(track => {
                        // Check if this specific song was excluded
                        if (excludedSongIds.has(track.id)) {
                          console.log(`[AUTO-UPDATE] Filtered out excluded song: ${track.name}`);
                          return false;
                        }

                        // Check if this specific song was disliked by user
                        if (dislikedSongIds.has(track.id)) {
                          console.log(`[AUTO-UPDATE] Filtered out disliked song: ${track.name}`);
                          return false;
                        }

                        // Check year constraint (both min and max)
                        if ((minYear !== null || maxYear !== null) && track.album && track.album.release_date) {
                          const releaseYear = parseInt(track.album.release_date.substring(0, 4));
                          if (minYear !== null && releaseYear < minYear) {
                            return false;
                          }
                          if (maxYear !== null && releaseYear > maxYear) {
                            return false;
                          }
                        }

                        // Check artist exclusions
                        if (excludedArtists.length > 0) {
                          const trackArtists = track.artists.map(a => a.name.toLowerCase());
                          for (const excludedArtist of excludedArtists) {
                            if (trackArtists.some(a => a.includes(excludedArtist) || excludedArtist.includes(a))) {
                              return false;
                            }
                          }
                        }

                        return true;
                      });
                      const yearRangeLog = minYear !== null || maxYear !== null ? ` year range: ${minYear || 'any'}-${maxYear || 'current'},` : '';
                      console.log(`[AUTO-UPDATE] Applied filters: ${beforeFilter} tracks -> ${genreFilteredResults.length} tracks (${yearRangeLog} excluded ${excludedSongIds.size} songs, ${dislikedSongIds.size} disliked songs, ${excludedArtists.length} artists)`);
                    }

                    // Remove duplicates by both URI and normalized track name
                    const existingUris = new Set(playlist.tracks.map(t => t.uri));
                    const existingTrackIds = new Set(playlist.tracks.map(t => t.id).filter(Boolean));

                    // Also create a set of normalized names from existing tracks to avoid duplicates
                    const normalizeTrackName = (name) => {
                      let normalized = name.toLowerCase();
                      normalized = normalized
                        .replace(/\s*-\s*(a\s+)?colors?\s+show/gi, '')
                        .replace(/\s*-\s*((single|album|ep)\s+)?version/gi, '')
                        .replace(/\s*[\(\[].*?[\)\]]/g, '')
                        .replace(/[^\w\s]/g, '')
                        .replace(/\s+/g, ' ')
                        .trim();
                      return normalized;
                    };

                    const existingNormalizedNames = new Set(
                      playlist.tracks
                        .filter(t => t.name)
                        .map(t => normalizeTrackName(t.name))
                    );

                    // Initialize song history if it doesn't exist
                    if (!playlist.songHistory) {
                      playlist.songHistory = [];
                    }

                    // Create a Set of historical track keys (artist|||title) for fast lookup
                    const historicalTrackKeys = new Set(playlist.songHistory);

                    const uniqueTracks = [];
                    const seenUris = new Set();
                    const seenNormalizedNames = new Set();

                    // Deduplicate and filter
                    genreFilteredResults.forEach(track => {
                      const normalizedName = normalizeTrackName(track.name);
                      const artistName = track.artists[0]?.name || 'Unknown';
                      const trackKey = `${normalizedName}|||${artistName.toLowerCase()}`; // Artist+title combination
                      const isAppendMode = playlist.updateMode !== 'replace';

                      // Check if track already exists in playlist (by URI or ID)
                      const isExistingTrack = existingUris.has(track.uri) || existingTrackIds.has(track.id);

                      // Check if normalized name already exists in playlist
                      const isExistingName = existingNormalizedNames.has(normalizedName);

                      // Check if track exists in song history (previously used in ANY past version)
                      const isInHistory = historicalTrackKeys.has(trackKey);

                      // For replace mode: skip tracks from the CURRENT playlist to avoid immediate duplication
                      // For append mode: skip tracks already in the playlist
                      if (isExistingTrack || isExistingName) {
                        if (isAppendMode) {
                          // In append mode, definitely skip existing tracks
                          return;
                        } else {
                          // In replace mode, still check - this prevents us from adding the SAME track that's currently in playlist
                          console.log(`[AUTO-UPDATE] Skipping "${track.name}" by ${artistName} (currently in playlist)`);
                          return;
                        }
                      }

                      // Skip tracks that were in previous versions of the playlist
                      if (isInHistory) {
                        console.log(`[AUTO-UPDATE] Skipping "${track.name}" by ${artistName} (previously in playlist history)`);
                        return;
                      }

                      // Check for duplicates within the new batch using artist+title combo
                      const isDuplicateUri = seenUris.has(track.uri);
                      const isDuplicateKey = seenNormalizedNames.has(trackKey);

                      if (!isDuplicateUri && !isDuplicateKey && track.explicit === false) {
                        seenUris.add(track.uri);
                        seenNormalizedNames.add(trackKey); // Store artist+title combo
                        uniqueTracks.push(track);
                      } else if (isDuplicateKey) {
                        console.log(`[AUTO-UPDATE] Skipping duplicate in new batch: "${track.name}" by ${artistName}`);
                      }
                    });

                    // Get the desired number of tracks from playlist settings
                    const desiredCount = playlist.trackCount || (playlist.updateMode === 'replace' ? 30 : 10);

                    // If we don't have enough tracks, retry SoundCharts with expanded criteria.
                    // No Spotify/Apple keyword searches — SoundCharts is the only source.
                    if (uniqueTracks.length < desiredCount && soundChartsCriteria && process.env.SOUNDCHARTS_APP_ID) {
                      console.log(`[AUTO-UPDATE] Only ${uniqueTracks.length}/${desiredCount} tracks — retrying SoundCharts with expanded criteria...`);
                      try {
                        const expandedCriteria = {
                          ...soundChartsCriteria,
                          // Relax popularity/audio constraints to cast a wider net
                          popularity: null,
                          audioFeatures: null,
                        };
                        const moreSoundChartsSongs = await discoverSongsViaSoundCharts(expandedCriteria, 80);
                        if (moreSoundChartsSongs.length > 0) {
                          console.log(`[AUTO-UPDATE] SoundCharts expansion found ${moreSoundChartsSongs.length} additional songs`);
                          for (const scSong of moreSoundChartsSongs) {
                            if (uniqueTracks.length >= desiredCount) break;
                            try {
                              const expandedQuery = scSong.isrc
                                ? `isrc:${scSong.isrc}`
                                : `track:${scSong.name} artist:${scSong.artistName}`;
                              const results = await userSpotifyApi.searchTracks(expandedQuery, { limit: 1 });
                              if (results.body.tracks && results.body.tracks.items.length > 0) {
                                const track = results.body.tracks.items[0];
                                const normalizedName = normalizeTrackName(track.name);
                                const artistName = track.artists[0]?.name || 'Unknown';
                                const trackKey = `${normalizedName}|||${artistName.toLowerCase()}`;
                                if (!seenUris.has(track.uri) && !seenNormalizedNames.has(trackKey) &&
                                    !historicalTrackKeys.has(trackKey) && !existingUris.has(track.uri) &&
                                    !existingNormalizedNames.has(normalizedName) && track.explicit === false) {
                                  seenUris.add(track.uri);
                                  seenNormalizedNames.add(trackKey);
                                  uniqueTracks.push(track);
                                }
                              }
                            } catch (searchError) { /* skip */ }
                          }
                          console.log(`[AUTO-UPDATE] After SoundCharts expansion: ${uniqueTracks.length} total tracks`);
                        }
                      } catch (scError) {
                        console.log('[AUTO-UPDATE] SoundCharts expansion failed:', scError.message);
                      }
                    }

                    const songCount = Math.min(desiredCount, uniqueTracks.length);
                    newTrackUris = uniqueTracks.slice(0, songCount).map(track => track.uri);

                    // Store track info for history tracking (will be used after Spotify update succeeds)
                    tracksForHistory = uniqueTracks.slice(0, songCount).map(track => ({
                      name: track.name,
                      artist: track.artists[0]?.name || 'Unknown'
                    }));

                    console.log(`[AUTO-UPDATE] Generated ${newTrackUris.length} new track URIs for ${playlist.playlistName} (requested: ${desiredCount})${songCount < desiredCount ? ' - Warning: Not enough valid tracks found after filtering and additional searches' : ''}`);

                    // Validate track URIs before attempting to add them to Spotify
                    // Spotify track URIs must be in format: spotify:track:<base62_id>
                    // Base62 IDs are 22 characters long and use [0-9a-zA-Z]
                    const validUriRegex = /^spotify:track:[0-9a-zA-Z]{22}$/;
                    const invalidUris = [];
                    const validatedUris = newTrackUris.filter(uri => {
                      const isValid = validUriRegex.test(uri);
                      if (!isValid) {
                        invalidUris.push(uri);
                      }
                      return isValid;
                    });

                    if (invalidUris.length > 0) {
                      console.error(`[AUTO-UPDATE] WARNING: Filtered out ${invalidUris.length} invalid track URIs:`);
                      invalidUris.forEach((uri, idx) => {
                        console.error(`[AUTO-UPDATE]   ${idx + 1}. "${uri}"`);
                      });
                    }

                    // Update the track URIs and history to only include valid tracks
                    newTrackUris = validatedUris;
                    tracksForHistory = tracksForHistory.slice(0, validatedUris.length);

                    console.log(`[AUTO-UPDATE] Validated URIs: ${newTrackUris.length} valid out of original ${validatedUris.length + invalidUris.length}`);
                  }
                  } // end Spotify else branch
                } catch (generationError) {
                  console.error(`[AUTO-UPDATE] Track generation failed for ${playlist.playlistName}:`, generationError.message);
                  newTrackUris = [];
                }

                // Get user tokens (use platformUserId resolved earlier) — Spotify only
                if (playlistPlatform !== 'apple') {
                const tokens = await getUserTokens(platformUserId);
                if (tokens && newTrackUris.length > 0) {
                  const userSpotifyApi = new SpotifyWebApi({
                    clientId: process.env.SPOTIFY_CLIENT_ID,
                    clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
                    redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
                  });
                  userSpotifyApi.setAccessToken(tokens.access_token);
                  userSpotifyApi.setRefreshToken(tokens.refresh_token);

                  // Token was already refreshed earlier in the flow, so we can use it directly

                  // Update playlist based on mode
                  try {
                    if (playlist.updateMode === 'replace') {
                      // First, get current tracks in the playlist to remove them
                      console.log(`[AUTO-UPDATE] Replace mode: Getting current tracks for ${playlist.playlistName}`);
                      const currentPlaylistData = await userSpotifyApi.getPlaylist(playlist.playlistId);

                      // Filter out null/invalid tracks and validate URIs
                      const validUriRegex = /^spotify:track:[0-9a-zA-Z]{22}$/;
                      const allTrackItems = currentPlaylistData.body.tracks.items;
                      const invalidTracks = allTrackItems.filter(item => !item.track || !item.track.uri || !validUriRegex.test(item.track.uri));

                      if (invalidTracks.length > 0) {
                        console.log(`[AUTO-UPDATE] Warning: Found ${invalidTracks.length} invalid/null tracks in playlist, skipping them`);
                        invalidTracks.forEach((item, idx) => {
                          const uri = item.track?.uri || 'null';
                          const name = item.track?.name || 'Unknown';
                          console.log(`[AUTO-UPDATE]   ${idx + 1}. "${name}" - URI: ${uri}`);
                        });
                      }

                      const currentTrackUris = allTrackItems
                        .filter(item => item.track && item.track.uri && validUriRegex.test(item.track.uri))
                        .map(item => item.track.uri);

                      console.log(`[AUTO-UPDATE] Removing ${currentTrackUris.length} valid tracks from ${playlist.playlistName} (out of ${allTrackItems.length} total)`);

                      // Remove all current tracks first
                      if (currentTrackUris.length > 0) {
                        // Spotify API requires tracks in specific format for removal: array of objects with 'uri' property
                        const tracksToRemove = currentTrackUris.map(uri => ({ uri }));
                        try {
                          await userSpotifyApi.removeTracksFromPlaylist(playlist.playlistId, tracksToRemove);
                        } catch (removeError) {
                          console.error(`[AUTO-UPDATE] Error removing tracks:`, removeError.message);
                          console.error(`[AUTO-UPDATE] Failed URIs sample:`, currentTrackUris.slice(0, 3));
                          throw removeError;
                        }
                      }

                      // Then add the new tracks
                      await userSpotifyApi.addTracksToPlaylist(playlist.playlistId, newTrackUris);
                      console.log(`[AUTO-UPDATE] Successfully replaced all tracks in ${playlist.playlistName} with ${newTrackUris.length} new tracks`);
                    } else {
                      // Append mode - just add new tracks
                      await userSpotifyApi.addTracksToPlaylist(playlist.playlistId, newTrackUris);
                      console.log(`[AUTO-UPDATE] Successfully appended ${newTrackUris.length} tracks to ${playlist.playlistName}`);
                    }

                    // Sync playlist.tracks in the DB record so Fins reflects the real Spotify state
                    const newTracksForRecord = uniqueTracks.slice(0, songCount).map(track => ({
                      id: track.id,
                      name: track.name,
                      artist: track.artists[0]?.name || 'Unknown',
                      uri: track.uri,
                      album: track.album?.name || '',
                      image: track.album?.images[0]?.url || null,
                      externalUrl: track.external_urls?.spotify || null,
                      explicit: track.explicit || false
                    }));

                    if (playlist.updateMode === 'replace') {
                      playlist.tracks = newTracksForRecord;
                      playlist.trackUris = newTrackUris;
                      playlist.trackCount = newTrackUris.length;
                    } else {
                      if (!playlist.tracks) playlist.tracks = [];
                      if (!playlist.trackUris) playlist.trackUris = [];
                      playlist.tracks = [...playlist.tracks, ...newTracksForRecord];
                      playlist.trackUris = [...playlist.trackUris, ...newTrackUris];
                      playlist.trackCount = playlist.trackUris.length;
                    }
                    console.log(`[AUTO-UPDATE] Synced playlist.tracks: ${playlist.trackCount} total tracks`);

                    // Update song history to prevent repeats
                    // Accumulate tracks over multiple updates to keep playlists fresh
                    if (tracksForHistory.length > 0) {
                      // Define normalizeTrackName function for history tracking
                      const normalizeTrackName = (name) => {
                        let normalized = name.toLowerCase();
                        normalized = normalized
                          .replace(/\s*-\s*(a\s+)?colors?\s+show/gi, '')
                          .replace(/\s*-\s*((single|album|ep)\s+)?version/gi, '')
                          .replace(/\s*[\(\[].*?[\)\]]/g, '')
                          .replace(/[^\w\s]/g, '')
                          .replace(/\s+/g, ' ')
                          .trim();
                        return normalized;
                      };

                      // Initialize history if it doesn't exist
                      if (!playlist.songHistory) {
                        playlist.songHistory = [];
                      }

                      // Add new tracks to history
                      const newHistoryEntries = tracksForHistory.map(track => {
                        const normalizedName = normalizeTrackName(track.name);
                        return `${normalizedName}|||${track.artist.toLowerCase()}`;
                      });

                      // Append to existing history
                      playlist.songHistory = [...playlist.songHistory, ...newHistoryEntries];

                      // Keep last 200 tracks in history (prevents history from growing indefinitely)
                      // For a 30-song playlist updated daily, this represents ~6-7 updates worth of history
                      // For weekly updates, this is ~6 months of history
                      const MAX_HISTORY_SIZE = 200;
                      if (playlist.songHistory.length > MAX_HISTORY_SIZE) {
                        playlist.songHistory = playlist.songHistory.slice(-MAX_HISTORY_SIZE);
                      }

                      console.log(`[AUTO-UPDATE] Song history updated for ${playlist.playlistName} - now contains ${playlist.songHistory.length} tracks`);
                    }
                  } catch (updateError) {
                    console.error(`[AUTO-UPDATE] Failed to update ${playlist.playlistName}:`, updateError.message);
                  }
                }
                } // end if (playlistPlatform !== 'apple')

                // Update the nextUpdate timestamp, lastUpdated, and updatedAt
                const now = new Date().toISOString();
                playlist.lastUpdated = now;
                playlist.updatedAt = now;
                playlist.nextUpdate = calculateNextUpdate(playlist.updateFrequency, playlist.playlistId, playlist.updateTime);
                await savePlaylist(userId, playlist);

              } catch (updateError) {
                console.error(`[AUTO-UPDATE] Error updating playlist ${playlist.playlistName}:`, updateError.message);
                // Advance nextUpdate so the scheduler doesn't retry every minute on failure
                playlist.nextUpdate = calculateNextUpdate(playlist.updateFrequency, playlist.playlistId, playlist.updateTime);
                await savePlaylist(userId, playlist);
              }
            }
          }
        }
    } catch (error) {
      console.error('[AUTO-UPDATE] Scheduler error:', error);
    }
  });
};

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
    const { userId, billingPeriod } = req.body;
    if (!userId) return res.status(400).json({ error: 'Missing userId' });

    const email = isEmailBasedUserId(userId) ? userId : await getEmailUserIdFromPlatform(userId);
    if (!email) return res.status(400).json({ error: 'User not found' });

    const priceId = billingPeriod === 'annual'
      ? process.env.STRIPE_PRICE_ANNUAL
      : process.env.STRIPE_PRICE_MONTHLY;
    if (!priceId) return res.status(500).json({ error: 'Stripe price not configured' });

    // Create or reuse Stripe customer
    const stripe = getStripe();
    const userRecord = await db.getUser(email);
    let stripeCustomerId = userRecord?.stripeCustomerId;
    if (!stripeCustomerId) {
      const customer = await stripe.customers.create({ email, metadata: { email } });
      stripeCustomerId = customer.id;
      await db.updateStripeCustomer(email, stripeCustomerId);
    }

    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      customer: stripeCustomerId,
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: `${frontendUrl}/?payment=success`,
      cancel_url: `${frontendUrl}/pricing`,
      metadata: { email },
    });

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
    const frontendUrl = process.env.FRONTEND_URL || 'http://localhost:3000';
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
