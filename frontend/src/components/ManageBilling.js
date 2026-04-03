import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { loadStripe } from '@stripe/stripe-js';
import { Elements, PaymentElement, useStripe, useElements } from '@stripe/react-stripe-js';
import axios from 'axios';
import Icons from './Icons';
import ConfirmModal from './ConfirmModal';
import '../styles/ManageBilling.css';

const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

let stripePromise = null;
const getStripe = async () => {
  if (!stripePromise) {
    const { data } = await axios.get(`${API_BASE}/api/stripe/config`);
    stripePromise = loadStripe(data.publishableKey);
  }
  return stripePromise;
};

const BRAND_ICONS = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'Amex',
  discover: 'Discover',
};

const UpdateCardForm = ({ onSuccess, onCancel }) => {
  const stripe = useStripe();
  const elements = useElements();
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!stripe || !elements) return;

    setProcessing(true);
    setError(null);

    const result = await stripe.confirmSetup({
      elements,
      redirect: 'if_required',
    });

    if (result.error) {
      setError(result.error.message);
      setProcessing(false);
    } else {
      // Attach the new payment method to the subscription
      const userId = localStorage.getItem('userId');
      try {
        await axios.post(`${API_BASE}/api/stripe/confirm-payment-method`, {
          userId,
          setupIntentId: result.setupIntent.id,
        });
        onSuccess();
      } catch (err) {
        setError(err.response?.data?.error || 'Failed to update card');
        setProcessing(false);
      }
    }
  };

  return (
    <form onSubmit={handleSubmit} className="billing-update-card-form">
      <PaymentElement options={{ layout: 'tabs' }} />
      {error && <p className="billing-error">{error}</p>}
      <div className="billing-update-card-actions">
        <button type="button" className="billing-btn-secondary" onClick={onCancel} disabled={processing}>
          Cancel
        </button>
        <button type="submit" className="billing-btn-primary" disabled={!stripe || processing}>
          {processing ? 'Updating...' : 'Update Card'}
        </button>
      </div>
    </form>
  );
};

