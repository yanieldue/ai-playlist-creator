const SpotifyWebApi = require('spotify-web-api-node');
const AppleMusicService = require('./appleMusicService');

/**
 * Platform Service - Unified abstraction for Spotify and Apple Music
 * Routes API calls to the appropriate platform based on userId prefix
 */
class PlatformService {
  constructor() {
    this.spotifyClientId = process.env.SPOTIFY_CLIENT_ID;
    this.spotifyClientSecret = process.env.SPOTIFY_CLIENT_SECRET;
    this.spotifyRedirectUri = process.env.SPOTIFY_REDIRECT_URI || 'http://127.0.0.1:3001/callback';
  }

  /**
   * Detect platform from userId
   * @param {string} userId - User ID (spotify_xxx or apple_music_xxx)
   * @returns {string} 'spotify' or 'apple'
   */
  getPlatform(userId) {
    if (!userId) {
      throw new Error('userId is required');
    }

    if (userId.startsWith('spotify_')) {
      return 'spotify';
    }

    if (userId.startsWith('apple_music_')) {
      return 'apple';
    }

    throw new Error(`Unknown platform for userId: ${userId}`);
  }

  /**
   * Get Spotify API instance configured for user
   * @param {Object} tokens - User's Spotify tokens
   * @returns {SpotifyWebApi}
   */
  getSpotifyApi(tokens) {
    const spotifyApi = new SpotifyWebApi({
      clientId: this.spotifyClientId,
      clientSecret: this.spotifyClientSecret,
      redirectUri: this.spotifyRedirectUri
    });

    spotifyApi.setAccessToken(tokens.access_token);
    if (tokens.refresh_token) {
      spotifyApi.setRefreshToken(tokens.refresh_token);
    }

    return spotifyApi;
  }

  /**
   * Get Apple Music API instance
   * @param {Object} tokens - User's Apple Music tokens
   * @returns {AppleMusicService}
   */
  getAppleMusicApi(tokens) {
    return new AppleMusicService(tokens.developer_token);
  }

  /**
   * Refresh Spotify access token
   * @param {SpotifyWebApi} spotifyApi - Spotify API instance
   * @param {Object} tokens - User's tokens
   * @param {Function} updateTokens - Callback to update stored tokens
   */
  async refreshSpotifyToken(spotifyApi, tokens, updateTokens) {
    try {
      const refreshData = await spotifyApi.refreshAccessToken();
      const newAccessToken = refreshData.body.access_token;
      spotifyApi.setAccessToken(newAccessToken);

      // Update tokens
      tokens.access_token = newAccessToken;
      if (updateTokens) {
        await updateTokens(newAccessToken);
      }

      return true;
    } catch (error) {
      console.log('Spotify token refresh failed:', error.message);
      return false;
    }
  }

  /**
   * Search for tracks
   * @param {string} userId - User ID
   * @param {string} query - Search query
   * @param {Object} tokens - User's tokens
   * @param {string} storefront - Apple Music storefront (optional)
   * @param {number} limit - Number of results
   */
  async searchTracks(userId, query, tokens, storefront = 'us', limit = 25) {
    const platform = this.getPlatform(userId);

    if (platform === 'spotify') {
      const spotifyApi = this.getSpotifyApi(tokens);
      await this.refreshSpotifyToken(spotifyApi, tokens);

      const data = await spotifyApi.searchTracks(query, { limit });

      return data.body.tracks.items.map(track => ({
        id: track.id,
        name: track.name,
        uri: track.uri,
        artists: track.artists.map(artist => ({
          name: artist.name,
          id: artist.id
        })),
        album: {
          name: track.album.name,
          images: track.album.images
        },
        duration_ms: track.duration_ms,
        preview_url: track.preview_url,
        platform: 'spotify',
        external_urls: track.external_urls
      }));
    }

    if (platform === 'apple') {
      const appleMusicApi = this.getAppleMusicApi(tokens);
      const userStorefront = storefront || tokens.storefront || 'us';

      return await appleMusicApi.searchTracks(query, userStorefront, limit);
    }
  }

  /**
   * Create a playlist
   * @param {string} userId - User ID
   * @param {string} name - Playlist name
   * @param {string} description - Playlist description
   * @param {Array<string>} trackUris - Array of track URIs
   * @param {Object} tokens - User's tokens
   * @param {boolean} isPublic - Whether playlist is public (Spotify only)
   */
  async createPlaylist(userId, name, description, trackUris, tokens, isPublic = true) {
    const platform = this.getPlatform(userId);

    if (platform === 'spotify') {
      const spotifyApi = this.getSpotifyApi(tokens);
      await this.refreshSpotifyToken(spotifyApi, tokens);

      // Get Spotify user ID
      const meData = await spotifyApi.getMe();
      const spotifyUserId = meData.body.id;

      // Create playlist
      const playlistData = await spotifyApi.createPlaylist(name, {
        description,
        public: isPublic
      });

      const playlistId = playlistData.body.id;

      // Add tracks
      if (trackUris && trackUris.length > 0) {
        await spotifyApi.addTracksToPlaylist(playlistId, trackUris);
      }

      return {
        id: playlistId,
        name: playlistData.body.name,
        description: playlistData.body.description,
        url: playlistData.body.external_urls.spotify,
        platform: 'spotify',
        trackCount: trackUris.length
      };
    }

    if (platform === 'apple') {
      const appleMusicApi = this.getAppleMusicApi(tokens);

      // Create playlist
      const playlist = await appleMusicApi.createPlaylist(
        tokens.access_token, // user music token
        name,
        description
      );

      // Add tracks
      if (trackUris && trackUris.length > 0) {
        const trackIds = trackUris.map(uri =>
          uri.replace('apple:track:', '')
        );

        await appleMusicApi.addTracksToPlaylist(
          tokens.access_token,
          playlist.id,
          trackIds
        );
      }

      return {
        id: playlist.id,
        name: playlist.name,
        description,
        url: null, // Apple Music library playlists don't have public URLs
        platform: 'apple',
        trackCount: trackUris.length
      };
    }
  }

