import React, { useState, useEffect } from 'react';
import playlistService from '../services/api';
import musicKitService from '../services/musicKit';
import Icons from './Icons';
import '../styles/Account.css';

const Account = ({ onBack, showToast }) => {
  const [accountEmail, setAccountEmail] = useState('');
  const [connectedPlatforms, setConnectedPlatforms] = useState({ spotify: false, apple: false });
  const [showEditEmailModal, setShowEditEmailModal] = useState(false);
  const [showEditPasswordModal, setShowEditPasswordModal] = useState(false);
  const [showPlatformsDropdown, setShowPlatformsDropdown] = useState(false);
  const [newEmail, setNewEmail] = useState('');
  const [emailPassword, setEmailPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmNewPassword, setConfirmNewPassword] = useState('');
  const [accountLoading, setAccountLoading] = useState(false);
  const [accountError, setAccountError] = useState('');

  // Fallback toast function if not provided
  const toast = showToast || ((message, type) => {
    console.log(`[${type}] ${message}`);
    alert(message);
  });

  useEffect(() => {
    console.log('Account component mounted');

    // Check for OAuth callback parameters in URL
    const urlParams = new URLSearchParams(window.location.search);
    const emailParam = urlParams.get('email');
    const userIdParam = urlParams.get('userId');
    const success = urlParams.get('success');
    const spotifyConnected = urlParams.get('spotify') === 'connected';

    // If email is provided in callback, update localStorage (from OAuth redirect)
    if (emailParam) {
      const decodedEmail = decodeURIComponent(emailParam);
      console.log('Account: OAuth callback email parameter:', decodedEmail);
      console.log('Account: Previous userEmail was:', localStorage.getItem('userEmail'));
      localStorage.setItem('userEmail', decodedEmail);
      console.log('Account: Updated userEmail from OAuth callback:', decodedEmail);
    }

    // Get email from localStorage (either just updated or previously stored)
    const userEmail = localStorage.getItem('userEmail') || '';
    setAccountEmail(userEmail);

    // If userId is provided in callback, update it
    if (userIdParam) {
      console.log('Account: Storing userId from OAuth:', userIdParam);
      localStorage.setItem('userId', userIdParam);
      if (userIdParam.startsWith('spotify_')) {
        localStorage.setItem('spotifyUserId', userIdParam);
      }
    }

    // Clean up URL parameters after processing
    if (emailParam || userIdParam || success) {
      window.history.replaceState({}, document.title, '/account');
    }

    // Fetch the user's actual platform status from backend
    const fetchPlatformStatus = async () => {
      try {
        const accountInfo = await playlistService.getAccountInfo(userEmail);
        if (accountInfo && accountInfo.connectedPlatforms) {
          console.log('Fetched connected platforms from backend:', accountInfo.connectedPlatforms);
          setConnectedPlatforms(accountInfo.connectedPlatforms);
          // Also update localStorage to keep it in sync
          localStorage.setItem('connectedPlatforms', JSON.stringify(accountInfo.connectedPlatforms));
        }
      } catch (err) {
        console.error('Error fetching platform status:', err);
        // Fall back to localStorage if fetch fails
        const storedPlatforms = localStorage.getItem('connectedPlatforms');
        if (storedPlatforms) {
          try {
            const parsed = JSON.parse(storedPlatforms);
            console.log('Using fallback stored platforms:', parsed);
            setConnectedPlatforms(parsed);
          } catch (e) {
            console.error('Error parsing stored platforms:', e);
          }
        }
      }
    };

    console.log('Account.js initial state:', {
      userEmail,
      spotifyOAuthCompleted: localStorage.getItem('spotifyOAuthCompleted')
    });

    // Check if we just came back from Spotify OAuth callback
    // Only update if we're connecting from Account page (flag will be true when we initiate OAuth)
    const spotifyOAuthCompleted = localStorage.getItem('spotifyOAuthCompleted') === 'true';
    const connectingFromAccount = localStorage.getItem('connectingFromAccount') === 'true';
    console.log('Account.js useEffect - checking for OAuth callback:', {
      spotifyOAuthCompleted: spotifyOAuthCompleted || spotifyConnected,
      connectingFromAccount: connectingFromAccount,
      userEmail: userEmail
    });

    if (spotifyOAuthCompleted && connectingFromAccount) {
      console.log('Spotify OAuth callback detected from Account page! Updating platforms...');

      // First, clear ALL Apple Music data when switching to Spotify
      console.log('Clearing Apple Music data before switching to Spotify');
      localStorage.removeItem('appleMusicUserId');

      // Get the userId that was just set from Spotify OAuth and set Spotify data
      const spotifyId = localStorage.getItem('userId');
      if (spotifyId && spotifyId.startsWith('spotify_')) {
        localStorage.setItem('spotifyUserId', spotifyId);
        localStorage.setItem('activePlatform', 'spotify');
        console.log('Set Spotify data:', {
          spotifyUserId: spotifyId,
          userId: spotifyId,
          activePlatform: 'spotify'
        });
      }

      // Get current platforms from localStorage to preserve other platform connections
      // When connecting Spotify, disconnect Apple Music
      const updatedPlatforms = {
        spotify: true,
        apple: false  // Disconnect Apple Music when connecting Spotify
      };
      console.log('Updated platforms:', updatedPlatforms);
      setConnectedPlatforms(updatedPlatforms);
      localStorage.setItem('connectedPlatforms', JSON.stringify(updatedPlatforms));

      // Update the backend
      playlistService.updatePlatforms(userEmail, updatedPlatforms).catch(err => console.error('Error updating platforms:', err));
      // Clear the flags
      localStorage.removeItem('spotifyOAuthCompleted');
      localStorage.removeItem('connectingFromAccount');
      // Dispatch custom event to notify other components of platform changes
      // Use setTimeout to ensure localStorage updates are complete before event is processed
      setTimeout(() => {
        console.log('Dispatching platformsChanged event for Spotify');
        window.dispatchEvent(new CustomEvent('platformsChanged', { detail: updatedPlatforms }));
      }, 300);
      toast('Spotify connected successfully!', 'success');
    } else {
      // Fetch platform status from backend (only if not handling OAuth callback)
      fetchPlatformStatus();
    }
  }, []);

  const openEditEmailModal = () => {
    setNewEmail('');
    setEmailPassword('');
    setAccountError('');
    setShowEditEmailModal(true);
  };

  const closeEditEmailModal = () => {
    setShowEditEmailModal(false);
    setAccountError('');
  };

  const openEditPasswordModal = () => {
    setCurrentPassword('');
    setNewPassword('');
    setConfirmNewPassword('');
    setAccountError('');
    setShowEditPasswordModal(true);
  };

  const closeEditPasswordModal = () => {
    setShowEditPasswordModal(false);
    setAccountError('');
  };

  const togglePlatformsDropdown = () => {
    setShowPlatformsDropdown(!showPlatformsDropdown);
  };

  const handleTogglePlatform = async (platform) => {
    try {
      setAccountLoading(true);
      setAccountError('');

      console.log('handleTogglePlatform called:', {
        platform,
        isConnected: connectedPlatforms[platform],
        accountEmail
      });

      // If disconnecting, just update without OAuth
      if (connectedPlatforms[platform]) {
        // Always get fresh email from localStorage (don't rely on state)
        const emailToUse = localStorage.getItem('userEmail');
        if (!emailToUse) {
          setAccountError('Error: User email not found. Please try logging in again.');
          setAccountLoading(false);
          return;
        }
        console.log('Disconnecting from', platform, 'using email:', emailToUse);
        console.log('Current connectedPlatforms state:', connectedPlatforms);
        const updatedPlatforms = {
          ...connectedPlatforms,
          [platform]: false
        };
        console.log('Updated platforms after disconnect:', updatedPlatforms);
        console.log('Sending updatePlatforms API call with:', {
          email: emailToUse,
          platforms: updatedPlatforms
        });
        await playlistService.updatePlatforms(emailToUse, updatedPlatforms);
        localStorage.setItem('connectedPlatforms', JSON.stringify(updatedPlatforms));
        setConnectedPlatforms(updatedPlatforms);

        // Remove platform-specific userId from localStorage
        if (platform === 'spotify') {
          localStorage.removeItem('spotifyUserId');
          // If currently using Spotify, switch to Apple Music if available
          if (localStorage.getItem('activePlatform') === 'spotify') {
            if (updatedPlatforms.apple && localStorage.getItem('appleMusicUserId')) {
              localStorage.setItem('activePlatform', 'apple');
              localStorage.setItem('userId', localStorage.getItem('appleMusicUserId'));
            } else {
              localStorage.removeItem('activePlatform');
              localStorage.removeItem('userId');
            }
          }
        } else if (platform === 'apple') {
          localStorage.removeItem('appleMusicUserId');
          // If currently using Apple Music, switch to Spotify if available
          if (localStorage.getItem('activePlatform') === 'apple') {
            if (updatedPlatforms.spotify && localStorage.getItem('spotifyUserId')) {
              localStorage.setItem('activePlatform', 'spotify');
              localStorage.setItem('userId', localStorage.getItem('spotifyUserId'));
            } else {
              localStorage.removeItem('activePlatform');
              localStorage.removeItem('userId');
            }
          }
        }

        // Check if both platforms are now disconnected - clear platform-specific data but keep user logged in
        if (!updatedPlatforms.spotify && !updatedPlatforms.apple) {
          console.log('All platforms disconnected - clearing platform-specific data');
          // Keep userEmail to maintain login state
          // Only clear platform-specific userIds and activePlatform
          localStorage.removeItem('spotifyUserId');
          localStorage.removeItem('appleMusicUserId');
          localStorage.removeItem('activePlatform');
          // Set userId back to email to maintain authentication
          const userEmail = localStorage.getItem('userEmail');
          if (userEmail) {
            localStorage.setItem('userId', userEmail);
          }
        }

        // Dispatch custom event to notify other components of platform changes
        window.dispatchEvent(new CustomEvent('platformsChanged', { detail: updatedPlatforms }));
        const platformName = platform === 'spotify' ? 'Spotify' : 'Apple Music';
        toast(`${platformName} disconnected successfully`, 'success');
      } else {
        // If connecting, check if another platform is already connected and warn
        if (platform === 'spotify') {
          // Check if Apple Music is already connected
          if (connectedPlatforms.apple) {
            const confirmed = window.confirm(
              'Connecting Spotify will disconnect your Apple Music account. Your Apple Music playlists will no longer be accessible. Do you want to continue?'
            );
            if (!confirmed) {
              setAccountLoading(false);
              return;
            }
            // Clear Apple Music data from localStorage
            localStorage.removeItem('appleMusicUserId');
          }

          // Always get fresh email from localStorage (don't rely on state)
          const emailToUse = localStorage.getItem('userEmail');
          if (!emailToUse) {
            setAccountError('Error: User email not found. Please try logging in again.');
            setAccountLoading(false);
            return;
          }
          console.log('Getting Spotify auth URL for:', emailToUse);
          // Set flag to indicate we're connecting from Account page
          localStorage.setItem('connectingFromAccount', 'true');
          const response = await playlistService.getSpotifyAuthUrl(emailToUse, true);
          console.log('Spotify auth URL received:', response);
          console.log('Redirecting to:', response.url);
          window.location.href = response.url;
        } else if (platform === 'apple') {
          // Check if Spotify is already connected
          if (connectedPlatforms.spotify) {
            const confirmed = window.confirm(
              'Connecting Apple Music will disconnect your Spotify account. Your Spotify playlists will no longer be accessible. Do you want to continue?'
            );
            if (!confirmed) {
              setAccountLoading(false);
              return;
            }
            // Clear Spotify data from localStorage
            localStorage.removeItem('spotifyUserId');
          }

          // Use MusicKit JS for Apple Music authentication
          const emailToUse = localStorage.getItem('userEmail');
          if (!emailToUse) {
            setAccountError('Error: User email not found. Please try logging in again.');
            setAccountLoading(false);
            return;
          }

          console.log('Connecting to Apple Music with MusicKit for:', emailToUse);

          // Step 1: Get developer token
          const developerToken = await playlistService.getAppleMusicDeveloperToken();

          // Step 2: Configure MusicKit
          await musicKitService.configure(developerToken);

          // Step 3: Authorize user (opens Apple sign-in)
          const userMusicToken = await musicKitService.authorize();

          // Step 4: Send user music token to backend
          const result = await playlistService.connectAppleMusicWithToken(userMusicToken, emailToUse);
          console.log('Apple Music connected successfully:', result);

          // Step 5: Update state and localStorage
          // First, clear ALL Spotify data when switching to Apple Music
          console.log('Clearing Spotify data before switching to Apple Music');
          localStorage.removeItem('spotifyUserId');

          // Then set Apple Music data
          if (result.userId) {
            localStorage.setItem('appleMusicUserId', result.userId);
            localStorage.setItem('userId', result.userId);
            localStorage.setItem('activePlatform', 'apple');
            console.log('Set Apple Music data:', {
              appleMusicUserId: result.userId,
              userId: result.userId,
              activePlatform: 'apple'
            });
          }

          const updatedPlatforms = {
            spotify: false,  // Disconnect Spotify when connecting Apple Music
            apple: true
          };
          setConnectedPlatforms(updatedPlatforms);
          localStorage.setItem('connectedPlatforms', JSON.stringify(updatedPlatforms));
          console.log('Updated connectedPlatforms:', updatedPlatforms);

          // Dispatch custom event to notify other components of platform changes
          // Use setTimeout to ensure localStorage updates are complete before event is processed
          setTimeout(() => {
            console.log('Dispatching platformsChanged event for Apple Music');
            window.dispatchEvent(new CustomEvent('platformsChanged', { detail: updatedPlatforms }));
          }, 300);

          setAccountError('');
          setAccountLoading(false);
          toast('Apple Music connected successfully!', 'success');
          return; // Exit early since we handled everything
        }
      }
    } catch (err) {
      console.error('Error details:', err);
      setAccountError(err.response?.data?.error || err.message || `Failed to update ${platform}`);
    } finally {
      setAccountLoading(false);
    }
  };

  const handleUpdateEmail = async () => {
    if (!newEmail || !emailPassword) {
      setAccountError('Please fill in all fields');
      return;
    }

    try {
      setAccountLoading(true);
      setAccountError('');
      await playlistService.updateEmail(newEmail, emailPassword);
      localStorage.setItem('userEmail', newEmail);
      setAccountEmail(newEmail);
      closeEditEmailModal();
      toast('Email updated successfully', 'success');
    } catch (err) {
      setAccountError(err.response?.data?.error || 'Failed to update email');
    } finally {
      setAccountLoading(false);
    }
  };

  const handleUpdatePassword = async () => {
    if (!currentPassword || !newPassword || !confirmNewPassword) {
      setAccountError('Please fill in all fields');
      return;
    }

    if (newPassword !== confirmNewPassword) {
      setAccountError('New passwords do not match');
      return;
    }

    if (newPassword.length < 6) {
      setAccountError('Password must be at least 6 characters');
      return;
    }

    try {
      setAccountLoading(true);
      setAccountError('');
      await playlistService.updatePassword(currentPassword, newPassword);
      closeEditPasswordModal();
      toast('Password updated successfully', 'success');
    } catch (err) {
      setAccountError(err.response?.data?.error || 'Failed to update password');
    } finally {
      setAccountLoading(false);
    }
  };


  return (
    <div className="account-page">
      <div className="account-header">
        <h1>Account</h1>
      </div>

      <div className="account-content">
        {accountError && (
          <div className="account-error-message" style={{ margin: '16px' }}>
            {accountError}
          </div>
        )}
        <div className="account-list">
          <button className="account-list-item" onClick={openEditEmailModal}>
            <span className="account-list-label">Email</span>
            <div className="account-list-value">
              <span>{accountEmail}</span>
              <Icons.ChevronRight size={20} color="#c7c7cc" />
            </div>
          </button>

          <button className="account-list-item" onClick={openEditPasswordModal}>
            <span className="account-list-label">Password</span>
            <div className="account-list-value">
              <span>••••••••</span>
              <Icons.ChevronRight size={20} color="#c7c7cc" />
            </div>
          </button>

          <button className="account-list-item platforms-dropdown-header" onClick={togglePlatformsDropdown}>
            <span className="account-list-label">Connected Music Platforms</span>
            <div className="account-list-value">
              <span>
                {Object.entries(connectedPlatforms)
                  .filter(([_, connected]) => connected)
                  .map(([platform]) => platform === 'spotify' ? 'Spotify' : 'Apple Music')
                  .join(', ') || 'None connected'}
              </span>
              <Icons.ChevronRight
                size={20}
                color="#c7c7cc"
                style={{
                  transform: showPlatformsDropdown ? 'rotate(90deg)' : 'rotate(0deg)',
                  transition: 'transform 0.2s'
                }}
              />
            </div>
          </button>

          {/* Platforms Dropdown */}
          {showPlatformsDropdown && (
            <div className="account-platforms-dropdown">
              <div className="platform-card">
                <div className="platform-card-header">
                  <div className="platform-card-info">
                    <img src="/spotify-logo.png" alt="Spotify" className="platform-logo" />
                    <div className="platform-card-text">
                      <span className="platform-card-name">Spotify</span>
                      <span className="platform-card-status">
                        {connectedPlatforms.spotify ? 'Connected' : 'Not connected'}
                      </span>
                    </div>
                  </div>
                  <button
                    className={`platform-toggle-btn ${connectedPlatforms.spotify ? 'connected' : ''}`}
                    onClick={() => handleTogglePlatform('spotify')}
                    disabled={accountLoading}
                  >
                    {connectedPlatforms.spotify ? 'Disconnect' : 'Connect'}
                  </button>
                </div>
              </div>

              <div className="platform-card">
                <div className="platform-card-header">
                  <div className="platform-card-info">
                    <img src="/apple-music-logo.png" alt="Apple Music" className="platform-logo" />
                    <div className="platform-card-text">
                      <span className="platform-card-name">Apple Music</span>
                      <span className="platform-card-status">
                        {connectedPlatforms.apple ? 'Connected' : 'Not connected'}
                      </span>
                    </div>
                  </div>
                  <button
                    className={`platform-toggle-btn ${connectedPlatforms.apple ? 'connected' : ''}`}
                    onClick={() => handleTogglePlatform('apple')}
                    disabled={accountLoading}
                  >
                    {connectedPlatforms.apple ? 'Disconnect' : 'Connect'}
                  </button>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

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

    </div>
  );
};

export default Account;
