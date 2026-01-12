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
  const [platformPlaylists, setPlatformPlaylists] = useState([]);
  const [loadingPlaylists, setLoadingPlaylists] = useState(false);
  const [importing, setImporting] = useState(false);
  const [activePlatform, setActivePlatform] = useState(null); // 'spotify' or 'apple'
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

  // Dropdown menu state
  const [openMenuId, setOpenMenuId] = useState(null);

  // Refinement instructions
  const [refinementInstructions, setRefinementInstructions] = useState([]);
  const [refinementInput, setRefinementInput] = useState('');
  const [addingRefinement, setAddingRefinement] = useState(false);
  const [showRefinementModal, setShowRefinementModal] = useState(false);

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

  // Close dropdown menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (openMenuId && !event.target.closest('.playlist-menu-container')) {
        setOpenMenuId(null);
      }
    };

    document.addEventListener('click', handleClickOutside);
    return () => {
      document.removeEventListener('click', handleClickOutside);
    };
  }, [openMenuId]);

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

  const toggleMenu = (playlistId, e) => {
    e.stopPropagation();
    setOpenMenuId(openMenuId === playlistId ? null : playlistId);
  };

  const handleMenuAction = (action, playlist, e) => {
    e.stopPropagation();
    setOpenMenuId(null);

    if (action === 'delete') {
      openDeleteModal(playlist.playlistId, playlist.playlistName);
    } else if (action === 'spotify') {
      window.open(playlist.spotifyUrl, '_blank', 'noopener,noreferrer');
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

      // If thumbs down, also remove the track from the playlist
      if (newReaction === 'thumbsDown') {
        await playlistService.updatePlaylist(
          playlistId,
          userId,
          [],
          [{ uri: track.uri }]
        );
      }

      // Refresh playlists to show updated reaction
      await fetchPlaylists();

      if (newReaction === 'thumbsUp') {
        showToast(`Great! Future updates will include more songs like "${track.name}"`, 'success');
      } else if (newReaction === 'thumbsDown') {
        showToast(`Removed "${track.name}" - future updates will avoid similar songs`, 'success');
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
    setLoadingPlaylists(true);
    setError('');

    try {
      const data = await playlistService.getPlatformPlaylists(userId);
      console.log('Platform playlists data:', data);

      // Store which platform we're importing from
      setActivePlatform(data.platform);

      // Filter out playlists that are already imported
      const importedPlaylistIds = playlists.map(p => p.playlistId);
      const availablePlaylists = data.playlists.filter(
        p => !importedPlaylistIds.includes(p.id)
      );
      setPlatformPlaylists(availablePlaylists);
    } catch (err) {
      const errorMessage = err.response?.data?.details || err.response?.data?.error || 'Failed to load playlists';
      console.error('Import error details:', errorMessage);
      console.error('Full response:', err.response?.data);
      setError(errorMessage);
      console.error(err);
    } finally {
      setLoadingPlaylists(false);
    }
  };

  const closeImportModal = () => {
    setShowImportModal(false);
    setPlatformPlaylists([]);
    setActivePlatform(null);
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
      const description = editOptionsPlaylist.description || '';
      const originalPrompt = editOptionsPlaylist.originalPrompt || '';
      const playlistName = editOptionsPlaylist.playlistName;

      // Build context about the playlist's intended vibe
      let playlistContext = '';
      if (originalPrompt) {
        playlistContext = `Original request: "${originalPrompt}".`;
      }
      if (description) {
        playlistContext += ` Description: ${description}`;
      }

      // Combine all refinements from both chat history and refinement instructions
      const allRefinements = [];

      // Add cumulative refinements from chat history (from initial generation modal)
      if (editOptionsPlaylist.chatMessages && editOptionsPlaylist.chatMessages.length > 0) {
        const chatRefinements = editOptionsPlaylist.chatMessages
          .filter(msg => msg.role === 'user')
          .map(msg => msg.content);
        allRefinements.push(...chatRefinements);
      }

      // Add refinements from Edit Playlist modal
      if (refinementInstructions && refinementInstructions.length > 0) {
        allRefinements.push(...refinementInstructions);
      }

      // Add all refinements to context
      if (allRefinements.length > 0) {
        playlistContext += ` Refinements: ${allRefinements.join('. ')}`;
        console.log(`[MANUAL-REFRESH] Applied ${allRefinements.length} total refinement(s)`);
      }

      let prompt;
      if (existingTracksInfo) {
        prompt = manualRefreshMode === 'replace'
          ? `${playlistContext ? playlistContext + '\n\n' : ''}Generate ${manualRefreshSongCount} new songs similar in style and mood to this playlist called "${playlistName}". Current songs include: ${existingTracksInfo}. Generate songs that match this exact vibe and description.`
          : `${playlistContext ? playlistContext + '\n\n' : ''}Add ${manualRefreshSongCount} more songs to "${playlistName}" that match these existing songs: ${existingTracksInfo}. Match the exact vibe and description.`;
      } else {
        // Fallback when track details aren't available
        prompt = `${playlistContext ? playlistContext + '\n\n' : ''}Generate ${manualRefreshSongCount} songs for a playlist called "${playlistName}".

IMPORTANT: Pay close attention to the original request and description to understand the exact genre and mood. Generate songs that precisely match the genre, mood, and energy level indicated by the playlist description.`;
      }

      // Build list of URIs to exclude from new generation
      const excludeUris = [];

      // For replace mode, exclude existing tracks
      if (manualRefreshMode === 'replace' && currentTracks && currentTracks.length > 0) {
        excludeUris.push(...currentTracks.map(track => track.uri));
      }

      // Always exclude songs that user removed with minus button
      if (editOptionsPlaylist.excludedSongs && editOptionsPlaylist.excludedSongs.length > 0) {
        const excludedSongUris = editOptionsPlaylist.excludedSongs.map(song => song.uri);
        excludeUris.push(...excludedSongUris);
        console.log(`[MANUAL-REFRESH] Excluding ${excludedSongUris.length} user-removed song(s)`);
      }

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
        <div className="playlists-header">
          <h1>My Playlists</h1>
        </div>
        <div className="playlists-grid">
          {[1, 2, 3].map((i) => (
            <div key={i} className="playlist-card skeleton-card">
              <div className="skeleton-cover"></div>
              <div className="skeleton-content">
                <div className="skeleton-title"></div>
                <div className="skeleton-meta"></div>
              </div>
            </div>
          ))}
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
          Import
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
                onClick={() => !playlist.isReadOnly && togglePlaylist(playlist.playlistId)}
                style={{ cursor: playlist.isReadOnly ? 'default' : 'pointer' }}
              >
                <div className="playlist-header-actions">
                  <div className="playlist-menu-container">
                    <button
                      className="playlist-menu-button"
                      onClick={(e) => toggleMenu(playlist.playlistId, e)}
                      title="More options"
                    >
                      ⋮
                    </button>
                    {openMenuId === playlist.playlistId && (
                      <div className="playlist-dropdown-menu">
                        <button
                          className="playlist-dropdown-item"
                          onClick={(e) => handleMenuAction('spotify', playlist, e)}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                            <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                          </svg>
                          Open in Spotify
                        </button>
                        <button
                          className="playlist-dropdown-item delete-item"
                          onClick={(e) => handleMenuAction('delete', playlist, e)}
                        >
                          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                          </svg>
                          Delete Playlist
                        </button>
                      </div>
                    )}
                  </div>
                  {!playlist.isReadOnly && (
                    <span className="expand-icon" onClick={(e) => e.stopPropagation()}>
                      {expandedPlaylistId === playlist.playlistId ? '▼' : '▶'}
                    </span>
                  )}
                </div>
                <div className="playlist-header-content">
                  {playlist.image ? (
                    <img src={playlist.image} alt={playlist.playlistName} className="playlist-cover-image" />
                  ) : (
                    <div className="playlist-cover-placeholder">♫</div>
                  )}
                  <div className="playlist-info">
                    <h2>
                      {playlist.playlistName}
                      {playlist.imported && (
                        <span className="imported-badge">Imported</span>
                      )}
                      {playlist.platform && (
                        <span className={`platform-badge platform-${playlist.platform}`} title={`${playlist.platform === 'apple' ? 'Apple Music' : 'Spotify'} playlist`}>
                          {playlist.platform === 'apple' ? (
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                              <path d="M18.5 9.5c-.5 0-1.8.3-2.9 1.4-.8-.9-2-1.4-3.1-1.4-2.4 0-4.5 2-4.5 4.5s2 4.5 4.5 4.5c1.2 0 2.3-.5 3.1-1.4 1.1 1.1 2.4 1.4 2.9 1.4 1.4 0 2.5-1.1 2.5-2.5v-4c0-1.4-1.1-2.5-2.5-2.5zM12.5 17c-1.7 0-3-1.3-3-3s1.3-3 3-3 3 1.3 3 3-1.3 3-3 3zm6-2.5c0 .6-.4 1-1 1-.3 0-.9-.1-1.5-.7.3-.6.5-1.3.5-2.1v-1.4c.6-.6 1.2-.8 1.5-.8.6 0 1 .4 1 1v3.5z"/>
                            </svg>
                          ) : (
                            <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor">
                              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                            </svg>
                          )}
                          {playlist.platform === 'apple' ? 'Apple Music' : 'Spotify'}
                        </span>
                      )}
                      {playlist.isReadOnly && (
                        <span className="readonly-badge" title={playlist.readOnlyReason}>🔒</span>
                      )}
                      {playlist.error && (
                        <span className="error-badge" title={playlist.error}>⚠️</span>
                      )}
                    </h2>
                    <p className="playlist-meta">
                      {playlist.updatedAt ? `Updated ${formatDate(playlist.updatedAt)}` : `${playlist.imported ? 'Imported' : 'Created'} ${formatDate(playlist.createdAt)}`}
                      {playlist.isReadOnly && <span style={{ color: '#fbbf24', marginLeft: '8px' }}>({playlist.readOnlyReason})</span>}
                      {playlist.error && !playlist.isReadOnly && <span style={{ color: '#ef4444', marginLeft: '8px' }}>({playlist.error})</span>}
                    </p>
                  </div>
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
                              {track.reaction !== 'thumbsDown' && (
                                <button
                                  className={`track-reaction-button ${track.reaction === 'thumbsUp' ? 'active-thumbs-up' : ''}`}
                                  onClick={() => handleTrackReaction(playlist.playlistId, track, 'thumbsUp')}
                                  title="I like this! Add more songs like this"
                                >
                                  {track.reaction === 'thumbsUp' ? (
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none">
                                      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                                      <line x1="7" y1="11" x2="7" y2="22" stroke="var(--track-bg-color)" strokeWidth="2"/>
                                    </svg>
                                  ) : (
                                    <Icons.ThumbsUp size={16} />
                                  )}
                                </button>
                              )}
                              {track.reaction !== 'thumbsUp' && (
                                <button
                                  className={`track-reaction-button ${track.reaction === 'thumbsDown' ? 'active-thumbs-down' : ''}`}
                                  onClick={() => handleTrackReaction(playlist.playlistId, track, 'thumbsDown')}
                                  title="Not for me. Exclude similar songs"
                                >
                                  {track.reaction === 'thumbsDown' ? (
                                    <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="none">
                                      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                                      <line x1="17" y1="2" x2="17" y2="13" stroke="var(--track-bg-color)" strokeWidth="2"/>
                                    </svg>
                                  ) : (
                                    <Icons.ThumbsDown size={16} />
                                  )}
                                </button>
                              )}
                            </div>
                          </div>
                          <a
                            href={track.externalUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="spotify-link-button"
                            title={`Open in ${track.platform === 'apple' ? 'Apple Music' : 'Spotify'}`}
                          >
                            {track.platform === 'apple' ? (
                              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M23.994 6.124a9.23 9.23 0 00-.24-2.19c-.317-1.31-1.062-2.31-2.18-3.043a5.022 5.022 0 00-1.877-.726 10.5 10.5 0 00-1.564-.15c-.04-.003-.083-.01-.124-.013H5.986c-.152.01-.303.017-.455.026-.747.043-1.49.123-2.193.4-1.336.53-2.3 1.455-2.865 2.78-.192.448-.292.925-.363 1.408a10.61 10.61 0 00-.1 1.18c-.01.062-.01.125-.01.187v11.744c0 .09.01.18.01.27.014.64.07 1.28.208 1.905.257 1.158.865 2.088 1.86 2.742.548.36 1.157.585 1.802.704.515.095 1.038.136 1.564.15.04.002.083.01.124.013h12.016c.152-.01.302-.016.454-.025.725-.042 1.445-.12 2.125-.38 1.415-.54 2.413-1.5 3.004-2.883.177-.414.275-.854.34-1.3a9.31 9.31 0 00.15-1.564c.003-.04.01-.083.013-.124V6.3c-.002-.06-.01-.12-.012-.18zM12.39 4.064c-.432.06-.803.136-1.145.31-.737.375-1.14 1.063-1.168 1.863-.014.402.034.792.162 1.17.216.638.626 1.13 1.232 1.44.44.225.917.326 1.41.364.655.05 1.29-.02 1.903-.244.766-.28 1.317-.778 1.628-1.548.177-.438.247-.895.213-1.363-.048-.667-.338-1.22-.898-1.64-.437-.328-.94-.514-1.477-.587-.337-.046-.675-.063-1.012-.075-.145-.008-.29-.01-.435-.01h-.413zm6.317 13.23c-.52.394-1.12.626-1.767.72-.674.097-1.35.09-2.025.015-.715-.08-1.397-.273-2.04-.606-.588-.305-1.114-.696-1.55-1.197-.48-.55-.828-1.177-1.053-1.868-.226-.693-.31-1.41-.284-2.137.023-.664.135-1.312.368-1.933.3-.8.757-1.488 1.4-2.036.427-.365.905-.65 1.432-.84.552-.2 1.122-.314 1.706-.368.61-.057 1.22-.044 1.828.014.516.05 1.02.15 1.51.315.654.22 1.24.546 1.755.994.63.55 1.1 1.212 1.403 1.99.297.763.42 1.557.395 2.372-.024.8-.19 1.566-.54 2.282-.345.71-.82 1.314-1.446 1.794-.41.313-.87.547-1.363.698-.49.15-1.003.23-1.524.25-.574.02-1.145-.01-1.714-.1-.572-.09-1.13-.245-1.67-.463-.465-.188-.905-.42-1.31-.718-.15-.11-.29-.23-.43-.352-.02-.016-.04-.033-.06-.052l-.02-.022c-.01-.01-.02-.016-.03-.023l-.015-.015-.015-.015.044-.04c.145-.14.29-.28.435-.417.295-.285.59-.568.884-.853l.6-.582c.04.032.082.06.124.086.48.312.998.548 1.55.7.61.168 1.235.245 1.868.22.524-.022 1.037-.11 1.53-.295.426-.16.81-.384 1.145-.7.33-.312.575-.684.714-1.126.144-.46.18-.93.124-1.407-.053-.453-.208-.87-.478-1.236-.27-.365-.616-.64-1.02-.843-.546-.276-1.13-.45-1.732-.575-.63-.13-1.267-.235-1.903-.346-.68-.12-1.353-.258-2.013-.447-.752-.215-1.467-.514-2.11-.972-.594-.424-1.056-.96-1.37-1.618-.296-.618-.42-1.278-.412-1.963.01-.754.18-1.478.533-2.142.362-.682.87-1.235 1.518-1.65.71-.455 1.497-.73 2.333-.866.84-.136 1.685-.155 2.533-.104.757.045 1.503.16 2.232.373.662.193 1.29.46 1.87.83.578.368 1.072.83 1.47 1.396.408.582.682 1.225.835 1.926.138.632.186 1.272.152 1.918-.03.55-.14 1.09-.326 1.61-.19.536-.468 1.027-.835 1.467-.374.45-.822.82-1.33 1.117-.51.3-1.06.515-1.64.657-.585.145-1.18.226-1.783.25-.603.024-1.206-.007-1.804-.092-.585-.083-1.16-.21-1.72-.388-.53-.17-1.04-.38-1.528-.638-.46-.243-.89-.53-1.29-.867-.04-.033-.076-.07-.115-.105l-.04-.037-.015-.015h-.01l-.01-.01c.01-.01.022-.02.034-.032.09-.088.18-.175.27-.26.32-.312.642-.622.962-.933.27-.263.54-.525.81-.787.028.023.058.042.086.063.52.38 1.087.692 1.692.94.645.264 1.314.455 2.005.584.63.118 1.268.18 1.912.188.55.006 1.097-.027 1.636-.15.495-.112.965-.28 1.392-.557.416-.27.74-.625.95-1.08.203-.44.28-.905.23-1.387-.047-.464-.208-.883-.487-1.252-.283-.374-.646-.65-1.064-.856-.56-.276-1.162-.452-1.78-.578-.66-.135-1.328-.24-1.995-.35-.667-.11-1.332-.228-1.987-.404-.736-.2-1.44-.477-2.07-.936-.558-.406-.993-.918-1.29-1.54-.295-.62-.43-1.283-.443-1.968-.013-.703.134-1.382.443-2.022.334-.692.822-1.26 1.458-1.69.71-.48 1.507-.78 2.357-.94.855-.162 1.717-.205 2.583-.17.78.032 1.553.12 2.31.31.71.177 1.39.43 2.027.79.61.344 1.15.773 1.61 1.31.473.553.823 1.178 1.063 1.87.233.67.347 1.362.364 2.07.017.685-.077 1.357-.288 2.008-.214.658-.54 1.256-.987 1.776-.455.53-.998.956-1.62 1.275-.635.326-1.314.547-2.02.68-.722.136-1.452.202-2.188.202-.722 0-1.44-.063-2.152-.182-.68-.114-1.348-.276-1.997-.51-.607-.22-1.19-.49-1.74-.83-.508-.314-.97-.682-1.382-1.11-.032-.034-.063-.07-.096-.104l-.025-.03-.01-.01-.005-.01c.01-.01.02-.018.03-.027.094-.09.188-.18.28-.27.335-.327.67-.652 1.003-.978.26-.253.52-.507.78-.76.03.024.062.046.093.07.547.41 1.15.73 1.795.984.68.268 1.387.458 2.113.586.712.126 1.432.194 2.158.2.62.006 1.238-.033 1.848-.16.578-.12 1.13-.318 1.64-.63.494-.304.892-.7 1.182-1.21.28-.49.418-1.023.422-1.593.004-.557-.128-1.08-.407-1.563-.287-.496-.688-.883-1.177-1.17-.597-.35-1.254-.57-1.936-.718-.733-.16-1.478-.26-2.228-.344-.753-.084-1.506-.17-2.253-.312-.71-.136-1.4-.34-2.047-.682-.616-.326-1.132-.764-1.54-1.34-.408-.578-.653-1.224-.745-1.925-.096-.738-.066-1.47.11-2.194.18-.746.527-1.417 1.042-1.99.522-.582 1.158-1.01 1.88-1.308.726-.3 1.49-.47 2.278-.54.796-.07 1.595-.077 2.393-.02.794.058 1.577.18 2.34.41.712.215 1.39.508 2.025.9.617.38 1.158.858 1.615 1.43.47.59.823 1.246 1.06 1.966.23.7.34 1.424.35 2.166.01.754-.09 1.497-.31 2.216-.227.746-.593 1.425-1.098 2.017-.524.612-1.16 1.096-1.89 1.46-.76.38-1.568.65-2.41.82-.87.176-1.75.27-2.638.29-.89.022-1.78-.02-2.667-.17-.842-.142-1.67-.35-2.477-.64-.76-.272-1.48-.622-2.15-1.06-.62-.404-1.17-.89-1.65-1.46-.05-.06-.1-.12-.15-.18l-.03-.04c-.01-.01-.02-.02-.03-.03l.05-.05c.15-.145.3-.29.45-.436.32-.31.64-.62.96-.93.27-.262.54-.525.81-.788.03.024.06.045.09.07.56.43 1.18.77 1.85 1.03.73.284 1.49.5 2.27.65.82.156 1.65.25 2.49.28.76.026 1.52 0 2.28-.1.7-.092 1.38-.26 2.02-.56.62-.29 1.15-.68 1.58-1.2.43-.52.72-1.11.87-1.77.15-.66.21-1.33.19-2.01-.02-.67-.14-1.32-.37-1.95-.24-.64-.58-1.22-1.04-1.73-.47-.52-1.03-.94-1.66-1.27-.68-.36-1.4-.62-2.16-.79-.82-.18-1.66-.28-2.51-.32-.85-.04-1.71-.02-2.56.08-.85.1-1.68.28-2.49.56-.81.28-1.57.65-2.28 1.1-.71.45-1.35.99-1.91 1.63-.57.65-1.03 1.37-1.37 2.17-.35.82-.58 1.68-.7 2.58-.12.91-.14 1.82-.06 2.74.08.91.27 1.8.58 2.67.31.87.73 1.68 1.27 2.42.54.74 1.18 1.4 1.91 1.96.73.56 1.54 1.01 2.41 1.36.88.35 1.8.6 2.75.76.96.16 1.93.25 2.91.26.98.01 1.95-.06 2.92-.21.97-.15 1.92-.38 2.84-.72.92-.34 1.8-.76 2.63-1.28.83-.52 1.6-1.13 2.3-1.83.7-.7 1.32-1.48 1.86-2.34.54-.86.98-1.78 1.33-2.75.35-.97.6-1.98.76-3.02.16-1.04.23-2.09.21-3.15-.02-1.06-.14-2.11-.36-3.15-.22-1.04-.53-2.05-.94-3.03-.41-.98-.92-1.92-1.53-2.8-.61-.88-1.31-1.7-2.1-2.43-.79-.73-1.66-1.38-2.61-1.94-.95-.56-1.97-1.03-3.05-1.4-1.08-.37-2.21-.64-3.38-.82-1.17-.18-2.37-.27-3.59-.27-1.22 0-2.44.08-3.65.26-1.21.18-2.4.45-3.55.83-1.15.38-2.26.86-3.32 1.44-1.06.58-2.07 1.25-3.01 2.02-.94.77-1.82 1.63-2.62 2.58-.8.95-1.52 1.98-2.15 3.09-.63 1.11-1.17 2.29-1.61 3.53-.44 1.24-.78 2.52-1.02 3.85-.24 1.33-.38 2.69-.42 4.08-.04 1.39.02 2.79.18 4.18.16 1.39.42 2.77.78 4.12.36 1.35.82 2.67 1.38 3.95.56 1.28 1.22 2.52 1.98 3.71.76 1.19 1.61 2.32 2.56 3.38.95 1.06 1.99 2.04 3.12 2.94 1.13.9 2.34 1.71 3.64 2.43 1.3.72 2.67 1.35 4.11 1.88 1.44.53 2.94.96 4.48 1.29 1.54.33 3.11.56 4.71.69 1.6.13 3.21.16 4.82.09 1.61-.07 3.21-.24 4.79-.51 1.58-.27 3.13-.64 4.65-1.11 1.52-.47 3-.1.04 1.47-.14 2.92-.38 1.45-.24 2.88-.58 4.27-1.02 1.39-.44 2.75-.98 4.06-1.62 1.31-.64 2.58-1.37 3.8-2.19 1.22-.82 2.39-1.73 3.5-2.72 1.11-.99 2.16-2.06 3.15-3.2.99-1.14 1.91-2.35 2.76-3.63.85-1.28 1.63-2.62 2.33-4.02.7-1.4 1.32-2.86 1.86-4.37.54-1.51 1-3.07 1.38-4.67.38-1.6.68-3.24.9-4.91.22-1.67.36-3.37.42-5.09.06-1.72.04-3.45-.06-5.18-.1-1.73-.3-3.46-.6-5.18-.3-1.72-.7-3.43-1.2-5.11-.5-1.68-1.1-3.33-1.8-4.95-.7-1.62-1.5-3.2-2.4-4.73-.9-1.53-1.9-3.02-3-4.45-1.1-1.43-2.3-2.81-3.6-4.13-1.3-1.32-2.7-2.58-4.2-3.77-1.5-1.19-3.1-2.31-4.8-3.36-1.7-1.05-3.5-2.02-5.4-2.91-1.9-.89-3.9-1.7-5.9-2.43-2-.73-4.1-1.38-6.3-1.95-2.2-.57-4.4-1.06-6.7-1.47-2.3-.41-4.6-.74-6.9-.99-2.3-.25-4.7-.42-7-.51-2.3-.09-4.7-.1-7-.03-2.3.07-4.6.23-6.9.48-2.3.25-4.6.59-6.8 1.02-2.2.43-4.4.95-6.6 1.56-2.2.61-4.3 1.31-6.4 2.09-2.1.78-4.2 1.65-6.2 2.6-2 .95-4 1.98-5.9 3.09-1.9 1.11-3.7 2.3-5.5 3.57-1.8 1.27-3.5 2.62-5.2 4.05-1.7 1.43-3.3 2.94-4.8 4.53-1.5 1.59-2.9 3.25-4.3 4.98-1.4 1.73-2.7 3.53-3.9 5.4-1.2 1.87-2.3 3.8-3.3 5.79-.1 1.99-1.9 4.03-2.7 6.12-.8 2.09-1.5 4.22-2.1 6.4-.6 2.18-1.1 4.4-1.5 6.65-.4 2.25-.7 4.52-.9 6.82-.2 2.3-.3 4.62-.3 6.95 0 2.33.1 4.66.3 6.99.2 2.33.5 4.65.9 6.96.4 2.31.9 4.6 1.5 6.87.6 2.27 1.3 4.51 2.1 6.72.8 2.21 1.7 4.38 2.7 6.51 1 2.13 2.1 4.22 3.3 6.26 1.2 2.04 2.5 4.03 3.9 5.97 1.4 1.94 2.9 3.82 4.5 5.64 1.6 1.82 3.3 3.58 5.1 5.27 1.8 1.69 3.7 3.31 5.7 4.86 2 1.55 4.1 3.02 6.3 4.42 2.2 1.4 4.5 2.72 6.9 3.96 2.4 1.24 4.9 2.4 7.5 3.48 2.6 1.08 5.3 2.08 8.1 2.99 2.8.91 5.7 1.74 8.6 2.48 2.9.74 5.9 1.39 9 1.95 3.1.56 6.2 1.03 9.4 1.41 3.2.38 6.4.67 9.7.87 3.3.2 6.6.31 9.9.33 3.3.02 6.7-.05 10-.21 3.3-.16 6.6-.42 9.9-.78 3.3-.36 6.6-.82 9.9-1.38 3.3-.56 6.5-1.22 9.8-1.98 3.3-.76 6.5-1.62 9.7-2.58 3.2-.96 6.4-2.02 9.5-3.18 3.1-1.16 6.2-2.42 9.2-3.78 3-1.36 6-2.82 8.9-4.38 2.9-1.56 5.7-3.22 8.5-4.98 2.8-1.76 5.5-3.62 8.1-5.58 2.6-1.96 5.1-4.02 7.5-6.18 2.4-2.16 4.7-4.42 6.9-6.78 2.2-2.36 4.3-4.82 6.3-7.38 2-2.56 3.9-5.22 5.7-7.97 1.8-2.75 3.5-5.59 5.1-8.52 1.6-2.93 3.1-5.95 4.5-9.06 1.4-3.11 2.7-6.3 3.9-9.58 1.2-3.28 2.3-6.64 3.3-10.08 1-3.44 1.9-6.96 2.7-10.56.8-3.6 1.5-7.27 2.1-11.01.6-3.74 1.1-7.55 1.5-11.42.4-3.87.7-7.8.9-11.79.2-3.99.3-8.03.3-12.13 0-4.1-.1-8.24-.3-12.43-.2-4.19-.5-8.42-.9-12.69-.4-4.27-1-8.58-1.7-12.92-.7-4.34-1.5-8.71-2.4-13.11-.9-4.4-2-8.82-3.2-13.26-1.2-4.44-2.5-8.89-4-13.35-1.5-4.46-3.1-8.92-4.9-13.38-1.8-4.46-3.7-8.91-5.7-13.35-2-4.44-4.1-8.86-6.3-13.26-2.2-4.4-4.6-8.77-7.1-13.11-2.5-4.34-5.1-8.64-7.8-12.9-2.7-4.26-5.5-8.47-8.4-12.63-2.9-4.16-5.9-8.26-9-12.3-3.1-4.04-6.3-8.02-9.6-11.93-3.3-3.91-6.7-7.75-10.2-11.52-3.5-3.77-7.1-7.46-10.8-11.07-3.7-3.61-7.5-7.14-11.4-10.59-3.9-3.45-7.9-6.81-12-10.08-4.1-3.27-8.3-6.45-12.6-9.53-4.3-3.08-8.7-6.07-13.2-8.96-4.5-2.89-9.1-5.68-13.8-8.37-4.7-2.69-9.5-5.28-14.3-7.77-4.8-2.49-9.7-4.88-14.7-7.17-5-2.29-10.1-4.48-15.2-6.57-5.1-2.09-10.3-4.08-15.6-5.97-5.3-1.89-10.7-3.68-16.1-5.37-5.4-1.69-10.9-3.28-16.5-4.77-5.6-1.49-11.2-2.88-16.9-4.17-5.7-1.29-11.4-2.48-17.2-3.57-5.8-1.09-11.7-2.08-17.6-2.97-5.9-.89-11.9-1.68-17.9-2.37-6-.69-12.1-1.28-18.2-1.77-6.1-.49-12.3-.88-18.5-1.17-6.2-.29-12.4-.48-18.7-.57-6.3-.09-12.6-.08-18.9.03-6.3.11-12.6.32-18.9.63-6.3.31-12.6.72-18.8 1.23-6.2.51-12.4 1.12-18.6 1.83-6.2.71-12.3 1.52-18.4 2.43-6.1.91-12.2 1.92-18.2 3.03-6 1.11-12 2.32-17.9 3.63-5.9 1.31-11.7 2.72-17.5 4.23-5.8 1.51-11.5 3.12-17.2 4.83-5.7 1.71-11.3 3.52-16.8 5.43-5.5 1.91-11 3.92-16.4 6.03-5.4 2.11-10.7 4.32-16 6.63-5.3 2.31-10.5 4.72-15.6 7.23-5.1 2.51-10.2 5.12-15.2 7.83-5 2.71-9.9 5.52-14.7 8.43-4.8 2.91-9.6 5.92-14.3 9.03-4.7 3.11-9.3 6.32-13.8 9.63-4.5 3.31-8.9 6.72-13.2 10.23-4.3 3.51-8.5 7.12-12.6 10.83-4.1 3.71-8.1 7.52-12 11.43-3.9 3.91-7.7 7.92-11.4 12.03-3.7 4.11-7.3 8.32-10.8 12.63-3.5 4.31-6.9 8.72-10.2 13.23-3.3 4.51-6.5 9.12-9.6 13.83-3.1 4.71-6.1 9.52-9 14.43-2.9 4.91-5.7 9.92-8.4 15.03-2.7 5.11-5.3 10.32-7.8 15.63-2.5 5.31-4.9 10.72-7.2 16.23-2.3 5.51-4.5 11.12-6.6 16.83-2.1 5.71-4.1 11.52-6 17.43-1.9 5.91-3.7 11.92-5.4 18.03-1.7 6.11-3.3 12.32-4.8 18.63-1.5 6.31-2.9 12.72-4.2 19.23-1.3 6.51-2.5 13.12-3.6 19.83-1.1 6.71-2.1 13.52-3 20.43-.9 6.91-1.7 13.92-2.4 21.03-.7 7.11-1.3 14.32-1.8 21.63-.5 7.31-.9 14.72-1.2 22.23-.3 7.51-.5 15.12-.6 22.83-.1 7.71-.1 15.52 0 23.43.1 7.91.3 15.92.6 24.03.3 8.11.7 16.32 1.2 24.63.5 8.31 1.1 16.72 1.8 25.23.7 8.51 1.5 17.12 2.4 25.83.9 8.71 1.9 17.52 3 26.43 1.1 8.91 2.3 17.92 3.6 27.03 1.3 9.11 2.7 18.32 4.2 27.63 1.5 9.31 3.1 18.72 4.8 28.23 1.7 9.51 3.5 19.12 5.4 28.83 1.9 9.71 3.9 19.52 6 29.43 2.1 9.91 4.3 19.92 6.6 30.03 2.3 10.11 4.7 20.32 7.2 30.63 2.5 10.31 5.1 20.72 7.8 31.23 2.7 10.51 5.5 21.12 8.4 31.83 2.9 10.71 5.9 21.52 9 32.43 3.1 10.91 6.3 21.92 9.6 33.03 3.3 11.11 6.7 22.32 10.2 33.63 3.5 11.31 7.1 22.72 10.8 34.23 3.7 11.51 7.5 23.12 11.4 34.83 3.9 11.71 7.9 23.52 12 35.43 4.1 11.91 8.3 23.92 12.6 36.03 4.3 12.11 8.7 24.32 13.2 36.63 4.5 12.31 9.1 24.72 13.8 37.23 4.7 12.51 9.5 25.12 14.3 37.83 4.8 12.71 9.7 25.52 14.7 38.43 5 12.91 10.1 25.92 15.2 39.03 5.1 13.11 10.3 26.32 15.6 39.63 5.3 13.31 10.7 26.72 16.1 40.23 5.4 13.51 10.9 27.12 16.5 40.83 5.6 13.71 11.2 28.52 16.9 42.43 5.7 13.91 11.4 28.92 17.2 43.03 5.8 14.11 11.7 29.32 17.6 43.63 5.9 14.31 11.9 29.72 18 44.23 6.1 14.51 12.3 30.12 18.5 44.83 6.2 14.71 12.4 30.52 18.7 45.43 6.3 14.91 12.6 30.92 18.9 46.03 6.3 15.11 12.6 31.32 18.9 46.63 6.2 15.31 12.4 31.72 18.6 47.23 6.1 15.51 12.3 32.12 18.4 47.83 6 15.71 12.1 32.52 18.2 48.43 5.9 15.91 11.9 32.92 17.9 49.03 5.8 16.11 11.7 33.32 17.6 49.63 5.7 16.31 11.4 33.72 17.2 50.23 5.6 16.51 11.2 34.12 16.9 50.83 5.4 16.71 10.9 34.52 16.5 51.43 5.3 16.91 10.7 34.92 16.1 52.03 5.1 17.11 10.3 35.32 15.6 52.63 5 17.31 10.1 35.72 15.2 53.23 4.8 17.51 9.7 36.12 14.7 53.83 4.7 17.71 9.5 36.52 14.3 54.43 4.5 17.91 9.1 36.92 13.8 55.03 4.3 18.11 8.7 37.32 13.2 55.63 4.1 18.31 8.3 37.72 12.6 56.23 3.9 18.51 7.9 38.12 12 56.83 3.7 18.71 7.5 38.52 11.4 57.43 3.5 18.91 7.1 38.92 10.8 58.03 3.3 19.11 6.7 39.32 10.2 58.63 3.1 19.31 6.3 39.72 9.6 59.23 2.9 19.51 5.9 40.12 9 59.83 2.7 19.71 5.5 40.52 8.4 60.43 2.5 19.91 5.1 40.92 7.8 61.03 2.3 20.11 4.7 41.32 7.2 61.63 2.1 20.31 4.3 41.72 6.6 62.23 1.9 20.51 3.9 42.12 6 62.83 1.7 20.71 3.5 42.52 5.4 63.43 1.5 20.91 3.1 42.92 4.8 64.03 1.3 21.11 2.7 43.32 4.2 64.63 1.1 21.31 2.3 43.72 3.6 65.23.9 21.51 1.9 44.12 3 65.83.7 21.71 1.5 44.52 2.4 66.43.5 21.91 1.1 44.92 1.8 67.03.3 22.11.7 45.32 1.2 67.63.1 22.31.3 45.72.6 68.23-.1 22.51-.1 46.12 0 68.83-.3 22.71-.5 46.52-.6 69.43-.5 22.91-.9 46.92-1.2 70.03-.7 23.11-1.3 47.32-1.8 70.63-.9 23.31-1.7 47.72-2.4 71.23-1.1 23.51-2.1 48.12-3 71.83-1.3 23.71-2.5 48.52-3.6 72.43-1.5 23.91-2.9 48.92-4.2 73.03-1.7 24.11-3.3 49.32-4.8 73.63-1.9 24.31-3.7 49.72-5.4 74.23-2.1 24.51-4.1 50.12-6 74.83-2.3 24.71-4.5 50.52-6.6 75.43-2.5 24.91-4.9 50.92-7.2 76.03-2.7 25.11-5.3 51.32-7.8 76.63-2.9 25.31-5.7 51.72-8.4 77.23-3.1 25.51-6.1 52.12-9 77.83-3.3 25.71-6.5 52.52-9.6 78.43-3.5 25.91-6.9 52.92-10.2 79.03-3.7 26.11-7.3 53.32-10.8 79.63-3.9 26.31-7.7 53.72-11.4 80.23-4.1 26.51-8.1 54.12-12 80.83-4.3 26.71-8.5 54.52-12.6 81.43-4.5 26.91-8.9 54.92-13.2 82.03-4.7 27.11-9.3 55.32-13.8 82.63-4.9 27.31-9.7 55.72-14.3 83.23-5.1 27.51-10.2 56.12-15.2 84.03-5.3 27.71-10.5 56.52-15.6 84.83-5.5 27.91-11 56.92-16.4 85.63-5.7 28.11-11.3 57.32-16.8 86.43-5.9 28.31-11.7 57.72-17.5 87.23-6.1 28.51-12.2 58.12-18.2 88.03-6.3 28.71-12.6 58.52-18.8 89.83"/>
                              </svg>
                            ) : (
                              <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                              </svg>
                            )}
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
              <h2>Import Playlist {activePlatform ? `from ${activePlatform === 'spotify' ? 'Spotify' : 'Apple Music'}` : ''}</h2>
              <button onClick={closeImportModal} className="close-modal-button">
                ×
              </button>
            </div>

            {loadingPlaylists ? (
              <div className="modal-loading">
                <span className="spinner"></span>
                <p>Loading your {activePlatform === 'apple' ? 'Apple Music' : 'Spotify'} playlists...</p>
              </div>
            ) : platformPlaylists.length === 0 ? (
              <div className="modal-empty">
                <p>No playlists available to import. All your {activePlatform === 'apple' ? 'Apple Music' : 'Spotify'} playlists have already been imported.</p>
              </div>
            ) : (
              <div className="spotify-playlists-list">
                {platformPlaylists.map((playlist) => (
                  <div key={playlist.id} className="spotify-playlist-item">
                    {playlist.image ? (
                      <img src={playlist.image} alt={playlist.name} className="spotify-playlist-image" />
                    ) : (
                      <div className="spotify-playlist-image playlist-cover-placeholder">♫</div>
                    )}
                    <div className="spotify-playlist-info">
                      <div className="spotify-playlist-name">{playlist.name}</div>
                      <div className="spotify-playlist-meta">
                        {playlist.trackCount} tracks{playlist.owner ? ` • by ${playlist.owner}` : ''}
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

                <div className="chat-input-container" onClick={() => setShowRefinementModal(true)}>
                  <input
                    type="text"
                    value=""
                    readOnly
                    placeholder="Refine your playlist!"
                    className="chat-input"
                    style={{ cursor: 'pointer' }}
                  />
                  <svg viewBox="0 0 24 24" style={{ width: '20px', height: '20px', fill: '#8e8e93' }}>
                    <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
                  </svg>
                  {addingRefinement && (
                    <div style={{ position: 'absolute', right: '50px' }}>
                      <div className="wave-loader">
                        <div className="wave-bar"></div>
                        <div className="wave-bar"></div>
                        <div className="wave-bar"></div>
                        <div className="wave-bar"></div>
                      </div>
                    </div>
                  )}
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


      {/* Refinement Modal */}
      {showRefinementModal && editOptionsPlaylist && (
        <div className="chat-modal-overlay" onClick={() => setShowRefinementModal(false)}>
          <div className="chat-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="chat-modal-header">
              <h2>Refine Playlist</h2>
              <button onClick={() => setShowRefinementModal(false)} className="close-modal-button">
                ×
              </button>
            </div>

            <div className="chat-modal-body">
              {/* Original Prompt */}
              <div className="chat-message original-prompt">
                <div className="chat-message-label">Original Request</div>
                <div className="chat-message-content">
                  {editOptionsPlaylist.originalPrompt || editOptionsPlaylist.playlistName}
                </div>
              </div>

              {/* Chat History */}
              <div className="chat-history">
                {editOptionsPlaylist.chatMessages && editOptionsPlaylist.chatMessages.map((msg, index) => (
                  <div key={index} className={`chat-message ${msg.role}`}>
                    <div className="chat-message-content">
                      {msg.content}
                    </div>
                  </div>
                ))}
                {refinementInstructions && refinementInstructions.map((instruction, index) => (
                  <div key={`refinement-${index}`} className="chat-message user">
                    <div className="chat-message-content">
                      {instruction.instruction}
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Chat Input */}
            <div className="chat-modal-input-area">
              <div className="chat-modal-input-container">
                <input
                  type="text"
                  value={refinementInput}
                  onChange={(e) => setRefinementInput(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && !addingRefinement && refinementInput.trim()) {
                      handleAddRefinement();
                      setShowRefinementModal(false);
                    }
                  }}
                  placeholder="Add a refinement..."
                  className="chat-modal-input"
                  disabled={addingRefinement}
                />
                <button
                  onClick={() => {
                    handleAddRefinement();
                    setShowRefinementModal(false);
                  }}
                  disabled={addingRefinement || !refinementInput.trim()}
                  className="chat-modal-send-button"
                  title="Send Message"
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
