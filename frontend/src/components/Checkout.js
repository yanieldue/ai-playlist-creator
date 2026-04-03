import React, { useState, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
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

const CheckoutForm = ({ trial, billingPeriod, intentType }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setProcessing(true);
    setError(null);

    const returnUrl = `${window.location.origin}/?payment=success`;

    let result;
    if (intentType === 'setup') {
      result = await stripe.confirmSetup({
        elements,
        confirmParams: { return_url: returnUrl },
      });
    } else {
      result = await stripe.confirmPayment({
        elements,
        confirmParams: { return_url: returnUrl },
      });
    }

    if (result.error) {
      setError(result.error.message);
      setProcessing(false);
      mp.track('Payment Failed', { error: result.error.message });
    } else {
      mp.track('Payment Succeeded', { plan: trial ? 'trial' : 'pro', billing_period: billingPeriod });
    }
  };

  return (
    <form onSubmit={handleSubmit} className="checkout-form">
      <PaymentElement
        options={{
          layout: 'tabs',
        }}
      />
      {error && <p className="checkout-error">{error}</p>}
      <button
        type="submit"
        className="checkout-submit-btn"
        disabled={!stripe || processing}
      >
        {processing
          ? 'Processing...'
          : trial
            ? 'Start Free Trial'
            : `Pay ${billingPeriod === 'annual' ? '$24.99/year' : '$2.99/month'}`
        }
      </button>
      {trial && (
        <p className="checkout-trial-note">
          Your card won't be charged today. After 7 days, your subscription begins at $24.99/year. Cancel anytime.
        </p>
      )}
    </form>
  );
};

const Checkout = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { billingPeriod = 'monthly', trial = false } = location.state || {};

  const [stripeInstance, setStripeInstance] = useState(null);
  const [clientSecret, setClientSecret] = useState(null);
  const [intentType, setIntentType] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const userId = localStorage.getItem('userId');

  useEffect(() => {
    if (!userId) {
      navigate('/');
      return;
    }

    let cancelled = false;

    const init = async () => {
      try {
        const [stripe, { data }] = await Promise.all([
          getStripe(),
          axios.post(`${API_BASE}/api/stripe/create-subscription`, {
            userId,
            billingPeriod,
            trial,
          }),
        ]);

        if (cancelled) return;

        setStripeInstance(stripe);
        setClientSecret(data.clientSecret);
        setIntentType(data.type);
        setLoading(false);

        mp.track('Checkout Started', { plan: trial ? 'trial' : 'pro', billing_period: billingPeriod });
      } catch (err) {
        if (cancelled) return;
        setError(err.response?.data?.error || 'Something went wrong. Please try again.');
        setLoading(false);
      }
    };

    init();
    return () => { cancelled = true; };
  }, [userId, billingPeriod, trial, navigate]);

  if (!location.state) {
    navigate('/pricing');
    return null;
  }

  const isDark = document.documentElement.classList.contains('dark-mode');

  const elementsOptions = clientSecret ? {
    clientSecret,
    appearance: {
      theme: isDark ? 'night' : 'stripe',
      variables: {
        colorPrimary: '#000000',
        colorBackground: isDark ? '#2c2c2e' : '#ffffff',
        colorText: isDark ? '#ffffff' : '#1c1c1e',
        colorDanger: '#ff453a',
        fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Segoe UI", sans-serif',
        borderRadius: '12px',
        spacingUnit: '4px',
      },
      rules: {
        '.Input': {
          border: isDark ? '1px solid #3a3a3c' : '1px solid #e5e5ea',
          boxShadow: 'none',
          padding: '14px 12px',
          fontSize: '16px',
        },
        '.Input:focus': {
          border: isDark ? '1px solid #ffffff' : '1px solid #000000',
          boxShadow: 'none',
        },
        '.Label': {
          fontSize: '14px',
          fontWeight: '500',
          color: isDark ? '#ebebf5cc' : '#3a3a3c',
        },
        '.Tab': {
          border: isDark ? '1px solid #3a3a3c' : '1px solid #e5e5ea',
          boxShadow: 'none',
        },
        '.Tab--selected': {
          border: isDark ? '1px solid #ffffff' : '1px solid #000000',
          boxShadow: 'none',
        },
      },
    },
  } : {};

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

        {!loading && !error && stripeInstance && clientSecret && (
          <Elements stripe={stripeInstance} options={elementsOptions}>
            <CheckoutForm
              trial={trial}
              billingPeriod={billingPeriod}
              intentType={intentType}
            />
          </Elements>
        )}

        <p className="checkout-secure-note">
          <Icons.Lock size={13} /> Your payment info is encrypted and secure
        </p>
      </div>
    </div>
  );
};

export default Checkout;
