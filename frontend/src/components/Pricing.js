import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import Icons from './Icons';
import { isPaid } from '../utils/plan';
import '../styles/Pricing.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const FREE_FEATURES = [
  { label: 'Generate playlists', detail: '1 per week' },
  { label: 'Chat refinement', detail: null },
  { label: 'Song reactions', detail: null },
  { label: 'My Playlists tab', detail: null },
  { label: 'Top & New Artists', detail: null },
  { label: 'Connect one platform', detail: null },
];

const PAID_FEATURES = [
  { label: 'Everything in Free', detail: 'Unlimited generations' },
  { label: 'Add More Songs', detail: null },
  { label: 'Draft playlists', detail: null },
  { label: 'Import playlists', detail: null },
  { label: 'Search songs & artists', detail: null },
  { label: 'Auto-update playlists', detail: 'Daily, weekly, or monthly' },
  { label: 'Manual refresh', detail: null },
  { label: 'Persistent refinement instructions', detail: null },
  { label: 'Connect Spotify + Apple Music', detail: 'Simultaneously' },
];

const Pricing = () => {
  const navigate = useNavigate();
  const [billingPeriod, setBillingPeriod] = useState('monthly');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const userId = localStorage.getItem('userId');
  const alreadyPaid = isPaid();

  const handleUpgrade = async () => {
    if (!userId) {
      navigate('/');
      return;
    }
    if (alreadyPaid) return;

    setLoading(true);
    setError(null);
    try {
      const { data } = await axios.post(`${API_BASE}/api/stripe/create-checkout-session`, {
        userId,
        billingPeriod,
      });
      window.location.href = data.url;
    } catch (err) {
      setError('Something went wrong. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="pricing-page">
      <button className="pricing-back-btn" onClick={() => navigate(-1)}>
        <Icons.ChevronLeft size={18} /> Back
      </button>

      <div className="pricing-header">
        <h1 className="pricing-title">Simple, honest pricing</h1>
        <p className="pricing-subtitle">Start free. Upgrade when you're ready.</p>

        <div className="pricing-toggle">
          <button
            className={`pricing-toggle-btn ${billingPeriod === 'monthly' ? 'active' : ''}`}
            onClick={() => setBillingPeriod('monthly')}
          >
            Monthly
          </button>
          <button
            className={`pricing-toggle-btn ${billingPeriod === 'annual' ? 'active' : ''}`}
            onClick={() => setBillingPeriod('annual')}
          >
            Annual
            <span className="pricing-save-badge">Save 30%</span>
          </button>
        </div>
      </div>

      <div className="pricing-cards">
        {/* Free Card */}
        <div className="pricing-card">
          <div className="pricing-card-header">
            <h2 className="pricing-plan-name">Free</h2>
            <div className="pricing-price">
              <span className="pricing-amount">$0</span>
              <span className="pricing-period">/month</span>
            </div>
            <p className="pricing-plan-desc">Everything you need to get started</p>
          </div>

          <ul className="pricing-features">
            {FREE_FEATURES.map((f, i) => (
              <li key={i} className="pricing-feature-row">
                <span className="pricing-check">✓</span>
                <span className="pricing-feature-text">
                  {f.label}
                  {f.detail && <span className="pricing-feature-detail"> — {f.detail}</span>}
                </span>
              </li>
            ))}
          </ul>

          <button className="pricing-cta pricing-cta-free" disabled>
            {alreadyPaid ? 'Free Plan' : 'Current Plan'}
          </button>
        </div>

        {/* Pro Card */}
        <div className="pricing-card pricing-card-pro">
          <div className="pricing-pro-badge">Pro</div>
          <div className="pricing-card-header">
            <h2 className="pricing-plan-name">Pro</h2>
            <div className="pricing-price">
              <span className="pricing-amount">
                {billingPeriod === 'annual' ? '$2.08' : '$2.99'}
              </span>
              <span className="pricing-period">/month</span>
            </div>
            <p className="pricing-plan-desc">
              {billingPeriod === 'annual'
                ? 'Billed annually — $24.99/year'
                : 'Billed monthly — cancel anytime'}
            </p>
          </div>

          <ul className="pricing-features">
            {PAID_FEATURES.map((f, i) => (
              <li key={i} className="pricing-feature-row">
                <span className="pricing-check pricing-check-pro">✓</span>
                <span className="pricing-feature-text">
                  {f.label}
                  {f.detail && <span className="pricing-feature-detail"> — {f.detail}</span>}
                </span>
              </li>
            ))}
          </ul>

          {error && <p className="pricing-error">{error}</p>}

          <button
            className="pricing-cta pricing-cta-pro"
            onClick={handleUpgrade}
            disabled={loading || alreadyPaid}
          >
            {alreadyPaid ? 'Current Plan' : loading ? 'Loading…' : `Get Pro — ${billingPeriod === 'annual' ? '$24.99/yr' : '$2.99/mo'}`}
          </button>
        </div>
      </div>

      <p className="pricing-footer-note">
        Secure payments via Stripe · Cancel anytime · No hidden fees
      </p>
    </div>
  );
};

export default Pricing;
