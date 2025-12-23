import React, { useState, useEffect } from 'react';
import playlistService from '../services/api';
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
  const [expandedFaqId, setExpandedFaqId] = useState(null);

  // FAQ data
  const faqs = [
    {
      id: 1,
      question: "How do I connect my Spotify account?",
      answer: "Click on 'Connected Music Platforms' above, then click the 'Connect' button next to Spotify. You'll be redirected to Spotify to authorize the connection."
    },
    {
      id: 2,
      question: "Can I connect multiple music platforms?",
      answer: "Yes! You can connect both Spotify and Apple Music to your account. Your playlists will be synced to whichever platform you choose when generating or refreshing a playlist."
    },
    {
      id: 3,
      question: "How do automatic playlist refreshes work?",
      answer: "When you enable auto-refresh for a playlist, we'll automatically update it with new songs based on your chosen frequency (daily, weekly, or monthly). The playlist will maintain its vibe while introducing fresh tracks."
    },
    {
      id: 4,
      question: "What happens if I disconnect a music platform?",
      answer: "Disconnecting a platform will prevent new playlists from being created on that service, but your existing playlists will remain on the platform. You can reconnect at any time to resume playlist creation."
    },
    {
      id: 5,
      question: "How do I change my email or password?",
      answer: "Click on 'Email' or 'Password' in the account settings above. You'll need to confirm your current password to make changes for security purposes."
    },
    {
      id: 6,
      question: "Can I refine playlists after they're created?",
      answer: "Absolutely! Go to 'My Playlists', click on any playlist, and use the 'Refine Playlist' option. You can chat with our AI to adjust the vibe, add or remove genres, change tempo, and more."
    }
  ];

  // Fallback toast function if not provided
  const toast = showToast || ((message, type) => {
    console.log(`[${type}] ${message}`);
    alert(message);
  });

  useEffect(() => {
    console.log('Account component mounted');
    const userEmail = localStorage.getItem('userEmail') || '';
    setAccountEmail(userEmail);

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
      spotifyOAuthCompleted: spotifyOAuthCompleted,
      connectingFromAccount: connectingFromAccount,
      userEmail: userEmail
    });

    if (spotifyOAuthCompleted && connectingFromAccount) {
      console.log('Spotify OAuth callback detected from Account page! Updating platforms...');
      const updatedPlatforms = {
        spotify: true,
        apple: false
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
      window.dispatchEvent(new CustomEvent('platformsChanged', { detail: updatedPlatforms }));
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

  const toggleFaq = (faqId) => {
    setExpandedFaqId(expandedFaqId === faqId ? null : faqId);
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
        const updatedPlatforms = {
          ...connectedPlatforms,
          [platform]: false
        };
        console.log('Sending updatePlatforms API call with:', {
          email: emailToUse,
          platforms: updatedPlatforms
        });
        await playlistService.updatePlatforms(emailToUse, updatedPlatforms);
        localStorage.setItem('connectedPlatforms', JSON.stringify(updatedPlatforms));
        setConnectedPlatforms(updatedPlatforms);
        // Dispatch custom event to notify other components of platform changes
        window.dispatchEvent(new CustomEvent('platformsChanged', { detail: updatedPlatforms }));
        const platformName = platform === 'spotify' ? 'Spotify' : 'Apple Music';
        toast(`${platformName} disconnected successfully`, 'success');
      } else {
        // If connecting, trigger OAuth flow
        if (platform === 'spotify') {
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
          const response = await playlistService.getSpotifyAuthUrl(emailToUse);
          console.log('Spotify auth URL received:', response);
          console.log('Redirecting to:', response.url);
          window.location.href = response.url;
        } else if (platform === 'apple') {
          // Always get fresh email from localStorage (don't rely on state)
          const emailToUse = localStorage.getItem('userEmail');
          if (!emailToUse) {
            setAccountError('Error: User email not found. Please try logging in again.');
            setAccountLoading(false);
            return;
          }
          console.log('Getting Apple Music auth URL for:', emailToUse);
          // Set flag to indicate we're connecting from Account page
          localStorage.setItem('connectingFromAccount', 'true');
          const response = await playlistService.getAppleMusicAuthUrl(emailToUse);
          console.log('Apple Music auth URL received:', response);
          console.log('Redirecting to:', response.url);
          window.location.href = response.url;
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

        {/* FAQ Section */}
        <div className="account-list" style={{ marginTop: '24px' }}>
          <div className="account-section-header">
            <span className="account-list-label" style={{ fontSize: '13px', fontWeight: '600', color: '#8e8e93', textTransform: 'uppercase', letterSpacing: '0.5px' }}>
              Frequently Asked Questions
            </span>
          </div>

          {faqs.map((faq) => (
            <div key={faq.id}>
              <button
                className="account-list-item faq-item"
                onClick={() => toggleFaq(faq.id)}
              >
                <span className="account-list-label">{faq.question}</span>
                <Icons.ChevronRight
                  size={20}
                  color="#c7c7cc"
                  style={{
                    transform: expandedFaqId === faq.id ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s'
                  }}
                />
              </button>

              {expandedFaqId === faq.id && (
                <div className="faq-answer">
                  {faq.answer}
                </div>
              )}
            </div>
          ))}
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
