import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import axios from 'axios';
import Icons from './Icons';
import { isPaid } from '../utils/plan';
import mp from '../utils/mixpanel';
import '../styles/Pricing.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const FREE_FEATURES = [
  { label: 'Generate playlists', detail: '1 per week — from a prompt or a mix' },
  { label: 'Chat refinement', detail: 'Adjust genre, tempo, or mood via chat' },
  { label: 'Dis/liked songs', detail: 'Like or skip songs to improve future playlists' },
];

const PAID_FEATURES = [
  { label: 'Unlimited generations', detail: 'Create as many playlists as you want' },
  { label: 'Add More Songs', detail: 'Expand any playlist with fresh songs anytime' },
  { label: 'Draft playlists', detail: 'Save unfinished playlists and come back later' },
  { label: 'Import playlists', detail: 'Bring in existing playlists from your platform' },
  { label: 'Auto-update playlists', detail: 'New songs added daily, weekly, or monthly (Spotify only)' },
  { label: 'Manual refresh', detail: 'Refresh a playlist with new songs on demand' },
  { label: 'Saved refinement instructions', detail: 'Your preferences are remembered on every refresh' },
];

const Pricing = ({ isOnboarding = false, onContinueFree }) => {
  const navigate = useNavigate();
  const [billingPeriod, setBillingPeriod] = useState('monthly');
  // Initialize from cache so the button renders correctly on refresh without waiting for API
  const [trialUsed, setTrialUsed] = useState(() => {
    const cached = localStorage.getItem('trialUsed');
    return cached === null ? true : cached === 'true'; // default hidden until confirmed eligible
  });

  const userId = localStorage.getItem('userId');
  const alreadyPaid = isPaid();
  const showTrial = !alreadyPaid && !trialUsed;

  useEffect(() => {
    mp.track('Pricing Page Viewed');
    if (!userId || alreadyPaid) return;
    const email = userId.includes('@') ? userId : null;
    if (!email) return;
    axios.get(`${API_BASE}/api/account/${encodeURIComponent(email)}`)
      .then(({ data }) => {
        const used = data.trialUsed || false;
        setTrialUsed(used);
        localStorage.setItem('trialUsed', String(used));
      })
      .catch(() => setTrialUsed(true)); // on error, don't show trial
  }, [userId, alreadyPaid]);

  const handleUpgrade = () => {
    if (!userId) { navigate('/'); return; }
    if (alreadyPaid) return;
    mp.track('Upgrade Clicked', { plan: 'pro', billing_period: billingPeriod });
    localStorage.setItem('seenPricingPage', 'true');
    navigate('/checkout', { state: { billingPeriod, trial: false } });
  };

  const handleStartTrial = () => {
    if (!userId) { navigate('/'); return; }
    mp.track('Upgrade Clicked', { plan: 'trial', billing_period: 'annual' });
    localStorage.setItem('seenPricingPage', 'true');
    localStorage.setItem('trialUsed', 'true');
    navigate('/checkout', { state: { billingPeriod: 'annual', trial: true } });
  };

  return (
    <div className="pricing-page">
      {!isOnboarding && (
        <button className="pricing-back-btn" onClick={() => navigate('/')}>
          <Icons.ChevronLeft size={18} /> Back
        </button>
      )}

      <div className="pricing-header">
        <h1 className="pricing-title">Simple, honest pricing</h1>
        <p className="pricing-subtitle">Start free. Upgrade when you're ready.</p>

        <div className="pricing-toggle">
          <button
            className={`pricing-toggle-btn ${billingPeriod === 'monthly' ? 'active' : ''}`}
            onClick={() => { mp.track('Billing Period Toggled', { period: 'monthly' }); setBillingPeriod('monthly'); }}
          >
            Monthly
          </button>
          <button
            className={`pricing-toggle-btn ${billingPeriod === 'annual' ? 'active' : ''}`}
            onClick={() => { mp.track('Billing Period Toggled', { period: 'annual' }); setBillingPeriod('annual'); }}
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
                  {f.detail && <span className="pricing-feature-detail">{f.detail}</span>}
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
                  {f.detail && <span className="pricing-feature-detail">{f.detail}</span>}
                </span>
              </li>
            ))}
          </ul>

          {showTrial && (
            <button
              className="pricing-cta pricing-cta-trial"
              onClick={handleStartTrial}
            >
              Start 7-Day Free Trial
            </button>
          )}

          <button
            className="pricing-cta pricing-cta-pro"
            onClick={handleUpgrade}
            disabled={alreadyPaid}
          >
            {alreadyPaid ? 'Current Plan' : `Get Pro — ${billingPeriod === 'annual' ? '$24.99/yr' : '$2.99/mo'}`}
          </button>

          {showTrial && (
            <p className="pricing-trial-note">7 days free, then $24.99/year. Cancel before trial ends and you won't be charged.</p>
          )}
        </div>
      </div>

      <p className="pricing-footer-note">
        Secure payments · Cancel anytime · No hidden fees
      </p>

      {isOnboarding ? (
        <button className="pricing-skip-btn" onClick={() => { mp.track('Continued with Free'); onContinueFree(); }}>
          Continue with Free
        </button>
      ) : !alreadyPaid && (
        <button className="pricing-skip-btn" onClick={() => navigate('/')}>
          Continue with Free
        </button>
      )}
    </div>
  );
};

export default Pricing;
