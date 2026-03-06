import React, { useState } from 'react';
import '../styles/Feedback.css';

const Feedback = ({ onBack, userId }) => {
  const [rating, setRating] = useState(0);
  const [hoverRating, setHoverRating] = useState(0);
  const [message, setMessage] = useState('');
  const [submitted, setSubmitted] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async () => {
    if (!message.trim() && rating === 0) {
      setError('Please add a message or rating before submitting.');
      return;
    }
    setError('');
    setLoading(true);
    try {
      const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';
      const res = await fetch(`${API_BASE}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: userId || localStorage.getItem('userId'),
          email: localStorage.getItem('userEmail'),
          rating,
          message,
        }),
      });
      if (!res.ok) throw new Error('Failed to send');
      setSubmitted(true);
    } catch (e) {
      setError('Something went wrong. Please try again.');
    } finally {
      setLoading(false);
    }
  };

  if (submitted) {
    return (
      <div className="feedback-page">
        <div className="feedback-header">
          <button className="feedback-back-btn" onClick={onBack}>
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M19 12H5M12 5l-7 7 7 7"/>
            </svg>
          </button>
          <h1>Feedback</h1>
          <div style={{ width: 36 }} />
        </div>
        <div className="feedback-success">
          <div className="feedback-success-illustration">
            <svg viewBox="0 0 120 120" width="120" height="120" fill="none">
              <circle cx="60" cy="60" r="56" fill="#f0fdf4" stroke="#86efac" strokeWidth="2"/>
              <path d="M36 62l16 16 32-32" stroke="#22c55e" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/>
            </svg>
          </div>
          <h2>Thank You!</h2>
          <p>Your feedback helps us make Fins better for everyone.</p>
          <button className="feedback-submit-btn" onClick={onBack}>Back to Home</button>
        </div>
      </div>
    );
  }

  return (
    <div className="feedback-page">
      <div className="feedback-header">
        <button className="feedback-back-btn" onClick={onBack}>
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <path d="M19 12H5M12 5l-7 7 7 7"/>
          </svg>
        </button>
        <h1>Feedback</h1>
        <div style={{ width: 36 }} />
      </div>

      <div className="feedback-content">
        <h2 className="feedback-title">How are we doing?</h2>
        <p className="feedback-subtitle">Your thoughts help us improve Fins for everyone.</p>

        <div className="feedback-stars">
          {[1, 2, 3, 4, 5].map((star) => (
            <button
              key={star}
              className={`feedback-star ${(hoverRating || rating) >= star ? 'active' : ''}`}
              onClick={() => setRating(star)}
              onMouseEnter={() => setHoverRating(star)}
              onMouseLeave={() => setHoverRating(0)}
            >
              <svg viewBox="0 0 24 24" width="36" height="36">
                <path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"
                  fill={(hoverRating || rating) >= star ? '#f43f5e' : 'none'}
                  stroke={(hoverRating || rating) >= star ? '#f43f5e' : '#d1d1d6'}
                  strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
              </svg>
            </button>
          ))}
        </div>

        <div className="feedback-textarea-wrapper">
          <textarea
            className="feedback-textarea"
            placeholder="Share your thoughts, suggestions, or report an issue..."
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            maxLength={1000}
          />
          <div className="feedback-char-count">{message.length}/1000</div>
        </div>

        {error && <p className="feedback-error">{error}</p>}

        <button
          className="feedback-submit-btn"
          onClick={handleSubmit}
          disabled={loading}
        >
          {loading ? 'Sending...' : 'Submit Feedback'}
        </button>
      </div>
    </div>
  );
};

export default Feedback;
