import React, { useState } from 'react';
import playlistService from '../services/api';
import Icons from './Icons';
import '../styles/SignupForm.css';

const SignupForm = ({ onSignupComplete }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [isLoginMode, setIsLoginMode] = useState(false);

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

      console.log('SignupForm: Set userEmail to:', trimmedEmail);

      // If user has userId, redirect to app, otherwise send to platform selection
      if (data.userId) {
        localStorage.setItem('userId', data.userId);
        // User is already connected, redirect to app
        window.location.href = '/';
      } else {
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

      console.log('Stored in localStorage:', {
        userEmail: localStorage.getItem('userEmail'),
        authToken: localStorage.getItem('authToken'),
        inSignupFlow: localStorage.getItem('inSignupFlow')
      });

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

  const handleSocialLogin = (platform) => {
    setError(`${platform} login coming soon!`);
  };

  return (
    <div className="signup-container-new">
      <div className="signup-card-new">
        <div className="signup-logo">
          <span className="logo-icon"><Icons.Music size={40} /></span>
        </div>

        <h1 className="signup-title">{isLoginMode ? 'Welcome back' : 'Get started with your email'}</h1>

        {error && <div className="signup-error-new">{error}</div>}

        <div className="signup-form">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyPress={(e) => {
              if (e.key === 'Enter') {
                handleContinue();
              }
            }}
            placeholder="name@email.com"
            className="signup-input-new"
            autoFocus
          />

          {!showPassword && (
            <button
              onClick={() => {
                setIsLoginMode(!isLoginMode);
                setError('');
              }}
              className="text-toggle-button"
              type="button"
            >
              {isLoginMode ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
            </button>
          )}

          {showPassword && (
            <>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyPress={(e) => {
                  if (e.key === 'Enter') {
                    handleContinue();
                  }
                }}
                placeholder={isLoginMode ? 'Enter your password' : 'Create a password'}
                className="signup-input-new"
                autoFocus
              />

              {!isLoginMode && (
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  onKeyPress={(e) => {
                    if (e.key === 'Enter') {
                      handleContinue();
                    }
                  }}
                  placeholder="Confirm your password"
                  className="signup-input-new"
                />
              )}

              <button
                onClick={() => {
                  setIsLoginMode(!isLoginMode);
                  setError('');
                  setConfirmPassword('');
                }}
                className="text-toggle-button"
                type="button"
              >
                {isLoginMode ? "Don't have an account? Sign up" : 'Already have an account? Log in'}
              </button>
            </>
          )}

          <button
            onClick={handleContinue}
            className="signup-button-new"
            disabled={loading}
          >
            {loading ? 'Loading...' : (isLoginMode ? 'Log In' : 'Sign Up')}
          </button>

          <div className="divider">
            <span>or</span>
          </div>

          <button
            onClick={() => handleSocialLogin('Google')}
            className="social-button google-button"
            disabled={loading}
          >
            <svg className="social-icon" viewBox="0 0 24 24" width="20" height="20">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/>
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
            </svg>
            Continue with Google
          </button>

          <button
            onClick={() => handleSocialLogin('Facebook')}
            className="social-button facebook-button"
            disabled={loading}
          >
            <svg className="social-icon" viewBox="0 0 24 24" width="20" height="20" fill="#1877F2">
              <path d="M24 12.073c0-6.627-5.373-12-12-12s-12 5.373-12 12c0 5.99 4.388 10.954 10.125 11.854v-8.385H7.078v-3.47h3.047V9.43c0-3.007 1.792-4.669 4.533-4.669 1.312 0 2.686.235 2.686.235v2.953H15.83c-1.491 0-1.956.925-1.956 1.874v2.25h3.328l-.532 3.47h-2.796v8.385C19.612 23.027 24 18.062 24 12.073z"/>
            </svg>
            Continue with Facebook
          </button>
        </div>

        <div className="signup-footer">
          <p>
            By continuing, you agree to our <a href="#terms" className="footer-link">Terms of Use</a> and acknowledge that you have read our <a href="#privacy" className="footer-link">Privacy Policy</a>.
          </p>
        </div>
      </div>
    </div>
  );
};

export default SignupForm;
