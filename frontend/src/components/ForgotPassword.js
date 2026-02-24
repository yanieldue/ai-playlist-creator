import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import Icons from './Icons';
import '../styles/SignupForm.css';

const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const ForgotPassword = () => {
  const [email, setEmail] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState(false);
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await axios.post(`${API_URL}/api/forgot-password`, { email });
      if (response.data.success) {
        setSuccess(true);
      }
    } catch (err) {
      setError(err.response?.data?.error || 'Failed to send password reset email');
      setLoading(false);
    }
  };

  if (success) {
    return (
      <div className="auth-container">
        <div className="auth-card">
          <div className="auth-logo">
            <Icons.Music size={28} />
          </div>
          <h1 className="auth-title">Check your email</h1>
          <p className="auth-subtitle">
            If an account exists for {email}, you'll receive a reset link shortly.
          </p>
          <div className="auth-form">
            <button className="auth-cta" onClick={() => navigate('/login')}>
              Back to login
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
        <h1 className="auth-title">Reset password</h1>
        <p className="auth-subtitle">
          Enter your email and we'll send you a link to reset your password.
        </p>

        {error && <div className="auth-error">{error}</div>}

        <form onSubmit={handleSubmit} className="auth-form">
          <input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="name@email.com"
            className="auth-input"
            required
            disabled={loading}
            autoFocus
          />
          <button type="submit" className="auth-cta" disabled={loading}>
            {loading ? 'Sending...' : 'Send reset link'}
          </button>
          <button
            type="button"
            className="auth-toggle"
            onClick={() => navigate('/login')}
          >
            Back to login
          </button>
        </form>
      </div>
    </div>
  );
};

export default ForgotPassword;
