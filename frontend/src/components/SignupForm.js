import React, { useState, useEffect, useRef, useMemo } from 'react';
import playlistService from '../services/api';
import '../styles/SignupForm.css';
import mp from '../utils/mixpanel';

const EyeOff = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
    <line x1="1" y1="1" x2="23" y2="23"/>
  </svg>
);

const EyeOn = () => (
  <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
    <circle cx="12" cy="12" r="3"/>
  </svg>
);

const SignupForm = ({ onSignupComplete }) => {
  const [mode, setMode] = useState('landing'); // 'landing' | 'login' | 'signup'
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [passwordVisible, setPasswordVisible] = useState(false);
  const [bgArtists, setBgArtists] = useState([]);

  const emailRef = useRef(null);
  const isLoginMode = mode === 'login';
  const isFormOpen = mode !== 'landing';

  // Lock body scroll for the duration of the auth page
  useEffect(() => {
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = prev; };
  }, []);

  useEffect(() => {
    playlistService.getFeaturedArtists()
      .then(data => setBgArtists(data.artists || []))
      .catch(() => {});
  }, []);

  // Focus email field after sheet slides up
  useEffect(() => {
    if (isFormOpen) {
      const t = setTimeout(() => emailRef.current?.focus(), 380);
      return () => clearTimeout(t);
    }
  }, [isFormOpen]);

  // Distribute artists across 3 columns, interleaved.
  // Middle column is reversed so it visually scrolls opposite (all columns use
  // the same upward CSS animation — reversed images create a downward look).
  const columns = useMemo(() => {
    const cols = [[], [], []];
    bgArtists.forEach((a, i) => cols[i % 3].push(a));
    cols[1] = [...cols[1]].reverse();
    return cols;
  }, [bgArtists]);

  const openForm = (loginMode) => {
    setMode(loginMode ? 'login' : 'signup');
    setError('');
    setShowPassword(false);
    setPassword('');
    setConfirmPassword('');
    setEmail('');
  };

  const closeForm = () => {
    setMode('landing');
    setError('');
    setShowPassword(false);
  };

  const toggleMode = () => {
    setMode(isLoginMode ? 'signup' : 'login');
    setError('');
    setShowPassword(false);
    setPassword('');
    setConfirmPassword('');
  };

  const validateEmail = (e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e);

  const handleContinue = async () => {
    setError('');
    if (!email.trim()) { setError('Please enter your email address'); return; }
    if (!validateEmail(email)) { setError('Please enter a valid email address'); return; }
    if (!showPassword) { setShowPassword(true); return; }
    if (!password) { setError('Please enter a password'); return; }
    if (!isLoginMode && password.length < 6) { setError('Password must be at least 6 characters long'); return; }
    if (!isLoginMode && !confirmPassword) { setError('Please confirm your password'); return; }
    if (!isLoginMode && password !== confirmPassword) { setError('Passwords do not match'); return; }
    if (isLoginMode) { await handleLogin(); } else { await handleSpotifySignup(); }
  };

  const handleLogin = async () => {
    setLoading(true);
    setError('');
    try {
      localStorage.removeItem('userId');
      localStorage.removeItem('userEmail');
      localStorage.removeItem('authToken');
      localStorage.removeItem('musicPlatform');
      localStorage.removeItem('connectedPlatforms');
      localStorage.removeItem('spotifyOAuthCompleted');
      localStorage.removeItem('draftPlaylists');

      const data = await playlistService.login(email, password);
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
      if (data.darkMode) { document.documentElement.classList.add('dark-mode'); }
      else { document.documentElement.classList.remove('dark-mode'); }

      if (data.userId) {
        localStorage.setItem('userId', data.userId);
        mp.identify(data.userId);
        mp.setPeople({ $email: trimmedEmail, platform: data.platform });
        mp.track('User Logged In', { platform: data.platform });
        window.location.href = '/';
      } else {
        mp.identify(trimmedEmail);
        mp.setPeople({ $email: trimmedEmail });
        mp.track('User Logged In', { platform: data.platform });
        localStorage.setItem('inSignupFlow', 'true');
        window.location.href = '/';
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Invalid email or password');
      setLoading(false);
    }
  };

  const handleSpotifySignup = async () => {
    setLoading(true);
    setError('');
    try {
      localStorage.clear();
      const data = await playlistService.signup(email, password, 'spotify');
      const trimmedEmail = email.trim().toLowerCase();
      localStorage.setItem('authToken', data.token);
      localStorage.setItem('userEmail', trimmedEmail);
      localStorage.setItem('musicPlatform', 'spotify');
      localStorage.setItem('inSignupFlow', 'true');
      localStorage.setItem('userPlan', data.plan || 'free');
      mp.alias(trimmedEmail);
      mp.identify(trimmedEmail);
      mp.setPeople({ $email: trimmedEmail, platform: 'spotify' });
      mp.track('User Signed Up', { platform: 'spotify' });
      window.location.href = '/platform-selection';
    } catch (err) {
      const errorMessage = err.response?.data?.error || err.message ||
        (err.code === 'ECONNABORTED' ? 'Request timeout - please try again' : 'Failed to create account. Please try again.');
      setError(errorMessage);
      setLoading(false);
    }
  };

  const PasswordToggle = () => (
    <button
      type="button"
      className="auth-password-toggle"
      onClick={() => setPasswordVisible(!passwordVisible)}
      tabIndex={-1}
      aria-label={passwordVisible ? 'Hide password' : 'Show password'}
    >
      {passwordVisible ? <EyeOff /> : <EyeOn />}
    </button>
  );

  return (
    <div className="auth-container">
      {/* Artist mosaic background */}
      {bgArtists.length > 0 && (
        <div className="auth-bg" aria-hidden="true">
          {columns.map((col, ci) => (
            <div key={ci} className={`auth-bg-col auth-bg-col-${ci}`}>
              {[...col, ...col, ...col].map((artist, i) => (
                <img key={i} src={artist.image} alt="" className="auth-bg-img" draggable={false} />
              ))}
            </div>
          ))}
        </div>
      )}
      <div className="auth-overlay" aria-hidden="true" />

      {/* Landing page */}
      <div className={`auth-landing${isFormOpen ? ' auth-landing--hidden' : ''}`}>
        <header className="auth-header">
          <div className="auth-brand">
            <img src="/fins_logo.png" alt="Fins" className="auth-brand-logo" />
            <span className="auth-brand-name">Fins</span>
          </div>
        </header>

        <div className="auth-hero">
          <h1 className="auth-hero-title">Your playlist,<br />your vibe.</h1>
          <p className="auth-hero-sub">AI-generated playlists built around your taste</p>
        </div>

        <div className="auth-landing-actions">
          <button className="auth-cta auth-cta--primary" onClick={() => openForm(false)}>
            Sign up for free
          </button>
          <button className="auth-cta auth-cta--secondary" onClick={() => openForm(true)}>
            Log in
          </button>
        </div>
      </div>

      {/* Backdrop tap-to-close (desktop) */}
      {isFormOpen && <div className="auth-sheet-backdrop" onClick={closeForm} />}

      {/* Form bottom sheet */}
      <div className={`auth-sheet${isFormOpen ? ' auth-sheet--open' : ''}`}>
        <div className="auth-sheet-handle" />
        <button className="auth-sheet-back" onClick={closeForm} aria-label="Close">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"
            strokeLinecap="round" strokeLinejoin="round" width="22" height="22">
            <polyline points="6 9 12 15 18 9" />
          </svg>
        </button>

        <h2 className="auth-sheet-title">
          {isLoginMode ? 'Log in' : 'Create account'}
        </h2>

        {error && <div className="auth-error">{error}</div>}

        <div className="auth-form">
          <input
            ref={emailRef}
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyPress={(e) => { if (e.key === 'Enter') handleContinue(); }}
            placeholder="name@email.com"
            className="auth-input"
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
                <PasswordToggle />
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
                  <PasswordToggle />
                </div>
              )}
            </>
          )}

          <button onClick={handleContinue} className="auth-cta auth-cta--primary auth-cta--submit" disabled={loading}>
            {loading ? 'Loading...' : showPassword ? (isLoginMode ? 'Log in' : 'Sign up') : 'Continue with email'}
          </button>

          {isLoginMode && showPassword && (
            <button onClick={() => window.location.href = '/forgot-password'} className="auth-link-btn" type="button">
              Forgot password?
            </button>
          )}

          <button onClick={toggleMode} className="auth-toggle" type="button">
            {isLoginMode ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default SignupForm;
