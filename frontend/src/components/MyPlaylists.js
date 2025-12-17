import React, { useState, useEffect } from 'react';
import playlistService from '../services/api';
import Icons from './Icons';
import DeleteConfirmationModal from './DeleteConfirmationModal';
import ErrorMessage from './ErrorMessage';
import '../styles/MyPlaylists.css';
import '../styles/EditOptionsModal.css';
import '../styles/PlaylistGenerator.css';

// Helper function to validate Spotify track URIs
// Spotify track IDs should be 22 characters of valid base62 characters (0-9, a-z, A-Z)
function isValidSpotifyTrackUri(uri) {
  if (!uri || typeof uri !== 'string') return false;
  if (!uri.startsWith('spotify:track:')) return false;

  const trackId = uri.substring('spotify:track:'.length);

  // Spotify track IDs are 22 characters long
  if (trackId.length !== 22) return false;

  // Check if all characters are valid base62 (0-9, a-z, A-Z)
  return /^[0-9a-zA-Z]{22}$/.test(trackId);
}

const MyPlaylists = ({ userId, onBack, showToast }) => {
  const [playlists, setPlaylists] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [errorLog, setErrorLog] = useState(null);
  const [expandedPlaylistId, setExpandedPlaylistId] = useState(null);
  const [editingPlaylistId, setEditingPlaylistId] = useState(null);
  const [selectedTracksToRemove, setSelectedTracksToRemove] = useState(new Set());
  const [showImportModal, setShowImportModal] = useState(false);
  const [spotifyPlaylists, setSpotifyPlaylists] = useState([]);
  const [loadingSpotifyPlaylists, setLoadingSpotifyPlaylists] = useState(false);
  const [importing, setImporting] = useState(false);
  const [tempUpdateFrequency, setTempUpdateFrequency] = useState('never');
  const [tempUpdateMode, setTempUpdateMode] = useState('append');
  const [tempIsPublic, setTempIsPublic] = useState(true);
  const [tempUpdateHour, setTempUpdateHour] = useState('12');
  const [tempUpdateMinute, setTempUpdateMinute] = useState('00');
  const [tempUpdatePeriod, setTempUpdatePeriod] = useState('AM');
  const [tempUpdateTimezone, setTempUpdateTimezone] = useState(Intl.DateTimeFormat().resolvedOptions().timeZone);

  // Edit options modal (unified modal with refresh and settings)
  const [showEditOptionsModal, setShowEditOptionsModal] = useState(false);
  const [editOptionsPlaylist, setEditOptionsPlaylist] = useState(null);
  const [refreshing, setRefreshing] = useState(false);
  const [refreshingMessage, setRefreshingMessage] = useState('Updating your playlist...');
  const [refreshError, setRefreshError] = useState(null);

  // Manual refresh settings (isolated - don't affect main settings)
  const [expandManualRefresh, setExpandManualRefresh] = useState(false);
  const [manualRefreshMode, setManualRefreshMode] = useState('append');
  const [manualRefreshSongCount, setManualRefreshSongCount] = useState(30);
  const [manualRefreshNewArtistsOnly, setManualRefreshNewArtistsOnly] = useState(false);

  // Track generation settings (shared - for auto-update and main settings page)
  const [refreshSongCount, setRefreshSongCount] = useState(30);
  const [refreshNewArtistsOnly, setRefreshNewArtistsOnly] = useState(false);

  // Delete confirmation modal
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [deletePlaylistData, setDeletePlaylistData] = useState(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Refinement instructions
  const [refinementInstructions, setRefinementInstructions] = useState([]);
  const [refinementInput, setRefinementInput] = useState('');
  const [addingRefinement, setAddingRefinement] = useState(false);

  // Helper function to calculate next update time
  const getNextUpdateTime = (frequency) => {
    const now = new Date();
    const nextUpdate = new Date(now);

    switch (frequency) {
      case 'daily':
        nextUpdate.setDate(nextUpdate.getDate() + 1);
        nextUpdate.setHours(0, 0, 0, 0);
        break;
      case 'weekly':
        nextUpdate.setDate(nextUpdate.getDate() + 7);
        nextUpdate.setHours(0, 0, 0, 0);
        break;
      case 'monthly':
        nextUpdate.setMonth(nextUpdate.getMonth() + 1);
        nextUpdate.setDate(1);
        nextUpdate.setHours(0, 0, 0, 0);
        break;
      default:
        return null;
    }

    return nextUpdate;
  };

  // Helper function to get timezone abbreviation
  const getTimezoneAbbr = () => {
    try {
      // Create a formatter with both date/time and timezone
      const formatter = new Intl.DateTimeFormat('en-US', {
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        timeZoneName: 'short'
      });

      // Format and split by space to get the timezone
      const formatted = formatter.format(new Date());

      // The timezone is typically the last part after splitting by space
      const parts = formatted.split(' ');
      const timezone = parts[parts.length - 1];

      // Make sure it's not just a number or other date part
      if (timezone && /^[A-Z]+$/.test(timezone)) {
        return timezone;
      }

      return '';
    } catch (error) {
      return '';
    }
  };

  // Helper function to format the next update time
  const formatNextUpdateTime = (frequency) => {
    if (frequency === 'never') {
      return 'No auto-updates scheduled';
    }

    const nextUpdate = getNextUpdateTime(frequency);
    if (!nextUpdate) return '';

    const today = new Date();
    const tomorrow = new Date(today);
    tomorrow.setDate(tomorrow.getDate() + 1);

    const tzAbbr = getTimezoneAbbr();
    const tzLabel = tzAbbr ? ` ${tzAbbr}` : '';

    // Check if next update is tomorrow
    if (
      nextUpdate.getDate() === tomorrow.getDate() &&
      nextUpdate.getMonth() === tomorrow.getMonth() &&
      nextUpdate.getFullYear() === tomorrow.getFullYear()
    ) {
      return `Tomorrow at 12:00 AM${tzLabel}`;
    }

    // Format: "Wednesday, January 15 at 12:00 AM PST"
    return nextUpdate.toLocaleDateString('en-US', {
      weekday: 'long',
      month: 'long',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true
    }) + tzLabel;
  };

  useEffect(() => {
    fetchPlaylists();
  }, [userId]);

  const fetchPlaylists = async () => {
    try {
      setLoading(true);
      setError('');
      setErrorLog(null);
      const data = await playlistService.getUserPlaylists(userId);
      // Sort by creation date, newest first
      const sortedPlaylists = data.playlists.sort((a, b) =>
        new Date(b.createdAt) - new Date(a.createdAt)
      );
      setPlaylists(sortedPlaylists);
    } catch (err) {
      const log = err.errorLog || {
        userMessage: 'Failed to load playlists',
        isRetryable: true,
      };
      setErrorLog(log);
      console.error(err);
    } finally {
      setLoading(false);
    }
  };

  const handleErrorDismiss = () => {
    setErrorLog(null);
  };

  const handleErrorRetry = () => {
    fetchPlaylists();
  };

  const togglePlaylist = (playlistId) => {
    if (expandedPlaylistId === playlistId) {
      setExpandedPlaylistId(null);
      setEditingPlaylistId(null);
      setSelectedTracksToRemove(new Set());
    } else {
      setExpandedPlaylistId(playlistId);
      setEditingPlaylistId(null);
      setSelectedTracksToRemove(new Set());
    }
  };



  const toggleTrackForRemoval = (trackUri) => {
    const newSelected = new Set(selectedTracksToRemove);
    if (newSelected.has(trackUri)) {
      newSelected.delete(trackUri);
    } else {
      newSelected.add(trackUri);
    }
    setSelectedTracksToRemove(newSelected);
  };

  const handleRemoveSelectedTracks = async (playlist) => {
    if (selectedTracksToRemove.size === 0) {
      setError('Please select at least one track to remove');
      return;
    }

    try {
      setError('');
      const tracksToRemove = Array.from(selectedTracksToRemove).map(uri => ({ uri }));
      await playlistService.updatePlaylist(
        playlist.playlistId,
        userId,
        [],
        tracksToRemove
      );

      // Refresh playlists to show updated tracks
      await fetchPlaylists();
      setSelectedTracksToRemove(new Set());
      setEditingPlaylistId(null);
      showToast(`Removed ${tracksToRemove.length} track(s) successfully!`, 'success');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to remove tracks');
      console.error(err);
    }
  };

  const handleExcludeTrack = async (playlistId, track) => {
    try {
      setError('');

      // Call exclude endpoint which removes and learns from the exclusion
      await playlistService.excludeSong(
        playlistId,
        userId,
        track.id,
        track.uri,
        track.artist
      );

      // Refresh playlists to show updated tracks
      await fetchPlaylists();
      showToast(`Removed "${track.name}" - won't show again`, 'success');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to exclude track');
      console.error(err);
      showToast('Failed to exclude track', 'error');
    }
  };

  const handleTrackReaction = async (playlistId, track, reaction) => {
    try {
      setError('');

      // Toggle reaction: if already set to this reaction, remove it
      const newReaction = track.reaction === reaction ? null : reaction;

      console.log('Reacting to song:', { playlistId, trackId: track.id, trackName: track.name, reaction: newReaction });

      // Call reaction endpoint
      await playlistService.reactToSong(
        playlistId,
        userId,
        track.id,
        track.uri,
        track.name,
        track.artist,
        newReaction
      );

      // Refresh playlists to show updated reaction
      await fetchPlaylists();

      if (newReaction === 'thumbsUp') {
        showToast(`Great! Future updates will include more songs like "${track.name}"`, 'success');
      } else if (newReaction === 'thumbsDown') {
        showToast(`Noted! Future updates will avoid songs like "${track.name}"`, 'success');
      } else {
        showToast(`Reaction removed from "${track.name}"`, 'success');
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to save reaction');
      showToast('Failed to save reaction', 'error');
    }
  };

  const formatDate = (dateString) => {
    const date = new Date(dateString);
    return date.toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  };

  const openImportModal = async () => {
    setShowImportModal(true);
    setLoadingSpotifyPlaylists(true);
    setError('');

    try {
      const data = await playlistService.getSpotifyPlaylists(userId);
      // Filter out playlists that are already imported
      const importedPlaylistIds = playlists.map(p => p.playlistId);
      const availablePlaylists = data.playlists.filter(
        p => !importedPlaylistIds.includes(p.id)
      );
      setSpotifyPlaylists(availablePlaylists);
    } catch (err) {
      const errorMessage = err.response?.data?.details || err.response?.data?.error || 'Failed to load Spotify playlists';
      console.error('Import error details:', errorMessage);
      console.error('Full response:', err.response?.data);
      setError(errorMessage);
      console.error(err);
    } finally {
      setLoadingSpotifyPlaylists(false);
    }
  };

  const closeImportModal = () => {
    setShowImportModal(false);
    setSpotifyPlaylists([]);
  };

  const openDeleteModal = (playlistId, playlistName) => {
    setDeletePlaylistData({ playlistId, playlistName });
    setShowDeleteModal(true);
  };

  const closeDeleteModal = () => {
    setShowDeleteModal(false);
    setDeletePlaylistData(null);
    setIsDeleting(false);
  };

  const confirmDeletePlaylist = async () => {
    if (!deletePlaylistData) return;

    setIsDeleting(true);
    try {
      const apiUrl = process.env.REACT_APP_API_URL || 'http://localhost:3001';
      const url = `${apiUrl}/api/playlists/${encodeURIComponent(deletePlaylistData.playlistId)}?userId=${userId}`;
      console.log('Deleting playlist:', deletePlaylistData.playlistId, 'for user:', userId);
      console.log('Request URL:', url);

      const response = await fetch(url, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
        },
      });

      console.log('Response status:', response.status);
      console.log('Response headers:', response.headers.get('content-type'));

      if (!response.ok) {
        const contentType = response.headers.get('content-type');
        let errorData;
        if (contentType && contentType.includes('application/json')) {
          errorData = await response.json();
          console.error('Error response:', errorData);
          throw new Error(errorData.details || errorData.error || `HTTP ${response.status}: Failed to delete playlist`);
        } else {
          const text = await response.text();
          console.error('Non-JSON response:', text.substring(0, 200));
          throw new Error(`HTTP ${response.status}: Server error - check backend logs`);
        }
      }

      const contentType = response.headers.get('content-type');
      let data;
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        console.warn('Non-JSON success response:', text);
        data = { success: true };
      }

      console.log('Delete response:', data);
      setError(`✅ Playlist deleted successfully`);
      await fetchPlaylists();
      closeDeleteModal();
      setTimeout(() => setError(''), 3000);
    } catch (err) {
      console.error('Delete error:', err);
      const errorMessage = err.message || 'Failed to delete playlist';
      setError(errorMessage);
      setIsDeleting(false);
    }
  };

  const handleImportPlaylist = async (playlistId) => {
    setImporting(true);
    setError('');

    try {
      await playlistService.importPlaylist(userId, playlistId);
      await fetchPlaylists();
      closeImportModal();
      showToast('Playlist imported successfully!', 'success');
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to import playlist');
      console.error(err);
    } finally {
      setImporting(false);
    }
  };


  // Unified edit options modal handlers
  const openEditOptionsModal = (playlist) => {
    setEditOptionsPlaylist(playlist);
    setExpandManualRefresh(false);
    setManualRefreshMode('append');
    setManualRefreshNewArtistsOnly(false);
    setManualRefreshSongCount(30);
    setRefreshSongCount(30);
    setRefreshNewArtistsOnly(false);
    setTempUpdateFrequency(playlist.updateFrequency || 'never');
    setTempUpdateMode(playlist.updateMode || 'append');
    setTempIsPublic(playlist.isPublic !== false);

    // Initialize refinement instructions
    setRefinementInstructions(playlist.refinementInstructions || []);
    setRefinementInput('');

    // Initialize time settings from playlist or use defaults
    if (playlist.updateTime) {
      const { hour, minute, period, timezone } = playlist.updateTime;
      setTempUpdateHour(hour || '12');
      setTempUpdateMinute(minute || '00');
      setTempUpdatePeriod(period || 'AM');
      setTempUpdateTimezone(timezone || Intl.DateTimeFormat().resolvedOptions().timeZone);
    } else {
      setTempUpdateHour('12');
      setTempUpdateMinute('00');
      setTempUpdatePeriod('AM');
      setTempUpdateTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
    }

    setShowEditOptionsModal(true);
  };

  const closeEditOptionsModal = () => {
    setShowEditOptionsModal(false);
    setEditOptionsPlaylist(null);
  };

  const handleSaveSettings = async () => {
    if (!editOptionsPlaylist) return;

    try {
      const updateTime = tempUpdateFrequency !== 'never' ? {
        hour: tempUpdateHour,
        minute: tempUpdateMinute,
        period: tempUpdatePeriod,
        timezone: tempUpdateTimezone
      } : null;

      await playlistService.updatePlaylistSettings(
        editOptionsPlaylist.playlistId,
        userId,
        tempUpdateFrequency,
        tempUpdateMode,
        tempIsPublic,
        updateTime
      );

      showToast('Settings updated successfully!', 'success');
      await fetchPlaylists();
      closeEditOptionsModal();
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to update settings');
      console.error(err);
    }
  };

  const handleManualRefresh = async () => {
    if (!editOptionsPlaylist) return;

    // Check if tracks are loaded
    if (!editOptionsPlaylist.tracks || editOptionsPlaylist.tracks.length === 0) {
      setRefreshError('Could not load playlist tracks. Please try again or refresh the page.');
      return;
    }

    setRefreshing(true);
    setRefreshingMessage('Generating new tracks...');
    setRefreshError(null);

    try {
      // Generate new tracks based on the existing playlist content
      // If stored tracks are empty, fetch current tracks from Spotify
      let currentTracks = editOptionsPlaylist.tracks;
      if (!currentTracks || currentTracks.length === 0) {
        try {
          setRefreshingMessage('Fetching current playlist tracks...');
          const tracksData = await playlistService.getPlaylistTracks(editOptionsPlaylist.playlistId, userId);
          currentTracks = tracksData.tracks;
        } catch (fetchErr) {
          console.warn('Could not fetch current tracks:', fetchErr);
          currentTracks = [];
        }
      }

      // Extract artist names and song titles from existing tracks for better context
      let existingTracksInfo = '';
      if (currentTracks && currentTracks.length > 0) {
        existingTracksInfo = currentTracks
          .slice(0, 10) // Use first 10 tracks as reference
          .map(track => `${track.name} by ${track.artist}`)
          .join(', ');
      }

      // Build prompt based on available data
      let prompt;
      if (existingTracksInfo) {
        prompt = manualRefreshMode === 'replace'
          ? `Generate ${manualRefreshSongCount} new songs similar in style and mood to this playlist called "${editOptionsPlaylist.playlistName}". Current songs include: ${existingTracksInfo}. Generate songs that match this vibe.`
          : `Add ${manualRefreshSongCount} more songs to "${editOptionsPlaylist.playlistName}" that match these existing songs: ${existingTracksInfo}`;
      } else {
        // Fallback when track details aren't available - extract genre/mood from name and description
        const description = editOptionsPlaylist.description || '';
        const playlistName = editOptionsPlaylist.playlistName;

        // Try to extract key descriptors from the name (e.g., "Velvet Vibes: R&B for Focus" -> "mellow R&B, focus")
        prompt = `Generate ${manualRefreshSongCount} songs for a playlist called "${playlistName}". ${description}

IMPORTANT: Pay close attention to the playlist name and description to understand the exact genre and mood:
- If the name mentions "R&B", only include R&B songs
- If it mentions "mellow", "smooth", "chill", or "focus", only include calm, relaxed songs (no upbeat or energetic tracks)
- If it mentions "Focus", prioritize instrumental or low-key vocals
- Match the EXACT vibe and energy level described in the name and description

Generate songs that precisely match the genre, mood, and energy level indicated by the playlist name and description.`;
      }

      // Add refinement instructions if they exist (just like auto-update does)
      if (refinementInstructions && refinementInstructions.length > 0) {
        prompt += '. ' + refinementInstructions.join('. ');
        console.log(`[MANUAL-REFRESH] Applied ${refinementInstructions.length} refinement instruction(s)`);
      }

      // For replace mode, pass existing track URIs to exclude them from new generation
      const excludeUris = manualRefreshMode === 'replace' && currentTracks && currentTracks.length > 0
        ? currentTracks.map(track => track.uri)
        : [];

      const result = await playlistService.generatePlaylist(
        prompt,
        userId,
        'spotify',
        true, // allowExplicit
        manualRefreshNewArtistsOnly,
        manualRefreshSongCount,
        excludeUris,
        editOptionsPlaylist.playlistId // Pass playlistId so backend can load song history
      );

      // Get the new track URIs
      const newTrackUris = result.tracks.map(track => track.uri);

      setRefreshingMessage('Updating your playlist...');

      if (manualRefreshMode === 'replace') {
        // Get all current track URIs to remove - filter out invalid URIs
        // Use tracks if available, otherwise fall back to trackUris
        let trackUrisToRemove = [];
        if (editOptionsPlaylist.tracks && editOptionsPlaylist.tracks.length > 0) {
          trackUrisToRemove = editOptionsPlaylist.tracks.map(track => track.uri);
        } else if (editOptionsPlaylist.trackUris && editOptionsPlaylist.trackUris.length > 0) {
          trackUrisToRemove = editOptionsPlaylist.trackUris;
        }

        const currentTrackUris = trackUrisToRemove.filter(isValidSpotifyTrackUri);

        console.log('Replace mode:', {
          playlistId: editOptionsPlaylist.playlistId,
          tracksToRemove: currentTrackUris.length,
          tracksToAdd: newTrackUris.length,
          removeData: currentTrackUris.slice(0, 3),
          invalidTracksFiltered: editOptionsPlaylist.tracks.length - currentTrackUris.length
        });

        // Update playlist: remove old tracks and add new ones
        await playlistService.updatePlaylist(
          editOptionsPlaylist.playlistId,
          userId,
          newTrackUris,
          currentTrackUris
        );
        showToast(`Replaced ${currentTrackUris.length} tracks with ${newTrackUris.length} new ones!`, 'success');
      } else {
        // Append mode: just add new tracks
        await playlistService.updatePlaylist(
          editOptionsPlaylist.playlistId,
          userId,
          newTrackUris,
          []
        );
        showToast(`Added ${newTrackUris.length} new tracks!`, 'success');
      }

      // Refresh the playlists list
      await fetchPlaylists();
      setRefreshing(false);
      closeEditOptionsModal();
    } catch (err) {
      setRefreshing(false);
      setRefreshingMessage('');
      setRefreshError('Something went wrong while refreshing your playlist. Please try again.');
      console.error(err);
    }
  };

  // Handle adding refinement instruction
  const handleAddRefinement = async () => {
    if (!refinementInput.trim() || !editOptionsPlaylist) return;

    setAddingRefinement(true);
    try {
      const response = await fetch(`http://localhost:3001/api/playlists/${editOptionsPlaylist.playlistId}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          instruction: refinementInput.trim(),
          action: 'add'
        })
      });

      if (!response.ok) {
        throw new Error('Failed to add refinement instruction');
      }

      const data = await response.json();
      setRefinementInstructions(data.refinementInstructions);
      setRefinementInput('');

      // Update the local playlist object
      setEditOptionsPlaylist({
        ...editOptionsPlaylist,
        refinementInstructions: data.refinementInstructions
      });

      showToast('Refinement instruction added successfully!', 'success');
    } catch (err) {
      console.error('Error adding refinement:', err);
      showToast('Failed to add refinement instruction', 'error');
    } finally {
      setAddingRefinement(false);
    }
  };

  // Handle removing refinement instruction
  const handleRemoveRefinement = async (instruction) => {
    if (!editOptionsPlaylist) return;

    try {
      const response = await fetch(`http://localhost:3001/api/playlists/${editOptionsPlaylist.playlistId}/refine`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          instruction,
          action: 'remove'
        })
      });

      if (!response.ok) {
        throw new Error('Failed to remove refinement instruction');
      }

      const data = await response.json();
      setRefinementInstructions(data.refinementInstructions);

      // Update the local playlist object
      setEditOptionsPlaylist({
        ...editOptionsPlaylist,
        refinementInstructions: data.refinementInstructions
      });

      showToast('Refinement instruction removed', 'success');
    } catch (err) {
      console.error('Error removing refinement:', err);
      showToast('Failed to remove refinement instruction', 'error');
    }
  };

  if (loading) {
    return (
      <div className="my-playlists">
        <div className="loading-container">
          <span className="spinner"></span>
          <p>Loading your playlists...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="my-playlists">
      <ErrorMessage
        errorLog={errorLog}
        onRetry={handleErrorRetry}
        onDismiss={handleErrorDismiss}
      />
      <div className="playlists-header">
        <h1>My Playlists</h1>
        <p className="playlists-count">
          {playlists.length} {playlists.length === 1 ? 'playlist' : 'playlists'} created
        </p>
        <button onClick={openImportModal} className="import-button">
          Import from Spotify
        </button>
      </div>

      {error && <div className="error-message">{error}</div>}

      {playlists.length === 0 ? (
        <div className="empty-state">
          <p>You haven't created any playlists yet.</p>
          <button onClick={onBack} className="create-first-button">
            Create Your First Playlist
          </button>
        </div>
      ) : (
        <div className="playlists-list">
          {playlists.map((playlist) => (
            <div key={playlist.playlistId} className={`playlist-card ${expandedPlaylistId === playlist.playlistId ? 'expanded' : ''}`}>
              <div
                className="playlist-card-header"
                onClick={() => togglePlaylist(playlist.playlistId)}
              >
                {playlist.image && (
                  <img src={playlist.image} alt={playlist.playlistName} className="playlist-cover-image" />
                )}
                <div className="playlist-info">
                  <h2>
                    {playlist.playlistName}
                    {playlist.imported && (
                      <span className="imported-badge">Imported</span>
                    )}
                    {playlist.error && (
                      <span className="error-badge" title={playlist.error}>⚠️</span>
                    )}
                  </h2>
                  <p className="playlist-meta">
                    {playlist.trackCount} tracks • {playlist.updatedAt ? `Updated ${formatDate(playlist.updatedAt)}` : `${playlist.imported ? 'Imported' : 'Created'} ${formatDate(playlist.createdAt)}`}
                    {playlist.error && <span style={{ color: '#ef4444', marginLeft: '8px' }}>({playlist.error})</span>}
                  </p>
                </div>
                <div className="playlist-actions">
                  <a
                    href={playlist.spotifyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="open-spotify-button"
                    onClick={(e) => e.stopPropagation()}
                  >
                    Open in Spotify
                  </a>
                  <button
                    className="delete-playlist-button"
                    onClick={(e) => {
                      e.stopPropagation();
                      openDeleteModal(playlist.playlistId, playlist.playlistName);
                    }}
                    title="Delete playlist"
                  >
                    ✕
                  </button>
                  <span className="expand-icon">
                    {expandedPlaylistId === playlist.playlistId ? '▼' : '▶'}
                  </span>
                </div>
              </div>

              {expandedPlaylistId === playlist.playlistId && (
                <div className="playlist-details">
                  <div className="playlist-controls">
                    {editingPlaylistId !== playlist.playlistId ? (
                      <button
                        onClick={() => openEditOptionsModal(playlist)}
                        className="edit-button"
                      >
                        Edit Playlist
                      </button>
                    ) : (
                      <div className="edit-controls">
                        <button onClick={() => { setEditingPlaylistId(null); setSelectedTracksToRemove(new Set()); }} className="cancel-button">
                          Cancel
                        </button>
                        <button
                          onClick={() => handleRemoveSelectedTracks(playlist)}
                          className="remove-button"
                          disabled={selectedTracksToRemove.size === 0}
                        >
                          Remove Selected ({selectedTracksToRemove.size})
                        </button>
                      </div>
                    )}
                  </div>


                  <div className="tracks-list">
                    {playlist.tracks && playlist.tracks.length > 0 ? (
                      playlist.tracks.map((track, index) => (
                        <div
                          key={`${playlist.playlistId}-${index}-${track.id}`}
                          className="track-item"
                        >
                          {track.image && (
                            <img src={track.image} alt={track.album} className="track-image" />
                          )}
                          <div className="track-content">
                            <div className="track-info">
                              <div className="track-name">{track.name}</div>
                              <div className="track-artist">{track.artist}</div>
                            </div>
                            <div className="track-actions">
                              <button
                                className={`track-reaction-button ${track.reaction === 'thumbsUp' ? 'active-thumbs-up' : ''}`}
                                onClick={() => handleTrackReaction(playlist.playlistId, track, 'thumbsUp')}
                                title="I like this! Add more songs like this"
                              >
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                  <path d="M1 21h4V9H1v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L14.17 1 7.59 7.59C7.22 7.95 7 8.45 7 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z"/>
                                </svg>
                              </button>
                              <button
                                className={`track-reaction-button ${track.reaction === 'thumbsDown' ? 'active-thumbs-down' : ''}`}
                                onClick={() => handleTrackReaction(playlist.playlistId, track, 'thumbsDown')}
                                title="Not for me. Exclude similar songs"
                              >
                                <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor">
                                  <path d="M15 3H6c-.83 0-1.54.5-1.84 1.22l-3.02 7.05c-.09.23-.14.47-.14.73v2c0 1.1.9 2 2 2h6.31l-.95 4.57-.03.32c0 .41.17.79.44 1.06L9.83 23l6.59-6.59c.36-.36.58-.86.58-1.41V5c0-1.1-.9-2-2-2zm4 0v12h4V3h-4z"/>
                                </svg>
                              </button>
                            </div>
                          </div>
                          <a
                            href={track.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="spotify-link-button"
                            title="Open in Spotify"
                          >
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                            </svg>
                          </a>
                        </div>
                      ))
                    ) : (
                      <p className="no-tracks">No tracks available</p>
                    )}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {showImportModal && (
        <div className="modal-overlay" onClick={closeImportModal}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Import Playlist from Spotify</h2>
              <button onClick={closeImportModal} className="close-modal-button">
                ×
              </button>
            </div>

            {loadingSpotifyPlaylists ? (
              <div className="modal-loading">
                <span className="spinner"></span>
                <p>Loading your Spotify playlists...</p>
              </div>
            ) : spotifyPlaylists.length === 0 ? (
              <div className="modal-empty">
                <p>No playlists available to import. All your Spotify playlists have already been imported.</p>
              </div>
            ) : (
              <div className="spotify-playlists-list">
                {spotifyPlaylists.map((playlist) => (
                  <div key={playlist.id} className="spotify-playlist-item">
                    {playlist.image && (
                      <img src={playlist.image} alt={playlist.name} className="spotify-playlist-image" />
                    )}
                    <div className="spotify-playlist-info">
                      <div className="spotify-playlist-name">{playlist.name}</div>
                      <div className="spotify-playlist-meta">
                        {playlist.trackCount} tracks • by {playlist.owner}
                      </div>
                      {playlist.description && (
                        <div className="spotify-playlist-description">{playlist.description}</div>
                      )}
                    </div>
                    <button
                      onClick={() => handleImportPlaylist(playlist.id)}
                      disabled={importing}
                      className="import-playlist-button"
                    >
                      {importing ? 'Importing...' : 'Import'}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Refreshing Modal */}
      {refreshing && (
        <div className="generating-modal-overlay">
          <div className="generating-modal-content" style={{ position: 'relative' }}>
            {refreshError && (
              <button
                onClick={() => {
                  setRefreshing(false);
                  setRefreshError(null);
                }}
                style={{
                  position: 'absolute',
                  top: '12px',
                  right: '12px',
                  background: 'none',
                  border: 'none',
                  fontSize: '28px',
                  cursor: 'pointer',
                  color: '#666',
                  padding: '0',
                  width: '32px',
                  height: '32px',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  transition: 'all 0.2s ease'
                }}
                onMouseEnter={(e) => {
                  e.target.style.color = '#000';
                  e.target.style.transform = 'scale(1.1)';
                }}
                onMouseLeave={(e) => {
                  e.target.style.color = '#666';
                  e.target.style.transform = 'scale(1)';
                }}
              >
                ×
              </button>
            )}
            <div className="generating-modal-header">
              <h2>Refreshing Your Playlist</h2>
            </div>
            <div className="generating-modal-body">
              {refreshError ? (
                <>
                  <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
                  <p className="generating-modal-message" style={{ color: '#ef4444' }}>
                    {refreshError}
                  </p>
                  <div style={{ display: 'flex', gap: '12px', marginTop: '24px' }}>
                    <button
                      onClick={() => {
                        setRefreshError(null);
                        handleManualRefresh();
                      }}
                      className="refresh-confirm-button"
                      style={{ flex: 1 }}
                    >
                      Try Again
                    </button>
                  </div>
                </>
              ) : (
                <>
                  <div className="generating-modal-spinner">
                    <div className="wave-bar-1"></div>
                    <div className="wave-bar-2"></div>
                    <div className="wave-bar-3"></div>
                  </div>
                  <p className="generating-modal-message">{refreshingMessage}</p>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Edit Options Modal */}
      {showEditOptionsModal && editOptionsPlaylist && (
        <div className="modal-overlay" onClick={closeEditOptionsModal}>
          <div className="modal-content refresh-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>Edit "{editOptionsPlaylist.playlistName}"</h2>
              <button onClick={closeEditOptionsModal} className="close-modal-button">
                ×
              </button>
            </div>

            <div className="modal-body">
              {/* Manual Refresh Section - Collapsible Dropdown */}
              <div className="modal-section dropdown-section">
                <button
                  className="dropdown-header"
                  onClick={() => setExpandManualRefresh(!expandManualRefresh)}
                  type="button"
                >
                  <span className="dropdown-title">Manual Refresh</span>
                  <span className={`dropdown-arrow ${expandManualRefresh ? 'expanded' : ''}`}>▼</span>
                </button>
                <p className="section-description">Refresh your playlist now with new songs</p>

                {expandManualRefresh && (
                  <div className="dropdown-content">
                    <div className="form-group">
                      <div
                        className={`refresh-option-item ${manualRefreshMode === 'append' ? 'active' : ''}`}
                        onClick={() => setManualRefreshMode('append')}
                      >
                        <div className="option-checkbox">
                          {manualRefreshMode === 'append' && <span className="checkmark"><Icons.Check size={16} /></span>}
                        </div>
                        <div className="option-content">
                          <span className="option-label">Append Songs</span>
                          <span className="option-description">Add new songs to your existing playlist</span>
                        </div>
                      </div>
                    </div>

                    <div className="form-group">
                      <div
                        className={`refresh-option-item ${manualRefreshMode === 'replace' ? 'active' : ''}`}
                        onClick={() => setManualRefreshMode('replace')}
                      >
                        <div className="option-checkbox">
                          {manualRefreshMode === 'replace' && <span className="checkmark"><Icons.Check size={16} /></span>}
                        </div>
                        <div className="option-content">
                          <span className="option-label">Replace All Songs</span>
                          <span className="option-description">Remove old songs and add new ones</span>
                        </div>
                      </div>
                    </div>

                    <div className="form-group">
                      <label htmlFor="manual-song-count">Number of Songs to {manualRefreshMode === 'append' ? 'Add' : 'Generate'}</label>
                      <input
                        type="number"
                        id="manual-song-count"
                        min="5"
                        max="50"
                        step="1"
                        value={manualRefreshSongCount}
                        onChange={(e) => {
                          const val = e.target.value;
                          // Allow empty string or any numeric input while typing
                          if (val === '') {
                            setManualRefreshSongCount('');
                          } else {
                            const num = parseInt(val, 10);
                            if (!isNaN(num)) {
                              setManualRefreshSongCount(num);
                            }
                          }
                        }}
                        onBlur={(e) => {
                          // Enforce min/max constraints when user leaves the field
                          const val = e.target.value;
                          if (val === '' || val === null) {
                            setManualRefreshSongCount(30); // Default to 30
                          } else {
                            const num = parseInt(val, 10);
                            if (!isNaN(num)) {
                              setManualRefreshSongCount(Math.min(Math.max(num, 5), 50));
                            } else {
                              setManualRefreshSongCount(30);
                            }
                          }
                        }}
                        className="song-count-input-large"
                      />
                      <p className="form-help-text">
                        Choose between 5 and 50 songs
                      </p>
                    </div>

                    <div className="form-group">
                      <div
                        className={`refresh-option-item ${manualRefreshNewArtistsOnly ? 'active' : ''}`}
                        onClick={() => setManualRefreshNewArtistsOnly(!manualRefreshNewArtistsOnly)}
                      >
                        <div className="option-checkbox">
                          {manualRefreshNewArtistsOnly && <span className="checkmark"><Icons.Check size={16} /></span>}
                        </div>
                        <div className="option-content">
                          <span className="option-label">New Artists Only</span>
                          <span className="option-description">Only include artists you haven't listened to before</span>
                        </div>
                      </div>
                    </div>

                    <button
                      onClick={handleManualRefresh}
                      disabled={refreshing}
                      className="refresh-confirm-button"
                      style={{ marginTop: '16px' }}
                    >
                      {refreshing ? 'Updating...' : 'Refresh Now'}
                    </button>
                  </div>
                )}
              </div>

              {/* Shared Track Generation Settings Section */}
              <div className="modal-section">
                <h3 className="section-title">Track Generation Settings</h3>
                <p className="section-description">Applied to auto-updates and main settings page</p>

                <div className="form-group">
                  <label htmlFor="refresh-song-count">Number of Songs to Generate</label>
                  <input
                    type="number"
                    id="refresh-song-count"
                    min="5"
                    max="50"
                    value={refreshSongCount}
                    onChange={(e) => {
                      const val = e.target.value;
                      if (val === '' || val === null) {
                        setRefreshSongCount('');
                      } else {
                        const num = parseInt(val, 10);
                        if (!isNaN(num) && num > 0) {
                          setRefreshSongCount(Math.min(Math.max(num, 5), 50));
                        }
                      }
                    }}
                    className="song-count-input-large"
                  />
                  <p className="form-help-text">
                    Choose between 5 and 50 songs
                  </p>
                </div>

                <div className="form-group">
                  <div
                    className={`refresh-option-item ${refreshNewArtistsOnly ? 'active' : ''}`}
                    onClick={() => setRefreshNewArtistsOnly(!refreshNewArtistsOnly)}
                  >
                    <div className="option-checkbox">
                      {refreshNewArtistsOnly && <span className="checkmark"><Icons.Check size={16} /></span>}
                    </div>
                    <div className="option-content">
                      <span className="option-label">New Artists Only</span>
                      <span className="option-description">Only include artists you haven't listened to before</span>
                    </div>
                  </div>
                </div>
              </div>

              {/* Auto-Update Settings Section */}
              <div className="modal-section">
                <h3 className="section-title">Auto-Update Settings</h3>
                <p className="section-description">Automatically refresh your playlist on schedule (won't run within 24 hours of a manual refresh)</p>

                <div className="form-group">
                  <label htmlFor="update-frequency">Auto-Update Frequency</label>
                  <select
                    id="update-frequency"
                    value={tempUpdateFrequency}
                    onChange={(e) => setTempUpdateFrequency(e.target.value)}
                    className="playlist-select"
                  >
                    <option value="never">Never</option>
                    <option value="daily">Daily</option>
                    <option value="weekly">Weekly</option>
                    <option value="monthly">Monthly</option>
                  </select>
                </div>

                {tempUpdateFrequency !== 'never' && (
                  <div className="form-group">
                    <label>Update Time</label>
                    <div style={{ display: 'flex', gap: '10px', alignItems: 'center' }}>
                      <select
                        value={tempUpdateHour}
                        onChange={(e) => setTempUpdateHour(e.target.value)}
                        className="playlist-select"
                        style={{ flex: '0 0 80px' }}
                      >
                        {Array.from({ length: 12 }, (_, i) => {
                          const hour = String(i + 1).padStart(2, '0');
                          return <option key={hour} value={hour}>{hour}</option>;
                        })}
                      </select>
                      <span>:</span>
                      <select
                        value={tempUpdateMinute}
                        onChange={(e) => setTempUpdateMinute(e.target.value)}
                        className="playlist-select"
                        style={{ flex: '0 0 80px' }}
                      >
                        <option value="00">00</option>
                        <option value="15">15</option>
                        <option value="30">30</option>
                        <option value="45">45</option>
                      </select>
                      <select
                        value={tempUpdatePeriod}
                        onChange={(e) => setTempUpdatePeriod(e.target.value)}
                        className="playlist-select"
                        style={{ flex: '0 0 80px' }}
                      >
                        <option value="AM">AM</option>
                        <option value="PM">PM</option>
                      </select>
                    </div>
                    <p className="form-help-text">
                      Choose what time to update this playlist
                    </p>
                  </div>
                )}

                {tempUpdateFrequency !== 'never' && (
                  <div className="form-group">
                    <label htmlFor="update-timezone">Timezone</label>
                    <select
                      id="update-timezone"
                      value={tempUpdateTimezone}
                      onChange={(e) => setTempUpdateTimezone(e.target.value)}
                      className="playlist-select"
                    >
                      <option value="America/Los_Angeles">Pacific Time (PST/PDT)</option>
                      <option value="America/Denver">Mountain Time (MST/MDT)</option>
                      <option value="America/Chicago">Central Time (CST/CDT)</option>
                      <option value="America/New_York">Eastern Time (EST/EDT)</option>
                      <option value="America/Phoenix">Arizona (MST)</option>
                      <option value="America/Anchorage">Alaska (AKST/AKDT)</option>
                      <option value="Pacific/Honolulu">Hawaii (HST)</option>
                      <option value="Europe/London">London (GMT/BST)</option>
                      <option value="Europe/Paris">Paris (CET/CEST)</option>
                      <option value="Asia/Tokyo">Tokyo (JST)</option>
                      <option value="Asia/Shanghai">Shanghai (CST)</option>
                      <option value="Australia/Sydney">Sydney (AEDT/AEST)</option>
                    </select>
                    <p className="form-help-text">
                      Select your timezone for accurate update scheduling
                    </p>
                  </div>
                )}

                <div className="form-group">
                  <label htmlFor="update-mode">Update Mode</label>
                  <select
                    id="update-mode"
                    value={tempUpdateMode}
                    onChange={(e) => setTempUpdateMode(e.target.value)}
                    className="playlist-select"
                  >
                    <option value="append">Append - Add new songs to existing ones</option>
                    <option value="replace">Replace - Remove old songs and add new ones</option>
                  </select>
                  <p className="form-help-text">
                    How should auto-updates modify your playlist?
                  </p>
                </div>
              </div>

              {/* Playlist Settings Section */}
              <div className="modal-section">
                <h3 className="section-title">Playlist Settings</h3>
                <p className="section-description">Configure privacy and visibility</p>

                <div className="form-group">
                  <label htmlFor="is-public">Privacy</label>
                  <select
                    id="is-public"
                    value={tempIsPublic}
                    onChange={(e) => setTempIsPublic(e.target.value === 'true')}
                    className="playlist-select"
                  >
                    <option value="true">Public - Visible to everyone</option>
                    <option value="false">Private - Only visible to you</option>
                  </select>
                  <p className="form-help-text">
                    Control who can see this playlist
                  </p>
                </div>
              </div>

              {/* Refinement Instructions Section */}
              <div className="modal-section">
                <h3 className="section-title">Refine Playlist</h3>
                <p className="section-description">Add instructions to customize future auto-updates</p>

                {refinementInstructions.length > 0 && (
                  <div className="refinement-list" style={{ marginBottom: '16px' }}>
                    {refinementInstructions.map((instruction, index) => (
                      <div key={index} className="refinement-item" style={{
                        display: 'flex',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        padding: '10px 12px',
                        backgroundColor: '#f5f5f5',
                        borderRadius: '6px',
                        marginBottom: '8px'
                      }}>
                        <span style={{ flex: 1, fontSize: '14px' }}>{instruction}</span>
                        <button
                          onClick={() => handleRemoveRefinement(instruction)}
                          className="remove-refinement-button"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#ff4444',
                            cursor: 'pointer',
                            fontSize: '18px',
                            padding: '0 8px',
                            fontWeight: 'bold'
                          }}
                          title="Remove instruction"
                        >
                          ×
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                <div className="chat-input-container" style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    value={refinementInput}
                    onChange={(e) => setRefinementInput(e.target.value)}
                    onKeyPress={(e) => {
                      if (e.key === 'Enter' && !addingRefinement) {
                        handleAddRefinement();
                      }
                    }}
                    placeholder="e.g., Only include songs from the last 5 years"
                    className="chat-input"
                    disabled={addingRefinement}
                    style={{ flex: 1 }}
                  />
                  <button
                    onClick={handleAddRefinement}
                    disabled={addingRefinement || !refinementInput.trim()}
                    className="music-note-button"
                    title="Add instruction"
                  >
                    {addingRefinement ? (
                      <div className="wave-loader">
                        <div className="wave-bar"></div>
                        <div className="wave-bar"></div>
                        <div className="wave-bar"></div>
                        <div className="wave-bar"></div>
                      </div>
                    ) : (
                      <svg viewBox="0 0 24 24">
                        <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                      </svg>
                    )}
                  </button>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button onClick={closeEditOptionsModal} className="cancel-button">
                Cancel
              </button>
              <button
                onClick={handleSaveSettings}
                disabled={refreshing}
                className="save-settings-button"
              >
                Save Settings
              </button>
            </div>
          </div>
        </div>
      )}


      <DeleteConfirmationModal
        isOpen={showDeleteModal}
        playlistName={deletePlaylistData?.playlistName}
        onConfirm={confirmDeletePlaylist}
        onCancel={closeDeleteModal}
        isDeleting={isDeleting}
      />
    </div>
  );
};

export default MyPlaylists;