  /**
   * Get user's playlists
   * @param {string} userId - User ID
   * @param {Object} tokens - User's tokens
   */
  async getPlaylists(userId, tokens) {
    const platform = this.getPlatform(userId);

    if (platform === 'spotify') {
      const spotifyApi = this.getSpotifyApi(tokens);
      await this.refreshSpotifyToken(spotifyApi, tokens);

      const data = await spotifyApi.getUserPlaylists({ limit: 50 });

      return data.body.items.map(playlist => ({
        id: playlist.id,
        name: playlist.name,
        description: playlist.description,
        tracks: {
          total: playlist.tracks.total
        },
        platform: 'spotify',
        url: playlist.external_urls.spotify,
        images: playlist.images
      }));
    }

    if (platform === 'apple') {
      const appleMusicApi = this.getAppleMusicApi(tokens);

      return await appleMusicApi.getPlaylists(tokens.access_token);
    }
  }

  /**
   * Get tracks in a playlist
   * @param {string} userId - User ID
   * @param {string} playlistId - Playlist ID
   * @param {Object} tokens - User's tokens
   */
  async getPlaylistTracks(userId, playlistId, tokens) {
    const platform = this.getPlatform(userId);

    if (platform === 'spotify') {
      const spotifyApi = this.getSpotifyApi(tokens);
      await this.refreshSpotifyToken(spotifyApi, tokens);

      const data = await spotifyApi.getPlaylistTracks(playlistId);

      return data.body.items.map(item => ({
        id: item.track.id,
        name: item.track.name,
        uri: item.track.uri,
        artists: item.track.artists.map(artist => ({
          name: artist.name
        })),
        album: {
          name: item.track.album.name
        },
        duration_ms: item.track.duration_ms,
        platform: 'spotify',
        added_at: item.added_at
      }));
    }

    if (platform === 'apple') {
      const appleMusicApi = this.getAppleMusicApi(tokens);

      return await appleMusicApi.getPlaylistTracks(tokens.access_token, playlistId);
    }
  }

  /**
   * Add tracks to a playlist
   * @param {string} userId - User ID
   * @param {string} playlistId - Playlist ID
   * @param {Array<string>} trackUris - Array of track URIs
   * @param {Object} tokens - User's tokens
   */
  async addTracksToPlaylist(userId, playlistId, trackUris, tokens) {
    const platform = this.getPlatform(userId);

    if (platform === 'spotify') {
      const spotifyApi = this.getSpotifyApi(tokens);
      await this.refreshSpotifyToken(spotifyApi, tokens);

      await spotifyApi.addTracksToPlaylist(playlistId, trackUris);

      return { success: true };
    }

    if (platform === 'apple') {
      const appleMusicApi = this.getAppleMusicApi(tokens);

      const trackIds = trackUris.map(uri =>
        uri.replace('apple:track:', '')
      );

      await appleMusicApi.addTracksToPlaylist(
        tokens.access_token,
        playlistId,
        trackIds
      );

      return { success: true };
    }
  }

  /**
   * Remove tracks from a playlist
   * @param {string} userId - User ID
   * @param {string} playlistId - Playlist ID
   * @param {Array<string>} trackUris - Array of track URIs
   * @param {Object} tokens - User's tokens
   */
  async removeTracksFromPlaylist(userId, playlistId, trackUris, tokens) {
    const platform = this.getPlatform(userId);

    if (platform === 'spotify') {
      const spotifyApi = this.getSpotifyApi(tokens);
      await this.refreshSpotifyToken(spotifyApi, tokens);

      await spotifyApi.removeTracksFromPlaylist(playlistId, trackUris.map(uri => ({ uri })));

      return { success: true };
    }

    if (platform === 'apple') {
      // Apple Music doesn't support direct track removal
      // Would need to implement workaround
      throw new Error('Remove tracks not yet supported for Apple Music');
    }
  }

  /**
   * Convert Spotify track to Apple Music track
   * Searches Apple Music for the same track by name and artist
   * @param {Object} spotifyTrack - Spotify track object with name and artists
   * @param {string} storefront - Apple Music storefront
   * @param {string} developerToken - Apple Music developer token
   */
  async convertSpotifyTrackToAppleMusic(spotifyTrack, storefront, developerToken) {
    const appleMusicApi = new AppleMusicService(developerToken);

    const trackName = spotifyTrack.name;
    const artistName = spotifyTrack.artists?.[0]?.name || '';

    try {
      const appleMusicTrack = await appleMusicApi.findTrackByNameAndArtist(
        trackName,
        artistName,
        storefront
      );

      return appleMusicTrack;
    } catch (error) {
      console.log(`Could not find Apple Music match for: ${trackName} by ${artistName}`);
      return null;
    }
  }
}

module.exports = PlatformService;
