import React, { useState, useEffect, useMemo } from 'react';
import playlistService from '../services/api';
import Icons from './Icons';
import '../styles/SignupForm.css';
import mp from '../utils/mixpanel';

const SignupForm = ({ onSignupComplete }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [isLoginMode, setIsLoginMode] = useState(true);
  const [bgArtists, setBgArtists] = useState([]);

  useEffect(() => {
    playlistService.getFeaturedArtists()
      .then(data => setBgArtists(data.artists || []))
      .catch(() => {});
  }, []);

  // Distribute artists across 3 columns, interleaved for visual variety
  const columns = useMemo(() => {
    const cols = [[], [], []];
    bgArtists.forEach((a, i) => cols[i % 3].push(a));
    return cols;
  }, [bgArtists]);

  const validateEmail = (email) => {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  };

  const handleContinue = async () => {
    setError('');

    if (!email.trim()) {
      setError('Please enter your email address');
      return;
    }

    if (!validateEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }

    if (!showPassword) {
      setShowPassword(true);
      return;
    }

    if (!password) {
      setError('Please enter a password');
      return;
    }

    if (!isLoginMode && password.length < 6) {
      setError('Password must be at least 6 characters long');
      return;
    }

    if (!isLoginMode && !confirmPassword) {
      setError('Please confirm your password');
      return;
    }

    if (!isLoginMode && password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (isLoginMode) {
      await handleLogin();
    } else {
      await handleSpotifySignup();
    }
  };

  const handleLogin = async () => {
    setLoading(true);
    setError('');

    try {
      // CLEAR ALL USER DATA before logging in with a potentially different account
      localStorage.removeItem('userId');
      localStorage.removeItem('userEmail');
      localStorage.removeItem('authToken');
      localStorage.removeItem('musicPlatform');
      localStorage.removeItem('connectedPlatforms');
      localStorage.removeItem('spotifyOAuthCompleted');
      localStorage.removeItem('draftPlaylists');

      console.log('SignupForm: Cleared all localStorage before login');

      // Login the user
      const data = await playlistService.login(email, password);

      // Store the auth token and user info - ALWAYS use the email from the login form
      const trimmedEmail = email.trim().toLowerCase();
      localStorage.setItem('authToken', data.token);
      localStorage.setItem('userEmail', trimmedEmail);
      localStorage.setItem('musicPlatform', data.platform);
      localStorage.setItem('userPlan', data.plan || 'free');
      if (data.productTourCompleted) {
        localStorage.setItem('productTourCompleted', 'true');
      } else {
        localStorage.removeItem('productTourCompleted');
      }
      localStorage.setItem('allowExplicit', JSON.stringify(data.allowExplicit !== false));
      localStorage.setItem('darkMode', JSON.stringify(data.darkMode || false));
      if (data.darkMode) {
        document.documentElement.classList.add('dark-mode');
      } else {
        document.documentElement.classList.remove('dark-mode');
      }

      console.log('SignupForm: Set userEmail to:', trimmedEmail);

      // If user has userId, redirect to app, otherwise send to platform selection
      if (data.userId) {
        localStorage.setItem('userId', data.userId);
        mp.identify(data.userId);
        mp.setPeople({ $email: trimmedEmail, platform: data.platform });
        mp.track('User Logged In', { platform: data.platform });
        // User is already connected, redirect to app
        window.location.href = '/';
      } else {
        mp.identify(trimmedEmail);
        mp.setPeople({ $email: trimmedEmail });
        mp.track('User Logged In', { platform: data.platform });
        // User needs to connect to a music platform
        // Set flag to show platform selection
        localStorage.setItem('inSignupFlow', 'true');
        // Redirect to home, which will show platform selection
        window.location.href = '/';
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Invalid email or password');
      setLoading(false);
      console.error('Login error:', err);
    }
  };

  const handleSpotifySignup = async () => {
    setLoading(true);
    setError('');

    try {
      console.log('=== SIGNUP FLOW STARTED ===');
      console.log('Email input:', email);

      // CLEAR ALL USER DATA before signing up a new account to prevent contamination
      console.log('Clearing all localStorage...');
      localStorage.clear();
      console.log('localStorage cleared completely');

      // Register the user
      console.log('Calling signup API with email:', email, 'password length:', password.length);
      const data = await playlistService.signup(email, password, 'spotify');
      console.log('Signup success! Response:', data);

      // Store the auth token and user info
      const trimmedEmail = email.trim().toLowerCase();
      localStorage.setItem('authToken', data.token);
      localStorage.setItem('userEmail', trimmedEmail);
      localStorage.setItem('musicPlatform', 'spotify');
      localStorage.setItem('inSignupFlow', 'true');
      localStorage.setItem('userPlan', data.plan || 'free');

      console.log('Stored in localStorage:', {
        userEmail: localStorage.getItem('userEmail'),
        authToken: localStorage.getItem('authToken'),
        inSignupFlow: localStorage.getItem('inSignupFlow')
      });

      mp.alias(trimmedEmail);
      mp.identify(trimmedEmail);
      mp.setPeople({ $email: trimmedEmail, platform: 'spotify' });
      mp.track('User Signed Up', { platform: 'spotify' });

      console.log('✓ Signup complete, redirecting to platform selection');
      // Redirect to platform selection page
      window.location.href = '/platform-selection';
    } catch (err) {
      console.error('=== SIGNUP FAILED ===');
      console.error('Error:', err);
      console.error('Error response:', err.response?.data);
      const errorMessage = err.response?.data?.error ||
                          err.message ||
                          (err.code === 'ECONNABORTED' ? 'Request timeout - please try again' : 'Failed to create account. Please try again.');
      console.error('Displaying to user:', errorMessage);
      setError(errorMessage);
      setLoading(false);
    }
  };

  const toggleMode = () => {
    setIsLoginMode(!isLoginMode);
    setError('');
    setShowPassword(false);
    setPassword('');
    setConfirmPassword('');
  };

  return (
    <div className="auth-container">
      {bgArtists.length > 0 && (
        <div className="auth-bg" aria-hidden="true">
          {columns.map((col, ci) => (
            <div key={ci} className={`auth-bg-col ${ci % 2 === 1 ? 'scroll-down' : 'scroll-up'}`}>
              {[...col, ...col, ...col].map((artist, i) => (
                <img
                  key={i}
                  src={artist.image}
                  alt=""
                  className="auth-bg-img"
                  draggable={false}
                />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="auth-overlay" aria-hidden="true" />
      <div className="auth-card">
        <div className="auth-logo">
          <img src="/fins_logo.png" alt="Fins" className="auth-logo-img" />
        </div>

        <h1 className="auth-title">
          {isLoginMode ? 'Welcome back' : 'Create account'}
        </h1>
        <p className="auth-subtitle">
          {isLoginMode
            ? 'Log in to continue to your playlists'
            : 'Sign up to start building playlists'}
        </p>

        {error && <div className="auth-error">{error}</div>}

        <div className="auth-form">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyPress={(e) => { if (e.key === 'Enter') handleContinue(); }}
            placeholder="name@email.com"
            className="auth-input"
            autoFocus
          />

          {showPassword && (
            <>
              <div className="auth-input-wrapper">
                <input
                  type={passwordVisible ? 'text' : 'password'}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onKeyPress={(e) => { if (e.key === 'Enter') handleContinue(); }}
                  placeholder={isLoginMode ? 'Enter your password' : 'Create a password'}
                  className="auth-input"
                  autoFocus
                />
                <button
                  type="button"
                  className="auth-password-toggle"
                  onClick={() => setPasswordVisible(!passwordVisible)}
                  tabIndex={-1}
                  aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                >
                  {passwordVisible ? (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                      <line x1="1" y1="1" x2="23" y2="23"/>
                    </svg>
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                      <circle cx="12" cy="12" r="3"/>
                    </svg>
                  )}
                </button>
              </div>

              {!isLoginMode && (
                <div className="auth-input-wrapper">
                  <input
                    type={passwordVisible ? 'text' : 'password'}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    onKeyPress={(e) => { if (e.key === 'Enter') handleContinue(); }}
                    placeholder="Confirm your password"
                    className="auth-input"
                  />
                  <button
                    type="button"
                    className="auth-password-toggle"
                    onClick={() => setPasswordVisible(!passwordVisible)}
                    tabIndex={-1}
                    aria-label={passwordVisible ? 'Hide password' : 'Show password'}
                  >
                    {passwordVisible ? (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                        <line x1="1" y1="1" x2="23" y2="23"/>
                      </svg>
                    ) : (
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                        <circle cx="12" cy="12" r="3"/>
                      </svg>
                    )}
                  </button>
                </div>
              )}
            </>
          )}

          <button
            onClick={handleContinue}
            className="auth-cta"
            disabled={loading}
          >
            {loading
              ? 'Loading...'
              : showPassword
                ? (isLoginMode ? 'Log in' : 'Sign up')
                : 'Continue with email'}
          </button>

          {isLoginMode && showPassword && (
            <button
              onClick={() => window.location.href = '/forgot-password'}
              className="auth-link-btn"
              type="button"
            >
              Forgot password?
            </button>
          )}

          <button onClick={toggleMode} className="auth-toggle" type="button">
            {isLoginMode
              ? "Don't have an account? Sign up"
              : 'Already have an account? Log in'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SignupForm;
