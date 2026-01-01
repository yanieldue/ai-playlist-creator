const axios = require('axios');

/**
 * Apple Music API Service
 * Provides methods to interact with Apple Music API
 * Requires developer token (JWT) and user music token
 */
class AppleMusicService {
  constructor(developerToken) {
    this.developerToken = developerToken;
    this.baseUrl = 'https://api.music.apple.com/v1';
  }

  /**
   * Make authenticated request to Apple Music API
   */
  async request(endpoint, userToken, options = {}) {
    const headers = {
      'Authorization': `Bearer ${this.developerToken}`,
      'Content-Type': 'application/json'
    };

    // Add user music token if provided
    if (userToken) {
      headers['Music-User-Token'] = userToken;
    }

    try {
      const response = await axios({
        method: options.method || 'GET',
        url: `${this.baseUrl}${endpoint}`,
        headers,
        data: options.data,
        params: options.params
      });

      return response.data;
    } catch (error) {
      console.error('Apple Music API Error:', error.response?.data || error.message);
      throw {
        status: error.response?.status,
        message: error.response?.data?.errors?.[0]?.detail || error.message,
        code: error.response?.data?.errors?.[0]?.code
      };
    }
  }

  /**
   * Get user's storefront (country code)
   * Required for catalog searches
   */
  async getUserStorefront(userToken) {
    const data = await this.request('/me/storefront', userToken);
    return data.data[0].id; // e.g., 'us', 'gb', 'jp'
  }

  /**
   * Search for tracks in Apple Music catalog
   * @param {string} query - Search query
   * @param {string} storefront - Country code (e.g., 'us')
   * @param {number} limit - Number of results (default: 25)
   */
  async searchTracks(query, storefront, limit = 25) {
    const data = await this.request(`/catalog/${storefront}/search`, null, {
      params: {
        term: query,
        types: 'songs',
        limit
      }
    });

    if (!data.results?.songs?.data) {
      return [];
    }

    // Normalize to match Spotify format
    return data.results.songs.data.map(track => ({
      id: track.id,
      name: track.attributes.name,
      uri: `apple:track:${track.id}`,
      artists: [{
        name: track.attributes.artistName
      }],
      album: {
        name: track.attributes.albumName,
        images: track.attributes.artwork ? [{
          url: track.attributes.artwork.url
            .replace('{w}', '640')
            .replace('{h}', '640')
        }] : []
      },
      duration_ms: track.attributes.durationInMillis,
      preview_url: track.attributes.previews?.[0]?.url || null,
      platform: 'apple',
      isrc: track.attributes.isrc,
      url: track.attributes.url
    }));
  }

  /**
   * Get user's library playlists
   * @param {string} userToken - User's music token
   */
  async getPlaylists(userToken) {
    const data = await this.request('/me/library/playlists', userToken, {
      params: {
        limit: 100
      }
    });

    if (!data.data) {
      return [];
    }

    return data.data.map(playlist => ({
      id: playlist.id,
      name: playlist.attributes.name,
      description: playlist.attributes.description?.standard || '',
      tracks: {
        total: playlist.attributes.hasCatalog ?
          (playlist.relationships?.tracks?.data?.length || 0) : 0
      },
      platform: 'apple',
      url: null, // Apple Music library playlists don't have public URLs
      canEdit: playlist.attributes.canEdit
    }));
  }

  /**
   * Create a new playlist in user's library
   * @param {string} userToken - User's music token
   * @param {string} name - Playlist name
   * @param {string} description - Playlist description
   */
  async createPlaylist(userToken, name, description = '') {
    const data = await this.request('/me/library/playlists', userToken, {
      method: 'POST',
      data: {
        attributes: {
          name,
          description
        }
      }
    });

    return {
      id: data.data[0].id,
      name: data.data[0].attributes.name,
      platform: 'apple'
    };
  }

  /**
   * Get tracks in a playlist
   * @param {string} userToken - User's music token
   * @param {string} playlistId - Playlist ID
   */
  async getPlaylistTracks(userToken, playlistId) {
    const data = await this.request(
      `/me/library/playlists/${playlistId}/tracks`,
      userToken,
      {
        params: {
          limit: 100
        }
      }
    );

    if (!data.data) {
      return [];
    }

    return data.data.map(track => ({
      id: track.id,
      name: track.attributes.name,
      uri: `apple:track:${track.id}`,
      artists: [{
        name: track.attributes.artistName
      }],
      album: {
        name: track.attributes.albumName
      },
      duration_ms: track.attributes.durationInMillis,
      platform: 'apple'
    }));
  }

  /**
   * Add tracks to a playlist
   * @param {string} userToken - User's music token
   * @param {string} playlistId - Playlist ID
   * @param {Array<string>} trackIds - Array of track IDs (not URIs)
   */
  async addTracksToPlaylist(userToken, playlistId, trackIds) {
    // Convert URIs to IDs if needed
    const ids = trackIds.map(track => {
      if (typeof track === 'string' && track.startsWith('apple:track:')) {
        return track.replace('apple:track:', '');
      }
      return track;
    });

    const data = await this.request(
      `/me/library/playlists/${playlistId}/tracks`,
      userToken,
      {
        method: 'POST',
        data: {
          data: ids.map(id => ({
            id,
            type: 'songs'
          }))
        }
      }
    );

    return { success: true };
  }

  /**
   * Remove tracks from a playlist
   * Note: Apple Music uses different approach - need to delete by track library ID
   * @param {string} userToken - User's music token
   * @param {string} playlistId - Playlist ID
   * @param {Array<string>} trackIds - Array of track library IDs
   */
  async removeTracksFromPlaylist(userToken, playlistId, trackIds) {
    // Apple Music requires library track IDs, not catalog IDs
    // This is a limitation - we may need to get the full playlist first
    // and match by catalog ID to find library ID

    const ids = trackIds.map(track => {
      if (typeof track === 'string' && track.startsWith('apple:track:')) {
        return track.replace('apple:track:', '');
      }
      return track;
    });

    // Note: Apple Music API doesn't have a direct "remove tracks" endpoint
    // We would need to get all tracks, filter out the ones to remove,
    // and recreate the playlist order. For now, throw not implemented.
    throw new Error('Remove tracks not yet implemented for Apple Music');
  }

  /**
   * Get a specific track by ID
   * @param {string} trackId - Track ID
   * @param {string} storefront - Country code
   */
  async getTrack(trackId, storefront) {
    const data = await this.request(`/catalog/${storefront}/songs/${trackId}`, null);

    if (!data.data || data.data.length === 0) {
      return null;
    }

    const track = data.data[0];
    return {
      id: track.id,
      name: track.attributes.name,
      uri: `apple:track:${track.id}`,
      artists: [{
        name: track.attributes.artistName
      }],
      album: {
        name: track.attributes.albumName,
        images: track.attributes.artwork ? [{
          url: track.attributes.artwork.url
            .replace('{w}', '640')
            .replace('{h}', '640')
        }] : []
      },
      duration_ms: track.attributes.durationInMillis,
      platform: 'apple'
    };
  }

  /**
   * Search for a track by name and artist (used for Spotify -> Apple Music conversion)
   * @param {string} trackName - Track name
   * @param {string} artistName - Artist name
   * @param {string} storefront - Country code
   */
  async findTrackByNameAndArtist(trackName, artistName, storefront) {
    const query = `${trackName} ${artistName}`;
    const results = await this.searchTracks(query, storefront, 5);

    if (results.length === 0) {
      return null;
    }

    // Return first result (best match)
    // In production, you might want to implement fuzzy matching
    return results[0];
  }
}

module.exports = AppleMusicService;
