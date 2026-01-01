import React, { useState, useEffect } from 'react';
import playlistService from '../services/api';
import musicKitService from '../services/musicKit';
import '../styles/PlatformSelection.css';

const PlatformSelection = ({ email, authToken, onComplete }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connectedPlatforms, setConnectedPlatforms] = useState({
    spotify: false,
    apple: false
  });
  const [isConnecting, setIsConnecting] = useState(null); // 'spotify' or 'apple' while connecting

  useEffect(() => {
    // Check if we're coming back from OAuth
    const urlParams = new URLSearchParams(window.location.search);
    const userIdParam = urlParams.get('userId');
    const emailParam = urlParams.get('email');
    const success = urlParams.get('success');
    const spotifyConnected = urlParams.get('spotify') === 'connected';
    const appleConnected = urlParams.get('apple') === 'connected';

    if (spotifyConnected) {
      console.log('PlatformSelection: Spotify OAuth completed');
      setConnectedPlatforms(prev => ({
        ...prev,
        spotify: true
      }));

      // Store userId from OAuth callback
      if (userIdParam) {
        console.log('PlatformSelection: Storing userId from OAuth:', userIdParam);
        localStorage.setItem('userId', userIdParam);
      }

      // Update email if provided
      if (emailParam) {
        const decodedEmail = decodeURIComponent(emailParam);
        console.log('PlatformSelection: Updating email from OAuth:', decodedEmail);
        localStorage.setItem('userEmail', decodedEmail);
      }

      // Clean up URL
      window.history.replaceState({}, document.title, '/platform-selection');
    }

    if (appleConnected) {
      console.log('PlatformSelection: Apple Music OAuth completed');
      setConnectedPlatforms(prev => ({
        ...prev,
        apple: true
      }));

      // Store userId from OAuth callback
      if (userIdParam) {
        console.log('PlatformSelection: Storing userId from OAuth:', userIdParam);
        localStorage.setItem('userId', userIdParam);
      }

      // Update email if provided
      if (emailParam) {
        const decodedEmail = decodeURIComponent(emailParam);
        console.log('PlatformSelection: Updating email from OAuth:', decodedEmail);
        localStorage.setItem('userEmail', decodedEmail);
      }

      // Clean up URL
      window.history.replaceState({}, document.title, '/platform-selection');
    }
  }, []);

  const handleConnectSpotify = async () => {
    setIsConnecting('spotify');
    setError('');

    try {
      console.log('PlatformSelection: Getting Spotify auth URL for:', email);
      const authData = await playlistService.getSpotifyAuthUrl(email);

      if (authData && authData.url) {
        console.log('PlatformSelection: Redirecting to Spotify OAuth');
        window.location.href = authData.url;
      } else {
        setError('Failed to get Spotify authorization URL');
        setIsConnecting(null);
      }
    } catch (err) {
      console.error('PlatformSelection: Error connecting to Spotify:', err);
      setError(err.response?.data?.error || 'Failed to connect to Spotify');
      setIsConnecting(null);
    }
  };

  const handleConnectApple = async () => {
    setIsConnecting('apple');
    setError('');

    try {
      console.log('PlatformSelection: Connecting to Apple Music with MusicKit');

      // Get email from props or localStorage
      const userEmail = email || localStorage.getItem('userEmail');
      if (!userEmail) {
        throw new Error('Email not found. Please sign up or log in first.');
      }

      // Step 1: Get developer token from backend
      const developerToken = await playlistService.getAppleMusicDeveloperToken();
      console.log('PlatformSelection: Got developer token');

      // Step 2: Configure MusicKit with developer token
      await musicKitService.configure(developerToken);
      console.log('PlatformSelection: MusicKit configured');

      // Step 3: Authorize user (opens Apple sign-in popup)
      const userMusicToken = await musicKitService.authorize();
      console.log('PlatformSelection: User authorized with Apple Music');

      // Step 4: Send user music token to backend
      const result = await playlistService.connectAppleMusicWithToken(userMusicToken, userEmail);
      console.log('PlatformSelection: Apple Music connected successfully', result);

      // Step 5: Store userId and update state
      if (result.userId) {
        localStorage.setItem('userId', result.userId);
        localStorage.setItem('appleMusicUserId', result.userId);
      }

      setConnectedPlatforms(prev => ({
        ...prev,
        apple: true
      }));

      setIsConnecting(null);
    } catch (err) {
      console.error('PlatformSelection: Error connecting to Apple Music:', err);
      setError(err.response?.data?.error || err.message || 'Failed to connect to Apple Music');
      setIsConnecting(null);
    }
  };

  const handleFinishSignup = async () => {
    setLoading(true);
    setError('');

    try {
      console.log('PlatformSelection: Finishing signup with platforms:', connectedPlatforms);

      // Check if we have a userId (from OAuth)
      const storedUserId = localStorage.getItem('userId');
      const connectingFromAccount = localStorage.getItem('connectingFromAccount') === 'true';
      console.log('PlatformSelection: Checking for userId:', storedUserId);
      console.log('PlatformSelection: Connecting from Account page:', connectingFromAccount);

      // Get email from localStorage if not provided as prop
      const emailToUse = email || localStorage.getItem('userEmail');

      // Update user's connected platforms
      await playlistService.updatePlatforms(emailToUse, connectedPlatforms);

      console.log('PlatformSelection: Platforms updated, completing signup');

      // Store connection status in localStorage
      localStorage.setItem('connectedPlatforms', JSON.stringify(connectedPlatforms));

      // Clear signup flow flag
      localStorage.removeItem('inSignupFlow');
      // Clear account connection flag
      localStorage.removeItem('connectingFromAccount');

      // If user connected at least one platform and has userId, they're authenticated
      if (storedUserId) {
        console.log('PlatformSelection: User authenticated with userId:', storedUserId);
        // If user was connecting from Account page, stay on Account page
        if (connectingFromAccount) {
          console.log('PlatformSelection: Returning to Account page');
          window.location.href = '/account';
          return;
        }
        // Otherwise redirect to home page (signup flow)
        console.log('PlatformSelection: Redirecting to home page');
        window.location.href = '/';
        return;
      }

      // If user connected at least one platform but no userId yet, they need to complete OAuth
      if (connectedPlatforms.spotify || connectedPlatforms.apple) {
        console.log('PlatformSelection: User connected platforms but no userId, getting auth');
        if (connectedPlatforms.spotify) {
          const authData = await playlistService.getSpotifyAuthUrl(emailToUse);
          if (authData && authData.url) {
            window.location.href = authData.url;
            return;
          }
        }
      }
    } catch (err) {
      console.error('PlatformSelection: Error finishing signup:', err);
      setError(err.response?.data?.error || 'Failed to complete signup');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="platform-selection-container">
      <div className="platform-selection-card">
        <div className="platform-selection-header">
          <h2>Connect Your Music Platform</h2>
          <p>Choose which music services you'd like to use</p>
        </div>

        {error && <div className="platform-selection-error">{error}</div>}

        <div className="platform-selection-content">
          <div className="platform-option">
            <div className="platform-icon-wrapper spotify-bg">
              <img src="/spotify-logo.png" alt="Spotify" className="platform-logo-img" />
            </div>
            <div className="platform-option-content">
              <h3>Spotify</h3>
            </div>
            {connectedPlatforms.spotify ? (
              <button className="platform-button connected" disabled>
                ✓ Connected
              </button>
            ) : (
              <button
                className="platform-button spotify-button"
                onClick={handleConnectSpotify}
                disabled={isConnecting === 'spotify' || loading}
              >
                {isConnecting === 'spotify' ? 'Connecting...' : 'Connect'}
              </button>
            )}
          </div>

          <div className="platform-option">
            <div className="platform-icon-wrapper apple-bg">
              <img src="/apple-music-logo.png" alt="Apple Music" className="platform-logo-img" />
            </div>
            <div className="platform-option-content">
              <h3>Apple Music</h3>
            </div>

            {connectedPlatforms.apple ? (
              <button className="platform-button connected" disabled>
                ✓ Connected
              </button>
            ) : (
              <button
                className="platform-button apple-button"
                onClick={handleConnectApple}
                disabled={isConnecting === 'apple' || loading}
              >
                {isConnecting === 'apple' ? 'Connecting...' : 'Connect'}
              </button>
            )}
          </div>
        </div>

        <div className="platform-selection-actions">
          {connectedPlatforms.spotify || connectedPlatforms.apple ? (
            <>
              <button
                className="platform-selection-primary-button"
                onClick={handleFinishSignup}
                disabled={loading}
              >
                {loading ? 'Completing Signup...' : 'Finish Signup'}
              </button>
              <button
                className="platform-selection-secondary-button"
                onClick={() => {
                  // Show platform selection again after coming back from OAuth
                  // This allows connecting another platform
                  window.history.replaceState({}, document.title, '/platform-selection');
                }}
              >
                Connect Another Platform
              </button>
            </>
          ) : null}
        </div>

        <p className="platform-selection-note">
          You must connect at least one platform to create your account
        </p>
      </div>
    </div>
  );
};

export default PlatformSelection;
