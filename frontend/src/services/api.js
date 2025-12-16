import axios from 'axios';
import { createErrorLog } from '../utils/errorHandler';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 60000, // 60 second timeout for long-running requests like playlist generation
});

// Error interceptor
api.interceptors.response.use(
  (response) => response,
  (error) => {
    const errorLog = createErrorLog(error, {
      timestamp: new Date().toISOString(),
      userAgent: navigator.userAgent,
    });

    // Log critical errors to backend for developer notification
    if (errorLog.shouldNotify) {
      // Send error to backend for logging and email notification
      axios.post(`${API_BASE_URL}/api/log-error`, {
        errorLog,
      }).catch((logError) => {
        // Silently fail if error logging fails
        console.error('Failed to log error:', logError);
      });
    }

    // Store error in sessionStorage for debugging
    try {
      const errors = JSON.parse(sessionStorage.getItem('appErrors') || '[]');
      errors.push(errorLog);
      // Keep only last 50 errors
      if (errors.length > 50) {
        errors.shift();
      }
      sessionStorage.setItem('appErrors', JSON.stringify(errors));
    } catch (e) {
      console.error('Failed to store error log:', e);
    }

    // Re-throw with error log attached
    error.errorLog = errorLog;
    throw error;
  }
);

export const playlistService = {
  // Get Spotify authorization URL
  getSpotifyAuthUrl: async (userEmail = null) => {
    let url = '/api/auth/spotify';
    if (userEmail) {
      url += `?email=${encodeURIComponent(userEmail)}`;
    }
    const response = await api.get(url);
    return response.data;
  },

  // Get Apple Music authorization URL
  getAppleMusicAuthUrl: async (userEmail = null) => {
    let url = '/api/auth/apple';
    if (userEmail) {
      url += `?email=${encodeURIComponent(userEmail)}`;
    }
    const response = await api.get(url);
    return response.data;
  },

  // User signup
  signup: async (email, password, platform) => {
    const response = await api.post('/api/signup', {
      email: email.trim().toLowerCase(),
      password,
      platform,
    });
    return response.data;
  },

  // User login
  login: async (email, password) => {
    const response = await api.post('/api/login', {
      email: email.trim().toLowerCase(),
      password,
    });
    return response.data;
  },

  // Generate playlist using AI
  generatePlaylist: async (prompt, userId, platform = 'spotify', allowExplicit = true, newArtistsOnly = false, songCount = 30, excludeTrackUris = [], playlistId = null) => {
    const response = await api.post('/api/generate-playlist', {
      prompt,
      userId,
      platform,
      allowExplicit,
      newArtistsOnly,
      songCount,
      excludeTrackUris,
      playlistId,
    });
    return response.data;
  },

  // Search Spotify for tracks and artists
  searchSpotify: async (query, userId) => {
    const response = await api.post('/api/search-spotify', {
      query,
      userId,
    });
    return response.data;
  },

  // Get user's top artists
  getTopArtists: async (userId) => {
    const response = await api.get(`/api/top-artists/${userId}`);
    return response.data;
  },

  // Get new artist recommendations
  getNewArtists: async (userId) => {
    const response = await api.get(`/api/new-artists/${userId}`);
    return response.data;
  },

  // Create playlist on Spotify
  createPlaylist: async (userId, playlistName, description, trackUris, updateFrequency, updateMode, isPublic, prompt) => {
    const response = await api.post('/api/create-playlist', {
      userId,
      playlistName,
      description,
      trackUris,
      updateFrequency,
      updateMode,
      isPublic,
      prompt,
    });
    return response.data;
  },

  // Get user's playlist history
  getUserPlaylists: async (userId) => {
    const response = await api.get(`/api/playlists/${userId}`);
    return response.data;
  },

  // Get current tracks for a playlist from Spotify
  getPlaylistTracks: async (playlistId, userId) => {
    const response = await api.get(`/api/playlists/${playlistId}/tracks?userId=${userId}`);
    return response.data;
  },

  // Update playlist (add/remove tracks)
  updatePlaylist: async (playlistId, userId, tracksToAdd, tracksToRemove) => {
    const response = await api.post(`/api/playlists/${playlistId}/update`, {
      userId,
      tracksToAdd,
      tracksToRemove,
    });
    return response.data;
  },

  // Exclude a song from playlist (immediate removal + learning)
  excludeSong: async (playlistId, userId, trackId, trackUri, artistName) => {
    const response = await api.post(`/api/playlists/${playlistId}/exclude-song`, {
      userId,
      trackId,
      trackUri,
      artistName,
    });
    return response.data;
  },

  // Health check
  healthCheck: async () => {
    const response = await api.get('/api/health');
    return response.data;
  },

  // Get user's Spotify playlists for import
  getSpotifyPlaylists: async (userId) => {
    const response = await api.get(`/api/spotify-playlists/${userId}`);
    return response.data;
  },

  // Import a Spotify playlist
  importPlaylist: async (userId, playlistId) => {
    const response = await api.post('/api/import-playlist', {
      userId,
      playlistId,
    });
    return response.data;
  },

  // Get user profile
  getUserProfile: async (userId) => {
    const response = await api.get(`/api/user-profile/${userId}`);
    return response.data;
  },

  // Update playlist settings (auto-update frequency, mode, and privacy)
  updatePlaylistSettings: async (playlistId, userId, updateFrequency, updateMode, isPublic, updateTime = null) => {
    const response = await api.put(`/api/playlists/${playlistId}/settings`, {
      userId,
      updateFrequency,
      updateMode,
      isPublic,
      updateTime,
    });
    return response.data;
  },

  // Search for users and playlists
  search: async (query, userId) => {
    const response = await api.post('/api/search', {
      query,
      userId,
    });
    return response.data;
  },

  // Get user account info
  getAccountInfo: async (email) => {
    const response = await api.get(`/api/account/${email}`);
    return response.data;
  },

  // Update user email
  updateEmail: async (currentEmail, newEmail, password) => {
    const response = await api.put('/api/account/email', {
      currentEmail,
      newEmail,
      password,
    });
    return response.data;
  },

  // Update user password
  updatePassword: async (email, currentPassword, newPassword) => {
    const response = await api.put('/api/account/password', {
      email,
      currentPassword,
      newPassword,
    });
    return response.data;
  },

  // Update music platform (legacy single platform)
  updatePlatform: async (email, platform) => {
    const response = await api.put('/api/account/platform', {
      email,
      platform,
    });
    return response.data;
  },

  // Update multiple music platforms
  updatePlatforms: async (email, platforms) => {
    const response = await api.put('/api/account/platforms', {
      email,
      platforms,
    });
    return response.data;
  },

  // Create user account (for users who skip platform selection)
  createUserAccount: async (email) => {
    const response = await api.post('/api/account/create', {
      email,
    });
    return response.data;
  },
};

export default playlistService;
