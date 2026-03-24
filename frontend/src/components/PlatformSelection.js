import React, { useState, useEffect } from 'react';
import playlistService from '../services/api';
import musicKitService from '../services/musicKit';
import ConfirmModal from './ConfirmModal';
import '../styles/SignupForm.css';
import '../styles/PlatformSelection.css';

const PlatformSelection = ({ email, authToken, onComplete }) => {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [connectedPlatforms, setConnectedPlatforms] = useState({ spotify: false, apple: false });
  const [isConnecting, setIsConnecting] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);

  useEffect(() => {
    const fetchConnectedPlatforms = async () => {
      const userEmail = email || localStorage.getItem('userEmail');
      if (userEmail) {
        try {
          const platforms = await playlistService.getConnectedPlatforms(userEmail);
          setConnectedPlatforms(platforms);
        } catch (err) {
          console.error('PlatformSelection: Error fetching connected platforms:', err);
        }
      }
    };

    const urlParams = new URLSearchParams(window.location.search);
    const userIdParam = urlParams.get('userId');
    const emailParam = urlParams.get('email');
    const spotifyConnected = urlParams.get('spotify') === 'connected';
    const appleConnected = urlParams.get('apple') === 'connected';

    if (spotifyConnected) {
      setConnectedPlatforms({ spotify: true, apple: false });
      if (userIdParam) localStorage.setItem('userId', userIdParam);
      if (emailParam) localStorage.setItem('userEmail', decodeURIComponent(emailParam));
      window.history.replaceState({}, document.title, '/platform-selection');
    } else if (appleConnected) {
      setConnectedPlatforms({ spotify: false, apple: true });
      if (userIdParam) localStorage.setItem('userId', userIdParam);
      if (emailParam) localStorage.setItem('userEmail', decodeURIComponent(emailParam));
      window.history.replaceState({}, document.title, '/platform-selection');
    } else {
      fetchConnectedPlatforms();
    }
  }, [email]);

  const handleConnectSpotify = async () => {
    if (connectedPlatforms.apple) {
      setConfirmModal({
        title: 'Switch to Spotify?',
        message: 'Connecting Spotify will disconnect your Apple Music account. Your Apple Music playlists will no longer be accessible.',
        onConfirm: () => { setConfirmModal(null); localStorage.removeItem('appleMusicUserId'); proceedConnectSpotify(); },
      });
      return;
    }
    proceedConnectSpotify();
  };

  const proceedConnectSpotify = async () => {
    setIsConnecting('spotify');
    setError('');
    try {
      const userEmail = email || localStorage.getItem('userEmail');
      const authData = await playlistService.getSpotifyAuthUrl(userEmail);
      if (authData?.url) { window.location.href = authData.url; }
      else { setError('Failed to get Spotify authorization URL'); setIsConnecting(null); }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to connect to Spotify');
      setIsConnecting(null);
    }
  };

  const handleConnectApple = async () => {
    if (connectedPlatforms.spotify) {
      setConfirmModal({
        title: 'Switch to Apple Music?',
        message: 'Connecting Apple Music will disconnect your Spotify account. Your Spotify playlists will no longer be accessible.',
        onConfirm: () => { setConfirmModal(null); localStorage.removeItem('spotifyUserId'); proceedConnectApple(); },
      });
      return;
    }
    proceedConnectApple();
  };

  const proceedConnectApple = async () => {
    setIsConnecting('apple');
    setError('');
    try {
      const userEmail = email || localStorage.getItem('userEmail');
      if (!userEmail) throw new Error('Email not found. Please sign up or log in first.');
      const developerToken = await playlistService.getAppleMusicDeveloperToken();
      await musicKitService.configure(developerToken);
      const userMusicToken = await musicKitService.authorize();
      const result = await playlistService.connectAppleMusicWithToken(userMusicToken, userEmail);
      if (result.userId) {
        localStorage.setItem('userId', result.userId);
        localStorage.setItem('appleMusicUserId', result.userId);
      }
      setConnectedPlatforms(prev => ({ ...prev, apple: true }));
      setIsConnecting(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to connect to Apple Music');
      setIsConnecting(null);
    }
  };

  const handleFinishSignup = async () => {
    setLoading(true);
    setError('');
    try {
      const storedUserId = localStorage.getItem('userId');
      const connectingFromAccount = localStorage.getItem('connectingFromAccount') === 'true';
      const emailToUse = email || localStorage.getItem('userEmail');
      await playlistService.updatePlatforms(emailToUse, connectedPlatforms);
      localStorage.setItem('connectedPlatforms', JSON.stringify(connectedPlatforms));
      localStorage.removeItem('inSignupFlow');
      localStorage.removeItem('connectingFromAccount');
      if (storedUserId) {
        window.location.href = connectingFromAccount ? '/account' : '/';
        return;
      }
      if (connectedPlatforms.spotify) {
        const authData = await playlistService.getSpotifyAuthUrl(emailToUse);
        if (authData?.url) { window.location.href = authData.url; return; }
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to complete signup');
    } finally {
      setLoading(false);
    }
  };

  const anyConnected = connectedPlatforms.spotify || connectedPlatforms.apple;

  return (
    <>
      <ConfirmModal
        isOpen={!!confirmModal}
        title={confirmModal?.title}
        message={confirmModal?.message}
        confirmLabel="Continue"
        onConfirm={confirmModal?.onConfirm}
        onCancel={() => setConfirmModal(null)}
      />

      <div className="auth-page">
        <header className="auth-page-header">
          <div className="auth-brand auth-brand--centered">
            <img src="/fins_logo.png" alt="Fins" className="auth-brand-logo" />
            <span className="auth-brand-name">Fins</span>
          </div>
        </header>

        <div className="auth-page-content">
          <h2 className="auth-page-title">Connect your music</h2>
          <p className="ps-subtitle">Choose which platform to use with Fins</p>

          {error && <div className="auth-error">{error}</div>}

          <div className="ps-options">
            <div className={`ps-option${connectedPlatforms.spotify ? ' ps-option--connected' : ''}`}>
              <img src="/spotify-logo.png" alt="Spotify" className="ps-platform-logo" />
              <span className="ps-platform-name">Spotify</span>
              {connectedPlatforms.spotify ? (
                <span className="ps-badge ps-badge--connected">Connected</span>
              ) : (
                <button
                  className="ps-connect-btn ps-connect-btn--spotify"
                  onClick={handleConnectSpotify}
                  disabled={isConnecting === 'spotify' || loading}
                >
                  {isConnecting === 'spotify' ? 'Connecting…' : 'Connect'}
                </button>
              )}
            </div>

            <div className={`ps-option${connectedPlatforms.apple ? ' ps-option--connected' : ''}`}>
              <img src="/apple-music-logo.png" alt="Apple Music" className="ps-platform-logo" />
              <span className="ps-platform-name">Apple Music</span>
              {connectedPlatforms.apple ? (
                <span className="ps-badge ps-badge--connected">Connected</span>
              ) : (
                <button
                  className="ps-connect-btn ps-connect-btn--apple"
                  onClick={handleConnectApple}
                  disabled={isConnecting === 'apple' || loading}
                >
                  {isConnecting === 'apple' ? 'Connecting…' : 'Connect'}
                </button>
              )}
            </div>
          </div>

          {anyConnected && (
            <button
              className="auth-cta auth-cta--primary ps-continue-btn"
              onClick={handleFinishSignup}
              disabled={loading}
            >
              {loading ? 'Completing…' : 'Continue'}
            </button>
          )}

          <p className="ps-note">
            Connect one platform to continue. Switching platforms later will disconnect the previous one.
          </p>
        </div>
      </div>
    </>
  );
};

export default PlatformSelection;
