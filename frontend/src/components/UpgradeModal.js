import React from 'react';
import { useNavigate } from 'react-router-dom';
import Icons from './Icons';
import '../styles/UpgradeModal.css';

const FEATURE_DESCRIPTIONS = {
  'Add More Songs': 'Keep adding songs to any generated playlist to make it as long as you want.',
  'Draft Playlists': 'Your unfinished playlists are saved automatically so you can come back and finish them anytime.',
  'Import Playlists': 'Import your existing Spotify or Apple Music playlists into the app to manage and auto-update them.',
  'Search': 'Search for any song or artist to use as inspiration when building your playlists.',
  'Auto-Update': 'Schedule your playlists to refresh automatically — daily, weekly, or monthly — with fresh tracks.',
  'Manual Refresh': 'Refresh any saved playlist on demand to get a new batch of songs whenever you want.',
  'Refinement Instructions': 'Save permanent instructions (e.g. "always avoid breakup songs") that apply to every future update.',
  'Dual Platform': 'Connect both Spotify and Apple Music at the same time to manage playlists across both services.',
};

const PAID_BENEFITS = [
  'Add more songs to any playlist',
  'Auto-update playlists daily, weekly, or monthly',
  'Manual refresh on demand',
  'Save and resume draft playlists',
  'Import your existing playlists',
  'Persistent refinement instructions',
  'Connect Spotify + Apple Music simultaneously',
  'Search songs and artists',
];

export default function UpgradeModal({ isOpen, onClose, featureName }) {
  const navigate = useNavigate();
  if (!isOpen) return null;

  const handleUpgradeClick = () => {
    onClose();
    navigate('/pricing');
  };

  return (
    <div className="upgrade-overlay" onClick={onClose}>
      <div className="upgrade-modal" onClick={e => e.stopPropagation()}>
        <button className="upgrade-close" onClick={onClose} aria-label="Close">✕</button>

        <div className="upgrade-lock-icon"><Icons.Lock size={40} /></div>

        <h2 className="upgrade-title">Paid Feature</h2>
        <p className="upgrade-feature-name">{featureName}</p>

        {FEATURE_DESCRIPTIONS[featureName] && (
          <p className="upgrade-description">{FEATURE_DESCRIPTIONS[featureName]}</p>
        )}

        <div className="upgrade-divider" />

        <p className="upgrade-benefits-label">Everything in the paid plan:</p>
        <ul className="upgrade-benefits">
          {PAID_BENEFITS.map(benefit => (
            <li key={benefit}>
              <span className="upgrade-check">✓</span>
              {benefit}
            </li>
          ))}
        </ul>

        <button className="upgrade-cta" onClick={handleUpgradeClick}>
          See Plans
        </button>
      </div>
    </div>
  );
}
