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
      console.error('Apple Music API Error Details:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message,
        endpoint: endpoint,
        method: options.method || 'GET'
      });
      throw {
        status: error.response?.status,
        message: error.response?.data?.errors?.[0]?.detail || error.message,
        code: error.response?.data?.errors?.[0]?.code,
        fullError: error.response?.data
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
   * Search Apple Music catalog for various types
   * @param {string} query - Search query
   * @param {string} storefront - Country code (e.g., 'us')
   * @param {Array<string>} types - Types to search for (e.g., ['artists', 'songs', 'albums'])
   * @param {number} limit - Number of results per type (default: 25)
   */
  async searchCatalog(query, storefront, types = ['songs'], limit = 25) {
    const data = await this.request(`/catalog/${storefront}/search`, null, {
      params: {
        term: query,
        types: types.join(','),
        limit
      }
    });

    return data.results || {};
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

    // For each playlist without artwork, fetch it individually to get the first track's artwork
    const playlists = await Promise.all(data.data.map(async (playlist) => {
      let image = null;
      let trackCount = 0;

      // Try to get artwork from the playlist itself
      if (playlist.attributes.artwork) {
        image = playlist.attributes.artwork.url
          .replace('{w}', '300')
          .replace('{h}', '300');
      }

      // Always fetch individual playlist to get track count and artwork if needed
      try {
        const detailedPlaylist = await this.getPlaylist(userToken, playlist.id);
        if (!image) {
          image = detailedPlaylist.image;
        }
        trackCount = detailedPlaylist.tracks?.length || 0;
      } catch (err) {
        console.log(`Could not fetch details for playlist ${playlist.id}:`, err.message);
      }

      return {
        id: playlist.id,
        name: playlist.attributes.name,
        description: playlist.attributes.description?.standard || '',
        image: image,
        trackCount: trackCount,
        tracks: {
          total: trackCount
        },
        platform: 'apple',
        url: null, // Apple Music library playlists don't have public URLs
        canEdit: playlist.attributes.canEdit
      };
    }));

    return playlists;
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
   * Get a single playlist with tracks
   * @param {string} userToken - User's music token
   * @param {string} playlistId - Playlist ID
   */
  async getPlaylist(userToken, playlistId) {
    const data = await this.request(
      `/me/library/playlists/${playlistId}`,
      userToken,
      {
        params: {
          include: 'tracks'
        }
      }
    );

    if (!data.data || data.data.length === 0) {
      throw new Error('Playlist not found');
    }

    const playlist = data.data[0];

    let image = null;
    // Try playlist artwork first
    if (playlist.attributes.artwork) {
      image = playlist.attributes.artwork.url
        .replace('{w}', '300')
        .replace('{h}', '300');
    }
    // Fall back to first track's album art
    else if (playlist.relationships?.tracks?.data?.[0]?.attributes?.artwork) {
      image = playlist.relationships.tracks.data[0].attributes.artwork.url
        .replace('{w}', '300')
        .replace('{h}', '300');
    }

    return {
      id: playlist.id,
      name: playlist.attributes.name,
      description: playlist.attributes.description?.standard || '',
      image: image,
      tracks: playlist.relationships?.tracks?.data || []
    };
  }

  /**
   * Get tracks in a playlist
   * @param {string} userToken - User's music token
   * @param {string} playlistId - Playlist ID
   */
  async getPlaylistTracks(userToken, playlistId) {
    // First get the playlist with tracks included
    const playlist = await this.getPlaylist(userToken, playlistId);

    if (!playlist.tracks || playlist.tracks.length === 0) {
      return [];
    }

    return playlist.tracks.map(track => ({
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
            .replace('{w}', '300')
            .replace('{h}', '300')
        }] : []
      },
      duration_ms: track.attributes.durationInMillis,
      platform: 'apple',
      url: track.attributes.url || null
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

    console.log(`Processing ${trackIds.length} tracks for playlist ${playlistId}`);
    console.log(`Sample track URIs:`, trackIds.slice(0, 3));
    console.log(`Sample track IDs after conversion:`, ids.slice(0, 3));

    // Apple Music requires a different approach than Spotify
    // We need to add tracks in batches and handle each batch separately
    console.log(`Adding ${ids.length} tracks to Apple Music playlist ${playlistId}...`);

    // Split into batches of 25 (Apple Music limit)
    const batchSize = 25;
    const batches = [];
    for (let i = 0; i < ids.length; i += batchSize) {
      batches.push(ids.slice(i, i + batchSize));
    }

    console.log(`Processing ${batches.length} batch(es) of tracks...`);

    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      console.log(`Batch ${i + 1}/${batches.length}: Adding ${batch.length} tracks...`);

      try {
        // Add tracks directly using catalog IDs
        // The endpoint accepts both catalog IDs and library IDs
        await this.request(
          `/me/library/playlists/${playlistId}/tracks`,
          userToken,
          {
            method: 'POST',
            data: {
              data: batch.map(id => ({
                id,
                type: 'songs'
              }))
            }
          }
        );
        console.log(`✓ Batch ${i + 1} added successfully`);
      } catch (error) {
        console.error(`Error adding batch ${i + 1}:`, error);
        // Try adding to library first, then retry
        console.log(`Attempting to add batch ${i + 1} to library first...`);
        try {
          await this.request(
            `/me/library`,
            userToken,
            {
              method: 'POST',
              params: {
                'ids[songs]': batch.join(',')
              }
            }
          );
          console.log('Added to library, waiting 1 second...');
          await new Promise(resolve => setTimeout(resolve, 1000));

          // Retry adding to playlist
          await this.request(
            `/me/library/playlists/${playlistId}/tracks`,
            userToken,
            {
              method: 'POST',
              data: {
                data: batch.map(id => ({
                  id,
                  type: 'songs'
                }))
              }
            }
          );
          console.log(`✓ Batch ${i + 1} added successfully after library addition`);
        } catch (retryError) {
          console.error(`Failed to add batch ${i + 1} even after library addition:`, retryError);
          throw retryError;
        }
      }
    }

    console.log(`✓ Successfully added all ${ids.length} tracks to playlist`);
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

  /**
   * Get user's library playlists
   * @param {string} userToken - User music token
   * @param {number} limit - Number of playlists to fetch (default: 100)
   */
  async getLibraryPlaylists(userToken, limit = 100) {
    try {
      const data = await this.request(`/me/library/playlists`, userToken, {
        params: { limit }
      });

      if (!data.data) {
        return [];
      }

      return data.data.map(playlist => ({
        id: playlist.id,
        name: playlist.attributes.name,
        description: playlist.attributes.description?.standard || '',
        trackCount: playlist.attributes.trackCount || 0
      }));
    } catch (error) {
      console.error('Error fetching library playlists:', error);
      return [];
    }
  }

  /**
   * Get tracks from a library playlist
   * @param {string} userToken - User music token
   * @param {string} playlistId - Playlist ID
   * @param {number} limit - Number of tracks to fetch (default: 100)
   */
  async getLibraryPlaylistTracks(userToken, playlistId, limit = 100) {
    try {
      const data = await this.request(`/me/library/playlists/${playlistId}/tracks`, userToken, {
        params: { limit }
      });

      if (!data.data) {
        return [];
      }

      return data.data.map(track => ({
        id: track.id,
        name: track.attributes.name,
        artistName: track.attributes.artistName,
        albumName: track.attributes.albumName,
        artwork: track.attributes.artwork
      }));
    } catch (error) {
      console.error(`Error fetching tracks for playlist ${playlistId}:`, error);
      return [];
    }
  }

  /**
   * Get top artists from user's library playlists
   * Analyzes all library playlists and counts artist frequency
   * @param {string} userToken - User music token
   * @param {number} limit - Number of top artists to return (default: 50)
   */
  async getTopArtistsFromLibrary(userToken, limit = 50) {
    try {
      // Get all library playlists
      console.log('Fetching library playlists...');
      const playlists = await this.getLibraryPlaylists(userToken);
      console.log(`Found ${playlists.length} library playlists`);

      if (playlists.length === 0) {
        return [];
      }

      // Count artist occurrences across all playlists
      const artistCounts = new Map();

      // Fetch tracks from each playlist
      for (const playlist of playlists) {
        console.log(`Fetching tracks from playlist: ${playlist.name}`);
        const tracks = await this.getLibraryPlaylistTracks(userToken, playlist.id);

        // Count each artist
        for (const track of tracks) {
          const artistName = track.artistName;
          if (artistName) {
            const current = artistCounts.get(artistName) || { count: 0, artwork: null };
            artistCounts.set(artistName, {
              count: current.count + 1,
              artwork: track.artwork || current.artwork
            });
          }
        }
      }

      // Convert to array and sort by count
      const topArtists = Array.from(artistCounts.entries())
        .map(([name, data]) => ({
          name,
          count: data.count,
          artwork: data.artwork
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, limit);

      console.log(`Analyzed library: found ${artistCounts.size} unique artists, returning top ${topArtists.length}`);

      // Format for frontend (match Spotify format)
      return topArtists.map(artist => ({
        id: artist.name.toLowerCase().replace(/\s+/g, '-'), // Generate ID from name
        name: artist.name,
        image: artist.artwork ? artist.artwork.url.replace('{w}', '300').replace('{h}', '300') : null,
        playcount: artist.count,
        platform: 'apple'
      }));
    } catch (error) {
      console.error('Error getting top artists from library:', error);
      return [];
    }
  }

  /**
   * Get artist recommendations based on library analysis
   * Finds similar artists in the catalog that user doesn't already have
   * @param {string} userToken - User music token
   * @param {string} storefront - User's storefront (e.g., 'us')
   * @param {number} limit - Number of recommendations to return (default: 50)
   */
  async getRecommendedArtists(userToken, storefront, limit = 50) {
    try {
      // Get top artists from user's library
      console.log('Getting top artists from library for recommendations...');
      const topArtists = await this.getTopArtistsFromLibrary(userToken, 20);

      if (topArtists.length === 0) {
        console.log('No artists in library, cannot generate recommendations');
        return [];
      }

      // Get all artists from library to filter out duplicates
      const playlists = await this.getLibraryPlaylists(userToken);
      const libraryArtists = new Set();

      for (const playlist of playlists) {
        const tracks = await this.getLibraryPlaylistTracks(userToken, playlist.id);
        for (const track of tracks) {
          if (track.artistName) {
            libraryArtists.add(track.artistName.toLowerCase());
          }
        }
      }

      console.log(`Found ${libraryArtists.size} unique artists in library`);

      // For each top artist, search for similar artists in catalog
      const recommendations = new Map();

      for (const artist of topArtists.slice(0, 5)) { // Use top 5 artists as seeds
        try {
          console.log(`Searching for artists similar to: ${artist.name}`);

          // Search for the artist in catalog to get their genre
          const searchResults = await this.searchCatalog(artist.name, storefront, ['artists'], 1);

          if (searchResults.artists?.data?.[0]) {
            const catalogArtist = searchResults.artists.data[0];
            const genres = catalogArtist.attributes.genreNames || [];

            // Search for artists in the same genre
            if (genres.length > 0) {
              const genreQuery = genres[0]; // Use primary genre
              const genreResults = await this.searchCatalog(genreQuery, storefront, ['artists'], 25);

              if (genreResults.artists?.data) {
                for (const similarArtist of genreResults.artists.data) {
                  const artistName = similarArtist.attributes.name;
                  const artistNameLower = artistName.toLowerCase();

                  // Skip if already in library or already recommended
                  if (libraryArtists.has(artistNameLower) || recommendations.has(artistNameLower)) {
                    continue;
                  }

                  recommendations.set(artistNameLower, {
                    id: similarArtist.id,
                    name: artistName,
                    image: similarArtist.attributes.artwork?.url
                      ? similarArtist.attributes.artwork.url.replace('{w}', '300').replace('{h}', '300')
                      : null,
                    genres: similarArtist.attributes.genreNames || [],
                    platform: 'apple'
                  });

                  if (recommendations.size >= limit) {
                    break;
                  }
                }
              }
            }
          }

          if (recommendations.size >= limit) {
            break;
          }
        } catch (error) {
          console.error(`Error finding similar artists to ${artist.name}:`, error);
        }
      }

      const recommendedArtists = Array.from(recommendations.values());
      console.log(`Generated ${recommendedArtists.length} artist recommendations`);

      return recommendedArtists;
    } catch (error) {
      console.error('Error getting recommended artists:', error);
      return [];
    }
  }
}

module.exports = AppleMusicService;
