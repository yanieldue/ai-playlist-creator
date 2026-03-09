import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import Icons from './Icons';
import '../styles/SignupForm.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const ResetPassword = () => {
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [loading, setLoading] = useState(true);
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    const tokenParam = searchParams.get('token');
    if (!tokenParam) {
      setError('Invalid reset link');
      setLoading(false);
      return;
    }
    setToken(tokenParam);
    verifyToken(tokenParam);
  }, [searchParams]);

  const verifyToken = async (tokenToVerify) => {
    try {
      const response = await axios.get(`${API_URL}/api/verify-reset-token/${tokenToVerify}`);
      if (response.data.success) {
        setEmail(response.data.email);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Invalid or expired reset token');
    } finally {
      setLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');

    if (newPassword !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }
    if (newPassword.length < 6) {
      setError('Password must be at least 6 characters long');
      return;
    }

    setVerifying(true);
    try {
      const response = await axios.post(`${API_URL}/api/reset-password`, { token, newPassword });
      if (response.data.success) {
        setSuccess(true);
        setTimeout(() => navigate('/login'), 3000);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset password');
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-logo">
            <Icons.Music size={28} />
          </div>
          <h1 className="auth-title">Verifying link...</h1>
          <p className="auth-subtitle">Please wait a moment.</p>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-logo">
            <Icons.Music size={28} />
          </div>
          <h1 className="auth-title">Password reset!</h1>
          <p className="auth-subtitle">
            Your password has been updated. Redirecting to login...
          </p>
        </div>
      </div>
    );
  }

  if (error && !email) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-logo">
            <Icons.Music size={28} />
          </div>
          <h1 className="auth-title">Invalid link</h1>
          <p className="auth-subtitle">{error}</p>
          <div className="auth-form">
            <button className="auth-cta" onClick={() => navigate('/forgot-password')}>
              Request new reset link
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="auth-container">
      <div className="auth-card">
        <div className="auth-logo">
          <Icons.Music size={28} />
        </div>
        <h1 className="auth-title">Set new password</h1>
        <p className="auth-subtitle">Choose a new password for {email}</p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <div style={{ position: 'relative' }}>
            <input
              type={showNew ? 'text' : 'password'}
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="New password"
              className="auth-input"
              style={{ paddingRight: 44 }}
              required
              disabled={verifying}
              minLength={6}
              autoFocus
            />
            <button
              type="button"
              onClick={() => setShowNew(v => !v)}
              style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#8e8e93', padding: 0, display: 'flex', alignItems: 'center' }}
              tabIndex={-1}
            >
              {showNew ? <Icons.EyeOff size={18} /> : <Icons.Eye size={18} />}
            </button>
          </div>
          <div style={{ position: 'relative' }}>
            <input
              type={showConfirm ? 'text' : 'password'}
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              className="auth-input"
              style={{ paddingRight: 44 }}
              required
              disabled={verifying}
              minLength={6}
            />
            <button
              type="button"
              onClick={() => setShowConfirm(v => !v)}
              style={{ position: 'absolute', right: 12, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', color: '#8e8e93', padding: 0, display: 'flex', alignItems: 'center' }}
              tabIndex={-1}
            >
              {showConfirm ? <Icons.EyeOff size={18} /> : <Icons.Eye size={18} />}
            </button>
          </div>
          <button type="submit" className="auth-cta" disabled={verifying}>
            {verifying ? 'Resetting...' : 'Reset password'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ResetPassword;
