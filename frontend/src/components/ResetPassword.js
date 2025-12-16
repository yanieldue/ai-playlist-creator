import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import axios from 'axios';
import '../styles/SignupForm.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const ResetPassword = () => {
  const [searchParams] = useSearchParams();
  const [token, setToken] = useState('');
  const [email, setEmail] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
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
      const response = await axios.post(`${API_URL}/api/reset-password`, {
        token,
        newPassword
      });

      if (response.data.success) {
        setSuccess(true);
        setTimeout(() => {
          navigate('/login');
        }, 3000);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to reset password');
      setVerifying(false);
    }
  };

  if (loading) {
    return (
      <div className="signup-container">
        <div className="signup-card">
          <div className="signup-header">
            <h1>Verifying...</h1>
            <p className="signup-subtitle">Please wait while we verify your reset link.</p>
          </div>
        </div>
      </div>
    );
  }

  if (success) {
    return (
      <div className="signup-container">
        <div className="signup-card">
          <div className="signup-header">
            <h1>Password Reset Successfully</h1>
            <p className="signup-subtitle">
              Your password has been reset. Redirecting to login...
            </p>
          </div>
        </div>
      </div>
    );
  }

  if (error && !email) {
    return (
      <div className="signup-container">
        <div className="signup-card">
          <div className="signup-header">
            <h1>Invalid Link</h1>
            <p className="signup-subtitle">{error}</p>
          </div>

          <div className="form-footer">
            <button
              type="button"
              className="link-button"
              onClick={() => navigate('/forgot-password')}
            >
              Request New Reset Link
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="signup-container">
      <div className="signup-card">
        <div className="signup-header">
          <h1>Set New Password</h1>
          <p className="signup-subtitle">Enter your new password for {email}</p>
        </div>

        <form onSubmit={handleSubmit} className="signup-form">
          {error && <div className="error-message">{error}</div>}

          <div className="form-group">
            <label htmlFor="newPassword">New Password</label>
            <input
              id="newPassword"
              type="password"
              value={newPassword}
              onChange={(e) => setNewPassword(e.target.value)}
              placeholder="Enter new password"
              required
              disabled={verifying}
              minLength={6}
            />
          </div>

          <div className="form-group">
            <label htmlFor="confirmPassword">Confirm Password</label>
            <input
              id="confirmPassword"
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              placeholder="Confirm new password"
              required
              disabled={verifying}
              minLength={6}
            />
          </div>

          <button type="submit" className="submit-button" disabled={verifying}>
            {verifying ? 'Resetting...' : 'Reset Password'}
          </button>
        </form>
      </div>
    </div>
  );
};

export default ResetPassword;