const ManageBilling = ({ onBack, showToast }) => {
  const navigate = useNavigate();
  const [subscription, setSubscription] = useState(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState(false);
  const [showUpdateCard, setShowUpdateCard] = useState(false);
  const [setupClientSecret, setSetupClientSecret] = useState(null);
  const [stripeInstance, setStripeInstance] = useState(null);
  const [confirmModal, setConfirmModal] = useState(null);

  const toast = showToast || ((message) => alert(message));
  const userId = localStorage.getItem('userId');

  const fetchSubscription = useCallback(async () => {
    if (!userId) return;
    try {
      const { data } = await axios.get(`${API_BASE}/api/stripe/subscription/${encodeURIComponent(userId)}`);
      setSubscription(data.subscription);
    } catch (err) {
      console.error('Failed to fetch subscription:', err);
    } finally {
      setLoading(false);
    }
  }, [userId]);

  useEffect(() => {
    fetchSubscription();
  }, [fetchSubscription]);

  const handleCancel = () => {
    setConfirmModal({
      title: 'Cancel subscription?',
      message: 'You\'ll keep Pro access until the end of your current billing period. You can resume anytime before then.',
      onConfirm: async () => {
        setConfirmModal(null);
        setActionLoading(true);
        try {
          await axios.post(`${API_BASE}/api/stripe/cancel-subscription`, { userId });
          toast('Subscription canceled. You\'ll keep Pro access until the end of your billing period.', 'success');
          await fetchSubscription();
        } catch (err) {
          toast(err.response?.data?.error || 'Failed to cancel. Please try again.', 'error');
        } finally {
          setActionLoading(false);
        }
      },
    });
  };

  const handleResume = async () => {
    setActionLoading(true);
    try {
      await axios.post(`${API_BASE}/api/stripe/resume-subscription`, { userId });
      toast('Subscription resumed!', 'success');
      await fetchSubscription();
    } catch (err) {
      toast(err.response?.data?.error || 'Failed to resume. Please try again.', 'error');
    } finally {
      setActionLoading(false);
    }
  };

  const handleUpdateCard = async () => {
    try {
      const [stripe, { data }] = await Promise.all([
        getStripe(),
        axios.post(`${API_BASE}/api/stripe/update-payment-method`, { userId }),
      ]);
      setStripeInstance(stripe);
      setSetupClientSecret(data.clientSecret);
      setShowUpdateCard(true);
    } catch (err) {
      toast(err.response?.data?.error || 'Failed to start card update.', 'error');
    }
  };

  const handleCardUpdateSuccess = async () => {
    setShowUpdateCard(false);
    setSetupClientSecret(null);
    toast('Payment method updated!', 'success');
    await fetchSubscription();
  };

  const formatDate = (dateStr) => {
    if (!dateStr) return '—';
    return new Date(dateStr).toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });
  };

  const formatAmount = (amount, currency, interval) => {
    if (!amount) return '—';
    const dollars = (amount / 100).toFixed(2);
    const sym = currency === 'usd' ? '$' : currency.toUpperCase() + ' ';
    return `${sym}${dollars}/${interval === 'year' ? 'year' : 'month'}`;
  };

  const isDark = document.documentElement.classList.contains('dark-mode');

  const elementsOptions = setupClientSecret ? {
    clientSecret: setupClientSecret,
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
      },
    },
  } : {};

  const goBack = () => {
    if (onBack) {
      onBack();
    } else {
      navigate('/account');
    }
  };

  return (
    <div className="billing-page">
      <ConfirmModal
        isOpen={!!confirmModal}
        title={confirmModal?.title}
        message={confirmModal?.message}
        confirmLabel="Cancel Subscription"
        onConfirm={confirmModal?.onConfirm}
        onCancel={() => setConfirmModal(null)}
      />

      <div className="billing-header">
        <button className="billing-back-btn" onClick={goBack}>
          <Icons.ChevronLeft size={18} /> Back
        </button>
        <h1 className="billing-title">Manage Billing</h1>
      </div>

      <div className="billing-container">
        {loading ? (
          <div className="billing-loading">
            <div className="billing-spinner" />
          </div>
        ) : !subscription ? (
          <div className="billing-empty">
            <p>No active subscription found.</p>
            <button className="billing-btn-primary" onClick={() => navigate('/pricing')}>
              View Plans
            </button>
          </div>
        ) : (
          <>
            {/* Plan section */}
            <div className="billing-section">
              <div className="billing-section-header">
                <h2>Your Plan</h2>
                {subscription.status === 'trialing' && (
                  <span className="billing-badge billing-badge-trial">Trial</span>
                )}
                {subscription.status === 'active' && !subscription.cancelAtPeriodEnd && (
                  <span className="billing-badge billing-badge-active">Active</span>
                )}
                {subscription.cancelAtPeriodEnd && (
                  <span className="billing-badge billing-badge-canceling">Canceling</span>
                )}
              </div>

              <div className="billing-plan-details">
                <div className="billing-detail-row">
                  <span className="billing-detail-label">Plan</span>
                  <span className="billing-detail-value">
                    Pro — {formatAmount(subscription.plan.amount, subscription.plan.currency, subscription.plan.interval)}
                  </span>
                </div>

                {subscription.status === 'trialing' && subscription.trialEnd && (
                  <div className="billing-detail-row">
                    <span className="billing-detail-label">Trial ends</span>
                    <span className="billing-detail-value">{formatDate(subscription.trialEnd)}</span>
                  </div>
                )}

                <div className="billing-detail-row">
                  <span className="billing-detail-label">
                    {subscription.cancelAtPeriodEnd ? 'Access until' : 'Next billing date'}
                  </span>
                  <span className="billing-detail-value">{formatDate(subscription.currentPeriodEnd)}</span>
                </div>
              </div>

              {subscription.cancelAtPeriodEnd ? (
                <button
                  className="billing-btn-primary"
                  onClick={handleResume}
                  disabled={actionLoading}
                >
                  {actionLoading ? 'Resuming...' : 'Resume Subscription'}
                </button>
              ) : (
                <button
                  className="billing-btn-danger"
                  onClick={handleCancel}
                  disabled={actionLoading}
                >
                  Cancel Subscription
                </button>
              )}
            </div>

            {/* Payment method section */}
            <div className="billing-section">
              <h2>Payment Method</h2>

              {showUpdateCard && stripeInstance && setupClientSecret ? (
                <Elements stripe={stripeInstance} options={elementsOptions}>
                  <UpdateCardForm
                    onSuccess={handleCardUpdateSuccess}
                    onCancel={() => { setShowUpdateCard(false); setSetupClientSecret(null); }}
                  />
                </Elements>
              ) : (
                <>
                  {subscription.paymentMethod ? (
                    <div className="billing-card-info">
                      <div className="billing-card-icon">
                        <Icons.CreditCard size={20} />
                      </div>
                      <div className="billing-card-details">
                        <span className="billing-card-brand">
                          {BRAND_ICONS[subscription.paymentMethod.brand] || subscription.paymentMethod.brand} •••• {subscription.paymentMethod.last4}
                        </span>
                        <span className="billing-card-exp">
                          Expires {String(subscription.paymentMethod.expMonth).padStart(2, '0')}/{subscription.paymentMethod.expYear}
                        </span>
                      </div>
                      <button className="billing-btn-secondary" onClick={handleUpdateCard}>
                        Update
                      </button>
                    </div>
                  ) : (
                    <div className="billing-no-card">
                      <p>No payment method on file</p>
                      <button className="billing-btn-secondary" onClick={handleUpdateCard}>
                        Add Card
                      </button>
                    </div>
                  )}
                </>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
};

export default ManageBilling;
