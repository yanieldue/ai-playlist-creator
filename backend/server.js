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
app.use(express.json());

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
    let privateKey = process.env.APPLE_MUSIC_PRIVATE_KEY;

    // If using pre-generated token, return it
    if (process.env.APPLE_MUSIC_DEV_TOKEN && !privateKey) {
      return process.env.APPLE_MUSIC_DEV_TOKEN;
    }

    // Generate JWT token if private key is available
    if (teamId && keyId && privateKey) {
      // Handle base64 encoded private key
      if (!privateKey.includes('-----BEGIN')) {
        // It's base64 encoded, decode it
        const decodedKey = Buffer.from(privateKey, 'base64').toString('utf-8');
        privateKey = `-----BEGIN EC PRIVATE KEY-----\n${decodedKey}\n-----END EC PRIVATE KEY-----`;
      }

      const now = Math.floor(Date.now() / 1000);
      const expiresIn = 15 * 60; // 15 minutes

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

      console.log('Generated new Apple Music JWT token');
      return token;
    }

    console.warn('Apple Music token generation: missing credentials (APPLE_MUSIC_TEAM_ID, APPLE_MUSIC_KEY_ID, or APPLE_MUSIC_PRIVATE_KEY)');
    return process.env.APPLE_MUSIC_DEV_TOKEN;
  } catch (error) {
    console.error('Error generating Apple Music token:', error.message);
    return process.env.APPLE_MUSIC_DEV_TOKEN;
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

// Load playlists from file on startup
function loadPlaylists() {
  try {
    if (fs.existsSync(PLAYLISTS_FILE)) {
      const data = fs.readFileSync(PLAYLISTS_FILE, 'utf8');
      const playlistsObj = JSON.parse(data);
      console.log('Loaded playlists for', Object.keys(playlistsObj).length, 'users from file');
      return new Map(Object.entries(playlistsObj));
    }
  } catch (error) {
    console.error('Error loading playlists:', error);
  }
  return new Map();
}

// Save playlists to file
function savePlaylists() {
  try {
    const playlistsObj = Object.fromEntries(userPlaylists);
    fs.writeFileSync(PLAYLISTS_FILE, JSON.stringify(playlistsObj, null, 2));
  } catch (error) {
    console.error('Error saving playlists:', error);
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
      db.updateUser(email, userData);
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

// Store user playlists (persisted to file)
const userPlaylists = loadPlaylists();

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
    const user = {
      email: normalizedEmail,
      password: password, // TODO: Hash password in production
      platform: platform,
      connectedPlatforms: {
        spotify: platform === 'spotify',
        apple: platform === 'apple'
      },
      createdAt: new Date().toISOString(),
      userId: null, // Will be set after Spotify/Apple authentication
    };

    registeredUsers.set(normalizedEmail, user);
    saveUsers();

    // Generate a simple auth token (in production, use JWT)
    const token = Buffer.from(`${normalizedEmail}:${Date.now()}`).toString('base64');

    res.json({
      success: true,
      token: token,
      email: normalizedEmail,
      platform: platform,
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

    res.json({
      success: true,
      token: token,
      email: normalizedEmail,
      platform: user.platform,
      userId: user.userId,
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

    const user = registeredUsers.get(normalizedEmail);

    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      success: true,
      email: normalizedEmail,
      platform: user.platform,
      connectedPlatforms: user.connectedPlatforms || {
        spotify: user.platform === 'spotify',
        apple: user.platform === 'apple'
      },
      userId: user.userId,
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
  const { email } = req.query;

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

  // Use email as state to identify user on callback
  const state = email;
  const authorizeURL = spotifyApi.createAuthorizeURL(scopes, state);
  console.log('Spotify auth URL requested for email:', email, 'State:', state);
  res.json({ url: authorizeURL });
});

// Spotify callback
app.get('/callback', async (req, res) => {
  const { code, state } = req.query;

  try {
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

    // Use Spotify user ID as the userId for consistent identification
    const userId = `spotify_${spotifyUserId}`;
    const tokenData = { access_token, refresh_token };
    userTokens.set(userId, tokenData);

    // Save to database
    await db.setToken(userId, tokenData);
    console.log('User authenticated and tokens saved to database:', userId);

    // The 'state' parameter contains the user's email (from the auth request)
    let userEmail = state || '';

    // If state is 'state' (old default), it means email wasn't provided
    if (userEmail === 'state') {
      console.warn('OAuth callback received without email in state parameter. This should not happen.');
      userEmail = '';
    }

    console.log('Linking Spotify userId:', userId, 'to email:', userEmail);

    // Update the user record in registeredUsers to link the Spotify connection
    if (userEmail && registeredUsers.has(userEmail)) {
      const user = registeredUsers.get(userEmail);
      user.userId = userId;
      user.connectedPlatforms = user.connectedPlatforms || {};
      user.connectedPlatforms.spotify = true;
      registeredUsers.set(userEmail, user);
      saveUsers();
      console.log('Updated user record for:', userEmail);
    } else if (userEmail) {
      console.warn('User email from OAuth callback not found in registered users:', userEmail);
    }

    // Redirect back to frontend with userId, email, and success flag for Account component
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}?userId=${userId}&email=${encodeURIComponent(userEmail)}&success=true&spotify=connected`;
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

    // Create a unique user ID for this Apple Music connection
    const userId = `apple_music_${Date.now()}`;

    // Store the authorization code and token info
    userTokens.set(userId, {
      access_token: code,
      developer_token: appleMusicDevToken,
      platform: 'apple_music',
      email: userEmail,
      authorized_at: new Date().toISOString()
    });
    saveTokens();

    console.log('Apple Music user authenticated:', userId);

    // Update the user record in registeredUsers to link the Apple Music connection
    if (userEmail && registeredUsers.has(userEmail)) {
      const user = registeredUsers.get(userEmail);
      user.appleMusicUserId = userId;
      user.connectedPlatforms = user.connectedPlatforms || {};
      user.connectedPlatforms.apple = true;
      registeredUsers.set(userEmail, user);
      saveUsers();
      console.log('Updated user record for:', userEmail);
    } else if (userEmail) {
      console.warn('User email from Apple Music callback not found in registered users:', userEmail);
    }

    // Redirect back to frontend with userId, email, and success flag
    const redirectUrl = `${process.env.FRONTEND_URL || 'http://localhost:3000'}?userId=${userId}&email=${encodeURIComponent(userEmail)}&success=true&apple=connected`;
    console.log('Redirecting to:', redirectUrl);
    res.redirect(redirectUrl);
  } catch (error) {
    console.error('Error in Apple Music callback:', error);
    res.redirect(`${process.env.FRONTEND_URL || 'http://localhost:3000'}?error=apple_auth_failed&message=${encodeURIComponent(error.message)}`);
  }
});

// Get user's top artists
app.get('/api/top-artists/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const tokens = await getUserTokens(userId);
    if (!tokens) {
      // Return empty array for users without Spotify connection
      console.log('No tokens found for userId:', userId, '- returning empty artists array');
      return res.json({ artists: [] });
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
    }

    // Get top 10 artists from the last month
    const topArtistsData = await userSpotifyApi.getMyTopArtists({ limit: 10, time_range: 'short_term' });

    const topArtists = topArtistsData.body.items.map(artist => ({
      id: artist.id,
      name: artist.name,
      image: artist.images[0]?.url,
      genres: artist.genres,
      popularity: artist.popularity,
      uri: artist.uri
    }));

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
  try {
    const { userId } = req.params;

    const tokens = await getUserTokens(userId);
    if (!tokens) {
      console.log('No tokens found for userId:', userId, '- returning empty new artists array');
      return res.json({ artists: [] });
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
    }

    // Get user's top artists to understand their taste
    let topArtistIds = [];
    try {
      const topArtistsData = await userSpotifyApi.getMyTopArtists({ limit: 5, time_range: 'medium_term' });
      topArtistIds = topArtistsData.body.items.map(artist => artist.id);
    } catch (err) {
      console.log('Could not fetch top artists for new artists recommendation:', err.message);
      // If we can't get top artists, return empty array
      return res.json({ artists: [] });
    }

    // Get user's recently played tracks to find artists they've listened to
    let listenedArtistIds = new Set();
    try {
      const recentlyPlayedData = await userSpotifyApi.getMyRecentlyPlayedTracks({ limit: 50 });
      listenedArtistIds = new Set(
        recentlyPlayedData.body.items.flatMap(item =>
          item.track.artists.map(artist => artist.id)
        )
      );
    } catch (err) {
      console.log('Could not fetch recently played tracks (user may have no listening history):', err.message);
      // Continue without recently played data
    }

    // Get recommendations based on seed artists
    let recommendationsData;
    try {
      recommendationsData = await userSpotifyApi.getRecommendations({
        seed_artists: topArtistIds.slice(0, 5),
        limit: 50
      });
    } catch (err) {
      console.log('Could not fetch recommendations:', err.message);
      // If we can't get recommendations, return empty array
      return res.json({ artists: [] });
    }

    // Filter out artists the user has already listened to
    const newArtists = [];
    const seenArtistIds = new Set();

    for (const track of recommendationsData.body.tracks) {
      for (const artist of track.artists) {
        // Only include if:
        // 1. Not in their top artists
        // 2. Not in their recently played
        // 3. Haven't already added this artist
        if (!topArtistIds.includes(artist.id) &&
            !listenedArtistIds.has(artist.id) &&
            !seenArtistIds.has(artist.id)) {

          // Get full artist details
          try {
            const artistData = await userSpotifyApi.getArtist(artist.id);
            newArtists.push({
              id: artistData.body.id,
              name: artistData.body.name,
              image: artistData.body.images[0]?.url,
              genres: artistData.body.genres,
              popularity: artistData.body.popularity,
              uri: artistData.body.uri
            });
            seenArtistIds.add(artist.id);

            if (newArtists.length >= 10) break;
          } catch (err) {
            console.log('Error fetching artist details:', err.message);
          }
        }
      }
      if (newArtists.length >= 10) break;
    }

    res.json({ artists: newArtists });
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

// Get user profile
app.get('/api/user-profile/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const tokens = await getUserTokens(userId);
    if (!tokens) {
      console.log('No tokens found for userId:', userId);
      // Return basic profile for users without platform connection
      return res.json({
        displayName: 'Music Lover',
        image: null,
        email: null,
        external_urls: { spotify: null },
        followers: { total: 0 },
        href: null,
        uri: null
      });
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
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

  } catch (error) {
    console.error('Error fetching user profile:', error);
    res.status(500).json({
      error: 'Failed to fetch user profile',
      details: error.message
    });
  }
});

// Search Spotify for tracks and artists
app.post('/api/search-spotify', async (req, res) => {
  try {
    const { query, userId } = req.body;

    if (!query) {
      return res.status(400).json({ error: 'Query is required' });
    }

    const tokens = await getUserTokens(userId);
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
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
    const { prompt, userId, platform = 'spotify', allowExplicit = true, newArtistsOnly = false, songCount = 30, excludeTrackUris = [], playlistId = null } = req.body;
    
    if (!prompt) {
      return res.status(400).json({ error: 'Prompt is required' });
    }
    
    // Get user tokens
    const tokens = await getUserTokens(userId);
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
        userTokens.set(userId, tokens);
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

        // Get user's top artists (all time, last 6 months, last 4 weeks)
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

        // Get user's recently played tracks
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

        console.log(`Found ${knownArtists.size} known artists to filter out`);
      } catch (error) {
        console.error('Error fetching listening history:', error);
        // Continue anyway - we'll just not filter
      }
    }

    console.log('Generating playlist for prompt:', prompt);

    // Step 0: Use Claude to extract the genre, style, audio features, AND vibe/context/era from the prompt
    const genreExtractionResponse = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 800,
      messages: [{
        role: 'user',
        content: `Extract the primary genre, key musical characteristics, specific audio features, mood/atmosphere, era/decade, and cultural context from this playlist prompt.

Prompt: "${prompt}"

Respond ONLY with valid JSON in this format:
{
  "primaryGenre": "the main genre (e.g., R&B, hip-hop, pop, rock, etc.) or null if not specified",
  "subgenre": "specific subgenre if mentioned (e.g., '90s West Coast hip-hop', 'neo-soul', 'indie folk', 'trap') or null",
  "secondaryGenres": ["related genres"],
  "keyCharacteristics": ["soulful", "upbeat", "melancholic", etc.],
  "style": "The overall vibe/style (e.g., contemporary, vintage, indie, mainstream, etc.)",
  "atmosphere": ["mood/atmosphere tags - pick from: melancholic, uplifting, aggressive, dreamy, intimate, energetic, relaxed, dark, bright, nostalgic, euphoric, contemplative, romantic, rebellious, peaceful"],
  "era": {
    "decade": "specific decade if mentioned (e.g., '90s', '2000s', '2010s', '2020s') or null",
    "yearRange": { "min": year or null, "max": year or null },
    "descriptors": ["vintage", "classic", "modern", "contemporary", "retro", "current"] or []
  },
  "culturalContext": {
    "region": "geographic/cultural region if mentioned (e.g., 'West Coast', 'Atlanta', 'UK', 'Latin') or null",
    "movement": "cultural movement if applicable (e.g., 'golden age hip-hop', 'Britpop', 'emo') or null",
    "scene": "music scene if mentioned (e.g., 'underground', 'indie', 'mainstream', 'bedroom pop') or null"
  },
  "contextClues": {
    "useCase": "intended use (e.g., 'focus', 'workout', 'party', 'sleep', 'study', 'driving', 'cooking') or null",
    "avoidances": ["what NOT to include - e.g., 'no intense songs', 'no sad songs', 'not too aggressive']
  },
  "audioFeatures": {
    "bpm": { "min": number or null, "max": number or null, "target": number or null },
    "energy": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null },
    "danceability": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null },
    "valence": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null },
    "acousticness": { "min": 0.0-1.0 or null, "max": 0.0-1.0 or null }
  }
}

IMPORTANT GUIDELINES:
- Subgenre: Be VERY specific if a subgenre is mentioned or implied. "R&B" is too broad - look for "90s R&B", "neo-soul", "alternative R&B", "contemporary R&B"
- Atmosphere: Select ALL that apply from the list provided. These describe the EMOTIONAL VIBE of the playlist.
- Era: If user mentions "90s", "from the 2000s", "past 5 years", extract it here. For "past X years", calculate yearRange from current year 2025.
- Cultural Context: Extract geographic regions (West Coast, Atlanta, UK), movements (golden age, new wave), or scenes (indie, underground)
- Context Clues - Use Case: Infer from words like "focus", "workout", "party", "chill", "study" - these are CRITICAL for vibe
- Context Clues - Avoidances: If prompt says "focus" or "study", user wants to AVOID intense/distracting songs even if they normally like them
- Audio features remain the same as before

Audio features guidelines:
- BPM: Extract specific BPM values (e.g., "100 bpm" = target: 100), ranges (e.g., "90-110 bpm"), or infer from descriptors ("fast" = 140-180, "slow" = 60-90, "moderate" = 90-120)
- Energy: 0.0 = calm/quiet, 1.0 = intense/loud. Infer from words like "energetic", "chill", "intense", "relaxed"
- Danceability: 0.0 = not danceable, 1.0 = very danceable. Look for "dance", "party", "club", "workout"
- Valence: 0.0 = sad/negative, 1.0 = happy/positive. Infer from "happy", "sad", "upbeat", "melancholic"
- Acousticness: 0.0 = electronic, 1.0 = acoustic. Look for "acoustic", "unplugged", "electronic", "produced"

Use null or [] for any feature not mentioned or implied.

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
        scene: null
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

    // Step 1: Use Claude to analyze the prompt and generate search queries
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
${newArtistsOnly ? '\nIMPORTANT: The user wants to discover NEW artists they have never listened to before. Focus on emerging, indie, underground, or lesser-known artists in your search queries.' : ''}

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

ERA & CULTURAL CONTEXT:
- Decade: ${genreData.era.decade || 'not specified'} ${genreData.era.decade ? '← MUST stick to this era' : ''}
- Year range: ${genreData.era.yearRange.min || genreData.era.yearRange.max ? `${genreData.era.yearRange.min || 'any'} to ${genreData.era.yearRange.max || 'any'}` : 'not specified'}
- Era descriptors: ${genreData.era.descriptors.join(', ') || 'none'}
- Cultural region: ${genreData.culturalContext.region || 'not specified'} ${genreData.culturalContext.region ? '← Include region-specific queries' : ''}
- Movement: ${genreData.culturalContext.movement || 'not specified'}
- Scene: ${genreData.culturalContext.scene || 'not specified'}

SEARCH QUERY REQUIREMENTS:
- For GENRE-SPECIFIC playlists, include at least 8 genre-specific queries (e.g., for R&B: "R&B singles", "contemporary R&B", "soulful R&B artists")
- If SUBGENRE is specified, ALL queries must target that specific subgenre (e.g., "90s R&B" not just "R&B")
- If DECADE/ERA is specified, add year filters to queries (e.g., "year:1990-1999") or mention the era
- If CULTURAL REGION is specified, include region-specific artists/styles (e.g., "West Coast hip-hop", "UK grime")
- If USE CASE is specified, tailor queries to that context (e.g., "focus" = chill/ambient versions, "workout" = high-energy)
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
    
    // Parse AI response
    let aiData;
    try {
      const responseText = aiResponse.content[0].text.trim();
      aiData = JSON.parse(responseText);
    } catch (parseError) {
      console.error('Failed to parse AI response:', aiResponse.content[0].text);
      return res.status(500).json({ error: 'Failed to parse AI response' });
    }
    
    console.log('AI generated:', aiData);
    
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

    // Step 2: Search for songs based on AI-generated queries
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
                artist: track.artists[0].name,
                uri: track.uri,
                album: track.album.name,
                image: track.album.images[0]?.url,
                previewUrl: track.preview_url,
                externalUrl: track.external_urls.spotify,
                explicit: track.explicit,
                genres: track.artists[0]?.genres || [] // Store artist genres for filtering
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

    console.log(`Found ${allTracks.length} unique tracks before audio features filtering`);

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

    if (hasAudioFeatureFilters && allTracks.length > 0) {
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
          return `${t.name} by ${t.artist}${artistGenres}`;
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

    const trackSelectionPrompt = `From the following list of songs, select ${isSingleArtistPlaylist || hasSpecificArtists ? 'UP TO' : 'the'} ${songCount} BEST songs that match this playlist theme: "${prompt}"

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
- Movement: ${genreData.culturalContext.movement || 'Not specified'}
- Scene: ${genreData.culturalContext.scene || 'Not specified'}

${hasAudioFeatureFilters ? `AUDIO FEATURES:
- These songs have already been pre-filtered to match the requested audio characteristics (BPM, energy, danceability, etc.)` : ''}

Songs available:
${tracksForSelection.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist} (Album: ${t.album})${t.audioFeatures ? ` [BPM: ${t.audioFeatures.bpm}, Energy: ${t.audioFeatures.energy}, Dance: ${t.audioFeatures.danceability}]` : ''} [Artist genres: ${t.genres.join(', ') || 'Unknown'}]`).join('\n')}

Respond ONLY with a JSON array of the indices (1-based) of the songs you select. Select songs that:
${isSingleArtistPlaylist || hasSpecificArtists
  ? `- ONLY include songs by the EXACT artists mentioned in the prompt
- Read the prompt carefully to identify which artists are requested
- For example, if the prompt says "Justin Bieber and One Direction", ONLY select songs where the artist is "Justin Bieber" or "One Direction"
- DO NOT include songs by related or similar artists (e.g., no Harry Styles if only One Direction is requested, no Ariana Grande if only Justin Bieber is requested)
- STRICTLY filter by artist name - the artist field MUST exactly match one of the requested artists
- Include exactly ${songCount} songs if available, or as many as possible from the specified artists`
  : `- STRICTLY match the genre and style indicated in the playlist prompt
- Provide good variety in artists and tempo
- Have strong thematic coherence with the playlist`}
- Are high quality and well-known tracks
- AVOID selecting multiple versions of the same song (e.g., don't include both "Song Title" and "Song Title - Live Version" or "Song Title - A COLORS SHOW")

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

    // If Claude selected fewer tracks than requested, fill up to songCount with remaining tracks
    if (selectedTracks.length < songCount && tracksForSelection.length > selectedTracks.length) {
      console.log(`Claude only selected ${selectedTracks.length}/${songCount} tracks. Auto-filling remaining slots...`);

      // Get indices that were already selected
      const selectedTrackNames = new Set(selectedTracks.map(t => t.name));

      // Add remaining tracks that weren't selected until we hit songCount
      for (const track of tracksForSelection) {
        if (selectedTracks.length >= songCount) break;
        if (!selectedTrackNames.has(track.name)) {
          selectedTracks.push(track);
          selectedTrackNames.add(track.name);
        }
      }

      console.log(`Auto-filled to ${selectedTracks.length} tracks total`);
    }

    // Step 4: VIBE CHECK - Review the selected tracks for coherence
    // This addresses the #1 complaint: AI missing the "vibe" even when genres match
    if (selectedTracks.length > 0 && (genreData.atmosphere.length > 0 || genreData.contextClues.useCase || genreData.era.decade || genreData.subgenre)) {
      console.log('Running vibe check on selected tracks...');

      const vibeCheckPrompt = `You are reviewing a playlist to ensure it has a COHERENT VIBE and emotional atmosphere.

Original user request: "${prompt}"

REQUIRED VIBE/CONTEXT:
- Target atmosphere: ${genreData.atmosphere.join(', ') || 'not specified'}
- Use case: ${genreData.contextClues.useCase || 'not specified'}
- Subgenre: ${genreData.subgenre || 'not specified'}
- Era/decade: ${genreData.era.decade || 'not specified'}
- Avoid: ${genreData.contextClues.avoidances.join('; ') || 'nothing'}

Selected tracks:
${selectedTracks.map((t, i) => `${i + 1}. "${t.name}" by ${t.artist}`).join('\n')}

Review this track list and identify any songs that are TECHNICALLY correct (right genre) but EMOTIONALLY WRONG (don't fit the vibe/atmosphere/context).

For example:
- If use case is "focus" or "study", songs that are too intense/distracting should be removed even if user normally likes them
- If atmosphere is "melancholic" or "dreamy", upbeat party songs should be removed
- If era is "90s", songs from 2020s should be removed
- If subgenre is "neo-soul", trap songs should be removed even if both are R&B

Respond ONLY with valid JSON:
{
  "vibeIssues": [
    {"index": 1, "trackName": "Song Name", "reason": "why it doesn't fit the vibe"},
    ...
  ],
  "keepIndices": [list of indices (1-based) of songs that DO fit the vibe and should be kept]
}

Be strict about vibe coherence. If a song is technically correct but emotionally wrong for this specific context, flag it.

DO NOT include any text outside the JSON.`;

      try {
        const vibeCheckResponse = await anthropic.messages.create({
          model: 'claude-sonnet-4-20250514',
          max_tokens: 1500,
          messages: [{
            role: 'user',
            content: vibeCheckPrompt
          }]
        });

        const vibeCheckText = vibeCheckResponse.content[0].text.trim();
        const vibeCheckData = JSON.parse(vibeCheckText);

        if (vibeCheckData.vibeIssues && vibeCheckData.vibeIssues.length > 0) {
          console.log(`Vibe check found ${vibeCheckData.vibeIssues.length} tracks that don't fit the vibe:`);
          vibeCheckData.vibeIssues.forEach(issue => {
            console.log(`  - "${issue.trackName}": ${issue.reason}`);
          });

          // Filter to only keep tracks that passed the vibe check
          selectedTracks = vibeCheckData.keepIndices
            .map(index => selectedTracks[index - 1])
            .filter(track => track !== undefined);

          console.log(`After vibe check: ${selectedTracks.length} tracks remain`);

          // Auto-fill to requested count if vibe check removed tracks
          if (selectedTracks.length < songCount && tracksForSelection.length > selectedTracks.length) {
            console.log(`Vibe check reduced track count to ${selectedTracks.length}/${songCount}. Auto-filling remaining slots...`);

            const selectedTrackNames = new Set(selectedTracks.map(t => t.name));

            // Add remaining tracks that weren't selected until we hit songCount
            for (const track of tracksForSelection) {
              if (selectedTracks.length >= songCount) break;
              if (!selectedTrackNames.has(track.name)) {
                selectedTracks.push(track);
                selectedTrackNames.add(track.name);
              }
            }

            console.log(`Auto-filled to ${selectedTracks.length} tracks total after vibe check`);
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

    res.json({
      playlistName: aiData.playlistName,
      description: aiData.description,
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
    const { userId, playlistName, description, trackUris, updateFrequency, updateMode, isPublic, prompt } = req.body;

    console.log('Create playlist request:', {
      userId,
      playlistName,
      trackCount: trackUris?.length,
      updateFrequency,
      updateMode,
      isPublic
    });

    const tokens = await getUserTokens(userId);
    if (!tokens) {
      console.error('No tokens found for userId:', userId);
      console.log('Available userIds:', Array.from(userTokens.keys()));
      return res.status(401).json({ error: 'User not authenticated' });
    }

    console.log('Found tokens for user, creating Spotify API instance...');

    // Create a new instance for this user to avoid conflicts
    const userSpotifyApi = new SpotifyWebApi({
      clientId: process.env.SPOTIFY_CLIENT_ID,
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET,
      redirectUri: process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback'
    });

    userSpotifyApi.setAccessToken(tokens.access_token);
    userSpotifyApi.setRefreshToken(tokens.refresh_token);

    // Try to refresh the access token if it's expired
    try {
      console.log('Refreshing access token...');
      const refreshData = await userSpotifyApi.refreshAccessToken();
      const newAccessToken = refreshData.body.access_token;
      userSpotifyApi.setAccessToken(newAccessToken);

      // Update stored tokens
      tokens.access_token = newAccessToken;
      userTokens.set(userId, tokens);
      saveTokens(); // Persist to file

      console.log('Access token refreshed successfully');
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
      // Continue anyway - token might still be valid
    }

    console.log('Getting Spotify user ID...');

    // Get user's Spotify ID
    const meData = await userSpotifyApi.getMe();

    if (!meData || !meData.body) {
      throw new Error('Failed to get user data from Spotify. Response: ' + JSON.stringify(meData));
    }

    const spotifyUserId = meData.body.id;

    console.log('Spotify user ID:', spotifyUserId);
    console.log('Creating playlist with name:', playlistName);

    // Create playlist - the third parameter must be an options object, not part of createPlaylist params
    let playlistData;
    try {
      playlistData = await userSpotifyApi.createPlaylist(playlistName, {
        description: description,
        public: isPublic !== undefined ? isPublic : true
      });
      console.log('createPlaylist raw response:', JSON.stringify(playlistData));
    } catch (createError) {
      console.error('createPlaylist threw error:', createError);
      throw new Error('Spotify createPlaylist error: ' + createError.message);
    }

    if (!playlistData || !playlistData.body) {
      throw new Error('Failed to create playlist on Spotify. Response was undefined or missing body property');
    }

    const playlistId = playlistData.body.id;
    console.log('Playlist created with ID:', playlistId);
    console.log('Adding', trackUris.length, 'tracks to playlist...');

    // Add tracks to playlist
    await userSpotifyApi.addTracksToPlaylist(playlistId, trackUris);

    console.log('Playlist created successfully!');

    // Store playlist in history
    const playlistRecord = {
      playlistId: playlistId,
      playlistName: playlistName,
      description: description,
      trackUris: trackUris,
      trackCount: trackUris.length,
      createdAt: new Date().toISOString(),
      spotifyUrl: playlistData.body.external_urls.spotify,
      updateFrequency: updateFrequency || 'never',
      updateMode: updateMode || 'append',
      isPublic: isPublic !== undefined ? isPublic : true,
      originalPrompt: prompt,
      refinementInstructions: [], // Initialize empty array for refinements
      excludedSongs: [], // Track individual songs user removed (format: "trackId")
      excludedArtists: [], // Track artists user doesn't want (auto-populated when all songs from artist removed)
      lastUpdated: null,
      nextUpdate: updateFrequency && updateFrequency !== 'never' ? calculateNextUpdate(updateFrequency, playlistData.body.id) : null,
      tracks: []
    };

    // Get user's playlists array or create new one
    const userPlaylistHistory = userPlaylists.get(userId) || [];
    userPlaylistHistory.push(playlistRecord);
    userPlaylists.set(userId, userPlaylistHistory);
    savePlaylists();

    console.log('Playlist saved to history');

    res.json({
      success: true,
      playlistUrl: playlistData.body.external_urls.spotify,
      playlistId: playlistId
    });

  } catch (error) {
    console.error('Error creating playlist:', error);
    console.error('Error details:', {
      message: error.message,
      statusCode: error.statusCode,
      body: error.body
    });
    res.status(500).json({
      error: 'Failed to create playlist',
      details: error.message,
      statusCode: error.statusCode
    });
  }
});

// Get user's playlist history
app.get('/api/playlists/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const userPlaylistHistory = userPlaylists.get(userId) || [];

    // For each playlist, fetch current track details from Spotify
    const tokens = await getUserTokens(userId);
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
    }

    // Fetch detailed track info for each playlist
    const playlistsWithDetails = await Promise.all(
      userPlaylistHistory.map(async (playlist) => {
        try {
          // Get playlist details from Spotify
          const playlistDetails = await userSpotifyApi.getPlaylist(playlist.playlistId);
          const tracks = playlistDetails.body.tracks.items.map(item => ({
            id: item.track.id,
            name: item.track.name,
            artist: item.track.artists[0].name,
            uri: item.track.uri,
            album: item.track.album.name,
            image: item.track.album.images[0]?.url,
            externalUrl: item.track.external_urls.spotify
          }));

          return {
            ...playlist,
            tracks: tracks,
            trackCount: tracks.length
          };
        } catch (error) {
          console.error(`Error fetching playlist ${playlist.playlistId}:`, error.message);
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
app.get('/api/spotify-playlists/:userId', async (req, res) => {
  try {
    const { userId } = req.params;

    const tokens = await getUserTokens(userId);
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
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
      isOwner: playlist.owner.id === userId.replace('spotify_', '')
    }));

    res.json({ playlists });
  } catch (error) {
    console.error('Error fetching Spotify playlists:', error.message || error);
    console.error('Full error:', error);
    res.status(500).json({
      error: 'Failed to fetch Spotify playlists',
      details: error.message || 'Unknown error',
      stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
    });
  }
});

// Import a Spotify playlist
app.post('/api/import-playlist', async (req, res) => {
  try {
    const { userId, playlistId } = req.body;

    const tokens = await getUserTokens(userId);
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
    } catch (refreshError) {
      console.log('Token refresh failed or not needed:', refreshError.message);
    }

    // Get playlist details
    const playlistDetails = await userSpotifyApi.getPlaylist(playlistId);
    const trackUris = playlistDetails.body.tracks.items.map(item => item.track.uri);

    // Store in user's playlist history
    const playlistRecord = {
      playlistId: playlistId,
      playlistName: playlistDetails.body.name,
      description: playlistDetails.body.description || '',
      image: playlistDetails.body.images?.length > 0 ? playlistDetails.body.images[0].url : null,
      trackUris: trackUris,
      trackCount: trackUris.length,
      createdAt: new Date().toISOString(),
      spotifyUrl: playlistDetails.body.external_urls.spotify,
      imported: true
    };

    const userPlaylistHistory = userPlaylists.get(userId) || [];

    // Check if already imported
    const alreadyImported = userPlaylistHistory.some(p => p.playlistId === playlistId);
    if (alreadyImported) {
      return res.status(400).json({ error: 'Playlist already imported' });
    }

    userPlaylistHistory.push(playlistRecord);
    userPlaylists.set(userId, userPlaylistHistory);
    savePlaylists();

    console.log('Playlist imported:', playlistId);

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
    const { userId } = req.query;

    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }

    const tokens = await getUserTokens(userId);
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
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
    const { userId, tracksToAdd, tracksToRemove } = req.body;

    console.log('Update playlist endpoint:', {
      playlistId,
      tracksToRemove: tracksToRemove?.length || 0,
      tracksToAdd: tracksToAdd?.length || 0,
      removeSample: tracksToRemove?.slice(0, 2),
      addSample: tracksToAdd?.slice(0, 2)
    });

    const tokens = await getUserTokens(userId);
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
      userTokens.set(userId, tokens);
      // Save updated token to database
      await db.updateAccessToken(userId, newAccessToken);
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
        const validTracksToRemove = tracksToRemove.filter(isValidSpotifyTrackUri);

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
      savePlaylists();
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
    const { userId, updateFrequency, updateMode, isPublic, updateTime } = req.body;

    console.log('Update settings request:', { playlistId, userId, updateFrequency, updateMode, isPublic, updateTime });

    // Get user's playlist history
    const userPlaylistHistory = userPlaylists.get(userId) || [];

    // Find the playlist
    const playlistIndex = userPlaylistHistory.findIndex(p => p.playlistId === playlistId);
    if (playlistIndex === -1) {
      return res.status(404).json({ error: 'Playlist not found' });
    }

    // If isPublic setting changed, update it on Spotify
    if (isPublic !== undefined && isPublic !== userPlaylistHistory[playlistIndex].isPublic) {
      const tokens = await getUserTokens(userId);
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
          userTokens.set(userId, tokens);
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
    savePlaylists();

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
    savePlaylists();

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
    savePlaylists();

    // Also remove from Spotify if the playlist exists there
    try {
      const tokens = await getUserTokens(userId);
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
          userTokens.set(userId, tokens);
          await db.updateAccessToken(userId, refreshData.body.access_token);
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
    savePlaylists();

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
                  savePlaylists();

                  continue; // Skip this playlist and move to the next one
                }
              }

              console.log(`[AUTO-UPDATE] Updating playlist: ${playlist.playlistName} (${playlist.playlistId})`);

              try {
                // Get the playlist's original prompt or use the name as fallback
                let prompt = playlist.originalPrompt || `Generate songs similar to: ${playlist.playlistName}`;

                // Add any refinement instructions the user has provided
                if (playlist.refinementInstructions && playlist.refinementInstructions.length > 0) {
                  prompt += '. ' + playlist.refinementInstructions.join('. ');
                  console.log(`[AUTO-UPDATE] Applied ${playlist.refinementInstructions.length} refinement instruction(s)`);
                }

                // Ensure tracks array exists
                if (!playlist.tracks) {
                  playlist.tracks = [];
                }

                // If we have current tracks, enhance the prompt to make sure new songs are similar
                if (playlist.tracks.length > 0) {
                  const topTracks = playlist.tracks.slice(0, 5).map(t => t.name).join(', ');
                  prompt = `${prompt}. Reference tracks: ${topTracks}`;
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
                  const tokens = await getUserTokens(userId);

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
                        userTokens.set(userId, tokens);
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
                          console.log(`[AUTO-UPDATE] Year filter from ${source}: only songs from ${minYear} or later (last ${years} years)`);
                        }
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

                    // Filter tracks based on year, artist exclusions, and song exclusions
                    const excludedSongIds = new Set(playlist.excludedSongs || []);

                    if (minYear !== null || excludedArtists.length > 0 || excludedSongIds.size > 0) {
                      const beforeFilter = genreFilteredResults.length;
                      genreFilteredResults = genreFilteredResults.filter(track => {
                        // Check if this specific song was excluded
                        if (excludedSongIds.has(track.id)) {
                          console.log(`[AUTO-UPDATE] Filtered out excluded song: ${track.name}`);
                          return false;
                        }

                        // Check year constraint
                        if (minYear !== null && track.album && track.album.release_date) {
                          const releaseYear = parseInt(track.album.release_date.substring(0, 4));
                          if (releaseYear < minYear) {
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
                      console.log(`[AUTO-UPDATE] Applied filters: ${beforeFilter} tracks -> ${genreFilteredResults.length} tracks (excluded ${excludedSongIds.size} songs, ${excludedArtists.length} artists)`);
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

                // Get user tokens
                const tokens = await getUserTokens(userId);
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
                savePlaylists();

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

    app.listen(PORT, () => {
      console.log(`🎵 AI Playlist Creator Backend running on port ${PORT}`);
      console.log(`📝 Make sure to set up your .env file with API credentials`);

      // Start the auto-update scheduler
      scheduleAutoUpdates();
      console.log(`⏰ Auto-update scheduler started`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

startServer();
