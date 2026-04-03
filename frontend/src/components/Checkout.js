import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { EmbeddedCheckoutProvider, EmbeddedCheckout } from '@stripe/react-stripe-js';
import axios from 'axios';
import Icons from './Icons';
import mp from '../utils/mixpanel';
import '../styles/Checkout.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

let stripePromise = null;
const getStripe = async () => {
  if (!stripePromise) {
    const { data } = await axios.get(`${API_BASE}/api/stripe/config`);
    stripePromise = loadStripe(data.publishableKey);
  }
  return stripePromise;
};

const Checkout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { billingPeriod = 'monthly', trial = false } = location.state || {};

  const [stripeInstance, setStripeInstance] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const userId = localStorage.getItem('userId');

  const fetchClientSecret = useCallback(async () => {
    const { data } = await axios.post(`${API_BASE}/api/stripe/create-subscription`, {
      userId,
      billingPeriod,
      trial,
    });
    return data.clientSecret;
  }, [userId, billingPeriod, trial]);

  useEffect(() => {
    if (!userId) {
      navigate('/');
      return;
    }

    getStripe().then(stripe => {
      setStripeInstance(stripe);
      setLoading(false);
      mp.track('Checkout Started', { plan: trial ? 'trial' : 'pro', billing_period: billingPeriod });
    }).catch(err => {
      setError('Failed to initialize payment. Please try again.');
      setLoading(false);
    });
  }, [userId, trial, billingPeriod, navigate]);

  if (!location.state) {
    navigate('/pricing');
    return null;
  }

  return (
    <div className="checkout-page">
      <button className="checkout-back-btn" onClick={() => navigate('/pricing')}>
        <Icons.ChevronLeft size={18} /> Back
      </button>

      <div className="checkout-container">
        <div className="checkout-header">
          <h1 className="checkout-title">
            {trial ? 'Start your free trial' : 'Complete your upgrade'}
          </h1>
          <div className="checkout-summary">
            <div className="checkout-plan-name">Pro Plan</div>
            <div className="checkout-plan-price">
              {trial
                ? <>7 days free, then <strong>$24.99/year</strong></>
                : billingPeriod === 'annual'
                  ? <><strong>$24.99</strong>/year</>
                  : <><strong>$2.99</strong>/month</>
              }
            </div>
          </div>
        </div>

        {loading && (
          <div className="checkout-loading">
            <div className="checkout-spinner" />
            <p>Setting up secure payment...</p>
          </div>
        )}

        {error && !loading && (
          <div className="checkout-error-box">
            <p>{error}</p>
            <button onClick={() => navigate('/pricing')} className="checkout-back-link">
              Back to pricing
            </button>
          </div>
        )}

        {!loading && !error && stripeInstance && (
          <div className="checkout-embedded-wrap">
            <EmbeddedCheckoutProvider
              stripe={stripeInstance}
              options={{ fetchClientSecret }}
            >
              <EmbeddedCheckout />
            </EmbeddedCheckoutProvider>
          </div>
        )}

        <p className="checkout-secure-note">
          <Icons.Lock size={13} /> Your payment info is encrypted and secure
        </p>
      </div>
    </div>
  );
};

export default Checkout;
