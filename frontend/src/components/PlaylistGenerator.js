import React, { useState, useEffect, useRef } from 'react';
import { flushSync } from 'react-dom';
import playlistService from '../services/api';
import MyPlaylists from './MyPlaylists';
import Settings from './Settings';
import Account from './Account';
import FAQ from './FAQ';
import SignupForm from './SignupForm';
import PlatformSelection from './PlatformSelection';
import Toast from './Toast';
import Icons from './Icons';
import ErrorMessage from './ErrorMessage';
import ProductTour from './ProductTour';
import '../styles/PlaylistGenerator.css';
import '../styles/ApplePodcastsTheme.css';
import '../styles/AccountModal.css';

const PlaylistGenerator = () => {
  const [prompt, setPrompt] = useState('');
  const [userId, setUserId] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [inSignupFlow, setInSignupFlow] = useState(false);
  const [loading, setLoading] = useState(false);
  const [generatedPlaylist, setGeneratedPlaylist] = useState(null);
  const [error, setError] = useState('');
  const [creatingPlaylist, setCreatingPlaylist] = useState(false);
  const [activeTab, setActiveTab] = useState('home');
  const [showProfileDropdown, setShowProfileDropdown] = useState(false);
  const [userProfile, setUserProfile] = useState(null);
  const [showPlaylistModal, setShowPlaylistModal] = useState(false);
  const [modalStep, setModalStep] = useState(1); // 1 = track selection, 2 = name/description
  const [chatMessages, setChatMessages] = useState([]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  const [loadingMoreSongs, setLoadingMoreSongs] = useState(false);
  const [editedPlaylistName, setEditedPlaylistName] = useState('');
  const [editedDescription, setEditedDescription] = useState('');
  const [updateFrequency, setUpdateFrequency] = useState('never');
  const [updateMode, setUpdateMode] = useState('append');
  const [isPublic, setIsPublic] = useState(true);
  const [draftPlaylists, setDraftPlaylists] = useState([]);
  const [currentDraftId, setCurrentDraftId] = useState(null);
  const [generatingMessage, setGeneratingMessage] = useState('');
  const [showGeneratingModal, setShowGeneratingModal] = useState(false);
  const [generatingError, setGeneratingError] = useState(null);
  const [errorInfo, setErrorInfo] = useState(null);
  const [retryCount, setRetryCount] = useState(0);
  const [lastRetryFunction, setLastRetryFunction] = useState(null);
  const [showChatModal, setShowChatModal] = useState(false);
  const [showProductTour, setShowProductTour] = useState(false);

  // Search state
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState(null);
  const [showSearchResults, setShowSearchResults] = useState(false);
  const [searchLoading, setSearchLoading] = useState(false);
  const searchDropdownRef = useRef(null);

  // User preferences (loaded from localStorage)
  const [allowExplicit, setAllowExplicit] = useState(() => {
    const saved = localStorage.getItem('allowExplicit');
    return saved !== null ? JSON.parse(saved) : true;
  });
  const [newArtistsOnly, setNewArtistsOnly] = useState(false);
  const [songCount, setSongCount] = useState(30);
  const [showOptionsMenu, setShowOptionsMenu] = useState(false);
  const [showPromptTooltip, setShowPromptTooltip] = useState(false);
  const optionsMenuRef = useRef(null);

  // Toast notifications
  const [toasts, setToasts] = useState([]);

  // Top artists
  const [topArtists, setTopArtists] = useState([]);
  const [loadingTopArtists, setLoadingTopArtists] = useState(false);
  const topArtistsScrollRef = useRef(null);

  // New artists
  const [newArtists, setNewArtists] = useState([]);
  const [loadingNewArtists, setLoadingNewArtists] = useState(false);
  const [newArtistsFetched, setNewArtistsFetched] = useState(false);
  const newArtistsScrollRef = useRef(null);

  // Connected platforms
  const [connectedPlatforms, setConnectedPlatforms] = useState({ spotify: false, apple: false });
  const [spotifyUserId, setSpotifyUserId] = useState(null);
  const [appleMusicUserId, setAppleMusicUserId] = useState(null);
  const [activePlatform, setActivePlatform] = useState(null); // 'spotify' or 'apple'

  // Artist settings modal
  const [showArtistSettingsModal, setShowArtistSettingsModal] = useState(false);
  const [selectedArtist, setSelectedArtist] = useState(null);
  const [artistModalNewArtistsOnly, setArtistModalNewArtistsOnly] = useState(false);
  const [artistModalSongCount, setArtistModalSongCount] = useState(30);

  // Account settings modal
  const [showAccountModal, setShowAccountModal] = useState(false);
  const [accountEmail, setAccountEmail] = useState('');
  const [accountPlatform, setAccountPlatform] = useState('');

  // Edit email modal
  const [showEditEmailModal, setShowEditEmailModal] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');

  // Edit password modal
  const [showEditPasswordModal, setShowEditPasswordModal] = useState(false);

  // Ref to prevent duplicate playlist generation calls
  const isGeneratingRef = useRef(false);
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');

  // Edit platform modal
  const [showEditPlatformModal, setShowEditPlatformModal] = useState(false);
  const [selectedPlatform, setSelectedPlatform] = useState('');

  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState('');
  const [isDescriptionExpanded, setIsDescriptionExpanded] = useState(false);
  const [showTrackListMenu, setShowTrackListMenu] = useState(false);
  const trackListMenuRef = useRef(null);

  // Example prompts for inspiration
  const examplePrompts = [
    "Early 2000's pop music",
    "Workout rap music at the gym",
    "Music similar to Taylor Swift and Joji",
    "Chill indie vibes for studying",
    "90s R&B slow jams",
    "Electronic dance music for parties"
  ];

  // Helper function to get the active userId based on selected platform
  const getActiveUserId = () => {
    if (activePlatform === 'spotify' && spotifyUserId) {
      return spotifyUserId;
    } else if (activePlatform === 'apple' && appleMusicUserId) {
      return appleMusicUserId;
    }
    // Fallback to the general userId (backwards compatibility)
    return userId;
  };

  useEffect(() => {
    // Load platform-specific userIds from localStorage
    const storedSpotifyUserId = localStorage.getItem('spotifyUserId');
    const storedAppleMusicUserId = localStorage.getItem('appleMusicUserId');
    const storedActivePlatform = localStorage.getItem('activePlatform');

    console.log('PlaylistGenerator: Loading stored IDs:', {
      spotify: storedSpotifyUserId,
      apple: storedAppleMusicUserId,
      active: storedActivePlatform
    });

    if (storedSpotifyUserId) setSpotifyUserId(storedSpotifyUserId);
    if (storedAppleMusicUserId) setAppleMusicUserId(storedAppleMusicUserId);

    // Set active platform (prefer stored, otherwise use whichever is available)
    if (storedActivePlatform && (
      (storedActivePlatform === 'spotify' && storedSpotifyUserId) ||
      (storedActivePlatform === 'apple' && storedAppleMusicUserId)
    )) {
      setActivePlatform(storedActivePlatform);
    } else if (storedSpotifyUserId) {
      setActivePlatform('spotify');
      localStorage.setItem('activePlatform', 'spotify');
    } else if (storedAppleMusicUserId) {
      setActivePlatform('apple');
      localStorage.setItem('activePlatform', 'apple');
    }

    // Check URL params first
    const urlParams = new URLSearchParams(window.location.search);
    const success = urlParams.get('success');
    const spotifyConnected = urlParams.get('spotify') === 'connected';

    // First, check if user has a userId stored (either from signup or previous login)
    const storedUserId = localStorage.getItem('userId');
    if (storedUserId) {
      // Check if this is an old platform-specific userId (migration cleanup)
      const isOldPlatformId = storedUserId.startsWith('spotify_') || storedUserId.startsWith('apple_music_');

      if (isOldPlatformId) {
        console.warn('PlaylistGenerator: Detected old platform-specific userId, clearing localStorage');
        // Clear old data - user will need to log in again with new system
        localStorage.clear();
        window.location.reload();
        return;
      }

      console.log('PlaylistGenerator: Found existing userId in localStorage:', storedUserId);
      setUserId(storedUserId);
      setIsAuthenticated(true);

      // Note: userId is now email-based (platform-independent)
      // Platform-specific IDs are stored separately as spotifyUserId and appleMusicUserId
    }

    // Check if user is in signup flow
    const inSignup = localStorage.getItem('inSignupFlow') === 'true';
    if (inSignup && !storedUserId) {
      // Only show PlatformSelection if in signup flow AND don't have userId yet
      console.log('PlaylistGenerator: User is in signup flow without userId');
      setInSignupFlow(true);
      return; // Don't check auth yet, let PlatformSelection handle it
    }

    // Check if user just authenticated via OAuth (urlParams already parsed above)
    const userIdParam = urlParams.get('userId');
    const emailParam = urlParams.get('email');
    const spotifyUserIdParam = urlParams.get('spotifyUserId');
    const appleMusicUserIdParam = urlParams.get('appleMusicUserId');
    const connectingFromAccount = localStorage.getItem('connectingFromAccount') === 'true';

    console.log('PlaylistGenerator useEffect - checking URL params:', {
      userIdParam,
      emailParam,
      spotifyUserIdParam,
      appleMusicUserIdParam,
      success,
      spotifyConnected,
      connectingFromAccount,
      currentStoredEmail: localStorage.getItem('userEmail'),
      storedUserId
    });

    // Check if we're in OAuth flow BEFORE clearing URL params
    const isInOAuthFlow = success === 'true' || spotifyConnected;

    if ((userIdParam && success === 'true') || spotifyConnected) {
      // Set a flag to skip validation on the next page load
      localStorage.setItem('skipValidation', 'true');

      if (userIdParam) {
        setUserId(userIdParam);
        setIsAuthenticated(true);
        localStorage.setItem('userId', userIdParam);
      }

      // If email is provided in callback, update localStorage
      if (emailParam) {
        const decodedEmail = decodeURIComponent(emailParam);
        console.log('PlaylistGenerator: OAuth callback email parameter:', decodedEmail);
        console.log('PlaylistGenerator: Previous userEmail was:', localStorage.getItem('userEmail'));
        localStorage.setItem('userEmail', decodedEmail);
        console.log('PlaylistGenerator: Updated userEmail from OAuth callback:', decodedEmail);
        console.log('PlaylistGenerator: Verified userEmail is now:', localStorage.getItem('userEmail'));
      }

      // Store platform-specific userIds from OAuth callback
      if (spotifyUserIdParam) {
        console.log('PlaylistGenerator: Storing Spotify userId from OAuth callback:', spotifyUserIdParam);
        setSpotifyUserId(spotifyUserIdParam);
        localStorage.setItem('spotifyUserId', spotifyUserIdParam);
        setActivePlatform('spotify');
        localStorage.setItem('activePlatform', 'spotify');
      }

      if (appleMusicUserIdParam) {
        console.log('PlaylistGenerator: Storing Apple Music userId from OAuth callback:', appleMusicUserIdParam);
        setAppleMusicUserId(appleMusicUserIdParam);
        localStorage.setItem('appleMusicUserId', appleMusicUserIdParam);
        setActivePlatform('apple');
        localStorage.setItem('activePlatform', 'apple');
      }

      // If coming back from Spotify OAuth, store flag for Account component to read
      if (spotifyConnected) {
        console.log('PlaylistGenerator: Spotify OAuth callback detected, storing flag for Account component');
        localStorage.setItem('spotifyOAuthCompleted', 'true');
      }

      // Clean up URL and redirect to home page
      console.log('PlaylistGenerator: Clearing URL parameters and redirecting to home');
      window.history.replaceState({}, document.title, '/');
    }

    // Load connected platforms from backend (get authoritative data)
    // Skip validation if we're in the middle of OAuth flow to avoid race conditions
    const skipValidation = localStorage.getItem('skipValidation') === 'true';

    // Clear the skipValidation flag after a delay to allow for page redirects
    if (skipValidation) {
      setTimeout(() => {
        localStorage.removeItem('skipValidation');
      }, 2000); // 2 second delay
    }

    const userEmail = localStorage.getItem('userEmail');
    if (userEmail && !isInOAuthFlow && !skipValidation) {
      playlistService.getAccountInfo(userEmail)
        .then(accountInfo => {
          if (accountInfo && accountInfo.connectedPlatforms) {
            console.log('PlaylistGenerator: Fetched connected platforms from backend:', accountInfo.connectedPlatforms);
            setConnectedPlatforms(accountInfo.connectedPlatforms);
            localStorage.setItem('connectedPlatforms', JSON.stringify(accountInfo.connectedPlatforms));

            // Validate localStorage userIds against backend platform status
            const backendPlatforms = accountInfo.connectedPlatforms;
            const localSpotifyUserId = localStorage.getItem('spotifyUserId');
            const localAppleMusicUserId = localStorage.getItem('appleMusicUserId');

            // If localStorage has spotifyUserId but backend says Spotify not connected, clear it
            if (localSpotifyUserId && !backendPlatforms.spotify) {
              console.warn('PlaylistGenerator: Clearing stale spotifyUserId - backend says not connected');
              localStorage.removeItem('spotifyUserId');
              setSpotifyUserId(null);
              // If this was the active platform, clear it
              if (activePlatform === 'spotify') {
                setActivePlatform(null);
                localStorage.removeItem('activePlatform');
              }
              // Clear any displayed data
              setTopArtists([]);
              setNewArtists([]);
            }

            // If localStorage has appleMusicUserId but backend says Apple not connected, clear it
            if (localAppleMusicUserId && !backendPlatforms.apple) {
              console.warn('PlaylistGenerator: Clearing stale appleMusicUserId - backend says not connected');
              localStorage.removeItem('appleMusicUserId');
              setAppleMusicUserId(null);
              // If this was the active platform, clear it
              if (activePlatform === 'apple') {
                setActivePlatform(null);
                localStorage.removeItem('activePlatform');
              }
              // Clear any displayed data
              setTopArtists([]);
              setNewArtists([]);
            }
          }
        })
        .catch(err => {
          console.error('PlaylistGenerator: Error fetching platform status from backend:', err);
          // Fall back to localStorage if fetch fails
          const storedPlatforms = localStorage.getItem('connectedPlatforms');
          if (storedPlatforms) {
            try {
              const parsed = JSON.parse(storedPlatforms);
              console.log('PlaylistGenerator: Using fallback stored platforms:', parsed);
              setConnectedPlatforms(parsed);
            } catch (e) {
              console.error('Error parsing stored platforms:', e);
            }
          }
        });
    } else {
      // Fall back to localStorage if no email
      const storedPlatforms = localStorage.getItem('connectedPlatforms');
      if (storedPlatforms) {
        try {
          const parsed = JSON.parse(storedPlatforms);
          setConnectedPlatforms(parsed);
        } catch (err) {
          console.error('Error parsing connected platforms:', err);
        }
      }
    }
  }, []);

  // Listen for platform changes from Account page
  useEffect(() => {
    const handlePlatformChange = (event) => {
      console.log('PlaylistGenerator: Platform changed event received:', event.detail);
      const newPlatforms = event.detail;
      setConnectedPlatforms(newPlatforms);

      // Reload userId and activePlatform from localStorage
      const storedSpotifyUserId = localStorage.getItem('spotifyUserId');
      const storedAppleMusicUserId = localStorage.getItem('appleMusicUserId');
      const storedActivePlatform = localStorage.getItem('activePlatform');
      const storedUserId = localStorage.getItem('userId');

      console.log('PlaylistGenerator: Reloading after platform change:', {
        spotify: storedSpotifyUserId,
        apple: storedAppleMusicUserId,
        active: storedActivePlatform,
        userId: storedUserId
      });

      if (storedSpotifyUserId) setSpotifyUserId(storedSpotifyUserId);
      else setSpotifyUserId(null);

      if (storedAppleMusicUserId) setAppleMusicUserId(storedAppleMusicUserId);
      else setAppleMusicUserId(null);

      if (storedActivePlatform) setActivePlatform(storedActivePlatform);
      else setActivePlatform(null);

      if (storedUserId) {
        setUserId(storedUserId);
        setIsAuthenticated(true);
      } else {
        setUserId(null);
        setIsAuthenticated(false);
      }

      // Reload top artists and new artists with the new active platform
      if (storedUserId) {
        setTopArtists([]);
        setNewArtists([]);
        setNewArtistsFetched(false);
        // Trigger refetch
        setTimeout(() => {
          fetchTopArtists();
          fetchNewArtists();
        }, 100);
      } else {
        // Clear data when no platforms connected
        setTopArtists([]);
        setNewArtists([]);
        setNewArtistsFetched(false);
      }
    };

    window.addEventListener('platformsChanged', handlePlatformChange);
    return () => window.removeEventListener('platformsChanged', handlePlatformChange);
  }, []);

  // Fetch top artists and new artists when user is authenticated
  useEffect(() => {
    if (isAuthenticated && userId && !newArtistsFetched) {
      // Only fetch if we have a platform connected
      if (spotifyUserId || appleMusicUserId) {
        if (topArtists.length === 0) {
          fetchTopArtists();
          fetchUserProfile();
        }
        fetchNewArtists();
      }

      // Check if user has completed the tour
      const tourCompleted = localStorage.getItem('productTourCompleted');
      if (!tourCompleted) {
        // Show tour after a brief delay to let the UI settle
        setTimeout(() => {
          setShowProductTour(true);
        }, 1000);
      }
    }
  }, [isAuthenticated, userId, spotifyUserId, appleMusicUserId]);

  // Load draft playlists when user is authenticated
  useEffect(() => {
    const loadDrafts = async () => {
      if (isAuthenticated && userId) {
        try {
          const response = await playlistService.getDrafts(userId);
          if (response.drafts && response.drafts.length > 0) {
            // Set the drafts array so they appear in the "Unfinished Playlists" section
            setDraftPlaylists(response.drafts);
            console.log('Loaded drafts:', response.drafts.length);
          }
        } catch (error) {
          console.error('Failed to load drafts:', error);
        }
      }
    };
    loadDrafts();
  }, [isAuthenticated, userId]);

  // Watch for connected platforms changes (when user connects/disconnects from Account page)
  useEffect(() => {
    const handlePlatformsChanged = async (event) => {
      console.log('PlaylistGenerator: platformsChanged event received:', event.detail);
      // Fetch the latest platform status from backend instead of relying on event data
      try {
        const userEmail = localStorage.getItem('userEmail');
        if (userEmail) {
          const accountInfo = await playlistService.getAccountInfo(userEmail);
          if (accountInfo && accountInfo.connectedPlatforms) {
            console.log('PlaylistGenerator: Fetched updated platforms from backend:', accountInfo.connectedPlatforms);
            setConnectedPlatforms(accountInfo.connectedPlatforms);
            // If user just connected a platform, fetch top artists and new artists
            if ((accountInfo.connectedPlatforms.spotify || accountInfo.connectedPlatforms.apple) && topArtists.length === 0) {
              console.log('PlaylistGenerator: Platform connected, fetching artists. Current userId:', userId);
              const currentUserId = userId || localStorage.getItem('userId');
              if (currentUserId) {
                fetchTopArtists();
                fetchNewArtists();
              } else {
                console.log('PlaylistGenerator: No userId available, cannot fetch artists yet');
              }
            }
          }
        }
      } catch (err) {
        console.error('PlaylistGenerator: Error fetching updated platforms:', err);
        // Fall back to event data if fetch fails
        setConnectedPlatforms(event.detail);
      }
    };

    window.addEventListener('platformsChanged', handlePlatformsChanged);
    return () => window.removeEventListener('platformsChanged', handlePlatformsChanged);
  }, [topArtists.length, userId]);

  // Close dropdown when clicking outside
  useEffect(() => {
    const handleClickOutside = (event) => {
      if (showProfileDropdown && !event.target.closest('.profile-section-topnav')) {
        setShowProfileDropdown(false);
      }
      if (showSearchResults && searchDropdownRef.current && !searchDropdownRef.current.contains(event.target)) {
        setShowSearchResults(false);
      }
      if (showOptionsMenu && optionsMenuRef.current && !optionsMenuRef.current.contains(event.target)) {
        setShowOptionsMenu(false);
      }
      if (showTrackListMenu && trackListMenuRef.current && !trackListMenuRef.current.contains(event.target)) {
        setShowTrackListMenu(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showProfileDropdown, showSearchResults, showOptionsMenu, showTrackListMenu]);

  // Prevent body scroll when modal is open
  useEffect(() => {
    if (showArtistSettingsModal || showPlaylistModal) {
      document.body.classList.add('modal-open');
    } else {
      document.body.classList.remove('modal-open');
    }
    return () => document.body.classList.remove('modal-open');
  }, [showArtistSettingsModal, showPlaylistModal]);

  const fetchUserProfile = async () => {
    try {
      const data = await playlistService.getUserProfile(userId);
      setUserProfile(data);
    } catch (err) {
      console.error('Failed to fetch user profile:', err);
    }
  };

  const handleLogout = () => {
    localStorage.removeItem('userId');
    setUserId(null);
    setIsAuthenticated(false);
    setUserProfile(null);
    setTopArtists([]);
    setGeneratedPlaylist(null);
    setShowProfileDropdown(false);
  };

  // Account modal handlers
  const openAccountModal = () => {
    const userEmail = localStorage.getItem('userEmail') || '';
    const platform = localStorage.getItem('musicPlatform') || 'spotify';

    setAccountEmail(userEmail);
    setAccountPlatform(platform);
    setAccountError('');
    setShowAccountModal(true);
  };

  const closeAccountModal = () => {
    setShowAccountModal(false);
    setAccountError('');
  };

  // Edit email modal handlers
  const openEditEmailModal = () => {
    setNewEmail('');
    setEmailPassword('');
    setAccountError('');
    setShowEditEmailModal(true);
    setShowAccountModal(false);
  };

  const closeEditEmailModal = () => {
    setShowEditEmailModal(false);
    setNewEmail('');
    setEmailPassword('');
    setAccountError('');
    setShowAccountModal(true);
  };

  // Edit password modal handlers
  const openEditPasswordModal = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setAccountError('');
    setShowEditPasswordModal(true);
    setShowAccountModal(false);
  };

  const closeEditPasswordModal = () => {
    setShowEditPasswordModal(false);
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setAccountError('');
    setShowAccountModal(true);
  };

  // Edit platform modal handlers
  const openEditPlatformModal = () => {
    setSelectedPlatform(accountPlatform);
    setAccountError('');
    setShowEditPlatformModal(true);
    setShowAccountModal(false);
  };

  const closeEditPlatformModal = () => {
    setShowEditPlatformModal(false);
    setAccountError('');
    setShowAccountModal(true);
  };

  const handleUpdateEmail = async () => {
    setAccountError('');

    if (!newEmail.trim()) {
      setAccountError('Please enter a new email address');
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(newEmail)) {
      setAccountError('Please enter a valid email address');
      return;
    }

    if (!emailPassword) {
      setAccountError('Please enter your password to confirm');
      return;
    }

    setAccountLoading(true);
    try {
      const data = await playlistService.updateEmail(accountEmail, newEmail, emailPassword);

      // Update local storage
      localStorage.setItem('authToken', data.token);
      localStorage.setItem('userEmail', data.email);

      setAccountEmail(data.email);
      showToast('Email updated successfully!', 'success');
      setShowEditEmailModal(false);
      setShowAccountModal(true);
      setNewEmail('');
      setEmailPassword('');
    } catch (err) {
      setAccountError(err.response?.data?.error || 'Failed to update email');
    } finally {
      setAccountLoading(false);
    }
  };

  const handleUpdatePassword = async () => {
    setAccountError('');

    if (!currentPassword) {
      setAccountError('Please enter your current password');
      return;
    }

    if (!newPassword) {
      setAccountError('Please enter a new password');
      return;
    }

    if (newPassword.length < 6) {
      setAccountError('New password must be at least 6 characters long');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setAccountError('New passwords do not match');
      return;
    }

    setAccountLoading(true);
    try {
      await playlistService.updatePassword(accountEmail, currentPassword, newPassword);

      showToast('Password updated successfully!', 'success');
      setShowEditPasswordModal(false);
      setShowAccountModal(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmNewPassword('');
    } catch (err) {
      setAccountError(err.response?.data?.error || 'Failed to update password');
    } finally {
      setAccountLoading(false);
    }
  };

  const handleUpdatePlatform = async () => {
    setAccountError('');

    if (selectedPlatform === accountPlatform) {
      setAccountError('Please select a different platform');
      return;
    }

    setAccountLoading(true);
    try {
      const data = await playlistService.updatePlatform(accountEmail, selectedPlatform);

      // Update local storage
      localStorage.setItem('musicPlatform', data.platform);

      setAccountPlatform(data.platform);
      showToast('Music platform updated successfully!', 'success');
      setShowEditPlatformModal(false);
      setShowAccountModal(true);

      // If switching to a platform that requires re-authentication
      if (selectedPlatform === 'spotify') {
        showToast('Please reconnect to Spotify to use the new platform', 'info');
        // Optionally redirect to Spotify auth
        // const authData = await playlistService.getSpotifyAuthUrl();
        // window.location.href = authData.url;
      }
    } catch (err) {
      setAccountError(err.response?.data?.error || 'Failed to update platform');
    } finally {
      setAccountLoading(false);
    }
  };

  const showToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(toast => toast.id !== id));
  };

  const handleSpotifyLogin = async () => {
    try {
      const { url } = await playlistService.getSpotifyAuthUrl();
      window.location.href = url;
    } catch (err) {
      setError('Failed to connect to Spotify. Please try again.');
      console.error(err);
    }
  };

  // Generate genre-specific messages based on the prompt
  const getGenreMessages = (promptText) => {
    const text = promptText.toLowerCase();

    // Define message sets for different genres/moods
    const messageMap = {
      // Chill/Relaxation
      chill: [
        'Finding the perfect vibe...',
        'Crafting a relaxing soundscape...',
        'Blending smooth melodies...',
        'Curating your zen playlist...',
      ],
      // Workout/Energetic
      workout: [
        'Pumping up the energy...',
        'Finding your rhythm...',
        'Building momentum...',
        'Intensifying the beat...',
      ],
      // Focus/Study
      focus: [
        'Selecting focus-friendly tracks...',
        'Building concentration vibes...',
        'Crafting a productive atmosphere...',
        'Finding the perfect flow...',
      ],
      // Party/Dance
      party: [
        'Turning up the heat...',
        'Mixing the best drops...',
        'Building the energy...',
        'Getting the crowd hyped...',
      ],
      // Love/Romance
      love: [
        'Finding romantic melodies...',
        'Crafting an intimate playlist...',
        'Blending heartfelt songs...',
        'Setting the mood...',
      ],
      // Sad/Emotional
      sad: [
        'Gathering emotional tracks...',
        'Finding cathartic songs...',
        'Building an emotional journey...',
        'Curating deep feelings...',
      ],
      // Default messages
      default: [
        'Discovering the perfect tracks...',
        'Curating your playlist...',
        'Blending songs harmoniously...',
        'Building your soundtrack...',
        'Searching the music library...',
        'Crafting your collection...',
      ],
    };

    // Detect genre keywords
    if (text.includes('chill') || text.includes('relax') || text.includes('sleep') || text.includes('calm') || text.includes('peaceful')) {
      return messageMap.chill;
    }
    if (text.includes('workout') || text.includes('gym') || text.includes('run') || text.includes('exercise') || text.includes('pump') || text.includes('energy')) {
      return messageMap.workout;
    }
    if (text.includes('focus') || text.includes('study') || text.includes('work') || text.includes('concentrate') || text.includes('productivity')) {
      return messageMap.focus;
    }
    if (text.includes('party') || text.includes('dance') || text.includes('club') || text.includes('raves') || text.includes('hip hop') || text.includes('edm')) {
      return messageMap.party;
    }
    if (text.includes('love') || text.includes('romantic') || text.includes('date') || text.includes('relationship') || text.includes('heart')) {
      return messageMap.love;
    }
    if (text.includes('sad') || text.includes('emotional') || text.includes('cry') || text.includes('breakup') || text.includes('melancholic')) {
      return messageMap.sad;
    }

    return messageMap.default;
  };

  const handleGeneratePlaylist = async (retryCount = 0) => {
    const maxRetries = 2; // Try up to 3 times total
    const callTimestamp = Date.now();
    console.log(`🎵 handleGeneratePlaylist called at ${callTimestamp}, retryCount: ${retryCount}, isGeneratingRef.current: ${isGeneratingRef.current}`);

    if (!prompt.trim()) {
      setError('Please enter a playlist description');
      return;
    }

    // Prevent duplicate submissions using ref (more reliable than state)
    if (retryCount === 0) {
      if (isGeneratingRef.current) {
        console.log(`⚠️ DUPLICATE REQUEST BLOCKED at ${callTimestamp} - Already generating a playlist`);
        return;
      }
      console.log(`✅ First request proceeding at ${callTimestamp}, setting ref to true`);
      isGeneratingRef.current = true;
    }

    // Only set initial state on first attempt
    if (retryCount === 0) {
      setLoading(true);
      setShowGeneratingModal(true);
      setError('');
      setGeneratedPlaylist(null);
    }

    // Get messages for this genre
    const messages = getGenreMessages(prompt);
    let messageIndex = 0;

    // Set initial message
    setGeneratingMessage(messages[messageIndex]);

    // Cycle through messages every 1.5 seconds
    const messageInterval = setInterval(() => {
      messageIndex = (messageIndex + 1) % messages.length;
      setGeneratingMessage(messages[messageIndex]);
    }, 1500);

    try {
      const result = await playlistService.generatePlaylist(prompt.trim(), userId, 'spotify', allowExplicit, newArtistsOnly, songCount);
      clearInterval(messageInterval);
      setGeneratingMessage('');
      setShowGeneratingModal(false);

      // Store the original prompt and requested song count with the playlist
      const playlistWithPrompt = { ...result, originalPrompt: prompt.trim(), requestedSongCount: songCount, chatMessages: [], excludedSongs: [] };

      // Auto-save draft to database for cross-device sync (only once per generation)
      if (retryCount === 0) {
        try {
          console.log('Saving draft to database...');
          const draftResponse = await playlistService.saveDraft(userId, playlistWithPrompt);
          // Store the draftId so we can delete it later
          playlistWithPrompt.draftId = draftResponse.draftId;
          console.log('Draft saved successfully with ID:', draftResponse.draftId);
        } catch (draftError) {
          console.error('Failed to save draft:', draftError);
          // Don't block the user if draft save fails
        }
      }

      setGeneratedPlaylist(playlistWithPrompt);

      // Initialize playlist name and description
      setEditedPlaylistName(result.playlistName);
      setEditedDescription(result.description);

      // Open modal at step 1
      setModalStep(1);
      setShowPlaylistModal(true);
      setChatMessages([]);
      setIsDescriptionExpanded(false);

      console.log('Generated playlist:', result);

      // Reset options to defaults after successful generation
      setNewArtistsOnly(false);
      setSongCount(30);

      // Reset generation lock
      isGeneratingRef.current = false;
    } catch (err) {
      clearInterval(messageInterval);
      setGeneratingMessage('');

      // If authentication failed, don't retry
      if (err.response?.status === 401) {
        localStorage.removeItem('userId');
        setUserId(null);
        setIsAuthenticated(false);
        setGeneratingError('Your session has expired. Please reconnect with Spotify.');
        setTimeout(() => {
          setShowGeneratingModal(false);
          setGeneratingError(null);
        }, 3000);
        setLoading(false);
        return;
      }

      // Automatic retry with exponential backoff
      if (retryCount < maxRetries) {
        const waitTime = Math.pow(2, retryCount) * 1000; // 1s, 2s
        console.log(`Playlist generation failed, retrying in ${waitTime}ms... (attempt ${retryCount + 1}/${maxRetries})`);

        setGeneratingMessage(`Request failed, retrying... (${retryCount + 1}/${maxRetries})`);

        await new Promise(resolve => setTimeout(resolve, waitTime));
        return handleGeneratePlaylist(retryCount + 1);
      }

      // All retries exhausted
      console.error('Playlist generation error:', err);
      const errorMessage = err.response?.data?.error || err.message || 'Something went wrong while generating your playlist.';
      setGeneratingError(`${errorMessage} Please try again.`);

      // Don't auto-close on error - let user close manually

      // Reset generation lock on error
      isGeneratingRef.current = false;
    } finally {
      if (retryCount === 0 || retryCount >= maxRetries) {
        setLoading(false);
        setGeneratingMessage('');
      }
    }
  };

  const removeTrackFromGenerated = async (trackId) => {
    // Find the track being removed to save its details
    const removedTrack = generatedPlaylist.tracks.find(track => track.id === trackId);

    // Remove track from the generated playlist immediately
    const updatedTracks = generatedPlaylist.tracks.filter(track => track.id !== trackId);

    // Track excluded songs so they won't be re-added in future operations
    const excludedSongs = generatedPlaylist.excludedSongs || [];
    if (removedTrack) {
      excludedSongs.push({
        id: removedTrack.id,
        name: removedTrack.name,
        artist: removedTrack.artists?.[0]?.name || removedTrack.artist,
        uri: removedTrack.uri
      });
    }

    const updatedPlaylist = {
      ...generatedPlaylist,
      tracks: updatedTracks,
      trackCount: updatedTracks.length,
      excludedSongs,
      chatMessages: chatMessages, // Preserve chat messages
      draftId: generatedPlaylist.draftId || generatedPlaylist.playlistId
    };

    setGeneratedPlaylist(updatedPlaylist);

    // Auto-save updated draft to database
    try {
      await playlistService.saveDraft(userId, updatedPlaylist);
      console.log('Draft auto-saved after removing track');
    } catch (draftError) {
      console.error('Failed to auto-save draft after removing track:', draftError);
      // Don't block the user if draft save fails
    }

    showToast('Track removed', 'success');
  };

  const handleCreatePlaylist = async () => {
    if (!generatedPlaylist) return;

    if (generatedPlaylist.tracks.length === 0) {
      setError('Please keep at least one track in the playlist');
      return;
    }

    setCreatingPlaylist(true);
    setError('');

    try {
      // Use all remaining tracks (user removed unwanted ones with minus button)
      const trackUris = generatedPlaylist.tracks.map(track => track.uri);
      const result = await playlistService.createPlaylist(
        userId,
        generatedPlaylist.playlistName,
        generatedPlaylist.description,
        trackUris
      );

      if (result.success) {
        showToast('Playlist created successfully! Opening Spotify...', 'success');
        window.open(result.playlistUrl, '_blank');

        // Delete draft from database if it has a draftId
        if (generatedPlaylist.draftId) {
          try {
            await playlistService.deleteDraft(userId, generatedPlaylist.draftId);
            console.log('Deleted draft from database');
          } catch (draftError) {
            console.error('Failed to delete draft:', draftError);
          }
        }

        // Clear the current draft from the list
        const updatedDrafts = currentDraftId
          ? draftPlaylists.filter(d => (d.playlistId || d.id) !== currentDraftId)
          : draftPlaylists.filter(d => (d.playlistId || d.id) !== generatedPlaylist.draftId);
        setDraftPlaylists(updatedDrafts);

        // Clear state
        setShowPlaylistModal(false);
        setModalStep(1);
        setChatMessages([]);
        setChatInput('');
        setError('');
        setGeneratedPlaylist(null);
        setPrompt('');
        setCurrentDraftId(null);
      }
    } catch (err) {
      // If authentication failed, clear stored userId and prompt re-authentication
      if (err.response?.status === 401) {
        localStorage.removeItem('userId');
        setUserId(null);
        setIsAuthenticated(false);
        setError('Your session has expired. Please reconnect with Spotify.');
      } else {
        const errorMessage = err.response?.data?.details
          ? `${err.response.data.error}: ${err.response.data.details}`
          : err.response?.data?.error || 'Failed to create playlist. Please try again.';
        setError(errorMessage);
        console.error('Create playlist error:', err.response?.data);
      }
      console.error(err);
    } finally {
      setCreatingPlaylist(false);
    }
  };

  const handleExampleClick = (examplePrompt) => {
    setPrompt(examplePrompt);
  };

  const fetchTopArtists = async () => {
    // Guard: Don't fetch if no userId OR no platform connected
    if (!userId || (!spotifyUserId && !appleMusicUserId)) {
      console.log('fetchTopArtists: Skipping - no userId or no connected platforms');
      setTopArtists([]);
      return;
    }

    setLoadingTopArtists(true);
    try {
      console.log('fetchTopArtists: Fetching for userId:', userId);
      const data = await playlistService.getTopArtists(userId);
      console.log('fetchTopArtists: Received data:', data);
      setTopArtists(data.artists);
      console.log('fetchTopArtists: Set topArtists to:', data.artists.length, 'artists');
    } catch (err) {
      console.error('Failed to fetch top artists (non-critical):', err);
      console.error('Error details:', err.response?.data);

      // Check if it's a scope error requiring reauth
      if (err.response?.status === 403 && err.response?.data?.requiresReauth) {
        setError('Please reconnect your Spotify account to grant the required permissions. Go to Settings to reconnect.');
      }

      setTopArtists([]);
    } finally {
      setLoadingTopArtists(false);
    }
  };

  const fetchNewArtists = async () => {
    // Guard: Don't fetch if no userId OR no platform connected OR not Spotify (this is Spotify-only feature)
    if (!userId || !spotifyUserId) {
      console.log('[fetchNewArtists] Skipping - no userId or not connected to Spotify');
      setNewArtists([]);
      return;
    }

    console.log('[fetchNewArtists] Starting fetch for userId:', userId);
    setLoadingNewArtists(true);
    try {
      const data = await playlistService.getNewArtists(userId);
      console.log('[fetchNewArtists] Received data:', data);
      console.log('[fetchNewArtists] Number of artists:', data.artists?.length || 0);
      setNewArtists(data.artists);
      setNewArtistsFetched(true);
    } catch (err) {
      console.log('Failed to fetch new artists (non-critical):', err.message);
      console.error('Error details:', err.response?.data);

      // Check if it's a scope error requiring reauth
      if (err.response?.status === 403 && err.response?.data?.requiresReauth) {
        setError('Please reconnect your Spotify account to grant the required permissions. Go to Settings to reconnect.');
      }

      setNewArtists([]);
      setNewArtistsFetched(true);
    } finally {
      setLoadingNewArtists(false);
    }
  };

  const handleChatSubmit = async (retryCount = 0) => {
    if (!chatInput.trim() || chatLoading) return;

    const userMessage = chatInput.trim();
    const maxRetries = 2; // Try up to 3 times total (initial + 2 retries)

    // Only clear input and add to chat on first attempt
    if (retryCount === 0) {
      setChatInput('');
      setChatLoading(true);
      // Add user message to chat
      setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    }

    try {
      // Use original prompt and description to maintain playlist vibe during refinement
      const originalPromptToUse = generatedPlaylist.originalPrompt || generatedPlaylist.playlistName;
      const descriptionContext = generatedPlaylist.description
        ? `\n\nPlaylist description: ${generatedPlaylist.description}`
        : '';

      // Build cumulative refinements from chat history (exclude the current message since it's already in state)
      const previousRefinements = chatMessages
        .filter(msg => msg.role === 'user')
        .map(msg => msg.content)
        .join('. ');

      const refinementPrompt = previousRefinements
        ? `Original request: "${originalPromptToUse}"${descriptionContext}\n\nPrevious refinements: ${previousRefinements}\n\nNew refinement: ${userMessage}`
        : `Original request: "${originalPromptToUse}"${descriptionContext}\n\nRefinement: ${userMessage}`;

      // Use the originally requested song count to maintain consistency
      const requestedCount = generatedPlaylist.requestedSongCount || songCount;

      // Get excluded song URIs to avoid re-adding them
      const excludedSongUris = (generatedPlaylist.excludedSongs || []).map(song => song.uri);

      // Call AI to adjust playlist based on user request
      const result = await playlistService.generatePlaylist(
        refinementPrompt,
        userId,
        'spotify',
        allowExplicit,
        newArtistsOnly,
        requestedCount,
        excludedSongUris
      );

      // Add AI response to chat messages
      const aiResponse = {
        role: 'assistant',
        content: `I've updated your playlist! I ${userMessage.toLowerCase().includes('add') ? 'added' : userMessage.toLowerCase().includes('remove') ? 'removed' : 'adjusted'} the tracks based on your request.`
      };

      const updatedChatMessages = [...chatMessages, { role: 'user', content: userMessage }, aiResponse];

      // Preserve the original prompt, requested count, chat history, excluded songs, and draft ID when refining
      const updatedPlaylist = {
        ...result,
        originalPrompt: generatedPlaylist.originalPrompt,
        requestedSongCount: generatedPlaylist.requestedSongCount,
        chatMessages: updatedChatMessages,
        excludedSongs: generatedPlaylist.excludedSongs || [],
        playlistId: generatedPlaylist.playlistId, // Preserve draft ID
        draftId: generatedPlaylist.draftId || generatedPlaylist.playlistId
      };

      setGeneratedPlaylist(updatedPlaylist);

      // Update chat messages in state
      setChatMessages(updatedChatMessages);

      // Auto-save updated draft with chat messages to database
      try {
        await playlistService.saveDraft(userId, updatedPlaylist);
        console.log('Draft auto-saved with chat messages');
      } catch (draftError) {
        console.error('Failed to auto-save draft after chat:', draftError);
        // Don't block the user if draft save fails
      }

      // Close chat modal after successful submission
      setShowChatModal(false);

      // Show success toast
      showToast('Playlist updated successfully!', 'success');
    } catch (err) {
      console.error('Refinement error:', err);

      // Automatic retry with exponential backoff
      if (retryCount < maxRetries) {
        const waitTime = Math.pow(2, retryCount) * 1000; // 1s, 2s, 4s
        console.log(`Refinement failed, retrying in ${waitTime}ms... (attempt ${retryCount + 1}/${maxRetries})`);

        // Show retry notification
        showToast(`Request failed, retrying... (${retryCount + 1}/${maxRetries})`, 'info');

        await new Promise(resolve => setTimeout(resolve, waitTime));
        return handleChatSubmit(retryCount + 1);
      }

      // All retries exhausted - show error
      const errorMessage = err.response?.data?.error || err.message || 'Network error. Please check your connection and try again.';

      // Remove the user message from chat since it failed
      setChatMessages(prev => prev.slice(0, -1));

      // Restore the input so user can try again
      setChatInput(userMessage);

      // Show error in chat
      setChatMessages(prev => [...prev, {
        role: 'assistant',
        content: `Sorry, I couldn't process that request after ${maxRetries + 1} attempts. ${errorMessage}`
      }]);

      // Show prominent error toast
      showToast(`Failed to refine playlist: ${errorMessage}`, 'error');
    } finally {
      setChatLoading(false);
    }
  };

  const handleAddMoreSongs = async (retryCount = 0) => {
    if (!userId) {
      showToast('Error: Not logged in', 'error');
      return;
    }

    const maxRetries = 2; // Try up to 3 times total

    if (retryCount === 0) {
      // Use flushSync to force immediate DOM update
      flushSync(() => {
        setLoadingMoreSongs(true);
        setError('');
      });

      // Use requestAnimationFrame twice to ensure browser has painted
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      // Additional delay to ensure loading state is visible to user
      await new Promise(resolve => setTimeout(resolve, 200));
    }

    try {
      // Generate more songs using the original prompt and description to maintain consistency
      const promptToUse = generatedPlaylist.originalPrompt || generatedPlaylist.playlistName;
      const descriptionContext = generatedPlaylist.description
        ? ` Description: ${generatedPlaylist.description}`
        : '';

      // Include cumulative refinements from chat history
      const refinements = chatMessages
        .filter(msg => msg.role === 'user')
        .map(msg => msg.content)
        .join('. ');

      const refinementsContext = refinements
        ? ` Refinements: ${refinements}.`
        : '';

      // Get excluded song URIs to avoid re-adding them
      const excludedSongUris = (generatedPlaylist.excludedSongs || []).map(song => song.uri);

      const result = await playlistService.generatePlaylist(
        `Based on this theme: "${promptToUse}".${descriptionContext}${refinementsContext} Add 10 more similar songs that match this exact vibe and description.`,
        userId,
        'spotify',
        allowExplicit,
        newArtistsOnly,
        10,
        excludedSongUris
      );

      // Append new tracks to existing playlist
      const existingTrackIds = new Set(generatedPlaylist.tracks.map(t => t.id));
      const newTracks = result.tracks.filter(track => !existingTrackIds.has(track.id));

      if (newTracks.length > 0) {
        const updatedPlaylist = {
          ...generatedPlaylist,
          tracks: [...generatedPlaylist.tracks, ...newTracks],
          trackCount: generatedPlaylist.trackCount + newTracks.length,
          chatMessages: chatMessages, // Preserve chat messages
          draftId: generatedPlaylist.draftId || generatedPlaylist.playlistId
        };

        setGeneratedPlaylist(updatedPlaylist);

        // Auto-save updated draft to database
        try {
          await playlistService.saveDraft(userId, updatedPlaylist);
          console.log('Draft auto-saved after adding more songs');
        } catch (draftError) {
          console.error('Failed to auto-save draft after adding songs:', draftError);
          // Don't block the user if draft save fails
        }

        showToast(`Added ${newTracks.length} new songs!`, 'success');
      } else {
        showToast('No new songs were added (all were duplicates)', 'info');
      }
    } catch (err) {
      console.error('Add more songs error:', err);

      // Automatic retry with exponential backoff
      if (retryCount < maxRetries) {
        const waitTime = Math.pow(2, retryCount) * 1000; // 1s, 2s
        console.log(`Add more failed, retrying in ${waitTime}ms... (attempt ${retryCount + 1}/${maxRetries})`);

        showToast(`Request failed, retrying... (${retryCount + 1}/${maxRetries})`, 'info');

        await new Promise(resolve => setTimeout(resolve, waitTime));
        return handleAddMoreSongs(retryCount + 1);
      }

      // All retries exhausted
      const errorMessage = err.response?.data?.error || err.message || 'Network error. Please try again.';
      setError(`Failed to add more songs: ${errorMessage}`);
      showToast(`Failed to add more songs: ${errorMessage}`, 'error');
    } finally {
      setLoadingMoreSongs(false);
    }
  };

  const handleModalNext = () => {
    if (generatedPlaylist.tracks.length === 0) {
      setError('Please keep at least one track in the playlist');
      return;
    }
    setError('');
    setModalStep(2);
  };

  const handleModalBack = () => {
    if (modalStep === 2) {
      setModalStep(1);
    } else {
      closePlaylistModal();
    }
  };

  const closePlaylistModal = async () => {
    // Update draft in database if playlist exists and wasn't completed
    if (generatedPlaylist && userId) {
      try {
        // Use the correct draftId from generatedPlaylist (not playlistId!)
        const draftId = currentDraftId || generatedPlaylist.draftId;

        if (!draftId) {
          console.warn('⚠️ No draftId found when closing modal, skipping draft save to prevent creating duplicate');
          setShowPlaylistModal(false);
          setModalStep(1);
          setChatMessages([]);
          setChatInput('');
          setError('');
          setCurrentDraftId(null);
          return;
        }

        // Update the draft with current edits
        const updatedPlaylist = {
          ...generatedPlaylist,
          playlistName: editedPlaylistName,
          description: editedDescription,
          chatMessages: chatMessages,
          draftId: draftId
        };

        await playlistService.saveDraft(userId, updatedPlaylist);
        console.log('✅ Draft updated on close with ID:', draftId);
      } catch (error) {
        console.error('Failed to update draft on close:', error);
      }
    }

    setShowPlaylistModal(false);
    setModalStep(1);
    setChatMessages([]);
    setChatInput('');
    setError('');
    setCurrentDraftId(null);
  };

  const handleFinalCreatePlaylist = async () => {
    if (!editedPlaylistName.trim()) {
      setError('Please enter a playlist name');
      return;
    }

    setCreatingPlaylist(true);
    setError('');

    try {
      // Use all remaining tracks (user removed unwanted ones with minus button)
      const trackUris = generatedPlaylist.tracks.map(track => track.uri);

      // Pass the original prompt, chat history, and excluded songs for storage
      const promptToStore = generatedPlaylist.originalPrompt || editedPlaylistName.trim();
      const chatMessagesToStore = chatMessages || [];
      const excludedSongsToStore = generatedPlaylist.excludedSongs || [];

      const result = await playlistService.createPlaylist(
        userId,
        editedPlaylistName.trim(),
        editedDescription.trim(),
        trackUris,
        updateFrequency,
        updateMode,
        isPublic,
        promptToStore,
        chatMessagesToStore,
        excludedSongsToStore
      );

      if (result.success) {
        showToast('Playlist created successfully! Opening Spotify...', 'success');
        window.open(result.playlistUrl, '_blank');

        // Delete draft from database if it has a draftId
        if (generatedPlaylist.draftId) {
          try {
            await playlistService.deleteDraft(userId, generatedPlaylist.draftId);
            console.log('Deleted draft from database');
          } catch (draftError) {
            console.error('Failed to delete draft:', draftError);
          }
        }

        // Clear the current draft from the list
        const updatedDrafts = currentDraftId
          ? draftPlaylists.filter(d => d.id !== currentDraftId)
          : draftPlaylists.filter(d =>
              !(d.playlist?.playlistName === editedPlaylistName &&
                d.playlist?.tracks?.length === generatedPlaylist.tracks.length)
            );
        setDraftPlaylists(updatedDrafts);

        setShowPlaylistModal(false);
        setModalStep(1);
        setChatMessages([]);
        setChatInput('');
        setError('');
        setGeneratedPlaylist(null);
        setPrompt('');
        setCurrentDraftId(null);
      }
    } catch (err) {
      if (err.response?.status === 401) {
        localStorage.removeItem('userId');
        setUserId(null);
        setIsAuthenticated(false);
        setError('Your session has expired. Please reconnect with Spotify.');
      } else {
        const errorMessage = err.response?.data?.details
          ? `${err.response.data.error}: ${err.response.data.details}`
          : err.response?.data?.error || 'Failed to create playlist. Please try again.';
        setError(errorMessage);
      }
    } finally {
      setCreatingPlaylist(false);
    }
  };

  const handleResumeDraft = (draftId) => {
    const draft = draftPlaylists.find(d => (d.playlistId || d.id) === draftId);
    if (!draft) return;

    // Restore playlist state from draft
    // Draft data is stored at the top level (playlistName, tracks, etc.)
    setGeneratedPlaylist(draft);
    setChatMessages(draft.chatMessages || []);
    setEditedPlaylistName(draft.playlistName);
    setEditedDescription(draft.description);
    setModalStep(1);
    setCurrentDraftId(draftId);
    setShowPlaylistModal(true);
    setIsDescriptionExpanded(false);
  };

  const handleDiscardDraft = async (draftId) => {
    try {
      // Delete from database
      await playlistService.deleteDraft(userId, draftId);

      // Update local state - use playlistId if available, otherwise id
      const updatedDrafts = draftPlaylists.filter(d => (d.playlistId || d.id) !== draftId);
      setDraftPlaylists(updatedDrafts);
      if (currentDraftId === draftId) {
        setCurrentDraftId(null);
      }
    } catch (error) {
      console.error('Failed to delete draft:', error);
      showToast('Failed to delete draft', 'error');
    }
  };

  // Scroll handlers for Top Artists carousel
  const scrollTopArtistsLeft = () => {
    if (topArtistsScrollRef.current) {
      topArtistsScrollRef.current.scrollBy({ left: -400, behavior: 'smooth' });
    }
  };

  const scrollTopArtistsRight = () => {
    if (topArtistsScrollRef.current) {
      topArtistsScrollRef.current.scrollBy({ left: 400, behavior: 'smooth' });
    }
  };

  const handleArtistClick = (artist) => {
    // Open settings modal for this artist
    setSelectedArtist(artist);
    setArtistModalNewArtistsOnly(false);
    setArtistModalSongCount(30);
    setShowArtistSettingsModal(true);
  };

  const handleCancelArtistSettings = () => {
    setShowArtistSettingsModal(false);
    setSelectedArtist(null);
    setArtistModalNewArtistsOnly(false);
    setArtistModalSongCount(30);
  };

  const handleConfirmArtistSettings = async () => {
    if (!selectedArtist) return;

    setShowArtistSettingsModal(false);
    setLoading(true);
    setShowGeneratingModal(true);
    setError('');
    setGeneratedPlaylist(null);

    // Get messages for this genre
    const promptText = `Songs similar to ${selectedArtist.name}`;
    const messages = getGenreMessages(promptText);
    let messageIndex = 0;

    // Set initial message
    setGeneratingMessage(messages[messageIndex]);

    // Cycle through messages every 1.5 seconds
    const messageInterval = setInterval(() => {
      messageIndex = (messageIndex + 1) % messages.length;
      setGeneratingMessage(messages[messageIndex]);
    }, 1500);

    try {
      // Generate playlist with the artist name and selected settings
      const result = await playlistService.generatePlaylist(
        promptText,
        userId,
        'spotify',
        allowExplicit,
        artistModalNewArtistsOnly,
        artistModalSongCount
      );
      clearInterval(messageInterval);
      setGeneratingMessage('');
      setShowGeneratingModal(false);

      // Store the original prompt and requested song count with the playlist
      const playlistWithPrompt = { ...result, originalPrompt: promptText, requestedSongCount: artistModalSongCount, chatMessages: [], excludedSongs: [] };

      // Auto-save draft to database for cross-device sync
      try {
        const draftResponse = await playlistService.saveDraft(userId, playlistWithPrompt);
        playlistWithPrompt.draftId = draftResponse.draftId;
        console.log('Draft saved successfully with ID:', draftResponse.draftId);
      } catch (draftError) {
        console.error('Failed to save draft:', draftError);
        // Don't block the user if draft save fails
      }

      setGeneratedPlaylist(playlistWithPrompt);

      // Set default name and description
      setEditedPlaylistName(result.playlistName);
      setEditedDescription(result.description || '');

      // Open the modal
      setShowPlaylistModal(true);
      setModalStep(1);
      setChatMessages([]);
      setIsDescriptionExpanded(false);

      console.log('Generated playlist for artist:', selectedArtist.name);

      // Reset artist modal state
      setSelectedArtist(null);
      setArtistModalNewArtistsOnly(false);
      setArtistModalSongCount(30);
    } catch (err) {
      clearInterval(messageInterval);
      setShowGeneratingModal(false);
      if (err.response?.status === 401) {
        localStorage.removeItem('userId');
        setUserId(null);
        setIsAuthenticated(false);
        setError('Your session has expired. Please reconnect with Spotify.');
      } else {
        setError(err.response?.data?.error || 'Failed to generate playlist. Please try again.');
      }
      console.error(err);
    } finally {
      setLoading(false);
      setGeneratingMessage('');
    }
  };

  const handleSearch = async (query) => {
    if (!query.trim()) {
      setSearchResults(null);
      setShowSearchResults(false);
      return;
    }

    setSearchLoading(true);
    try {
      const results = await playlistService.search(query.trim(), userId);
      setSearchResults(results);
      setShowSearchResults(true);
    } catch (err) {
      console.error('Search failed:', err);
      setSearchResults({ playlists: [], users: [] });
      setShowSearchResults(true);
    } finally {
      setSearchLoading(false);
    }
  };

  const handleSearchInputChange = (e) => {
    const query = e.target.value;
    setSearchQuery(query);

    // Debounce search
    if (query.trim()) {
      handleSearch(query);
    } else {
      setSearchResults(null);
      setShowSearchResults(false);
    }
  };


  return (
    <div className="playlist-generator">
      {isAuthenticated && userId ? (
        <>
          {/* Top Navigation Bar - Apple Style */}
          <div className="top-nav">
            <div className="nav-left">
              {/* Empty for balance */}
            </div>
            <div className="nav-center nav-tabs-center">
              <button
                onClick={() => setActiveTab('home')}
                className={`nav-tab-item ${activeTab === 'home' ? 'active' : ''}`}
              >
                Home
              </button>
              <button
                onClick={() => setActiveTab('playlists')}
                className={`nav-tab-item ${activeTab === 'playlists' ? 'active' : ''}`}
              >
                Playlists
              </button>
            </div>
            <div className="nav-right profile-section-topnav">
              <button
                className="profile-button-apple"
                onClick={() => setShowProfileDropdown(!showProfileDropdown)}
              >
                {userProfile?.image ? (
                  <img src={userProfile.image} alt="Profile" style={{ width: '100%', height: '100%', borderRadius: '50%' }} />
                ) : (
                  <svg viewBox="0 0 24 24" fill="white">
                    <path d="M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z"/>
                  </svg>
                )}
              </button>

              {showProfileDropdown && (
                <div className="profile-dropdown-topnav">
                  <div className="dropdown-user-info">
                    <div className="dropdown-user-name">{userProfile?.displayName || 'User'}</div>
                    {localStorage.getItem('userEmail') && (
                      <div className="dropdown-user-email">{localStorage.getItem('userEmail')}</div>
                    )}
                  </div>
                  <div className="dropdown-divider"></div>
                  <button className="dropdown-item" onClick={() => {
                    setShowProfileDropdown(false);
                    setActiveTab('account');
                  }}>
                    <span className="dropdown-icon"><Icons.User size={18} /></span>
                    Account
                  </button>
                  <button className="dropdown-item" onClick={() => {
                    setShowProfileDropdown(false);
                    setActiveTab('settings');
                  }}>
                    <span className="dropdown-icon"><Icons.Settings size={18} /></span>
                    Settings
                  </button>
                  <button className="dropdown-item" onClick={() => {
                    setShowProfileDropdown(false);
                    setActiveTab('faq');
                  }}>
                    <span className="dropdown-icon">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                      </svg>
                    </span>
                    FAQ
                  </button>
                  <button className="dropdown-item" onClick={() => {
                    setShowProfileDropdown(false);
                    setShowProductTour(true);
                  }}>
                    <span className="dropdown-icon">
                      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="10"></circle>
                        <path d="M12 16v-4"></path>
                        <path d="M12 8h.01"></path>
                      </svg>
                    </span>
                    Start Tour
                  </button>
                  <button className="dropdown-item logout" onClick={handleLogout}>
                    <span className="dropdown-icon"><Icons.Logout size={18} /></span>
                    Log Out
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* Main Content Area */}
          <div className="main-content">
            {activeTab === 'home' && (
              <>
                {/* Page Title */}
                <h1 className="page-title">Home</h1>

                {/* Draft Playlists Section */}
                {draftPlaylists.length > 0 && (
                  <div className="unfinished-playlists-section">
                    <div className="section-header">
                      <div>
                        <h2 className="section-title">Unfinished Playlists</h2>
                        <p className="section-subtitle">Continue editing your drafts</p>
                      </div>
                    </div>
                    <div className="draft-cards-container">
                      {draftPlaylists.map((draft) => {
                        const firstTrackImage = draft.tracks?.[0]?.image;
                        const draftId = draft.playlistId || draft.id;
                        return (
                          <div
                            key={draftId}
                            className="draft-card-apple"
                            onClick={() => handleResumeDraft(draftId)}
                            style={{ cursor: 'pointer' }}
                          >
                            <div className="draft-card-image">
                              {firstTrackImage ? (
                                <img src={firstTrackImage} alt={draft.playlistName} />
                              ) : (
                                <div className="draft-card-placeholder">
                                  <Icons.Playlist size={40} />
                                </div>
                              )}
                            </div>
                            <div className="draft-card-info">
                              <div className="draft-card-name">{draft.playlistName || 'Untitled Playlist'}</div>
                              <div className="draft-card-meta">{draft.tracks?.length || 0} tracks</div>
                            </div>
                            <button
                              className="draft-card-delete"
                              onClick={(e) => {
                                e.stopPropagation();
                                handleDiscardDraft(draftId);
                              }}
                              title="Delete draft"
                            >
                              ×
                            </button>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}

                {/* Check if any platform is connected */}
                {!spotifyUserId && !appleMusicUserId ? (
                  // No platforms connected - show prompt
                  <div className="horizontal-scroll-section">
                    <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                      <h3 style={{
                        fontSize: '18px',
                        color: '#ffffff',
                        marginBottom: '12px',
                        fontWeight: '600'
                      }}>
                        Get Started with AI Playlist Creator
                      </h3>
                      <p style={{
                        color: '#8e8e93',
                        fontSize: '14px',
                        marginBottom: '24px',
                        lineHeight: '1.6'
                      }}>
                        Connect your favorite music platform to discover personalized playlists.
                      </p>
                      <button
                        onClick={() => setActiveTab('account')}
                        style={{
                          background: '#fbbf24',
                          color: '#78350f',
                          border: 'none',
                          borderRadius: '12px',
                          padding: '12px 24px',
                          fontSize: '15px',
                          fontWeight: '600',
                          cursor: 'pointer',
                          transition: 'all 0.2s ease'
                        }}
                        onMouseOver={(e) => e.target.style.background = '#f59e0b'}
                        onMouseOut={(e) => e.target.style.background = '#fbbf24'}
                      >
                        Connect a Platform
                      </button>
                    </div>
                  </div>
                ) : (
                  // User is connected - show content
                  <>
                    {/* Show message for Apple Music-only users */}
                    {appleMusicUserId && !spotifyUserId && (
                      <div className="horizontal-scroll-section">
                        <div style={{ textAlign: 'center', padding: '60px 20px' }}>
                          <h3 style={{
                            fontSize: '18px',
                            color: '#ffffff',
                            marginBottom: '12px',
                            fontWeight: '600'
                          }}>
                            Apple Music Connected
                          </h3>
                          <p style={{
                            color: '#8e8e93',
                            fontSize: '14px',
                            marginBottom: '16px',
                            lineHeight: '1.6',
                            maxWidth: '500px',
                            margin: '0 auto 24px'
                          }}>
                            You can now create AI-generated playlists on Apple Music! The "Your Top Artists" and "Artists You Should Explore" features are currently Spotify-only.
                          </p>
                          <p style={{
                            color: '#8e8e93',
                            fontSize: '14px',
                            marginBottom: '24px'
                          }}>
                            Connect Spotify to unlock personalized artist recommendations.
                          </p>
                          <button
                            onClick={() => setActiveTab('account')}
                            style={{
                              background: '#fbbf24',
                              color: '#78350f',
                              border: 'none',
                              borderRadius: '12px',
                              padding: '12px 24px',
                              fontSize: '15px',
                              fontWeight: '600',
                              cursor: 'pointer',
                              transition: 'all 0.2s ease'
                            }}
                            onMouseOver={(e) => e.target.style.background = '#f59e0b'}
                            onMouseOut={(e) => e.target.style.background = '#fbbf24'}
                          >
                            Connect Spotify
                          </button>
                        </div>
                      </div>
                    )}

                    {/* Show Top Artists section only if user has Spotify */}
                    {loadingTopArtists ? (
                      <div className="horizontal-scroll-section">
                        <div className="section-header">
                          <div>
                            <h2 className="section-title">Your Top Artists</h2>
                            <p className="section-subtitle">Create a new playlist based on your last 3 months listening history</p>
                          </div>
                        </div>
                        <div style={{ textAlign: 'center', padding: '40px' }}>
                          <div className="loading-spinner-apple"></div>
                          <p style={{ color: '#8e8e93', marginTop: '12px' }}>Loading...</p>
                        </div>
                      </div>
                    ) : topArtists.length > 0 ? (
                      <div className="horizontal-scroll-section">
                        <div className="section-header">
                          <div>
                            <h2 className="section-title">Your Top Artists</h2>
                            <p className="section-subtitle">Create a new playlist based on your last 3 months listening history</p>
                          </div>
                        </div>
                        <div className="horizontal-scroll-container" ref={topArtistsScrollRef}>
                          {topArtists.map((artist) => (
                            <div
                              key={artist.id}
                              className="artist-card-apple"
                              onClick={() => handleArtistClick(artist)}
                              style={{ cursor: 'pointer' }}
                            >
                              <div className="artist-card-image">
                                {artist.image ? (
                                  <img src={artist.image} alt={artist.name} />
                                ) : (
                                  <span><Icons.Microphone size={32} /></span>
                                )}
                              </div>
                              <div className="artist-card-name">{artist.name}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}

                    {loadingNewArtists ? (
                      <div className="horizontal-scroll-section">
                        <div className="section-header">
                          <div>
                            <h2 className="section-title">Artists You Should Explore</h2>
                            <p className="section-subtitle">Discover new artists, and rediscover old artists</p>
                          </div>
                        </div>
                        <div style={{ textAlign: 'center', padding: '40px' }}>
                          <div className="loading-spinner-apple"></div>
                          <p style={{ color: '#8e8e93', marginTop: '12px' }}>Loading...</p>
                        </div>
                      </div>
                    ) : newArtists.length > 0 ? (
                      <div className="horizontal-scroll-section">
                        <div className="section-header">
                          <div>
                            <h2 className="section-title">Artists You Should Explore</h2>
                            <p className="section-subtitle">Discover new artists, and rediscover old artists</p>
                          </div>
                        </div>
                        <div className="horizontal-scroll-container" ref={newArtistsScrollRef}>
                          {newArtists.map((artist) => (
                            <div
                              key={artist.id}
                              className="artist-card-apple"
                              onClick={() => handleArtistClick(artist)}
                              style={{ cursor: 'pointer' }}
                            >
                              <div className="artist-card-image">
                                {artist.image ? (
                                  <img src={artist.image} alt={artist.name} />
                                ) : (
                                  <span><Icons.Microphone size={32} /></span>
                                )}
                              </div>
                              <div className="artist-card-name">{artist.name}</div>
                            </div>
                          ))}
                        </div>
                      </div>
                    ) : null}
                  </>
                )}
              </>
            )}

            {activeTab === 'playlists' && (
              <>
                <MyPlaylists userId={userId} onBack={() => setActiveTab('home')} showToast={showToast} />
              </>
            )}

            {activeTab === 'settings' && (
              <>
                <Settings onBack={() => setActiveTab('home')} />
              </>
            )}

            {activeTab === 'account' && (
              <Account onBack={() => setActiveTab('home')} showToast={showToast} />
            )}

            {activeTab === 'faq' && (
              <FAQ onBack={() => setActiveTab('home')} />
            )}
          </div>

          {/* Chat Input - Fixed above tab bar */}
          {activeTab === 'home' && (
            <div className="chat-input-container-apple">
              {showOptionsMenu && (
                <div
                  className="options-menu-apple"
                  ref={optionsMenuRef}
                  style={{ position: 'fixed', bottom: '75px', left: '20px', zIndex: 10001 }}
                >
                  <button
                    onClick={() => setNewArtistsOnly(!newArtistsOnly)}
                    className="options-menu-item"
                  >
                    <span><Icons.Sparkles size={18} /></span>
                    <span>New Artists Only {newArtistsOnly && <Icons.Check size={16} />}</span>
                  </button>
                  <div className="options-menu-item" style={{ cursor: 'default' }}>
                    <span><Icons.Music size={18} /></span>
                    <span>Songs: </span>
                    <input
                      type="number"
                      min="10"
                      max="50"
                      value={songCount}
                      onChange={(e) => setSongCount(parseInt(e.target.value) || 30)}
                      onClick={(e) => e.stopPropagation()}
                      style={{
                        width: '60px',
                        padding: '4px 8px',
                        borderRadius: '6px',
                        border: '1px solid #e2e8f0',
                        marginLeft: 'auto'
                      }}
                    />
                  </div>
                  <button
                    onClick={() => setShowOptionsMenu(false)}
                    className="options-menu-apply-button"
                  >
                    Apply
                  </button>
                </div>
              )}
              <div className="chat-input-wrapper">
                <div className="options-menu-wrapper" style={{ position: 'relative', display: 'flex', alignItems: 'center', gap: '4px' }}>
                  <button
                    onClick={() => setShowOptionsMenu(!showOptionsMenu)}
                    style={{
                      background: 'none',
                      border: 'none',
                      fontSize: '20px',
                      color: newArtistsOnly || songCount !== 30 ? '#4facfe' : '#8e8e93',
                      cursor: 'pointer',
                      padding: '4px'
                    }}
                    title="Playlist options"
                  >
                    +
                  </button>
                  <div
                    className="prompt-info-icon"
                    onMouseEnter={() => setShowPromptTooltip(true)}
                    onMouseLeave={() => setShowPromptTooltip(false)}
                    style={{ position: 'relative', display: 'flex', alignItems: 'center' }}
                  >
                    <svg
                      viewBox="0 0 24 24"
                      width="18"
                      height="18"
                      fill="none"
                      stroke="#8e8e93"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{ cursor: 'pointer' }}
                    >
                      <circle cx="12" cy="12" r="10"/>
                      <line x1="12" y1="16" x2="12" y2="12"/>
                      <line x1="12" y1="8" x2="12.01" y2="8"/>
                    </svg>
                    {showPromptTooltip && (
                      <div className="prompt-tooltip">
                        <div className="prompt-tooltip-header">Tips for great playlists:</div>
                        <ul className="prompt-tooltip-list">
                          <li><strong>Be specific:</strong> Include artist names, genres, energy level, or time periods</li>
                          <li><strong>Example:</strong> "25 upbeat indie songs like Phantogram from the past 5 years"</li>
                        </ul>
                      </div>
                    )}
                  </div>
                </div>

                <input
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter' && prompt.trim() && !loading) {
                      handleGeneratePlaylist();
                    }
                  }}
                  placeholder="Create playlist for..."
                  disabled={loading}
                />
                <button
                  onClick={() => handleGeneratePlaylist()}
                  onTouchEnd={(e) => {
                    e.preventDefault();
                    if (!loading && prompt.trim()) {
                      handleGeneratePlaylist();
                    }
                  }}
                  disabled={loading || !prompt.trim()}
                  className="chat-send-button"
                  title="Generate Playlist"
                >
                  {loading ? (
                    <div className="loading-spinner-apple">
                      <div className="wave-bar-1" style={{ width: '3px', height: '14px', backgroundColor: 'white', borderRadius: '1px' }}></div>
                      <div className="wave-bar-2" style={{ width: '3px', height: '14px', backgroundColor: 'white', borderRadius: '1px' }}></div>
                      <div className="wave-bar-3" style={{ width: '3px', height: '14px', backgroundColor: 'white', borderRadius: '1px' }}></div>
                    </div>
                  ) : (
                    <svg viewBox="0 0 24 24" style={{ pointerEvents: 'none' }}>
                      <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
                    </svg>
                  )}
                </button>
              </div>
              {errorInfo && (
                <ErrorMessage
                  errorLog={errorInfo}
                  onRetry={lastRetryFunction}
                  onDismiss={() => setErrorInfo(null)}
                />
              )}
            </div>
          )}


          {/* Generation Modal */}
          {showGeneratingModal && (
            <div className="generating-modal-overlay">
              <div className="generating-modal-content">
                <div className="generating-modal-header">
                  <h2>Creating Your Playlist</h2>
                  {generatingError && (
                    <button
                      onClick={() => {
                        setShowGeneratingModal(false);
                        setGeneratingError(null);
                      }}
                      className="close-modal-button"
                    >
                      ×
                    </button>
                  )}
                </div>
                <div className="generating-modal-body">
                  {generatingError ? (
                    <>
                      <div style={{ fontSize: '48px', marginBottom: '16px' }}>⚠️</div>
                      <p className="generating-modal-message" style={{ color: '#ef4444' }}>
                        {generatingError}
                      </p>
                      <button
                        onClick={() => {
                          setShowGeneratingModal(false);
                          setGeneratingError(null);
                        }}
                        className="primary-button"
                        style={{ marginTop: '20px' }}
                      >
                        Close
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="generating-modal-spinner">
                        <div className="wave-bar-1"></div>
                        <div className="wave-bar-2"></div>
                        <div className="wave-bar-3"></div>
                      </div>
                      <p className="generating-modal-message">{generatingMessage}</p>
                    </>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* Playlist Creation Modal */}
          {showPlaylistModal && generatedPlaylist && (
          <div className="playlist-modal-overlay" onClick={closePlaylistModal}>
            <div className="playlist-modal-content" onClick={(e) => e.stopPropagation()}>
              {modalStep === 1 ? (
                <>
                  {/* Step 1: Track Selection + AI Chat */}
                  <div className="playlist-modal-header">
                    <h2>{generatedPlaylist.playlistName}</h2>
                    <button onClick={closePlaylistModal} className="close-modal-button">
                      ×
                    </button>
                  </div>

                  <div className="playlist-modal-description">
                    {!isDescriptionExpanded && generatedPlaylist.description && generatedPlaylist.description.length > 80 ? (
                      <>
                        <span>{generatedPlaylist.description.substring(0, 80)}...</span>{' '}
                        <span
                          className="description-more"
                          onClick={() => setIsDescriptionExpanded(true)}
                        >
                          see more
                        </span>
                      </>
                    ) : (
                      <>
                        {generatedPlaylist.description}
                        {isDescriptionExpanded && generatedPlaylist.description && generatedPlaylist.description.length > 80 && (
                          <>
                            {' '}
                            <span
                              className="description-more"
                              onClick={() => setIsDescriptionExpanded(false)}
                            >
                              less
                            </span>
                          </>
                        )}
                      </>
                    )}
                  </div>

                  <div className="playlist-modal-body">
                    {/* Left: Track List */}
                    <div className="playlist-modal-tracks">
                      <div className="playlist-modal-tracks-header">
                        <h3>Tracks ({generatedPlaylist.tracks.length})</h3>
                        <div className="tracks-header-buttons" ref={trackListMenuRef}>
                          <button
                            onClick={() => setShowTrackListMenu(!showTrackListMenu)}
                            className="track-list-menu-button"
                            type="button"
                          >
                            <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                              <circle cx="12" cy="5" r="2"/>
                              <circle cx="12" cy="12" r="2"/>
                              <circle cx="12" cy="19" r="2"/>
                            </svg>
                          </button>
                          {showTrackListMenu && (
                            <div className="track-list-menu-dropdown">
                              <button
                                onClick={() => {
                                  setShowTrackListMenu(false);
                                  handleAddMoreSongs();
                                }}
                                disabled={loadingMoreSongs}
                                className="track-list-menu-item"
                                type="button"
                              >
                                {loadingMoreSongs ? (
                                  <>
                                    <span className="spinner-small"></span>
                                    Adding...
                                  </>
                                ) : (
                                  '+ Add More Songs'
                                )}
                              </button>
                            </div>
                          )}
                        </div>
                      </div>

                      <div className="playlist-modal-tracks-list">
                        {generatedPlaylist.tracks.map((track, index) => (
                          <div key={track.id} className="modal-context track-item">
                            <span className="track-number">{index + 1}</span>
                            {track.image && (
                              <img src={track.image} alt={track.album} className="track-image" />
                            )}
                            <div className="track-info">
                              <div className="track-name">{track.name}</div>
                              <div className="track-artist">{track.artist}</div>
                            </div>
                            <div className="track-actions-modal">
                              <button
                                className="track-exclude-button-modal"
                                onClick={() => removeTrackFromGenerated(track.id)}
                                title="Remove from list"
                              >
                                <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor">
                                  <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" fill="none"/>
                                  <line x1="8" y1="12" x2="16" y2="12" stroke="currentColor" strokeWidth="2"/>
                                </svg>
                              </button>
                              <a
                                href={track.externalUrl}
                                target="_blank"
                                rel="noopener noreferrer"
                                className="spotify-link-modal"
                                title="Open in Spotify"
                              >
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor">
                                  <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
                                </svg>
                              </a>
                            </div>
                          </div>
                        ))}
                      </div>

                      {/* AI Chat - Below Track List */}
                      <div className="playlist-modal-chat-below">
                        <div className="chat-and-next-container">
                          <div className="chat-input-container" onClick={() => setShowChatModal(true)}>
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
                          </div>
                          <button onClick={handleModalNext} className="modal-button-primary chat-next-button">
                            Next
                          </button>
                        </div>
                      </div>
                    </div>

                  </div>

                  {error && <div className="modal-error-message">{error}</div>}
                </>
              ) : (
                <>
                  {/* Step 2: Edit Name & Description */}
                  <div className="playlist-modal-header">
                    <h2>Finalize Your Playlist</h2>
                    <button onClick={closePlaylistModal} className="close-modal-button">
                      ×
                    </button>
                  </div>

                  <div className="playlist-modal-body-step2">
                    <div className="playlist-form">
                      <div className="form-group">
                        <label htmlFor="playlist-name">Playlist Name *</label>
                        <input
                          id="playlist-name"
                          type="text"
                          value={editedPlaylistName}
                          onChange={(e) => setEditedPlaylistName(e.target.value)}
                          placeholder="Enter playlist name"
                          className="playlist-input"
                        />
                      </div>

                      <div className="form-group">
                        <label htmlFor="update-frequency">Auto-Update Frequency</label>
                        <select
                          id="update-frequency"
                          value={updateFrequency}
                          onChange={(e) => setUpdateFrequency(e.target.value)}
                          className="playlist-select"
                        >
                          <option value="never">Never - Keep playlist as is</option>
                          <option value="daily">Daily - Update every day</option>
                          <option value="weekly">Weekly - Update every week</option>
                          <option value="monthly">Monthly - Update every month</option>
                        </select>
                        <p className="form-help-text">
                          Automatically update your playlist with fresh songs based on the same theme
                        </p>
                      </div>

                      {updateFrequency !== 'never' && (
                        <div className="form-group">
                          <label htmlFor="update-mode">Update Mode</label>
                          <select
                            id="update-mode"
                            value={updateMode}
                            onChange={(e) => setUpdateMode(e.target.value)}
                            className="playlist-select"
                          >
                            <option value="append">Append - Add new songs to existing ones</option>
                            <option value="replace">Replace - Replace old songs with new ones</option>
                          </select>
                          <p className="form-help-text">
                            {updateMode === 'append'
                              ? 'New songs will be added to the end of your playlist'
                              : 'Old songs will be removed and replaced with fresh ones'}
                          </p>
                        </div>
                      )}

                      <div className="form-group">
                        <label htmlFor="playlist-privacy">Privacy</label>
                        <select
                          id="playlist-privacy"
                          value={isPublic ? 'public' : 'private'}
                          onChange={(e) => setIsPublic(e.target.value === 'public')}
                          className="playlist-select"
                        >
                          <option value="public">Public - Anyone can see this playlist</option>
                          <option value="private">Private - Only you can see this playlist</option>
                        </select>
                        <p className="form-help-text">
                          {isPublic
                            ? 'This playlist will be visible to anyone with the link'
                            : 'This playlist will only be visible to you'}
                        </p>
                      </div>
                    </div>

                    {error && <div className="modal-error-message">{error}</div>}
                  </div>

                  <div className="playlist-modal-footer">
                    <button onClick={handleModalBack} className="modal-button-secondary">
                      Back
                    </button>
                    <button
                      onClick={handleFinalCreatePlaylist}
                      disabled={creatingPlaylist}
                      className="modal-button-primary"
                    >
                      {creatingPlaylist ? (
                        <>
                          <span className="spinner-small"></span>
                          Creating...
                        </>
                      ) : (
                        'Create'
                      )}
                    </button>
                  </div>
                </>
              )}
            </div>
          </div>
          )}

          {/* Chat Modal */}
          {showChatModal && (
            <div className="chat-modal-overlay" onClick={() => setShowChatModal(false)}>
              <div className="chat-modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="chat-modal-header">
                  <h2>Refine Playlist</h2>
                  <button onClick={() => setShowChatModal(false)} className="close-modal-button">
                    ×
                  </button>
                </div>

                <div className="chat-modal-body">
                  {/* Original Prompt */}
                  <div className="chat-message original-prompt">
                    <div className="chat-message-label">Original Request</div>
                    <div className="chat-message-content">
                      {generatedPlaylist?.originalPrompt || generatedPlaylist?.playlistName}
                    </div>
                  </div>

                  {/* Chat History */}
                  <div className="chat-history">
                    {chatMessages.map((msg, index) => (
                      <div key={index} className={`chat-message ${msg.role}`}>
                        <div className="chat-message-content">
                          {msg.content}
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
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyPress={(e) => {
                        if (e.key === 'Enter' && !chatLoading && chatInput.trim()) {
                          handleChatSubmit();
                        }
                      }}
                      placeholder="Add a refinement..."
                      className="chat-modal-input"
                      disabled={chatLoading}
                    />
                    <button
                      onClick={handleChatSubmit}
                      disabled={chatLoading || !chatInput.trim()}
                      className="chat-modal-send-button"
                      title="Send Message"
                    >
                      {chatLoading ? (
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

          {/* Artist Settings Modal */}
          {showArtistSettingsModal && selectedArtist && (
            <div className="modal-overlay" onClick={handleCancelArtistSettings}>
              <div className="modal-content refresh-modal-content" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>Create Playlist from {selectedArtist.name}</h2>
                  <button onClick={handleCancelArtistSettings} className="close-modal-button">
                    ×
                  </button>
                </div>

                {selectedArtist.image && (
                  <div style={{ display: 'flex', justifyContent: 'center', padding: '20px 20px 0' }}>
                    <img src={selectedArtist.image} alt={selectedArtist.name} style={{ width: '100px', height: '100px', borderRadius: '15px', objectFit: 'cover' }} />
                  </div>
                )}

                <div className="modal-body">
                  <div className="form-group">
                    <div
                      className={`refresh-option-item ${artistModalNewArtistsOnly ? 'active' : ''}`}
                      onClick={() => setArtistModalNewArtistsOnly(!artistModalNewArtistsOnly)}
                    >
                      <div className="option-checkbox">
                        {artistModalNewArtistsOnly && <span className="checkmark"><Icons.Check size={16} /></span>}
                      </div>
                      <div className="option-content">
                        <span className="option-label">New Artists Only</span>
                        <span className="option-description">Discover artists you've never listened to</span>
                      </div>
                    </div>
                  </div>

                  <div className="form-group">
                    <label htmlFor="artist-song-count">Number of Songs</label>
                    <input
                      type="number"
                      id="artist-song-count"
                      min="10"
                      max="50"
                      value={artistModalSongCount}
                      onChange={(e) => setArtistModalSongCount(e.target.value)}
                      onBlur={(e) => {
                        const val = e.target.value;
                        if (val === '' || val === null) {
                          setArtistModalSongCount(30);
                        } else {
                          const num = parseInt(val, 10);
                          if (!isNaN(num) && num > 0) {
                            setArtistModalSongCount(Math.min(Math.max(num, 10), 50));
                          }
                        }
                      }}
                      className="song-count-input-large"
                    />
                    <p className="form-help-text">
                      Choose between 10 and 50 songs
                    </p>
                  </div>
                </div>

                <div className="modal-footer">
                  <button onClick={handleCancelArtistSettings} className="cancel-button">
                    Cancel
                  </button>
                  <button onClick={handleConfirmArtistSettings} className="refresh-confirm-button">
                    Generate Playlist
                  </button>
                </div>
              </div>
            </div>
          )}

      {/* Account Settings Modal */}
      {showAccountModal && (
        <div className="modal-overlay" onClick={closeAccountModal}>
          <div className="account-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-header">
              <button className="account-back-button" onClick={closeAccountModal}>‹</button>
              <h2>Account</h2>
              <div style={{ width: '32px' }}></div>
            </div>

            <div className="account-modal-body">
              <div className="account-list">
                <button className="account-list-item" onClick={openEditEmailModal}>
                  <span className="account-list-label">Email</span>
                  <div className="account-list-value">
                    <span>{accountEmail}</span>
                    <span className="account-arrow">›</span>
                  </div>
                </button>

                <button className="account-list-item" onClick={openEditPasswordModal}>
                  <span className="account-list-label">Password</span>
                  <div className="account-list-value">
                    <span>••••••••</span>
                    <span className="account-arrow">›</span>
                  </div>
                </button>

                <button className="account-list-item" onClick={openEditPlatformModal}>
                  <span className="account-list-label">Music Platform</span>
                  <div className="account-list-value">
                    <span>{accountPlatform === 'spotify' ? 'Spotify' : 'Apple Music'}</span>
                    <span className="account-arrow">›</span>
                  </div>
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Email Modal */}
      {showEditEmailModal && (
        <div className="modal-overlay" onClick={closeEditEmailModal}>
          <div className="account-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-header">
              <button className="account-back-button" onClick={closeEditEmailModal}>‹</button>
              <h2>Email</h2>
              <div style={{ width: '32px' }}></div>
            </div>

            {accountError && (
              <div className="account-error-message">{accountError}</div>
            )}

            <div className="account-modal-body">
              <div className="account-form">
                <div className="form-group">
                  <label>New Email Address</label>
                  <input
                    type="email"
                    value={newEmail}
                    onChange={(e) => setNewEmail(e.target.value)}
                    placeholder="name@email.com"
                    className="account-input"
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label>Confirm with Password</label>
                  <input
                    type="password"
                    value={emailPassword}
                    onChange={(e) => setEmailPassword(e.target.value)}
                    placeholder="Enter your password"
                    className="account-input"
                  />
                </div>

                <button
                  onClick={handleUpdateEmail}
                  disabled={accountLoading}
                  className="account-button-primary"
                >
                  {accountLoading ? 'Updating...' : 'Update Email'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Password Modal */}
      {showEditPasswordModal && (
        <div className="modal-overlay" onClick={closeEditPasswordModal}>
          <div className="account-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-header">
              <button className="account-back-button" onClick={closeEditPasswordModal}>‹</button>
              <h2>Password</h2>
              <div style={{ width: '32px' }}></div>
            </div>

            {accountError && (
              <div className="account-error-message">{accountError}</div>
            )}

            <div className="account-modal-body">
              <div className="account-form">
                <div className="form-group">
                  <label>Current Password</label>
                  <input
                    type="password"
                    value={currentPassword}
                    onChange={(e) => setCurrentPassword(e.target.value)}
                    placeholder="Enter current password"
                    className="account-input"
                    autoFocus
                  />
                </div>

                <div className="form-group">
                  <label>New Password</label>
                  <input
                    type="password"
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="Enter new password"
                    className="account-input"
                  />
                </div>

                <div className="form-group">
                  <label>Confirm New Password</label>
                  <input
                    type="password"
                    value={confirmNewPassword}
                    onChange={(e) => setConfirmNewPassword(e.target.value)}
                    placeholder="Confirm new password"
                    className="account-input"
                  />
                </div>

                <button
                  onClick={handleUpdatePassword}
                  disabled={accountLoading}
                  className="account-button-primary"
                >
                  {accountLoading ? 'Updating...' : 'Update Password'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Edit Platform Modal */}
      {showEditPlatformModal && (
        <div className="modal-overlay" onClick={closeEditPlatformModal}>
          <div className="account-modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="account-modal-header">
              <button className="account-back-button" onClick={closeEditPlatformModal}>‹</button>
              <h2>Music Platform</h2>
              <div style={{ width: '32px' }}></div>
            </div>

            {accountError && (
              <div className="account-error-message">{accountError}</div>
            )}

            <div className="account-modal-body">
              <div className="account-form">
                <div className="form-group">
                  <label>Select Platform</label>
                  <select
                    value={selectedPlatform}
                    onChange={(e) => setSelectedPlatform(e.target.value)}
                    className="account-select"
                  >
                    <option value="spotify">Spotify</option>
                    <option value="apple">Apple Music</option>
                  </select>
                </div>

                <button
                  onClick={handleUpdatePlatform}
                  disabled={accountLoading || selectedPlatform === accountPlatform}
                  className="account-button-primary"
                >
                  {accountLoading ? 'Updating...' : 'Update Platform'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Toast Container */}
      {toasts.length > 0 && (
        <div className="toast-container">
          {toasts.map(toast => (
            <Toast
              key={toast.id}
              message={toast.message}
              type={toast.type}
              onClose={() => removeToast(toast.id)}
            />
          ))}
        </div>
      )}

      {/* Product Tour */}
      <ProductTour
        isOpen={showProductTour}
        onClose={() => setShowProductTour(false)}
        onComplete={() => setShowProductTour(false)}
        onNavigateHome={() => setActiveTab('home')}
        onNavigateToPlaylists={() => setActiveTab('playlists')}
        currentTab={activeTab}
      />
        </>
      ) : inSignupFlow ? (
        <PlatformSelection
          email={localStorage.getItem('userEmail')}
          authToken={localStorage.getItem('authToken')}
          onComplete={() => {
            console.log('PlatformSelection: Signup flow complete, authenticating user');
            localStorage.removeItem('inSignupFlow');
            setInSignupFlow(false);
            // User will be authenticated via OAuth callback
          }}
        />
      ) : (
        <SignupForm onSignupComplete={() => {
          // Signup complete will redirect to platform selection
        }} />
      )}
    </div>
  );
};

export default PlaylistGenerator;
