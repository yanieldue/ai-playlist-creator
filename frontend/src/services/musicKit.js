/**
 * MusicKit Service
 * Handles Apple Music authentication using MusicKit JS
 */

class MusicKitService {
  constructor() {
    this.music = null;
    this.configured = false;
  }

  /**
   * Initialize MusicKit with developer token from backend
   */
  async configure(developerToken) {
    if (this.configured && this.music) {
      return this.music;
    }

    // Wait for MusicKit to load
    await this.waitForMusicKit();

    try {
      await window.MusicKit.configure({
        developerToken: developerToken,
        app: {
          name: 'AI Playlist Creator',
          build: '1.0.0'
        }
      });

      this.music = window.MusicKit.getInstance();
      this.configured = true;
      console.log('MusicKit configured successfully');
      return this.music;
    } catch (error) {
      console.error('Error configuring MusicKit:', error);
      throw error;
    }
  }

  /**
   * Wait for MusicKit JS library to load
   */
  async waitForMusicKit(timeout = 10000) {
    const startTime = Date.now();

    while (!window.MusicKit) {
      if (Date.now() - startTime > timeout) {
        throw new Error('MusicKit failed to load');
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }

  /**
   * Authorize user with Apple Music
   * Returns user music token
   */
  async authorize() {
    if (!this.music) {
      throw new Error('MusicKit not configured. Call configure() first.');
    }

    try {
      // Request authorization - this opens Apple's OAuth page in popup/redirect
      const musicUserToken = await this.music.authorize();
      console.log('Apple Music authorization successful');

      return musicUserToken;
    } catch (error) {
      console.error('Apple Music authorization failed:', error);
      throw error;
    }
  }

  /**
   * Get current authorization status
   */
  isAuthorized() {
    return this.music?.isAuthorized || false;
  }

  /**
   * Get user music token
   */
  getUserToken() {
    if (!this.music) {
      return null;
    }
    return this.music.musicUserToken;
  }

  /**
   * Unauthorize and clear tokens
   */
  async unauthorize() {
    if (this.music) {
      await this.music.unauthorize();
      console.log('Apple Music unauthorized');
    }
  }

  /**
   * Get MusicKit instance (for advanced usage)
   */
  getInstance() {
    return this.music;
  }

  /**
   * Initialize MusicKit for an already-authenticated user without showing an auth dialog.
   * Call this on app load so library modification methods are available.
   * @param {string} developerToken
   */
  async initForExistingUser(developerToken) {
    try {
      await this.configure(developerToken);
      // MusicKit restores the previous session automatically — no authorize() needed.
      return this.music?.isAuthorized || false;
    } catch (e) {
      console.warn('[MusicKit] initForExistingUser failed:', e.message);
      return false;
    }
  }

  /**
   * Remove specific tracks from a library playlist via MusicKit JS.
   * Uses music.api.music() which runs through Apple's client-side auth pipeline
   * and may succeed where server-side REST calls return 401.
   * @param {string} playlistId - Library playlist ID (e.g. p.xxxxx)
   * @param {Array<{id: string, index: number}>} tracks - tracks to remove with their position
   */
  async removeTracksFromPlaylist(playlistId, tracks) {
    if (!this.music) throw new Error('MusicKit not initialized');
    await this.music.api.music(
      `/v1/me/library/playlists/${playlistId}/tracks`,
      undefined,
      {
        fetchOptions: {
          method: 'DELETE',
          body: JSON.stringify({
            data: tracks.map(({ id, index }) => ({
              id,
              type: 'library-songs',
              meta: { position: index }
            }))
          })
        }
      }
    );
    console.log(`[MusicKit] Removed ${tracks.length} track(s) from playlist ${playlistId}`);
  }

  /**
   * Delete an entire library playlist via MusicKit JS.
   * @param {string} playlistId - Library playlist ID
   */
  async deleteLibraryPlaylist(playlistId) {
    if (!this.music) throw new Error('MusicKit not initialized');
    await this.music.api.music(
      `/v1/me/library/playlists/${playlistId}`,
      undefined,
      { fetchOptions: { method: 'DELETE' } }
    );
    console.log(`[MusicKit] Deleted playlist ${playlistId}`);
  }
}

// Export singleton instance
export default new MusicKitService();
