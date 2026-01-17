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
} else {
  console.log('Email not configured. Password reset emails will be logged to console.');
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
  if (usePostgres) {
    try {
      await db.savePlaylist(userId, playlistData.playlistId, playlistData);
    } catch (error) {
      console.error('Error saving playlist to database:', error);
    }
  } else {
    // Update in-memory map
    const userPlaylistsArray = userPlaylists.get(userId) || [];
    const existingIndex = userPlaylistsArray.findIndex(p => p.playlistId === playlistData.playlistId);
    if (existingIndex >= 0) {
      userPlaylistsArray[existingIndex] = playlistData;
    } else {
      userPlaylistsArray.push(playlistData);
    }
    userPlaylists.set(userId, userPlaylistsArray);
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

    // Check if user already exists
    if (registeredUsers.has(normalizedEmail)) {
      return res.status(400).json({ error: 'An account with this email already exists' });
    }

    // Create user account (in production, you should hash the password)
    // Use email as the userId (platform-independent)
    const user = {
      email: normalizedEmail,
      password: password, // TODO: Hash password in production
      platform: platform,
      connectedPlatforms: {
        spotify: platform === 'spotify',
        apple: platform === 'apple'
      },
      createdAt: new Date().toISOString(),
      userId: normalizedEmail, // Use email as userId (platform-independent)
    };

    registeredUsers.set(normalizedEmail, user);

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
    if (process.env.SENDGRID_API_KEY) {
      try {
        await sgMail.send({
          to: normalizedEmail,
          from: process.env.SENDGRID_FROM_EMAIL || 'noreply@yourdomain.com',
          subject: 'Password Reset Request - AI Playlist Creator',
          html: `
            <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
              <h2 style="color: #333;">Password Reset Request</h2>
              <p>You requested to reset your password for AI Playlist Creator.</p>
              <p>Click the button below to reset your password:</p>
              <div style="text-align: center; margin: 30px 0;">
                <a href="${resetLink}" style="background-color: #1DB954; color: white; padding: 12px 30px; text-decoration: none; border-radius: 25px; display: inline-block;">Reset Password</a>
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
        console.error('Failed to send email:', emailError);
        console.error('SendGrid error details:', emailError.response?.body);
        // Log the reset link for development
        console.log(`Password reset link for ${normalizedEmail}: ${resetLink}`);
      }
    } else {
      // For development without email configured
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
      appleMusicUserId: platformUserIds?.apple_music_user_id || memUser?.appleMusicUserId
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
    const { currentEmail, newEmail, password } = req.body;

    if (!currentEmail || !newEmail || !password) {
      return res.status(400).json({ error: 'Current email, new email, and password are required' });
    }

    const normalizedCurrentEmail = currentEmail.trim().toLowerCase();
    const normalizedNewEmail = newEmail.trim().toLowerCase();

    const user = registeredUsers.get(normalizedCurrentEmail);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify password
    if (user.password !== password) {
      return res.status(401).json({ error: 'Invalid password' });
    }

    // Check if new email is already taken
    if (normalizedNewEmail !== normalizedCurrentEmail && registeredUsers.has(normalizedNewEmail)) {
      return res.status(409).json({ error: 'Email already in use' });
    }

    // Update email
    registeredUsers.delete(normalizedCurrentEmail);
    user.email = normalizedNewEmail;
    registeredUsers.set(normalizedNewEmail, user);
    saveUsers();

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
    const user = registeredUsers.get(normalizedEmail);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    // Verify current password
    if (user.password !== currentPassword) {
      return res.status(401).json({ error: 'Current password is incorrect' });
    }

    // Update password
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

    // Get top 10 artists from the last 4 weeks
    const topArtistsData = await userSpotifyApi.getMyTopArtists({ limit: 10, time_range: 'short_term' });

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

    console.log(`\n🚫 EXCLUSION LIST:`);
    console.log(`   - Top 10 artists: ${topArtistNames.join(', ')}`);
    console.log(`   - Total artists to exclude: ${allArtistsToExclude.length}`);
    console.log(`   - First 30 excluded artists: ${allArtistsToExclude.slice(0, 30).join(', ')}`);

    // CRITICAL CHECK: Are JENNIE and TWICE in the exclusion list?
    const hasJennie = allArtistsToExclude.some(name => name.toLowerCase().includes('jennie'));
    const hasTwice = allArtistsToExclude.some(name => name.toLowerCase().includes('twice'));
    console.log(`   - ⚠️ JENNIE in exclusion list: ${hasJennie}`);
    console.log(`   - ⚠️ TWICE in exclusion list: ${hasTwice}`);

    // Use AI to suggest artists to explore (ask for 30 to account for Spotify search mismatches)
    // Show more artists to exclude in the prompt to reduce AI errors
    const topExcludeForPrompt = allArtistsToExclude.slice(0, 30); // Show first 30 for context
    const aiPrompt = `Based on a user whose TOP 10 favorite artists are: ${topArtistNames.join(', ')}${genres.length > 0 ? ` and enjoys these genres: ${genres.slice(0, 5).join(', ')}` : ''}, suggest 30 NEW artists they should explore.

CRITICAL INSTRUCTION: The user has ALREADY listened to these ${allArtistsToExclude.length} artists. DO NOT suggest ANY of them:
${topExcludeForPrompt.join(', ')}${allArtistsToExclude.length > 30 ? `, and ${allArtistsToExclude.length - 30} more artists` : ''}.

Focus on artists that are:
- In similar genres and styles to their favorites
- Artists with deep catalogs worth exploring
- Well-regarded artists they may have missed
- Mix of mainstream and indie artists that fit their taste
- Artists that would naturally expand their musical horizons
- IMPORTANT: Artists they have NOT listened to yet

Return ONLY a valid JSON array in this exact format, with no additional text or markdown:
[
  {"name": "Artist Name", "genres": ["genre1", "genre2"], "description": "Brief description"},
  ...
]`;

    console.log('Sending request to AI...');
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4000,
      messages: [{
        role: 'user',
        content: aiPrompt
      }]
    });

    const aiContent = aiResponse.content[0].text.trim();
    console.log('AI Response received');

    // Parse AI response
    let suggestedArtists;
    try {
      // Remove markdown code blocks if present
      const jsonMatch = aiContent.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        suggestedArtists = JSON.parse(jsonMatch[0]);
      } else {
        suggestedArtists = JSON.parse(aiContent);
      }
    } catch (parseError) {
      console.error('Failed to parse AI response:', parseError);
      console.error('AI Content:', aiContent);
      return res.json({ artists: [] });
    }

    console.log(`\n🤖 AI SUGGESTED ${suggestedArtists.length} artists:`, suggestedArtists.map(a => a.name));

    // CRITICAL CHECK: Did AI suggest JENNIE or TWICE?
    const aiSuggestedJennie = suggestedArtists.some(a => a.name.toLowerCase().includes('jennie'));
    const aiSuggestedTwice = suggestedArtists.some(a => a.name.toLowerCase().includes('twice'));
    if (aiSuggestedJennie || aiSuggestedTwice) {
      console.log(`🚨 CRITICAL ERROR: AI IGNORED EXCLUSION INSTRUCTIONS!`);
      console.log(`   - AI suggested JENNIE: ${aiSuggestedJennie}`);
      console.log(`   - AI suggested TWICE: ${aiSuggestedTwice}`);
    }

    // Filter out any artists that user has listened to (top artists + recently played)
    const allArtistsToExcludeLower = allArtistsToExclude.map(name => name.toLowerCase().trim());
    const filteredArtists = suggestedArtists.filter(artist => {
      const artistNameLower = artist.name.toLowerCase().trim();
      const isListenedArtist = allArtistsToExcludeLower.includes(artistNameLower);
      if (isListenedArtist) {
        console.log(`⊘ FILTERING OUT: "${artist.name}" (already in listening history)`);
      }
      return !isListenedArtist;
    });

    console.log(`\n✅ After filtering: ${filteredArtists.length} artists remain`);
    if (suggestedArtists.length - filteredArtists.length > 0) {
      console.log(`⚠️ Filtered out ${suggestedArtists.length - filteredArtists.length} artists from AI suggestions`);
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

    // FINAL CHECK: Are JENNIE or TWICE in the final results?
    const finalHasJennie = formattedArtists.some(a => a.name.toLowerCase().includes('jennie'));
    const finalHasTwice = formattedArtists.some(a => a.name.toLowerCase().includes('twice'));

    console.log(`\n📤 RETURNING ${formattedArtists.length} artists to frontend:`);
    console.log(`   - Artists: ${formattedArtists.map(a => a.name).join(', ')}`);
    console.log(`   - ${formattedArtists.filter(a => a.image).length} with images`);

    if (finalHasJennie || finalHasTwice) {
      console.log(`\n🚨🚨🚨 CRITICAL BUG: JENNIE OR TWICE IN FINAL RESULTS! 🚨🚨🚨`);
      console.log(`   - JENNIE in results: ${finalHasJennie}`);
      console.log(`   - TWICE in results: ${finalHasTwice}`);
      console.log(`   - This should NEVER happen - filtering failed!`);
    }

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
          displayName: 'Music Lover',
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
      // Return basic info with email
      const user = await db.getUser(userId);
      res.json({
        displayName: user?.email?.split('@')[0] || 'Music Lover',
        email: user?.email || userId,
        image: null // Apple Music doesn't provide profile images
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

    // Extract song count from prompt if user specified it
    // Look for patterns like "30 songs", "create 25 tracks", "give me 20 songs", etc.
    const songCountMatch = prompt.match(/\b(\d+)\s+(?:songs?|tracks?)\b/i);
    if (songCountMatch) {
      const extractedCount = parseInt(songCountMatch[1], 10);
      // Only override if it's a reasonable number (between 5 and 100)
      if (extractedCount >= 5 && extractedCount <= 100) {
        songCount = extractedCount;
        console.log(`Extracted song count from prompt: ${songCount}`);
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
    "language": "language preference (e.g., 'English only', 'Spanish', 'Korean', 'any') or null"
  },
  "contextClues": {
    "useCase": "intended use or null",
    "avoidances": ["what NOT to include"]
  },
  "audioFeatures": {
    "bpm": { "min": number or null, "max": number or null, "target": number or null },
    "energy": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null },
    "danceability": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null },
    "valence": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null },
    "acousticness": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null }
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
    "preference": "cohesive/varied/unexpected" or null
  }
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

AUDIO FEATURES:
- BPM: "fast" = 140-180, "slow" = 60-90, "moderate/mid-tempo" = 90-120, "very slow" = 50-75
- Energy: "energetic/hype" = 0.7-1.0, "chill/relaxed/laid-back" = 0.0-0.4, "mellow/smooth" = 0.2-0.5, "moderate" = 0.4-0.7
- Valence: "happy/upbeat/feel-good" = 0.6-1.0, "sad/melancholic/moody" = 0.0-0.4, "emotional/in your feels" = 0.2-0.5
- Danceability: "danceable/groovy" = 0.6-1.0, "not danceable/slow jam" = 0.0-0.4, "moderate groove" = 0.4-0.6
- Acousticness: "acoustic/stripped" = 0.6-1.0, "electronic/produced" = 0.0-0.3

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
        language: null
      },
      contextClues: {
        useCase: null,
        avoidances: []
      },
      audioFeatures: {
        bpm: { min: null, max: null, target: null },
        energy: { min: null, max: null },
        danceability: { min: null, max: null },
        valence: { min: null, max: null },
        acousticness: { min: null, max: null }
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
      }
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

    // Step 0.5: If no explicit genre was specified but artists were requested, analyze those artists to infer the genre
    if ((!genreData.primaryGenre || genreData.primaryGenre === 'not specified') &&
        genreData.artistConstraints.requestedArtists &&
        genreData.artistConstraints.requestedArtists.length > 0 &&
        !genreData.artistConstraints.exclusiveMode) {

      console.log('No explicit genre specified, but artists requested. Searching music platform for artist genres...');

      try {
        // Search for each artist on the platform to get their actual genre information
        const artistGenres = [];
        const artistPopularities = [];

        for (const artistName of genreData.artistConstraints.requestedArtists) {
          try {
            let artistInfo = null;

            if (platform === 'apple') {
              const appleMusicDevToken = generateAppleMusicToken();
              const searchResult = await fetch(
                `https://api.music.apple.com/v1/catalog/us/search?term=${encodeURIComponent(artistName)}&types=artists&limit=1`,
                {
                  headers: {
                    'Authorization': `Bearer ${appleMusicDevToken}`
                  }
                }
              );

              if (!searchResult.ok) {
                console.log(`Apple Music search failed for ${artistName}: ${searchResult.status} ${searchResult.statusText}`);
                continue;
              }

              const responseText = await searchResult.text();
              if (!responseText || responseText.trim().length === 0) {
                console.log(`Apple Music returned empty response for ${artistName}`);
                continue;
              }

              let data;
              try {
                data = JSON.parse(responseText);
              } catch (parseError) {
                console.log(`Failed to parse Apple Music response for ${artistName}:`, responseText.substring(0, 200));
                continue;
              }

              if (data.results?.artists?.data?.[0]) {
                const artist = data.results.artists.data[0];

                // Apple Music doesn't provide popularity scores directly
                // But we can estimate from the artist's catalog URL presence and other signals
                let estimatedPopularity = null;

                // Try to get the artist's full details and top songs to estimate popularity
                try {
                  const artistId = artist.id;

                  // Fetch artist details and top songs in parallel
                  const [artistDetailResponse, topSongsResponse] = await Promise.all([
                    fetch(
                      `https://api.music.apple.com/v1/catalog/us/artists/${artistId}`,
                      {
                        headers: {
                          'Authorization': `Bearer ${appleMusicDevToken}`
                        }
                      }
                    ),
                    fetch(
                      `https://api.music.apple.com/v1/catalog/us/artists/${artistId}/view/top-songs`,
                      {
                        headers: {
                          'Authorization': `Bearer ${appleMusicDevToken}`
                        }
                      }
                    )
                  ]);

                  let popularityScore = 0;
                  let signals = [];
                  let hasEditorialNotes = false;

                  // Signal 1: Editorial notes (STRONGEST signal - Apple manually curates popular artists)
                  if (artistDetailResponse.ok) {
                    const artistDetail = await artistDetailResponse.json();
                    const artistData = artistDetail.data?.[0];

                    hasEditorialNotes = !!(artistData?.attributes?.editorialNotes?.standard || artistData?.attributes?.editorialNotes?.short);
                    if (hasEditorialNotes) {
                      signals.push('editorial');
                    }
                  }

                  // Signal 2: Number of top songs (secondary signal, can be misleading)
                  let topSongCount = 0;
                  if (topSongsResponse.ok) {
                    const topSongs = await topSongsResponse.json();
                    topSongCount = topSongs.data?.length || 0;
                    if (topSongCount > 0) {
                      signals.push(`${topSongCount}topSongs`);
                    }
                  }

                  // IMPORTANT: Editorial notes override top song count
                  // If no editorial notes, artist is likely indie/underground regardless of top songs
                  if (hasEditorialNotes) {
                    // Has editorial notes = Apple curated = mainstream/popular
                    if (topSongCount >= 10) {
                      estimatedPopularity = 75; // Very mainstream
                    } else if (topSongCount >= 5) {
                      estimatedPopularity = 65; // Mainstream
                    } else {
                      estimatedPopularity = 55; // Mid-tier
                    }
                  } else {
                    // No editorial notes = not curated by Apple = indie/underground
                    // Even with many "top songs", treat as indie if Apple hasn't curated them
                    if (topSongCount >= 10) {
                      estimatedPopularity = 35; // Indie with some traction
                    } else if (topSongCount >= 5) {
                      estimatedPopularity = 28; // Underground with recognition
                    } else {
                      estimatedPopularity = 22; // Pure indie/underground
                    }
                  }

                  console.log(`Apple Music heuristic for ${artist.attributes.name}: signals=[${signals.join(', ')}], estimated popularity=${estimatedPopularity}/100`);
                } catch (detailError) {
                  console.log(`Could not fetch artist details for popularity estimation: ${detailError.message}`);
                  // Default to indie if we can't determine
                  estimatedPopularity = 25;
                }

                artistInfo = {
                  name: artist.attributes.name,
                  genres: artist.attributes.genreNames || [],
                  popularity: estimatedPopularity
                };
              }
            } else {
              // Spotify
              const searchResult = await userSpotifyApi.searchArtists(artistName, { limit: 1 });
              if (searchResult.body.artists?.items?.[0]) {
                const artist = searchResult.body.artists.items[0];
                artistInfo = {
                  name: artist.name,
                  genres: artist.genres || [],
                  popularity: artist.popularity || null // 0-100 scale
                };
              }
            }

            if (artistInfo) {
              if (artistInfo.genres.length > 0) {
                console.log(`Found genres for ${artistInfo.name}: ${artistInfo.genres.join(', ')}`);
                artistGenres.push(...artistInfo.genres);
              }

              if (artistInfo.popularity !== null) {
                console.log(`Popularity for ${artistInfo.name}: ${artistInfo.popularity}/100`);
                artistPopularities.push(artistInfo.popularity);
              }

              if (artistInfo.genres.length === 0) {
                console.log(`No genres found for ${artistName}, will use Claude as fallback`);
              }
            }
          } catch (err) {
            console.log(`Failed to search for ${artistName}:`, err.message);
          }
        }

        // Infer popularity preference from requested artists (if not explicitly set by user)
        // Only infer if user hasn't already specified a popularity preference
        if (artistPopularities.length > 0 && !genreData.trackConstraints.popularity.preference) {
          const avgPopularity = artistPopularities.reduce((a, b) => a + b, 0) / artistPopularities.length;
          console.log(`Average popularity of requested artists: ${avgPopularity.toFixed(1)}/100`);

          // Determine preference based on average popularity
          // 0-40: underground/indie
          // 41-65: balanced/mid-tier
          // 66-100: mainstream
          if (avgPopularity <= 40) {
            genreData.trackConstraints.popularity.preference = 'underground';
            genreData.trackConstraints.popularity.max = 50; // Cap at 50 to avoid mainstream
            console.log('🎯 Auto-detected popularity preference: UNDERGROUND (requested artists have low popularity)');
          } else if (avgPopularity >= 66) {
            genreData.trackConstraints.popularity.preference = 'mainstream';
            genreData.trackConstraints.popularity.min = 60; // Set floor at 60 for mainstream
            console.log('🎯 Auto-detected popularity preference: MAINSTREAM (requested artists have high popularity)');
          } else {
            genreData.trackConstraints.popularity.preference = 'balanced';
            console.log('🎯 Auto-detected popularity preference: BALANCED (requested artists have mid-tier popularity)');
          }
        } else if (artistPopularities.length === 0) {
          console.log('⚠️  No popularity data available for requested artists, cannot infer popularity preference');
          console.log('    To get indie/underground artists, add "indie" or "underground" to your prompt');
        }

        // If we got genres from the platform, use Claude to analyze them
        // If we didn't get genres, let Claude make an educated guess (but log a warning)
        let claudePrompt;
        if (artistGenres.length > 0) {
          claudePrompt = `Based on these genres from music artists "${genreData.artistConstraints.requestedArtists.join(', ')}", determine the overall genre characteristics:

Platform genres found: ${[...new Set(artistGenres)].join(', ')}

Respond ONLY with valid JSON in this format:
{
  "primaryGenre": "the main genre these artists share",
  "subgenre": "specific subgenre if applicable",
  "keyCharacteristics": ["characteristic1", "characteristic2"],
  "style": "overall style description",
  "atmosphere": ["mood tag1", "mood tag2"],
  "audioFeatures": {
    "energy": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null },
    "valence": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null }
  }
}

Analyze the platform genres to identify the common thread and style.`;
        } else {
          console.log('⚠️  WARNING: No platform genres found, Claude will guess based on artist names (may be inaccurate)');
          claudePrompt = `Based on your knowledge of these music artists, what genre/style do they represent?

Artists: ${genreData.artistConstraints.requestedArtists.join(', ')}

IMPORTANT: If you are not confident about these specific artists, respond with "unknown" for primaryGenre.

Respond ONLY with valid JSON in this format:
{
  "primaryGenre": "the main genre these artists share, or 'unknown' if not confident",
  "subgenre": "specific subgenre if applicable or null",
  "keyCharacteristics": ["characteristic1", "characteristic2"] or [],
  "style": "overall style description or null",
  "atmosphere": ["mood tag1", "mood tag2"] or [],
  "audioFeatures": {
    "energy": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null },
    "valence": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null }
  }
}`;
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
        if (artistGenreData.audioFeatures) {
          if (artistGenreData.audioFeatures.energy && !genreData.audioFeatures.energy.min && !genreData.audioFeatures.energy.max) {
            genreData.audioFeatures.energy = artistGenreData.audioFeatures.energy;
          }
          if (artistGenreData.audioFeatures.valence && !genreData.audioFeatures.valence.min && !genreData.audioFeatures.valence.max) {
            genreData.audioFeatures.valence = artistGenreData.audioFeatures.valence;
          }
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
      const userPlaylistsArray = userPlaylists.get(userId) || [];
      existingPlaylistData = userPlaylistsArray.find(p => p.playlistId === playlistId);

      // If adding more songs to existing playlist, preserve original genre data (especially requestedArtists and popularity preference)
      if (existingPlaylistData && existingPlaylistData.genreData) {
        console.log('Reusing original genre data from existing playlist to maintain consistency');
        // Preserve requested artists from original prompt
        if (existingPlaylistData.genreData.artistConstraints?.requestedArtists) {
          genreData.artistConstraints.requestedArtists = existingPlaylistData.genreData.artistConstraints.requestedArtists;
          genreData.artistConstraints.exclusiveMode = existingPlaylistData.genreData.artistConstraints.exclusiveMode || false;
          console.log(`Preserved requested artists: ${genreData.artistConstraints.requestedArtists.join(', ')} (exclusive: ${genreData.artistConstraints.exclusiveMode})`);
        }
        // Preserve popularity preference (underground/mainstream/balanced)
        if (existingPlaylistData.genreData.trackConstraints?.popularity?.preference) {
          genreData.trackConstraints.popularity.preference = existingPlaylistData.genreData.trackConstraints.popularity.preference;
          genreData.trackConstraints.popularity.max = existingPlaylistData.genreData.trackConstraints.popularity.max;
          genreData.trackConstraints.popularity.min = existingPlaylistData.genreData.trackConstraints.popularity.min;
          console.log(`Preserved popularity preference: ${genreData.trackConstraints.popularity.preference}`);
        }
        // Preserve primary genre
        if (existingPlaylistData.genreData.primaryGenre) {
          genreData.primaryGenre = existingPlaylistData.genreData.primaryGenre;
          genreData.subgenre = existingPlaylistData.genreData.subgenre;
          console.log(`Preserved genre: ${genreData.primaryGenre} / ${genreData.subgenre}`);
        }
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

    // Strategy: Mine Spotify playlists to find similar artists at the same popularity level
    // This works better than APIs for underground/niche artists
    let playlistMinedTracks = [];
    let usePlaylistMining = false;
    let discoveredArtists = []; // Artists discovered from playlist mining to pass to Claude

    // Check if user wants underground/indie artists (either via specific artists OR via preference)
    // Note: must check for null/undefined before comparing, as null <= 50 is true in JS
    const wantsUnderground = genreData.trackConstraints.popularity.preference === 'underground' ||
                             (genreData.trackConstraints.popularity.max !== null &&
                              genreData.trackConstraints.popularity.max !== undefined &&
                              genreData.trackConstraints.popularity.max <= 50);
    const hasRequestedArtists = genreData.artistConstraints.requestedArtists &&
                                 genreData.artistConstraints.requestedArtists.length > 0;
    const isExclusiveArtistMode = genreData.artistConstraints.exclusiveMode === true || genreData.artistConstraints.exclusiveMode === 'true';
    console.log(`🎯 Exclusive artist mode: ${isExclusiveArtistMode}, hasRequestedArtists: ${hasRequestedArtists}, wantsUnderground: ${wantsUnderground}`);

    // Skip playlist mining if user wants ONLY songs from specific artists (exclusive mode)
    // Playlist mining finds similar artists, which is wrong for "only Justin Bieber" requests
    if ((hasRequestedArtists && !isExclusiveArtistMode) || wantsUnderground) {
      console.log(`🔍 Mining Spotify playlists for ${hasRequestedArtists ? 'similar artists' : 'underground ' + (genreData.primaryGenre || 'music')}...`);

      try {
        const token = await getSpotifyClientToken();
        const requestedArtists = genreData.artistConstraints.requestedArtists || [];
        const requestedLower = requestedArtists.map(a => a.toLowerCase());

        // Use Claude to generate dynamic search queries based on the user's prompt
        let searchQueries = [];

        try {
          console.log('🤖 Generating dynamic search queries with Claude...');
          const searchQueryResponse = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 500,
            messages: [{
              role: 'user',
              content: `Generate 5 Spotify playlist search queries to find playlists matching this request:

User prompt: "${prompt}"
${hasRequestedArtists ? `Mentioned artists: ${requestedArtists.join(', ')}` : ''}
${wantsUnderground ? 'User wants underground/indie artists' : ''}

Create search queries that would find curated Spotify playlists with songs matching this vibe.
Each query should be 2-4 words, optimized for Spotify's playlist search.

Return ONLY a JSON array of 5 search query strings, nothing else.
Example: ["chill r&b vibes", "late night soul", "mellow r&b 2024", "in your feels r&b", "slow jams playlist"]`
            }]
          });

          const queryText = searchQueryResponse.content[0].text.trim()
            .replace(/^```json\n?/, '').replace(/\n?```$/, '')
            .replace(/^```\n?/, '').replace(/\n?```$/, '');

          const parsedQueries = JSON.parse(queryText);
          if (Array.isArray(parsedQueries) && parsedQueries.length > 0) {
            searchQueries = parsedQueries.slice(0, 5);
            console.log(`✓ Claude generated queries: ${searchQueries.join(', ')}`);
          }
        } catch (queryError) {
          console.log('Failed to generate dynamic queries:', queryError.message);
        }

        // Fallback to basic queries if Claude failed
        if (searchQueries.length === 0) {
          const genreHint = genreData.primaryGenre || 'music';
          if (hasRequestedArtists) {
            searchQueries.push(`${requestedArtists[0]} mix`, `${genreHint} ${requestedArtists[0]}`);
          }
          if (wantsUnderground) {
            searchQueries.push(`underground ${genreHint}`, `indie ${genreHint}`);
          }
          if (genreData.atmosphere && genreData.atmosphere.length > 0) {
            searchQueries.push(`${genreData.atmosphere[0]} ${genreHint}`);
          }
          searchQueries.push(`best ${genreHint} playlist`, `${genreHint} vibes`);
          searchQueries = searchQueries.slice(0, 5);
        }

        console.log(`🔎 Search queries: ${searchQueries.join(', ')}`);

        const allPlaylistTracks = new Map(); // trackId -> {track, artist, songName}
        const artistSongCount = new Map(); // artist -> count of songs found
        let playlistsAccepted = 0;
        const maxPlaylistsToProcess = 5; // Limit to avoid long searches
        const minTracksNeeded = songCount * 3; // Get 3x the needed tracks for variety

        for (const query of searchQueries.slice(0, 5)) {
          // Early exit if we have enough tracks
          if (allPlaylistTracks.size >= minTracksNeeded && playlistsAccepted >= 3) {
            console.log(`✓ Have enough tracks (${allPlaylistTracks.size}), stopping search early`);
            break;
          }

          try {
            const playlistSearch = await axios.get('https://api.spotify.com/v1/search', {
              headers: { 'Authorization': `Bearer ${token}` },
              params: { q: query, type: 'playlist', limit: 5 }
            });

            for (const playlist of playlistSearch.data.playlists.items || []) {
              // Early exit if we have enough playlists
              if (playlistsAccepted >= maxPlaylistsToProcess) break;
              if (!playlist || playlist.tracks.total > 200 || playlist.tracks.total < 10) continue;

              // Skip playlists that are just the artist's name (likely their own playlist)
              const playlistNameLower = playlist.name.toLowerCase();
              const isArtistPlaylist = requestedLower.some(artist =>
                playlistNameLower === artist ||
                playlistNameLower === `${artist} radio` ||
                playlistNameLower.replace(/[^a-z0-9]/g, '') === artist.replace(/[^a-z0-9]/g, '')
              );
              if (isArtistPlaylist) {
                console.log(`⏭️ Skipping artist-owned playlist: "${playlist.name}"`);
                continue;
              }

              try {
                const tracksResponse = await axios.get(playlist.tracks.href + '?limit=100', {
                  headers: { 'Authorization': `Bearer ${token}` }
                });

                // Count unique artists in this playlist
                const playlistArtists = new Set();
                tracksResponse.data.items.forEach(item => {
                  if (item.track) playlistArtists.add(item.track.artists[0].name.toLowerCase());
                });

                // Only use playlists with multiple different artists (curated playlists)
                if (playlistArtists.size < 5) {
                  console.log(`⏭️ Skipping low-diversity playlist: "${playlist.name}" (only ${playlistArtists.size} artists)`);
                  continue;
                }

                // Check if this playlist contains any of our requested artists (if we have any)
                const hasRequestedArtist = hasRequestedArtists && tracksResponse.data.items.some(item =>
                  item.track && requestedArtists.some(ra =>
                    item.track.artists[0].name.toLowerCase().includes(ra.toLowerCase()) ||
                    ra.toLowerCase().includes(item.track.artists[0].name.toLowerCase())
                  )
                );

                // Accept playlist if:
                // 1. We have requested artists AND this playlist contains them, OR
                // 2. We're doing genre-based underground search (no specific artists) and this is a curated playlist
                const acceptPlaylist = hasRequestedArtist || (!hasRequestedArtists && wantsUnderground);

                if (acceptPlaylist) {
                  playlistsAccepted++;
                  console.log(`✓ Found curated playlist: "${playlist.name}" (${tracksResponse.data.items.length} tracks, ${playlistArtists.size} artists) [${playlistsAccepted}/${maxPlaylistsToProcess}]`);

                  // Add all tracks from this playlist
                  for (const item of tracksResponse.data.items) {
                    if (!item.track) continue;
                    const artistName = item.track.artists[0].name;
                    const trackId = item.track.id;

                    if (!allPlaylistTracks.has(trackId)) {
                      allPlaylistTracks.set(trackId, {
                        track: item.track.name,
                        artist: artistName,
                        spotifyId: trackId,
                        spotifyUri: item.track.uri,
                        spotifyTrack: item.track
                      });
                    }

                    artistSongCount.set(artistName, (artistSongCount.get(artistName) || 0) + 1);
                  }
                }
              } catch (e) {
                // Skip playlists we can't access
              }
            }
          } catch (e) {
            console.log('Playlist search error:', e.message);
          }
        }

        // Filter and prepare tracks
        if (allPlaylistTracks.size > 0) {
          // Get unique artists discovered (excluding the requested ones if any)
          discoveredArtists = Array.from(artistSongCount.keys())
            .filter(a => requestedLower.length === 0 || !requestedLower.some(r => a.toLowerCase().includes(r) || r.includes(a.toLowerCase())))
            .slice(0, 30);

          console.log(`🎵 Discovered ${discoveredArtists.length} similar artists from playlist mining`);
          console.log('Sample artists:', discoveredArtists.slice(0, 10).join(', '));

          // Only use playlist mining if we found enough diverse artists
          if (discoveredArtists.length >= 10) {
            // Convert to array and shuffle
            playlistMinedTracks = Array.from(allPlaylistTracks.values());

            // Shuffle the tracks
            for (let i = playlistMinedTracks.length - 1; i > 0; i--) {
              const j = Math.floor(Math.random() * (i + 1));
              [playlistMinedTracks[i], playlistMinedTracks[j]] = [playlistMinedTracks[j], playlistMinedTracks[i]];
            }

            console.log(`✨ Playlist mining found ${playlistMinedTracks.length} potential tracks from ${discoveredArtists.length} artists`);

            if (playlistMinedTracks.length >= songCount) {
              usePlaylistMining = true;
            }
          } else {
            console.log(`⚠️ Not enough artist diversity (${discoveredArtists.length} artists), falling back to Claude...`);
          }
        }
      } catch (error) {
        console.log('Playlist mining failed:', error.message);
      }
    }

    // Variables for playlist metadata
    var claudePlaylistName = null;
    var claudePlaylistDescription = null;

    // If using playlist mining, generate a playlist name with Claude
    if (usePlaylistMining) {
      try {
        const nameResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 200,
          messages: [{
            role: 'user',
            content: `Generate a creative playlist name and short description for a playlist based on this request: "${prompt}"

Genre: ${genreData.primaryGenre || 'mixed'}
Artists mentioned: ${genreData.artistConstraints.requestedArtists.join(', ') || 'various'}

Return ONLY valid JSON in this format:
{"playlistName": "Creative Name", "description": "Brief description"}`
          }]
        });

        const nameText = nameResponse.content[0].text.trim()
          .replace(/^```json\n?/, '').replace(/\n?```$/, '');
        const nameData = JSON.parse(nameText);
        claudePlaylistName = nameData.playlistName;
        claudePlaylistDescription = nameData.description;
        console.log('Playlist name:', claudePlaylistName);
      } catch (error) {
        // Fallback name
        claudePlaylistName = `${genreData.primaryGenre || 'Mixed'} Vibes`;
        claudePlaylistDescription = hasRequestedArtists
          ? `Songs similar to ${genreData.artistConstraints.requestedArtists.join(', ')}`
          : `Underground ${genreData.primaryGenre || 'music'} picks`;
      }
    }

    // Step 2: Use Claude to recommend specific songs (fallback or if no seed artists)
    let claudeRecommendedTracks = [];

    if (!usePlaylistMining) {
      console.log('🎵 Requesting song recommendations from Claude...');

      try {
        const songRecommendationResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 4000,
          messages: [{
            role: 'user',
            content: `You are a music expert with deep knowledge of songs across all genres and eras.

User's playlist request: "${prompt}"

${genreData.artistConstraints.requestedArtists.length > 0 ? `The user mentioned these artists: ${genreData.artistConstraints.requestedArtists.join(', ')}

Your primary goal is to match the SOUND and VIBE of these artists. Find songs that sound similar in terms of:
- Musical style and production
- Mood and atmosphere
- Vocal style and delivery
- Overall feel and energy

CRITICAL: Match the POPULARITY LEVEL of the requested artists. If they mention underground/indie artists, recommend OTHER underground/indie artists - NOT mainstream stars. If the requested artists are lesser-known (not chart-topping hits), find similar lesser-known artists in the same niche/scene.

Examples of what NOT to do:
- If user requests indie R&B artists → Do NOT recommend SZA, H.E.R., Daniel Caesar, Miguel, Jhené Aiko, Kehlani (too mainstream)
- If user requests underground hip-hop → Do NOT recommend Drake, Kendrick Lamar, J. Cole (too mainstream)
- If user requests indie rock → Do NOT recommend Coldplay, Imagine Dragons, The Killers (too mainstream)

Instead, dig deep into that specific scene/subgenre and find artists at a similar level of recognition.` : ''}

${existingPlaylistData && genreData.artistConstraints.requestedArtists.length > 0 ? `⚠️ REFINEMENT CONTEXT: This is a refinement of an existing playlist. The requested artists below were from the ORIGINAL prompt and should STILL be included, even if the refinement message seems to minimize them.` : ''}
${newArtistsOnly ? 'IMPORTANT: The user wants to discover NEW artists they have never listened to before. Focus on emerging, indie, underground, or lesser-known artists.' : ''}
${userFeedbackContext}

MUSIC PREFERENCES ANALYSIS:
Genre & Style:
- Primary genre: ${genreData.primaryGenre || 'not specified'}
- Subgenre: ${genreData.subgenre || 'not specified'}
- Secondary genres: ${genreData.secondaryGenres.join(', ') || 'none'}
- Key characteristics: ${genreData.keyCharacteristics.join(', ') || 'not specified'}
- Style: ${genreData.style || 'not specified'}

Vibe & Atmosphere:
- Atmosphere: ${genreData.atmosphere.join(', ') || 'not specified'}
- Use case: ${genreData.contextClues.useCase || 'not specified'}
- Avoid: ${genreData.contextClues.avoidances.join(', ') || 'nothing specified'}

Audio Characteristics:
- BPM range: ${genreData.audioFeatures.bpm.min || genreData.audioFeatures.bpm.max ? `${genreData.audioFeatures.bpm.min || 'any'}-${genreData.audioFeatures.bpm.max || 'any'}` : 'not specified'}
- Energy level: ${genreData.audioFeatures.energy.min !== null || genreData.audioFeatures.energy.max !== null ? `${genreData.audioFeatures.energy.min || 0.0}-${genreData.audioFeatures.energy.max || 1.0}` : 'not specified'}
- Danceability: ${genreData.audioFeatures.danceability.min !== null || genreData.audioFeatures.danceability.max !== null ? `${genreData.audioFeatures.danceability.min || 0.0}-${genreData.audioFeatures.danceability.max || 1.0}` : 'not specified'}
- Valence (mood): ${genreData.audioFeatures.valence.min !== null || genreData.audioFeatures.valence.max !== null ? `${genreData.audioFeatures.valence.min || 0.0}-${genreData.audioFeatures.valence.max || 1.0}` : 'not specified'}

Era & Cultural Context:
- Decade: ${genreData.era.decade || 'not specified'}
- Year range: ${genreData.era.yearRange.min || genreData.era.yearRange.max ? `${genreData.era.yearRange.min || 'any'} to ${genreData.era.yearRange.max || 'any'}` : 'not specified'}
- Cultural region: ${genreData.culturalContext.region || 'not specified'}
- Movement: ${genreData.culturalContext.movement || 'not specified'}

Requested Artists:
${genreData.artistConstraints.requestedArtists && genreData.artistConstraints.requestedArtists.length > 0
  ? `- Artists: ${genreData.artistConstraints.requestedArtists.join(', ')}
- EXCLUSIVE MODE: ${genreData.artistConstraints.exclusiveMode ? 'YES - User wants ONLY these artists, NO other artists' : 'NO - Include these artists + similar vibe artists'}
${genreData.artistConstraints.exclusiveMode
  ? `- ALL ${songCount} songs must be from: ${genreData.artistConstraints.requestedArtists.join(', ')}`
  : `- Include ~${Math.min(8, Math.floor(songCount * 0.25))} songs from: ${genreData.artistConstraints.requestedArtists.join(', ')}
- Include ~${songCount - Math.min(8, Math.floor(songCount * 0.25))} songs from similar artists with the same vibe`}`
  : '- No specific artists requested - choose songs that match the vibe and genre'}

Popularity Preference: ${genreData.trackConstraints.popularity.preference === 'underground'
  ? `PREFER UNDERGROUND/INDIE - Try to include lesser-known artists when possible, but prioritize matching the sound/vibe first.`
  : genreData.trackConstraints.popularity.preference === 'mainstream'
    ? `MAINSTREAM - Focus on popular, well-known artists.`
    : genreData.trackConstraints.popularity.preference === 'balanced'
      ? `BALANCED - Include a mix of well-known and lesser-known artists.`
      : 'No specific popularity preference.'}

YOUR TASK:
Recommend ${Math.ceil(songCount * 2)} specific songs that match this request (we ask for extra because some may not be found on the streaming platform). Use your music knowledge to select tracks that fit the genre, vibe, atmosphere, and preferences described above.

${!allowExplicit ? 'IMPORTANT: Only recommend clean/non-explicit songs.' : ''}

CRITICAL REQUIREMENTS:
1. Return ${Math.ceil(songCount * 2)} songs (we request extra because some may not be found on the platform)
2. Each song must include: EXACT track name and EXACT artist name as it appears on streaming platforms
3. EVERY song must match the SOUND and VIBE of the request - this is the most important requirement
4. ${genreData.artistConstraints.exclusiveMode
  ? `EXCLUSIVE MODE: ALL songs MUST be from ${genreData.artistConstraints.requestedArtists.join(' or ')}. Do NOT include any other artists. Include their biggest hits, deep cuts, features, and collaborations.`
  : 'If requested artists are specified, include some songs from them and find similar-sounding artists'}
5. ${genreData.artistConstraints.exclusiveMode
  ? `Include a variety of songs from the artist(s): hits, album tracks, features where they are credited, and collaborations.`
  : '**ARTIST DIVERSITY IS CRITICAL**: Maximum 2-3 songs per artist. Spread recommendations across at least 20 different artists. Do NOT recommend 10+ songs from a single artist.'}
6. ONLY recommend songs you are CERTAIN exist on Apple Music and Spotify - do NOT make up or guess song titles
7. ${genreData.artistConstraints.exclusiveMode
  ? 'For features/collabs, include songs where the requested artist is either the main artist OR a featured artist.'
  : 'SELF-CHECK: Before finalizing, verify you have at least 20 different artists. If not, replace duplicate artists with new ones.'}

Return ONLY valid JSON in this exact format:
{
  "playlistName": "Creative playlist name based on the prompt",
  "description": "Brief description of the playlist vibe",
  "songs": [
    {"track": "Song Name", "artist": "Artist Name"},
    {"track": "Song Name", "artist": "Artist Name"}
  ]
}

DO NOT include any text outside the JSON.`
        }]
      });

      const songRecommendationText = songRecommendationResponse.content[0].text.trim()
        .replace(/^```json\n?/, '').replace(/\n?```$/, '')
        .replace(/^```\n?/, '').replace(/\n?```$/, '');

      const songRecommendationData = JSON.parse(songRecommendationText);
      claudeRecommendedTracks = songRecommendationData.songs || [];

      console.log(`✨ Claude recommended ${claudeRecommendedTracks.length} songs`);
      console.log('Playlist name:', songRecommendationData.playlistName);
      console.log('Playlist description:', songRecommendationData.description);

      // Store playlist name and description for later use
      claudePlaylistName = songRecommendationData.playlistName;
      claudePlaylistDescription = songRecommendationData.description;

    } catch (error) {
      console.log('Failed to get song recommendations from Claude:', error.message);
      console.log('Falling back to traditional search query approach...');
    }
    } // End of if (!usePlaylistMining)

    // Combine recommendations - prefer playlist mining if available
    let recommendedTracks = usePlaylistMining ? playlistMinedTracks : claudeRecommendedTracks;

    // OPTIMIZATION: For playlist mining, run sanity check BEFORE fetching from Spotify/Apple
    // This avoids fetching 100+ tracks only to filter down to 30
    if (usePlaylistMining && recommendedTracks.length > songCount * 2) {
      console.log(`🔍 Pre-filtering ${recommendedTracks.length} mined tracks before API calls...`);

      const hasAvoidances = genreData.contextClues.avoidances && genreData.contextClues.avoidances.length > 0;
      // Note: must check for null/undefined before comparing, as null <= 50 is true in JS
      const wantsUndergroundFilter = genreData.trackConstraints.popularity.preference === 'underground' ||
                                      (genreData.trackConstraints.popularity.max !== null &&
                                       genreData.trackConstraints.popularity.max !== undefined &&
                                       genreData.trackConstraints.popularity.max <= 50);

      if (genreData.primaryGenre || hasAvoidances || wantsUndergroundFilter) {
        try {
          // Take a sample for the sanity check (max 80 to keep prompt size reasonable)
          const sampleTracks = recommendedTracks.slice(0, 80);

          const preFilterResponse = await anthropic.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 1500,
            messages: [{
              role: 'user',
              content: `Quick filter: Remove songs that don't match the request.

Original request: "${prompt}"
Genre: ${genreData.primaryGenre || 'not specified'}
${hasAvoidances ? `User explicitly wants to AVOID: ${genreData.contextClues.avoidances.join(', ')}` : ''}
${wantsUndergroundFilter ? `Popularity preference: UNDERGROUND/INDIE - strictly remove mainstream artists` : ''}

Songs:
${sampleTracks.map((t, i) => `${i + 1}. "${t.track}" by ${t.artist}`).join('\n')}

Return ONLY a JSON array of indices to KEEP.

Remove songs where:
- The artist/song clearly doesn't fit the GENRE or SOUND requested
${hasAvoidances ? `- The song matches what the user wants to AVOID (${genreData.contextClues.avoidances.join(', ')})` : ''}
${wantsUndergroundFilter ? `- The artist is MAINSTREAM (has chart hits, millions of streams, major label, radio play). Examples to REMOVE: SZA, Miguel, Khalid, Daniel Caesar, H.E.R., Summer Walker, Brent Faiyaz, Drake, The Weeknd, Jhené Aiko, Kehlani, Frank Ocean, Chris Brown, Usher, Ella Mai, Snoh Aalegra, Jorja Smith, etc.` : ''}

Be lenient on genre matching, but strict on ${wantsUndergroundFilter ? 'removing mainstream artists and ' : ''}the user's explicit avoidances.

Example response: [1, 2, 3, 4, 5, 6, 7, 8, ...]`
            }]
          });

          const preFilterContent = preFilterResponse.content[0].text.trim()
            .replace(/^```json\n?/, '').replace(/\n?```$/, '')
            .replace(/^```\n?/, '').replace(/\n?```$/, '');

          const keepMatch = preFilterContent.match(/\[([\d,\s]*)\]/);
          if (keepMatch) {
            const keepIndices = JSON.parse(keepMatch[0]);
            const filteredTracks = keepIndices
              .map(idx => sampleTracks[idx - 1])
              .filter(t => t !== undefined);

            if (filteredTracks.length >= songCount) {
              const removed = sampleTracks.length - filteredTracks.length;
              console.log(`✂️ Pre-filter removed ${removed} mismatched tracks, ${filteredTracks.length} remaining`);
              recommendedTracks = filteredTracks;
            } else {
              console.log(`⚠️ Pre-filter would leave only ${filteredTracks.length} tracks, keeping original ${sampleTracks.length}`);
              recommendedTracks = sampleTracks;
            }
          }
        } catch (error) {
          console.log('Pre-filter failed, continuing with all tracks:', error.message);
          // Limit to first 80 anyway to avoid too many API calls
          recommendedTracks = recommendedTracks.slice(0, 80);
        }
      }
    }

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

    // If we have recommendations (from Spotify or Claude), search for those specific songs
    if (recommendedTracks.length > 0) {
      console.log(`🔍 Searching ${platform} for ${recommendedTracks.length} ${usePlaylistMining ? 'playlist-mined' : 'Claude'}-recommended songs...`);

      if (platform === 'spotify') {
        // For Spotify users with playlist mining, we already have full track data
        if (usePlaylistMining) {
          // Get track IDs from playlist mining recommendations
          const minedTrackIds = recommendedTracks
            .filter(t => t.spotifyId)
            .map(t => t.spotifyId);

          console.log(`🎯 Fetching ${minedTrackIds.length} tracks from Spotify by ID...`);

          // Fetch tracks in batches of 50 (Spotify API limit)
          const batchSize = 50;
          for (let i = 0; i < minedTrackIds.length; i += batchSize) {
            const batchIds = minedTrackIds.slice(i, i + batchSize);

            try {
              const tracksResponse = await userSpotifyApi.getTracks(batchIds);
              const tracks = tracksResponse.body.tracks.filter(t => t !== null);

              for (const track of tracks) {
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
                    console.log(`Skipping duplicate song: "${track.name}" by ${track.artists[0].name}`);
                    continue;
                  }
                }

                seenTrackIds.add(track.id);
                seenSongSignatures.set(songSignature, track.name);

                allTracks.push({
                  id: track.id,
                  name: track.name,
                  uri: track.uri,
                  artists: track.artists,
                  album: track.album,
                  duration_ms: track.duration_ms,
                  preview_url: track.preview_url,
                  platform: 'spotify',
                  explicit: track.explicit,
                  artist: track.artists[0]?.name || 'Unknown'
                });

                console.log(`✓ Found: "${track.name}" by ${track.artists[0].name}`);
              }
            } catch (error) {
              console.log(`✗ Error fetching batch of tracks: ${error.message}`);
            }
          }
        } else {
          // For Claude recommendations, search Spotify
          for (const recommendedSong of recommendedTracks) {
          try {
            const searchQuery = `track:${recommendedSong.track} artist:${recommendedSong.artist}`;
            const searchPromise = userSpotifyApi.searchTracks(searchQuery, { limit: 5 });
            const searchResult = await Promise.race([
              searchPromise,
              new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), 5000))
            ]);
            const tracks = searchResult.body.tracks.items;

            if (tracks.length > 0) {
              // Take the best match (first result)
              const track = tracks[0];

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

              seenTrackIds.add(track.id);
              seenSongSignatures.set(songSignature, track.name);
              // Normalize track format to have 'artist' property for consistency
              allTracks.push({
                ...track,
                artist: track.artists?.[0]?.name || track.artist || 'Unknown Artist'
              });
              console.log(`✓ Found: "${track.name}" by ${track.artists?.[0]?.name || track.artist}`);
            } else {
              console.log(`✗ Could not find: "${recommendedSong.track}" by ${recommendedSong.artist}`);
            }
          } catch (error) {
            console.log(`Error searching for "${recommendedSong.track}": ${error.message}`);
          }
        }
        } // End of else (Claude recommendations for Spotify)
      } else if (platform === 'apple') {
        // For Apple Music users, search Apple Music for recommended songs
        const platformService = new PlatformService();
        const storefront = tokens.storefront || 'us';

        for (const recommendedSong of recommendedTracks) {
          try {
            const searchQuery = `${recommendedSong.track} ${recommendedSong.artist}`;
            const tracks = await platformService.searchTracks(platformUserId, searchQuery, tokens, storefront, 5);

            if (tracks.length > 0) {
              // Take the best match (first result)
              const track = tracks[0];

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

              seenTrackIds.add(track.id);
              seenSongSignatures.set(songSignature, track.name);
              // Normalize track format to have 'artist' property for consistency
              allTracks.push({
                ...track,
                artist: track.artists?.[0]?.name || track.artist || 'Unknown Artist'
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

      console.log(`📊 Successfully found ${allTracks.length} out of ${recommendedTracks.length} ${usePlaylistMining ? 'playlist-mined' : 'Claude'}-recommended songs`);

      // Quick sanity check - remove obvious mismatches (e.g., Lil Baby in an underground R&B playlist)
      // For playlist mining, we already did pre-filtering so just return the results
      if (usePlaylistMining && allTracks.length >= 5) {
        const selectedTracks = allTracks.slice(0, songCount);
        console.log(`🎯 Returning ${selectedTracks.length} playlist-mined tracks (pre-filtered)`);

        res.json({
          playlistName: claudePlaylistName,
          description: claudePlaylistDescription,
          tracks: selectedTracks,
          trackCount: selectedTracks.length
        });
        return; // Done
      }

      // For non-playlist-mining (Claude recommendations), run sanity check
      if (allTracks.length >= 5 && !usePlaylistMining) {
        let selectedTracks = [...allTracks]; // Pass ALL tracks to sanity check, slice after filtering

        // Run quick filter if we have genre, explicit avoidances, or underground preference
        const hasAvoidances = genreData.contextClues.avoidances && genreData.contextClues.avoidances.length > 0;
        // Note: must check for null/undefined before comparing, as null <= 50 is true in JS
        const wantsUndergroundFilter = genreData.trackConstraints.popularity.preference === 'underground' ||
                                        (genreData.trackConstraints.popularity.max !== null &&
                                         genreData.trackConstraints.popularity.max !== undefined &&
                                         genreData.trackConstraints.popularity.max <= 50);
        if (genreData.primaryGenre || hasAvoidances || wantsUndergroundFilter) {
          console.log(`🔍 Running quick sanity check on ${selectedTracks.length} tracks...`);

          try {
            const sanityCheckResponse = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1000,
              messages: [{
                role: 'user',
                content: `Quick filter: Remove songs that don't match the request.

Original request: "${prompt}"
Genre: ${genreData.primaryGenre || 'not specified'}
${hasAvoidances ? `User explicitly wants to AVOID: ${genreData.contextClues.avoidances.join(', ')}` : ''}
${wantsUndergroundFilter ? `Popularity preference: UNDERGROUND/INDIE - strictly remove mainstream artists` : ''}

Songs:
${selectedTracks.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist}`).join('\n')}

Return ONLY a JSON array of indices to KEEP.

Remove songs where:
- The artist/song clearly doesn't fit the GENRE or SOUND requested
${hasAvoidances ? `- The song matches what the user wants to AVOID (${genreData.contextClues.avoidances.join(', ')})` : ''}
${wantsUndergroundFilter ? `- The artist is MAINSTREAM (has chart hits, millions of streams, major label, radio play). Examples to REMOVE: SZA, Miguel, Khalid, Daniel Caesar, H.E.R., Summer Walker, Brent Faiyaz, Drake, The Weeknd, Jhené Aiko, Kehlani, Frank Ocean, Chris Brown, Usher, Ella Mai, Snoh Aalegra, Jorja Smith, etc.` : ''}

Be lenient on genre matching, but strict on ${wantsUndergroundFilter ? 'removing mainstream artists and ' : ''}the user's explicit avoidances.

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

        res.json({
          playlistName: claudePlaylistName,
          description: claudePlaylistDescription,
          tracks: selectedTracks,
          trackCount: selectedTracks.length
        });
        return; // Done
      }
    }

    // Fallback: Only if Claude recommendations failed or found less than 5 songs on the platform
    let needsFallback = allTracks.length < 5;

    if (needsFallback || claudeRecommendedTracks.length === 0) {
      console.log(`🔄 Fallback: Claude found only ${allTracks.length} songs on platform, using search queries...`);

      // Step 3: Use Claude to generate search queries (fallback)
    const aiResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2000,
      messages: [{
        role: 'user',
        content: `You are a music expert assistant. Based on the following user prompt for a playlist, generate a JSON response with:
1. A creative playlist name
2. A playlist description
3. 15-20 diverse search queries to find songs that match the prompt

User prompt: "${prompt}"
${existingPlaylistData && genreData.artistConstraints.requestedArtists.length > 0 ? `\n⚠️ REFINEMENT CONTEXT: This is a refinement of an existing playlist. The requested artists below were from the ORIGINAL prompt and should STILL be prioritized in search queries, even if the refinement message seems to minimize them. The user still wants these artists included, they're just adjusting the balance.` : ''}
${newArtistsOnly ? '\nIMPORTANT: The user wants to discover NEW artists they have never listened to before. Focus on emerging, indie, underground, or lesser-known artists in your search queries.' : ''}${userFeedbackContext}

IMPORTANT GUIDELINES - Genre & Style:
- Primary genre: ${genreData.primaryGenre || 'not specified'}
- Subgenre: ${genreData.subgenre || 'not specified'} ${genreData.subgenre ? '← BE VERY SPECIFIC TO THIS SUBGENRE' : ''}
- Secondary genres: ${genreData.secondaryGenres.join(', ') || 'none'}
- Key characteristics: ${genreData.keyCharacteristics.join(', ') || 'not specified'}
- Style: ${genreData.style || 'not specified'}

VIBE & ATMOSPHERE:
- Atmosphere tags: ${genreData.atmosphere.join(', ') || 'not specified'}
- Use case: ${genreData.contextClues.useCase || 'not specified'} ${genreData.contextClues.useCase ? '← CRITICAL: Tailor queries to this use case' : ''}
- Avoid: ${genreData.contextClues.avoidances.join(', ') || 'nothing specified'}

AUDIO CHARACTERISTICS (VERY IMPORTANT):
- BPM range: ${genreData.audioFeatures.bpm.min || genreData.audioFeatures.bpm.max ? `${genreData.audioFeatures.bpm.min || 'any'}-${genreData.audioFeatures.bpm.max || 'any'}` : 'not specified'}${genreData.audioFeatures.bpm.min && genreData.audioFeatures.bpm.min < 95 ? ' ← SLOW TEMPO REQUIRED' : ''}
- Energy level: ${genreData.audioFeatures.energy.min !== null || genreData.audioFeatures.energy.max !== null ? `${genreData.audioFeatures.energy.min || 0.0}-${genreData.audioFeatures.energy.max || 1.0}` : 'not specified'}${genreData.audioFeatures.energy.max && genreData.audioFeatures.energy.max < 0.5 ? ' ← LOW ENERGY/MELLOW REQUIRED' : ''}
- Danceability: ${genreData.audioFeatures.danceability.min !== null || genreData.audioFeatures.danceability.max !== null ? `${genreData.audioFeatures.danceability.min || 0.0}-${genreData.audioFeatures.danceability.max || 1.0}` : 'not specified'}
- Valence (mood): ${genreData.audioFeatures.valence.min !== null || genreData.audioFeatures.valence.max !== null ? `${genreData.audioFeatures.valence.min || 0.0}-${genreData.audioFeatures.valence.max || 1.0}` : 'not specified'}${genreData.audioFeatures.valence.max && genreData.audioFeatures.valence.max < 0.6 ? ' ← MOODY/EMOTIONAL VIBE' : ''}

ERA & CULTURAL CONTEXT:
- Decade: ${genreData.era.decade || 'not specified'} ${genreData.era.decade ? '← MUST stick to this era' : ''}
- Year range: ${genreData.era.yearRange.min || genreData.era.yearRange.max ? `${genreData.era.yearRange.min || 'any'} to ${genreData.era.yearRange.max || 'any'}` : 'not specified'}
- Era descriptors: ${genreData.era.descriptors.join(', ') || 'none'}
- Cultural region: ${genreData.culturalContext.region || 'not specified'} ${genreData.culturalContext.region ? '← Include region-specific queries' : ''}
- Movement: ${genreData.culturalContext.movement || 'not specified'}
- Scene: ${genreData.culturalContext.scene || 'not specified'}

REQUESTED ARTISTS:
${genreData.artistConstraints.requestedArtists && genreData.artistConstraints.requestedArtists.length > 0
  ? `- User specifically requested: ${genreData.artistConstraints.requestedArtists.join(', ')}
- EXCLUSIVE MODE: ${genreData.artistConstraints.exclusiveMode ? 'YES - User wants ONLY these artists, NO similar artists' : 'NO - Mix of these artists + similar vibe artists'}
${genreData.artistConstraints.exclusiveMode
  ? `- CRITICAL: ALL queries must be for the requested artists ONLY
- Include at least 3-4 queries per artist (just name, with genre, with mood descriptors, deep cuts)
- DO NOT include "similar to" or "artists like" queries
- Examples: "${genreData.artistConstraints.requestedArtists[0]}", "${genreData.artistConstraints.requestedArtists[0]} ${genreData.primaryGenre || ''}", "${genreData.artistConstraints.requestedArtists[0]} deep cuts"`
  : `- IMPORTANT: These artists are REFERENCE POINTS to establish the vibe, NOT the main content
- Include ONLY 1 query per requested artist: JUST the artist name (e.g., "Daniel J", "A.I DELLY", "Roe Xander")
- DO NOT create multiple queries per artist (no "Daniel J R&B", "Daniel J mellow", etc.)
- POPULARITY TARGETING: ${genreData.trackConstraints.popularity.preference === 'underground'
    ? `The requested artists are INDIE/UNDERGROUND (low popularity). Include terms like "indie", "underground", "emerging", "lesser-known", "hidden gems" in queries. AVOID mainstream artist names.`
    : genreData.trackConstraints.popularity.preference === 'mainstream'
    ? `The requested artists are MAINSTREAM (high popularity). Focus on well-known artists and popular tracks. Include artist names like those in the top charts.`
    : `The requested artists have MID-TIER popularity. Include a balanced mix of known and emerging artists.`}
- MAJORITY of your 15-20 queries (at least 12-15) must be:
  * Genre + vibe searches: "${genreData.trackConstraints.popularity.preference === 'underground' ? 'indie ' : ''}${genreData.primaryGenre || 'underground'} ${genreData.keyCharacteristics.join(' ') || 'chill mellow'}", "${genreData.trackConstraints.popularity.preference === 'underground' ? 'underground ' : ''}${genreData.primaryGenre || 'alternative'}", "${genreData.style || 'smooth'} ${genreData.primaryGenre || ''} ballads"
  * "Similar to [artist]" searches MUST include genre constraint: "${genreData.primaryGenre || ''} similar to [artist]", "${genreData.primaryGenre || ''} artists like [artist]"
  * Scene/style searches: "${genreData.trackConstraints.popularity.preference === 'underground' ? 'underground ' : ''}${genreData.primaryGenre || ''}", "${genreData.trackConstraints.popularity.preference === 'underground' ? 'indie ' : ''}${genreData.secondaryGenres.join(' ') || 'soul'}", "${genreData.trackConstraints.popularity.preference === 'underground' ? 'alternative ' : ''}${genreData.primaryGenre || ''} artists"
- CRITICAL: ALL genre/vibe searches MUST include the primary genre "${genreData.primaryGenre || ''}" to prevent genre drift
- CRITICAL: Final playlist should contain roughly 5-8 tracks from requested artists, 22-25 tracks from similar artists WITHIN THE SAME GENRE`}`
  : '- No specific artists requested'}

SEARCH QUERY REQUIREMENTS:
- If EXCLUSIVE MODE is enabled, 100% of queries must be for the requested artists ONLY (no genre-only or similar artist queries)
- If SPECIFIC ARTISTS are requested (non-exclusive), treat them as REFERENCE POINTS for the vibe:
  * STRICT LIMIT: Only 1 query per requested artist (just their name, nothing else)
  * MAJORITY (12-15 out of 15-20 queries) must focus on discovering OTHER similar artists
  * Use "similar to [artist]", "artists like [artist]", and genre/vibe searches
  * Example for "artists like Daniel J, A.I DELLY":
    - 2 queries: "Daniel J", "A.I DELLY"
    - 13-18 queries: "similar to Daniel J", "underground R&B chill", "indie alternative R&B", etc.
  * GOAL: 5-8 tracks from requested artists, 22-25 tracks discovering NEW similar artists
- For GENRE-SPECIFIC playlists (without exclusive artist mode), include at least 8 genre-specific queries (e.g., for R&B: "R&B singles", "contemporary R&B", "soulful R&B artists")
- If SUBGENRE is specified, ALL queries must target that specific subgenre (e.g., "90s R&B" not just "R&B")
- If DECADE/ERA is specified, add year filters to queries (e.g., "year:1990-1999") or mention the era
- If CULTURAL REGION is specified, include region-specific artists/styles (e.g., "West Coast hip-hop", "UK grime")
- If USE CASE is specified, tailor queries to that context (e.g., "focus" = chill/ambient versions, "workout" = high-energy)
- If AUDIO CHARACTERISTICS are specified (slow BPM, low energy, moody valence):
  * For SLOW/MELLOW vibes: Use terms like "slow jam", "ballad", "mellow", "smooth", "laid-back", "downtempo" in queries
  * For MOODY/EMOTIONAL vibes: Use terms like "emotional", "intimate", "soulful", "deep", "introspective" in queries
  * For LOW ENERGY: AVOID terms like "upbeat", "energetic", "party", "dance", "club", "hype" in queries
  * Example: Instead of "R&B songs", use "slow R&B ballads" or "mellow R&B" if slow/low energy is required
- Mix specific artist searches with broader genre/era/region searches
- AVOID queries that would return songs from different genres, eras, or regions
- AVOID vague emotional queries alone - always ground them in genre/style/era

Respond ONLY with valid JSON in this exact format:
{
  "playlistName": "Creative playlist name here",
  "description": "Brief description of the playlist",
  "searchQueries": ["query1", "query2", "query3", ...]
}

DO NOT include any text outside the JSON. Make the search queries specific and diverse to get great variety.`
      }]
    });
    
      // Parse AI response (fallback)
      let aiData;
      try {
        const responseText = aiResponse.content[0].text.trim();
        aiData = JSON.parse(responseText);

        // Override playlist name/description if we don't have Claude's version
        if (!claudePlaylistName) {
          claudePlaylistName = aiData.playlistName;
          claudePlaylistDescription = aiData.description;
        }
      } catch (parseError) {
        console.error('Failed to parse AI response:', aiResponse.content[0].text);
        return res.status(500).json({ error: 'Failed to parse AI response' });
      }

      console.log('Fallback: AI generated search queries:', JSON.stringify(aiData.searchQueries, null, 2));

      // Execute fallback search queries
      if (platform === 'spotify') {
      // Calculate search limit based on requested song count
      // More songs requested = need more tracks per query to account for duplicates/filtering
      const searchLimit = Math.min(
        Math.max(5, Math.ceil(songCount / 2)), // At least 5, scales with song count
        15 // Max 15 to avoid rate limiting
      );
      console.log(`Using search limit of ${searchLimit} tracks per query (requested ${songCount} songs)`);

      for (const query of aiData.searchQueries) {
        try {
          const searchPromise = userSpotifyApi.searchTracks(query, { limit: searchLimit });
          const searchResult = await Promise.race([
            searchPromise,
            new Promise((_, reject) => setTimeout(() => reject(new Error('Search timeout')), 5000))
          ]);
          const tracks = searchResult.body.tracks.items;

          // Add tracks, filtering out duplicates and explicit content if needed
          for (const track of tracks) {
            if (!seenTrackIds.has(track.id)) {
              // Skip tracks that are already in the playlist (for replace mode)
              if (excludeTrackIds.has(track.id)) {
                console.log(`Skipping "${track.name}" by ${track.artists[0].name} (already in playlist)`);
                continue;
              }

              // Filter explicit content if user doesn't allow it
              if (!allowExplicit && track.explicit) {
                continue;
              }

              // Filter out tracks from known artists if newArtistsOnly is enabled
              if (newArtistsOnly && knownArtists.size > 0) {
                const trackArtist = track.artists[0].name.toLowerCase();
                if (knownArtists.has(trackArtist)) {
                  console.log(`Skipping "${track.name}" by ${track.artists[0].name} (known artist)`);
                  continue;
                }
              }

              // Create a signature for the song (artist + normalized track name)
              const primaryArtist = track.artists[0].name.toLowerCase();
              const normalizedTrackName = normalizeTrackName(track.name);
              const songSignature = `${primaryArtist}::${normalizedTrackName}`;

              // Check if we've seen this song before
              if (seenSongSignatures.has(songSignature)) {
                // Only allow if it's a unique variation (remix, live, etc.)
                if (!isUniqueVariation(track.name)) {
                  console.log(`Skipping duplicate: "${track.name}" by ${track.artists[0].name} (already have it)`);
                  continue;
                }
              }

              // Check against playlist song history (if loaded)
              if (playlistSongHistory.size > 0) {
                const historySignature = `${normalizedTrackName}|||${primaryArtist}`;
                if (playlistSongHistory.has(historySignature)) {
                  console.log(`Skipping "${track.name}" by ${track.artists[0].name} (previously in playlist history)`);
                  continue;
                }
              }

              seenTrackIds.add(track.id);
              seenSongSignatures.set(songSignature, track.name);
              allTracks.push({
                id: track.id,
                name: track.name,
                artist: track.artists?.[0]?.name || 'Unknown Artist',
                uri: track.uri,
                album: track.album?.name || 'Unknown Album',
                image: track.album?.images?.[0]?.url,
                previewUrl: track.preview_url,
                externalUrl: track.external_urls?.spotify,
                explicit: track.explicit,
                genres: track.artists?.[0]?.genres || [] // Store artist genres for filtering
              });
            }
          }

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Error searching for "${query}":`, error.message);
        }
      }
    } else if (platform === 'apple') {
      // Apple Music search implementation
      const platformService = new PlatformService();
      const storefront = tokens.storefront || 'us';

      const searchLimit = Math.min(
        Math.max(5, Math.ceil(songCount / 2)),
        15
      );
      console.log(`Using search limit of ${searchLimit} tracks per query (requested ${songCount} songs)`);

      for (const query of aiData.searchQueries) {
        try {
          const tracks = await platformService.searchTracks(platformUserId, query, tokens, storefront, searchLimit);

          // Add tracks, filtering out duplicates and explicit content if needed
          for (const track of tracks) {
            if (!seenTrackIds.has(track.id)) {
              // Skip tracks that are already in the playlist (for replace mode)
              if (excludeTrackIds.has(track.id)) {
                console.log(`Skipping "${track.name}" by ${track.artists[0].name} (already in playlist)`);
                continue;
              }

              // Filter explicit content if user doesn't allow it
              if (!allowExplicit && track.explicit) {
                continue;
              }

              // Filter out tracks from known artists if newArtistsOnly is enabled
              if (newArtistsOnly && knownArtists.size > 0) {
                const trackArtist = track.artists[0].name.toLowerCase();
                if (knownArtists.has(trackArtist)) {
                  console.log(`Skipping "${track.name}" by ${track.artists[0].name} (known artist)`);
                  continue;
                }
              }

              // Create a signature for the song (artist + normalized track name)
              const primaryArtist = track.artists[0].name.toLowerCase();
              const normalizedTrackName = normalizeTrackName(track.name);
              const songSignature = `${primaryArtist}::${normalizedTrackName}`;

              // Check if we've seen this song before
              if (seenSongSignatures.has(songSignature)) {
                // Only allow if it's a unique variation (remix, live, etc.)
                if (!isUniqueVariation(track.name)) {
                  console.log(`Skipping duplicate: "${track.name}" by ${track.artists[0].name} (already have it)`);
                  continue;
                }
              }

              // Check against playlist song history (if loaded)
              if (playlistSongHistory.size > 0) {
                const historySignature = `${normalizedTrackName}|||${primaryArtist}`;
                if (playlistSongHistory.has(historySignature)) {
                  console.log(`Skipping "${track.name}" by ${track.artists[0].name} (previously in playlist history)`);
                  continue;
                }
              }

              seenTrackIds.add(track.id);
              seenSongSignatures.set(songSignature, track.name);
              allTracks.push({
                id: track.id,
                name: track.name,
                artist: track.artists?.[0]?.name || 'Unknown Artist',
                uri: track.uri,
                album: track.album?.name || 'Unknown Album',
                image: track.album?.images?.[0]?.url,
                previewUrl: track.preview_url,
                externalUrl: track.url || track.external_urls?.spotify || track.external_urls?.appleMusic,
                explicit: track.explicit || false,
                genres: [] // Apple Music doesn't provide genres per track
              });
            }
          }

          // Small delay to avoid rate limiting
          await new Promise(resolve => setTimeout(resolve, 100));
        } catch (error) {
          console.error(`Error searching for "${query}":`, error.message);
        }
      }
      }
    } // End fallback block

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

        // First, use Claude to normalize artist name variations (e.g., "Daniel J" vs "Daniel John")
        const uniqueArtistNames = [...new Set(allTracks.map(t => t.artist))];
        const artistNameMap = new Map(); // Maps normalized name -> canonical name

        if (uniqueArtistNames.length > 1) {
          try {
            const artistNormalizationResponse = await anthropic.messages.create({
              model: 'claude-sonnet-4-20250514',
              max_tokens: 1000,
              messages: [{
                role: 'user',
                content: `Given this list of artist names from music metadata, identify which names refer to the same artist despite spelling variations.

Artist names: ${uniqueArtistNames.join(', ')}

For each group of names that refer to the same artist, return them as a group. Use the most common/complete name as the canonical name.

Respond ONLY with JSON in this format:
{
  "groups": [
    {
      "canonical": "Daniel J",
      "variations": ["Daniel J", "daniel j", "Daniel John"]
    },
    {
      "canonical": "Frank Ocean",
      "variations": ["Frank Ocean"]
    }
  ]
}

IMPORTANT: Only group names that are clearly the same artist (typos, abbreviations, case differences). Do NOT group different artists.`
              }]
            });

            let normalizationText = artistNormalizationResponse.content[0].text.trim();
            if (normalizationText.startsWith('```json')) {
              normalizationText = normalizationText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
            } else if (normalizationText.startsWith('```')) {
              normalizationText = normalizationText.replace(/^```\n?/, '').replace(/\n?```$/, '');
            }
            const normalizationData = JSON.parse(normalizationText);

            // Build mapping from any variation -> canonical name
            normalizationData.groups.forEach(group => {
              group.variations.forEach(variation => {
                artistNameMap.set(variation.toLowerCase(), group.canonical);
              });
            });

            console.log('🔧 Artist name normalization applied:');
            normalizationData.groups.forEach(group => {
              if (group.variations.length > 1) {
                console.log(`  "${group.variations.join('", "')}" -> "${group.canonical}"`);
              }
            });
          } catch (err) {
            console.log('⚠️  Artist normalization failed, using exact names:', err.message);
          }
        }

        const artistTrackMap = new Map();

        // Group tracks by normalized artist name
        allTracks.forEach(track => {
          const originalArtist = track.artist;
          // First check if Claude mapped this artist, otherwise normalize ourselves
          const claudeNormalizedArtist = artistNameMap.get(originalArtist.toLowerCase());
          const finalNormalizedArtist = normalizeArtistForComparison(claudeNormalizedArtist || originalArtist);

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

      // If few/no requested artists were found, check if we should filter for indie vibe
      // BUT SKIP this filtering if user wants EXCLUSIVE mode (they only want these specific artists)
      const requestedArtistRatio = foundRequestedArtists.length / requestedArtists.length;

      // Count how many tracks are from requested artists
      const requestedArtistTrackCount = allTracks.filter(t =>
        requestedArtists.some(req => normalizeArtistForComparison(req) === normalizeArtistForComparison(t.artist))
      ).length;
      const requestedArtistTrackRatio = requestedArtistTrackCount / allTracks.length;

      console.log(`Requested artist coverage: ${foundRequestedArtists.length}/${requestedArtists.length} artists found, ${requestedArtistTrackCount}/${allTracks.length} tracks (${(requestedArtistTrackRatio * 100).toFixed(1)}%)`);

      // Check if requested artists are indie/underground (low popularity)
      const requestedArtistTracks = allTracks.filter(t =>
        requestedArtists.some(req => normalizeArtistForComparison(req) === normalizeArtistForComparison(t.artist))
      );
      const requestedArtistsAreIndie = requestedArtistTracks.length > 0 &&
        requestedArtistTracks.every(t => (t.popularity || 50) <= 45);

      if (requestedArtistsAreIndie) {
        console.log(`🎵 Detected indie/underground requested artists (all popularity <= 45)`);
      }

      // Filter for indie vibe if:
      // 1. NOT in exclusive mode (user wants similar vibe artists, not just the requested ones)
      // 2. EITHER:
      //    a) None of the requested artists were found, OR
      //    b) Less than 50% of requested artists found AND they make up <20% of tracks (dominated by other artists), OR
      //    c) Requested artists are clearly indie (all popularity <= 45) - maintain indie vibe throughout
      const shouldFilterForIndieVibe =
        !genreData.artistConstraints.exclusiveMode && (
          foundRequestedArtists.length === 0 ||
          (requestedArtistRatio < 0.5 && requestedArtistTrackRatio < 0.2) ||
          requestedArtistsAreIndie
        );

      if (shouldFilterForIndieVibe && allTracks.length > 0) {
        const reason = requestedArtistsAreIndie
          ? 'requested artists are indie/underground'
          : 'requested artists underrepresented';
        console.log(`🎯 Adjusting for indie/underground vibe (${reason})...`);

        // Calculate both average and median popularity
        const sortedByPopularity = [...allTracks].sort((a, b) => (b.popularity || 50) - (a.popularity || 50));
        const medianPopularity = sortedByPopularity[Math.floor(sortedByPopularity.length / 2)].popularity || 50;
        const avgPopularity = allTracks.reduce((sum, t) => sum + (t.popularity || 50), 0) / allTracks.length;

        // Check if top artists are mainstream (top 30% of tracks have high popularity)
        const top30PercentCount = Math.ceil(allTracks.length * 0.3);
        const top30PercentAvg = sortedByPopularity.slice(0, top30PercentCount).reduce((sum, t) => sum + (t.popularity || 50), 0) / top30PercentCount;

        console.log(`Track popularity - Avg: ${avgPopularity.toFixed(1)}, Median: ${medianPopularity}, Top 30% avg: ${top30PercentAvg.toFixed(1)}`);

        // Filter if:
        // 1. Median popularity > 55 (half the tracks are mainstream), OR
        // 2. Top 30% average > 65 (dominated by popular artists at the top)
        const hasMainstreamBias = medianPopularity > 55 || top30PercentAvg > 65;

        if (hasMainstreamBias) {
          // Use very strict threshold (35) when requested artists are underrepresented
          // This ensures we get truly underground/indie artists that might match the vibe
          const popularityThreshold = 35;
          const beforeCount = allTracks.length;

          // Keep tracks from requested artists even if they're popular, but filter everyone else
          allTracks.splice(0, allTracks.length, ...allTracks.filter(t => {
            const isRequestedArtist = requestedArtists.some(req => normalizeArtistForComparison(req) === normalizeArtistForComparison(t.artist));
            return isRequestedArtist || (t.popularity || 50) <= popularityThreshold;
          }));

          console.log(`Filtered out mainstream artists: ${beforeCount} -> ${allTracks.length} tracks (kept requested artists + popularity <= ${popularityThreshold})`);

          if (allTracks.length < songCount) {
            console.warn(`⚠️  Only ${allTracks.length} tracks found with indie/underground vibe (needed ${songCount})`);
            console.log(`💡 Tip: The requested artists (${requestedArtists.join(', ')}) may not be available on this platform, so results include similar lesser-known artists`);
          }
        } else {
          console.log('Track selection already has indie/underground vibe, no filtering needed');
        }
      } else if (genreData.artistConstraints.exclusiveMode) {
        console.log('Skipping indie filtering - exclusive mode enabled (user wants only requested artists)');
      } else {
        console.log('Requested artists well-represented in results, no indie filtering needed');
      }
    }

    // Step 2.5: Filter by audio features if specified
    let tracksForSelection = allTracks;
    const hasAudioFeatureFilters = genreData.audioFeatures && (
      genreData.audioFeatures.bpm.target !== null ||
      genreData.audioFeatures.bpm.min !== null ||
      genreData.audioFeatures.energy.min !== null ||
      genreData.audioFeatures.danceability.min !== null ||
      genreData.audioFeatures.valence.min !== null ||
      genreData.audioFeatures.acousticness.min !== null
    );

    if (hasAudioFeatureFilters && allTracks.length > 0 && platform === 'spotify') {
      console.log('Audio feature filters detected:', genreData.audioFeatures);

      try {
        // Fetch audio features for all tracks (Spotify allows up to 100 tracks per request)
        const trackIds = allTracks.map(t => t.id);
        const audioFeaturesData = [];

        // Process in batches of 100
        for (let i = 0; i < trackIds.length; i += 100) {
          const batch = trackIds.slice(i, i + 100);
          const response = await userSpotifyApi.getAudioFeaturesForTracks(batch);
          audioFeaturesData.push(...response.body.audio_features);

          // Small delay to avoid rate limiting
          if (i + 100 < trackIds.length) {
            await new Promise(resolve => setTimeout(resolve, 100));
          }
        }

        console.log(`Fetched audio features for ${audioFeaturesData.length} tracks`);

        // Filter tracks based on audio features
        const filteredTracks = [];
        const albumTrackCount = {}; // Track how many songs per album
        for (let i = 0; i < allTracks.length; i++) {
          const track = allTracks[i];
          const features = audioFeaturesData[i];

          if (!features) {
            console.log(`No audio features for "${track.name}", skipping`);
            continue;
          }

          let passesFilters = true;

          // BPM (tempo) filtering
          if (genreData.audioFeatures.bpm.target !== null) {
            const targetBpm = genreData.audioFeatures.bpm.target;
            const tolerance = 10; // ±10 BPM tolerance
            if (features.tempo < targetBpm - tolerance || features.tempo > targetBpm + tolerance) {
              console.log(`"${track.name}" filtered out: BPM ${features.tempo.toFixed(0)} (target: ${targetBpm}±${tolerance})`);
              passesFilters = false;
            }
          } else if (genreData.audioFeatures.bpm.min !== null || genreData.audioFeatures.bpm.max !== null) {
            const minBpm = genreData.audioFeatures.bpm.min || 0;
            const maxBpm = genreData.audioFeatures.bpm.max || 300;
            if (features.tempo < minBpm || features.tempo > maxBpm) {
              console.log(`"${track.name}" filtered out: BPM ${features.tempo.toFixed(0)} (range: ${minBpm}-${maxBpm})`);
              passesFilters = false;
            }
          }

          // Energy filtering
          if (genreData.audioFeatures.energy.min !== null || genreData.audioFeatures.energy.max !== null) {
            const minEnergy = genreData.audioFeatures.energy.min || 0;
            const maxEnergy = genreData.audioFeatures.energy.max || 1;
            if (features.energy < minEnergy || features.energy > maxEnergy) {
              console.log(`"${track.name}" filtered out: Energy ${features.energy.toFixed(2)} (range: ${minEnergy}-${maxEnergy})`);
              passesFilters = false;
            }
          }

          // Danceability filtering
          if (genreData.audioFeatures.danceability.min !== null || genreData.audioFeatures.danceability.max !== null) {
            const minDance = genreData.audioFeatures.danceability.min || 0;
            const maxDance = genreData.audioFeatures.danceability.max || 1;
            if (features.danceability < minDance || features.danceability > maxDance) {
              console.log(`"${track.name}" filtered out: Danceability ${features.danceability.toFixed(2)} (range: ${minDance}-${maxDance})`);
              passesFilters = false;
            }
          }

          // Valence (happiness) filtering
          if (genreData.audioFeatures.valence.min !== null || genreData.audioFeatures.valence.max !== null) {
            const minValence = genreData.audioFeatures.valence.min || 0;
            const maxValence = genreData.audioFeatures.valence.max || 1;
            if (features.valence < minValence || features.valence > maxValence) {
              console.log(`"${track.name}" filtered out: Valence ${features.valence.toFixed(2)} (range: ${minValence}-${maxValence})`);
              passesFilters = false;
            }
          }

          // Acousticness filtering
          if (genreData.audioFeatures.acousticness.min !== null || genreData.audioFeatures.acousticness.max !== null) {
            const minAcoustic = genreData.audioFeatures.acousticness.min || 0;
            const maxAcoustic = genreData.audioFeatures.acousticness.max || 1;
            if (features.acousticness < minAcoustic || features.acousticness > maxAcoustic) {
              console.log(`"${track.name}" filtered out: Acousticness ${features.acousticness.toFixed(2)} (range: ${minAcoustic}-${maxAcoustic})`);
              passesFilters = false;
            }
          }

          // Year range filtering (for "last 5 years", "from 2020-2024", etc.)
          if (genreData.era.yearRange.min !== null || genreData.era.yearRange.max !== null) {
            if (track.album && track.album.release_date) {
              const releaseYear = parseInt(track.album.release_date.substring(0, 4));
              const minYear = genreData.era.yearRange.min || 0;
              const maxYear = genreData.era.yearRange.max || 9999;

              if (releaseYear < minYear || releaseYear > maxYear) {
                console.log(`"${track.name}" filtered out: Release year ${releaseYear} (range: ${minYear}-${maxYear})`);
                passesFilters = false;
              }
            }
          }

          // Popularity filtering
          if (genreData.trackConstraints.popularity.min !== null || genreData.trackConstraints.popularity.max !== null) {
            const minPop = genreData.trackConstraints.popularity.min || 0;
            const maxPop = genreData.trackConstraints.popularity.max || 100;
            if (track.popularity < minPop || track.popularity > maxPop) {
              console.log(`"${track.name}" filtered out: Popularity ${track.popularity} (range: ${minPop}-${maxPop})`);
              passesFilters = false;
            }
          }

          // Duration filtering (convert milliseconds to seconds)
          if (genreData.trackConstraints.duration.min !== null || genreData.trackConstraints.duration.max !== null) {
            const durationSec = track.duration_ms / 1000;
            const minDur = genreData.trackConstraints.duration.min || 0;
            const maxDur = genreData.trackConstraints.duration.max || 999999;
            if (durationSec < minDur || durationSec > maxDur) {
              console.log(`"${track.name}" filtered out: Duration ${Math.floor(durationSec)}s (range: ${minDur}-${maxDur}s)`);
              passesFilters = false;
            }
          }

          // Version exclusions (live, remix, acoustic, etc.)
          if (genreData.trackConstraints.excludeVersions.length > 0) {
            const trackNameLower = track.name.toLowerCase();
            for (const excludeType of genreData.trackConstraints.excludeVersions) {
              if (trackNameLower.includes(excludeType.toLowerCase())) {
                console.log(`"${track.name}" filtered out: Excluded version type "${excludeType}"`);
                passesFilters = false;
                break;
              }
            }
          }

          // Artist features filtering (remove songs with "feat.", "ft.", "with", etc.)
          if (genreData.artistConstraints.excludeFeatures) {
            const trackNameLower = track.name.toLowerCase();
            if (trackNameLower.includes('feat.') || trackNameLower.includes('ft.') ||
                trackNameLower.includes(' with ') || trackNameLower.includes('featuring')) {
              console.log(`"${track.name}" filtered out: Contains features/collaborations`);
              passesFilters = false;
            }
          }

          // Language filtering (based on market/available_markets)
          if (passesFilters && genreData.culturalContext && genreData.culturalContext.language) {
            const languagePrefs = genreData.culturalContext.language;

            // Map language preferences to Spotify market codes
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

            // Check if preference or restriction is specified
            if (languagePrefs.prefer && languagePrefs.prefer.length > 0) {
              // Get all preferred markets
              let preferredMarkets = [];
              languagePrefs.prefer.forEach(lang => {
                const markets = languageToMarkets[lang.toLowerCase()];
                if (markets) preferredMarkets.push(...markets);
              });

              // Check if track is available in any preferred market
              if (preferredMarkets.length > 0 && track.available_markets) {
                const hasPreferredMarket = preferredMarkets.some(market =>
                  track.available_markets.includes(market)
                );
                if (!hasPreferredMarket) {
                  console.log(`"${track.name}" filtered out: Not available in preferred language markets`);
                  passesFilters = false;
                }
              }
            }

            if (languagePrefs.exclude && languagePrefs.exclude.length > 0) {
              // Get all excluded markets
              let excludedMarkets = [];
              languagePrefs.exclude.forEach(lang => {
                const markets = languageToMarkets[lang.toLowerCase()];
                if (markets) excludedMarkets.push(...markets);
              });

              // Check if track is ONLY available in excluded markets
              if (excludedMarkets.length > 0 && track.available_markets) {
                const onlyInExcludedMarkets = track.available_markets.every(market =>
                  excludedMarkets.includes(market)
                );
                if (onlyInExcludedMarkets) {
                  console.log(`"${track.name}" filtered out: Only available in excluded language markets`);
                  passesFilters = false;
                }
              }
            }
          }

          // Album diversity filtering (limit songs per album)
          if (passesFilters && genreData.trackConstraints.albumDiversity.maxPerAlbum !== null) {
            const albumId = track.album?.id;
            if (albumId) {
              const currentCount = albumTrackCount[albumId] || 0;
              const maxPerAlbum = genreData.trackConstraints.albumDiversity.maxPerAlbum;

              if (currentCount >= maxPerAlbum) {
                console.log(`"${track.name}" filtered out: Album "${track.album.name}" already has ${currentCount} tracks (max: ${maxPerAlbum})`);
                passesFilters = false;
              } else {
                // Track this album
                albumTrackCount[albumId] = currentCount + 1;
              }
            }
          }

          if (passesFilters) {
            // Add audio features to track for debugging
            filteredTracks.push({
              ...track,
              audioFeatures: {
                bpm: features.tempo.toFixed(0),
                energy: features.energy.toFixed(2),
                danceability: features.danceability.toFixed(2),
                valence: features.valence.toFixed(2),
                acousticness: features.acousticness.toFixed(2)
              }
            });
          }
        }

        tracksForSelection = filteredTracks;
        console.log(`After audio features filtering: ${tracksForSelection.length} tracks remain`);

        if (tracksForSelection.length === 0) {
          console.warn('Warning: No tracks passed audio feature filters, falling back to all tracks');
          tracksForSelection = allTracks;
        }
      } catch (error) {
        console.error('Error filtering by audio features:', error.message);
        console.log('Continuing with unfiltered tracks');
        tracksForSelection = allTracks;
      }
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
            content: `You are a strict music genre expert with comprehensive knowledge of artists, songs, and musical styles across all platforms and eras. The user wants ONLY songs that match this genre: "${genreData.primaryGenre}".

CRITICAL: The user's playlist description is: "${prompt}"

IMPORTANT DISTINCTION:
- The playlist DESCRIPTION (like "focus while working" or "chill vibes") is about the MOOD/USE CASE
- The GENRE requirement ("${genreData.primaryGenre}") is about the MUSICAL STYLE
- DO NOT match songs based on title keywords that match the description!
- Example: For an R&B playlist with description "music to focus while working", REJECT a song called "Focus" if it's not R&B genre

YOUR KNOWLEDGE BASE:
- Use your comprehensive training data about artists, genres, musical styles, and song classifications
- API genre tags (when provided) are hints, but NOT definitive - use your own knowledge as primary source
- Consider the artist's full discography, typical style, and the specific song's characteristics
- Account for artists who cross genres - evaluate each SONG individually, not just the artist

Below is a list of tracks with API genre tags when available. Be EXTREMELY STRICT - even a single genre mismatch ruins the playlist.

RULES FOR "${genreData.primaryGenre}" PLAYLISTS:
- If the genre is R&B: REJECT all jazz, soul-jazz, smooth jazz, fusion, and neo-soul/jazz crossover tracks
- If the genre is Hip-Hop: REJECT all R&B-pop crossover unless explicitly hip-hop
- If the genre is Rock: REJECT all pop-rock unless clearly rock
- REJECT all study music, focus playlists, background instrumentals, and compilation tracks
- REJECT any track where the primary MUSICAL GENRE differs from "${genreData.primaryGenre}"
- REJECT tracks that are "close but not quite" - be strict about genre boundaries
- REJECT tracks whose title matches the mood/description but whose genre doesn't match
- Use your music knowledge to identify genre mismatches even when API tags are missing or incorrect

Examples of REJECTIONS for R&B playlists:
- "Soulful" by Cal Harris Jr. (this is JAZZ, not R&B)
- "Focus" by Ariana Grande or any cover (this is POP, not R&B, even though "focus" might be in the playlist description)
- Any track with "Jazz" in artist genres or style
- Smooth jazz vocals (even if soulful)
- Neo-soul/jazz fusion tracks
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
    const artistKeywords = [
      'from', 'by', 'songs by', 'tracks by', 'music by',
      'playlist with songs from', ' songs', ' tracks', ' music'
    ];
    const hasSpecificArtists = !isSimilarityRequest && (
      artistKeywords.some(keyword => lowerPrompt.includes(keyword)) ||
      /\b(and|,)\b/i.test(prompt) || // Has "and" or commas
      isSingleArtistPlaylist // Greatest hits/best of also counts
    );

    // Request more songs than target to account for vibe check filtering
    // Vibe check typically removes 10-20% of songs that don't fit the atmosphere
    const hasVibeRequirements = genreData.atmosphere.length > 0 || genreData.contextClues.useCase || genreData.era.decade || genreData.subgenre;
    const selectionTarget = hasVibeRequirements ? Math.ceil(songCount * 1.2) : songCount; // Request 20% more if vibe check will run
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
  : genreData.primaryGenre
    ? `CRITICAL: The playlist MUST be in the ${genreData.primaryGenre} genre. ONLY select songs where the artist genres contain or strongly align with "${genreData.primaryGenre}". REJECT any songs from unrelated genres even if they match the mood or theme.`
    : 'Use the theme and characteristics to guide your selection.'}

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

            const selectedTrackIds = new Set(tracksAfterVibeCheck.map(t => t.id));
            const remainingTracks = tracksForSelection.filter(t => !selectedTrackIds.has(t.id));

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
        // User doesn't have any platform connected, return empty playlists
        console.log('No music platform connection found for email:', userId);
        return res.json({ playlists: [] });
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
      externalUrl: item.track.external_urls.spotify
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

    // If we're both removing and adding tracks, use replace API for better performance
    if (tracksToRemove && tracksToRemove.length > 0 && tracksToAdd && tracksToAdd.length > 0) {
      // This is a replace operation - use Spotify's replace API
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
      // Remove tracks if specified
      if (tracksToRemove && tracksToRemove.length > 0) {
        // tracksToRemove is expected to be in format [{ uri: 'spotify:track:...' }]
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

      // Add tracks if specified
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
      const playlistPlatform = userPlaylistHistory[playlistIndex].platform;

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
    const { userId, trackId, trackUri, trackName, artistName, reaction } = req.body;

    console.log(`[REACTION] Request received: playlistId=${playlistId}, userId=${userId}, trackId=${trackId}, reaction=${reaction}`);

    if (!userId || !trackId) {
      return res.status(400).json({ error: 'Missing required fields: userId, trackId' });
    }

    // Validate reaction value
    if (reaction !== null && reaction !== 'thumbsUp' && reaction !== 'thumbsDown') {
      return res.status(400).json({ error: 'Invalid reaction value. Must be "thumbsUp", "thumbsDown", or null' });
    }

    // Get user's playlists
    const userPlaylistsArray = userPlaylists.get(userId) || [];
    const playlist = userPlaylistsArray.find(p => p.playlistId === playlistId);

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
        reactedAt: new Date().toISOString()
      });
      console.log(`[REACTION] User liked song: ${trackName} by ${artistName}`);
    } else if (reaction === 'thumbsDown') {
      playlist.dislikedSongs.push({
        id: trackId,
        uri: trackUri,
        name: trackName,
        artist: artistName,
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
    console.log('[AUTO-UPDATE] Checking for playlists that need updating...');

    try {
      const allUsers = Array.from(userPlaylists.entries());

      for (const [userId, playlists] of allUsers) {
        for (const playlist of playlists) {
          // Check if playlist has auto-update enabled and if it's time to update
          if (playlist.updateFrequency && playlist.updateFrequency !== 'never' && playlist.nextUpdate) {
            const nextUpdateTime = new Date(playlist.nextUpdate);
            const now = new Date();

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

                try {
                  // Extract genre and characteristics using Claude
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

                  let genreData = { primaryGenre: null, secondaryGenres: [], keyCharacteristics: [], style: '' };
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

                  // Generate search queries using Claude
                  const aiResponse = await anthropic.messages.create({
                    model: 'claude-sonnet-4-20250514',
                    max_tokens: 2000,
                    messages: [{
                      role: 'user',
                      content: `You are a music expert assistant. Based on the following user prompt for a playlist, generate a JSON response with search queries to find songs that match the prompt.

Original prompt: "${playlist.originalPrompt || prompt}"
${playlist.refinementInstructions && playlist.refinementInstructions.length > 0 ? `\nRefinement instructions: ${playlist.refinementInstructions.join('; ')}` : ''}

IMPORTANT GUIDELINES:
- The primary genre for this playlist is: ${genreData.primaryGenre || 'not specified'}
- Secondary genres to consider: ${genreData.secondaryGenres.join(', ') || 'none'}
- Key characteristics: ${genreData.keyCharacteristics.join(', ') || 'not specified'}
- For GENRE-SPECIFIC playlists, PRIORITIZE genre-specific queries HEAVILY (e.g., for R&B: "R&B singles", "contemporary R&B", "soulful R&B artists", "R&B vocalists", etc.)
- Include at least 8 genre-specific queries if a primary genre is mentioned
- Mix specific artist searches with broader genre searches to get good variety within the correct genre
- AVOID queries that would return songs from different genres
- AVOID vague emotional queries alone - always ground them in the genre/style
- CRITICAL: If the prompt specifies a time period (e.g., "last 5 years", "2020s"), only suggest recent/contemporary artists who are active in that timeframe
- CRITICAL: If refinement instructions exclude specific artists, DO NOT include those artists in any search queries
- Maintain ALL constraints from the original prompt while applying refinements

Respond ONLY with valid JSON in this exact format:
{
  "searchQueries": ["query1", "query2", "query3", ...]
}

Generate 12-15 diverse search queries. DO NOT include any text outside the JSON.`
                    }]
                  });

                  let searchQueries = [];
                  try {
                    let aiText = aiResponse.content[0].text.trim();
                    // Remove markdown code blocks if present
                    if (aiText.startsWith('```json')) {
                      aiText = aiText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                    } else if (aiText.startsWith('```')) {
                      aiText = aiText.replace(/^```\n?/, '').replace(/\n?```$/, '');
                    }
                    const aiData = JSON.parse(aiText);
                    searchQueries = aiData.searchQueries || [];
                  } catch (parseError) {
                    console.log('Could not parse AI response in auto-update:', parseError.message);
                    searchQueries = [];
                  }

                  // Search Spotify for tracks matching the queries
                  const allSearchResults = [];

                  // If userId is email-based, resolve to Spotify platform userId
                  let platformUserId = userId;
                  if (isEmailBasedUserId(userId)) {
                    platformUserId = await resolvePlatformUserId(userId, 'spotify');
                    if (!platformUserId) {
                      console.log(`[AUTO-UPDATE] No Spotify connection for user ${userId}, skipping playlist ${playlist.playlistName}`);
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

                    // Execute searches with higher limit to get more initial results
                    for (const query of searchQueries) {
                      try {
                        const results = await userSpotifyApi.searchTracks(query, { limit: 10 });
                        if (results.body.tracks && results.body.tracks.items) {
                          allSearchResults.push(...results.body.tracks.items);
                        }
                      } catch (searchError) {
                        console.log(`Search failed for query "${query}":`, searchError.message);
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
                            content: `You are a strict music genre expert with comprehensive knowledge of artists, songs, and musical styles across all platforms and eras. The user wants ONLY songs that match this genre: "${genreData.primaryGenre}".

CRITICAL: The user's playlist description is: "${prompt}"

IMPORTANT DISTINCTION:
- The playlist DESCRIPTION (like "focus while working" or "chill vibes") is about the MOOD/USE CASE
- The GENRE requirement ("${genreData.primaryGenre}") is about the MUSICAL STYLE
- DO NOT match songs based on title keywords that match the description!
- Example: For an R&B playlist with description "music to focus while working", REJECT a song called "Focus" if it's not R&B genre

YOUR KNOWLEDGE BASE:
- Use your comprehensive training data about artists, genres, musical styles, and song classifications
- API genre tags (when provided) are hints, but NOT definitive - use your own knowledge as primary source
- Consider the artist's full discography, typical style, and the specific song's characteristics
- Account for artists who cross genres - evaluate each SONG individually, not just the artist

Below is a list of tracks with API genre tags when available. Be EXTREMELY STRICT - even a single genre mismatch ruins the playlist.

RULES FOR "${genreData.primaryGenre}" PLAYLISTS:
- If the genre is R&B: REJECT all jazz, soul-jazz, smooth jazz, fusion, and neo-soul/jazz crossover tracks
- If the genre is Hip-Hop: REJECT all R&B-pop crossover unless explicitly hip-hop
- If the genre is Rock: REJECT all pop-rock unless clearly rock
- REJECT all study music, focus playlists, background instrumentals, and compilation tracks
- REJECT any track where the primary MUSICAL GENRE differs from "${genreData.primaryGenre}"
- REJECT tracks that are "close but not quite" - be strict about genre boundaries
- REJECT tracks whose title matches the mood/description but whose genre doesn't match
- Use your music knowledge to identify genre mismatches even when API tags are missing or incorrect

Examples of REJECTIONS for R&B playlists:
- "Soulful" by Cal Harris Jr. (this is JAZZ, not R&B)
- "Focus" by Ariana Grande or any cover (this is POP, not R&B, even though "focus" might be in the playlist description)
- Any track with "Jazz" in artist genres or style
- Smooth jazz vocals (even if soulful)
- Neo-soul/jazz fusion tracks

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

                    // If we don't have enough tracks, try to fetch more
                    let searchAttempts = 0;
                    const maxSearchAttempts = 3;

                    while (uniqueTracks.length < desiredCount && searchAttempts < maxSearchAttempts) {
                      searchAttempts++;
                      console.log(`[AUTO-UPDATE] Only found ${uniqueTracks.length}/${desiredCount} tracks. Attempt ${searchAttempts}/${maxSearchAttempts} to find more...`);

                      try {
                        // Ask AI for more search queries
                        const additionalQueryResponse = await anthropic.messages.create({
                          model: 'claude-sonnet-4-20250514',
                          max_tokens: 1000,
                          messages: [{
                            role: 'user',
                            content: `The user wants a playlist with this prompt: "${playlist.originalPrompt}"

We currently have ${uniqueTracks.length} valid tracks but need ${desiredCount} total.

Generate ${Math.min(10, desiredCount - uniqueTracks.length)} NEW and DIFFERENT Spotify search queries to find more songs that match this playlist theme. Make these queries different from typical searches - try different artists, sub-genres, eras, or specific styles within the genre.

${genreData.primaryGenre && genreData.primaryGenre !== 'not specified' ? `The primary genre is: ${genreData.primaryGenre}. Make sure all queries target this genre specifically.` : ''}

Respond with valid JSON:
{
  "searchQueries": ["query 1", "query 2", ...]
}

Only include the JSON, no other text.`
                          }]
                        });

                        let additionalQueriesText = additionalQueryResponse.content[0].text.trim();
                        if (additionalQueriesText.startsWith('```json')) {
                          additionalQueriesText = additionalQueriesText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                        } else if (additionalQueriesText.startsWith('```')) {
                          additionalQueriesText = additionalQueriesText.replace(/^```\n?/, '').replace(/\n?```$/, '');
                        }
                        const additionalQueriesData = JSON.parse(additionalQueriesText);
                        const additionalQueries = additionalQueriesData.searchQueries || [];

                        if (additionalQueries.length === 0) {
                          console.log('[AUTO-UPDATE] No additional queries generated, stopping search');
                          break;
                        }

                        // Search with the new queries
                        const additionalSearchResults = [];
                        for (const query of additionalQueries) {
                          try {
                            const results = await userSpotifyApi.searchTracks(query, { limit: 10 });
                            if (results.body.tracks && results.body.tracks.items) {
                              additionalSearchResults.push(...results.body.tracks.items);
                            }
                          } catch (searchError) {
                            console.log(`Additional search failed for query "${query}":`, searchError.message);
                          }
                        }

                        console.log(`[AUTO-UPDATE] Found ${additionalSearchResults.length} additional tracks from new searches`);

                        // Filter by genre if needed
                        let additionalGenreFiltered = additionalSearchResults;
                        if (genreData.primaryGenre && genreData.primaryGenre !== 'not specified' && additionalSearchResults.length > 0) {
                          try {
                            const trackListForValidation = additionalSearchResults.slice(0, 50).map(t =>
                              `${t.name} by ${t.artists[0]?.name || 'Unknown'}`
                            ).join('\n');

                            const genreValidationResponse = await anthropic.messages.create({
                              model: 'claude-sonnet-4-20250514',
                              max_tokens: 2000,
                              messages: [{
                                role: 'user',
                                content: `You are a music genre expert. The user wants songs that match this genre: "${genreData.primaryGenre}".

Below is a list of tracks from search results. Filter and return ONLY tracks that clearly match "${genreData.primaryGenre}".

Tracks:
${trackListForValidation}

Respond with valid JSON:
{
  "validTracks": ["track 1 by artist 1", "track 2 by artist 2", ...]
}

Only include tracks that genuinely match "${genreData.primaryGenre}". DO NOT include any text outside the JSON.`
                              }]
                            });

                            let validationText = genreValidationResponse.content[0].text.trim();
                            if (validationText.startsWith('```json')) {
                              validationText = validationText.replace(/^```json\n?/, '').replace(/\n?```$/, '');
                            } else if (validationText.startsWith('```')) {
                              validationText = validationText.replace(/^```\n?/, '').replace(/\n?```$/, '');
                            }
                            const validationData = JSON.parse(validationText);
                            const validTrackNames = new Set(validationData.validTracks || []);

                            additionalGenreFiltered = additionalSearchResults.filter(track => {
                              const trackString = `${track.name} by ${track.artists[0]?.name || 'Unknown'}`;
                              return validTrackNames.has(trackString);
                            });

                            console.log(`[AUTO-UPDATE] Genre validation: ${additionalSearchResults.length} tracks -> ${additionalGenreFiltered.length} valid ${genreData.primaryGenre} tracks`);
                          } catch (validationError) {
                            console.log('Additional genre validation failed:', validationError.message);
                            additionalGenreFiltered = additionalSearchResults;
                          }
                        }

                        // Deduplicate and add to uniqueTracks
                        additionalGenreFiltered.forEach(track => {
                          const normalizedName = normalizeTrackName(track.name);
                          const artistName = track.artists[0]?.name || 'Unknown';
                          const trackKey = `${normalizedName}|||${artistName.toLowerCase()}`;
                          const isAppendMode = playlist.updateMode !== 'replace';
                          const isExistingTrack = existingUris.has(track.uri) || existingTrackIds.has(track.id);
                          const isExistingName = existingNormalizedNames.has(normalizedName);

                          if (isExistingTrack || isExistingName) {
                            if (isAppendMode) {
                              return;
                            } else {
                              // Replace mode: skip current playlist tracks
                              return;
                            }
                          }

                          // Check if track exists in song history
                          const isInHistory = historicalTrackKeys.has(trackKey);
                          if (isInHistory) {
                            console.log(`[AUTO-UPDATE] Skipping "${track.name}" by ${artistName} (previously in playlist history)`);
                            return;
                          }

                          const isDuplicateUri = seenUris.has(track.uri);
                          const isDuplicateKey = seenNormalizedNames.has(trackKey);

                          if (!isDuplicateUri && !isDuplicateKey && track.explicit === false && uniqueTracks.length < desiredCount) {
                            seenUris.add(track.uri);
                            seenNormalizedNames.add(trackKey);
                            uniqueTracks.push(track);
                          }
                        });

                        console.log(`[AUTO-UPDATE] After additional search: ${uniqueTracks.length} total unique tracks`);

                      } catch (additionalSearchError) {
                        console.log('[AUTO-UPDATE] Additional search attempt failed:', additionalSearchError.message);
                        break;
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
                } catch (generationError) {
                  console.error(`[AUTO-UPDATE] Track generation failed for ${playlist.playlistName}:`, generationError.message);
                  newTrackUris = [];
                }

                // Get user tokens (use platformUserId resolved earlier)
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

                // Update the nextUpdate timestamp, lastUpdated, and updatedAt
                const now = new Date().toISOString();
                playlist.lastUpdated = now;
                playlist.updatedAt = now;
                playlist.nextUpdate = calculateNextUpdate(playlist.updateFrequency, playlist.playlistId, playlist.updateTime);
                await savePlaylist(userId, playlist);

              } catch (updateError) {
                console.error(`[AUTO-UPDATE] Error updating playlist ${playlist.playlistName}:`, updateError.message);
              }
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
