/**
 * Platform Utilities
 * Helper functions for detecting and managing music platforms (Spotify, Apple Music)
 */

/**
 * Detect platform from userId
 * @param {string} userId - User ID (spotify_xxx or apple_music_xxx)
 * @returns {string} 'spotify' | 'apple' | 'unknown'
 */
export const getPlatformFromUserId = (userId) => {
  if (!userId) return 'unknown';

  if (userId.startsWith('spotify_')) {
    return 'spotify';
  }

  if (userId.startsWith('apple_music_')) {
    return 'apple';
  }

  return 'unknown';
};

/**
 * Get platform display name
 * @param {string} platform - 'spotify' | 'apple'
 * @returns {string} Display name
 */
export const getPlatformDisplayName = (platform) => {
  const names = {
    spotify: 'Spotify',
    apple: 'Apple Music',
    unknown: 'Unknown Platform'
  };

  return names[platform] || names.unknown;
};

/**
 * Get user's connected platforms from localStorage
 * @param {string} userEmail - User's email
 * @returns {Array<string>} Array of connected platforms ['spotify', 'apple']
 */
export const getConnectedPlatforms = (userEmail) => {
  try {
    // Check localStorage for stored connection info
    const spotifyUserId = localStorage.getItem('spotifyUserId');
    const appleMusicUserId = localStorage.getItem('appleMusicUserId');

    const platforms = [];
    if (spotifyUserId) platforms.push('spotify');
    if (appleMusicUserId) platforms.push('apple');

    return platforms;
  } catch (error) {
    console.error('Error getting connected platforms:', error);
    return [];
  }
};

/**
 * Get userId for specific platform
 * @param {string} platform - 'spotify' | 'apple'
 * @returns {string|null} UserId or null
 */
export const getUserIdForPlatform = (platform) => {
  if (platform === 'spotify') {
    return localStorage.getItem('spotifyUserId');
  }

  if (platform === 'apple') {
    return localStorage.getItem('appleMusicUserId');
  }

  return null;
};

/**
 * Store userId for platform
 * @param {string} platform - 'spotify' | 'apple'
 * @param {string} userId - User ID
 */
export const setUserIdForPlatform = (platform, userId) => {
  if (platform === 'spotify') {
    localStorage.setItem('spotifyUserId', userId);
  } else if (platform === 'apple') {
    localStorage.setItem('appleMusicUserId', userId);
  }
};

/**
 * Get active userId (current or selected platform)
 * @param {string} selectedPlatform - Currently selected platform
 * @returns {string|null} Active userId
 */
export const getActiveUserId = (selectedPlatform) => {
  // First check if there's a general userId (for single-platform users)
  const generalUserId = localStorage.getItem('userId');
  if (generalUserId) {
    const platform = getPlatformFromUserId(generalUserId);
    if (platform !== 'unknown') {
      return generalUserId;
    }
  }

  // For dual-platform users, use selected platform
  if (selectedPlatform) {
    return getUserIdForPlatform(selectedPlatform);
  }

  // Fallback: return first available platform
  const spotifyId = localStorage.getItem('spotifyUserId');
  const appleId = localStorage.getItem('appleMusicUserId');

  return spotifyId || appleId || null;
};

/**
 * Check if feature is supported on platform
 * @param {string} feature - Feature name
 * @param {string} platform - 'spotify' | 'apple'
 * @returns {boolean}
 */
export const isPlatformFeatureSupported = (feature, platform) => {
  const featureSupport = {
    topArtists: {
      spotify: true,
      apple: false  // Apple Music doesn't have top artists API
    },
    newArtists: {
      spotify: true,
      apple: false
    },
    autoRefresh: {
      spotify: true,
      apple: true
    },
    publicPlaylists: {
      spotify: true,
      apple: false  // Apple Music library playlists are private
    }
  };

  return featureSupport[feature]?.[platform] ?? false;
};
