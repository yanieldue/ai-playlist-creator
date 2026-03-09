import React, { useState, useEffect } from 'react';
import '../styles/ProductTour.css';
import Icons from './Icons';

// ── Diagram components (use real app CSS classes) ─────────────────────────────

const ChatInputDiagram = () => (
  <div className="tour-diagram">
    <div style={{ padding: '12px', background: 'transparent' }}>
      <div className="tour-diag-highlight" style={{ borderRadius: 20 }}>
        <div className="chat-input-wrapper" style={{ position: 'relative', margin: 0 }}>
          <input
            type="text"
            className="chat-input"
            placeholder="Create playlist for..."
            readOnly
            style={{ pointerEvents: 'none' }}
          />
          <button className="chat-send-button" style={{ pointerEvents: 'none' }}>
            <svg viewBox="0 0 24 24" style={{ pointerEvents: 'none' }}>
              <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
            </svg>
          </button>
        </div>
      </div>
    </div>
  </div>
);

const DIAGRAM_ARTIST_NAMES = ['Kendrick Lamar', 'SZA', 'Drake', 'Rihanna'];
const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const ArtistsDiagram = ({ images = {} }) => (
  <div className="tour-diagram">
    <div style={{ padding: '12px', overflowX: 'hidden' }}>
      <div className="tour-diag-highlight" style={{ borderRadius: 12, display: 'flex', gap: 10, padding: '8px' }}>
        {DIAGRAM_ARTIST_NAMES.map(name => (
          <div key={name} className="artist-card-apple" style={{ width: 70, minWidth: 70, cursor: 'default' }}>
            <div className="artist-card-image" style={{ width: 70, height: 70, borderRadius: 8, background: '#d1d1d6', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {images[name]
                ? <img src={images[name]} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
                : <Icons.Microphone size={22} color="#636366" />
              }
            </div>
            <div className="artist-card-name" style={{ fontSize: 10, marginTop: 4 }}>{name.split(' ')[0]}</div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

const NavTabsDiagram = () => (
  <div className="tour-diagram">
    <div style={{ padding: '12px 12px 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
        <button className="nav-tab-item" style={{ pointerEvents: 'none', fontSize: 13 }}>Home</button>
        <button className="nav-tab-item active tour-diag-highlight" style={{ pointerEvents: 'none', fontSize: 13, borderRadius: 8, padding: '4px 12px' }}>My Playlists</button>
      </div>
      {[1, 2].map(i => (
        <div key={i} className="playlist-card" style={{ marginBottom: 8, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 36, height: 36, borderRadius: 6, background: '#d1d1d6', flexShrink: 0 }} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>My Playlist {i}</div>
            <div style={{ fontSize: 11, color: '#8e8e93' }}>20 songs</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const ImportDiagram = () => (
  <div className="tour-diagram">
    <div style={{ padding: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>My Playlists</span>
        <button className="import-button tour-diag-highlight" style={{ pointerEvents: 'none', fontSize: 12, padding: '7px 14px' }}>
          Import
        </button>
      </div>
      <div className="playlist-card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ width: 36, height: 36, borderRadius: 6, background: '#d1d1d6', flexShrink: 0 }} />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>My Playlist</div>
          <div style={{ fontSize: 11, color: '#8e8e93' }}>24 songs</div>
        </div>
      </div>
    </div>
  </div>
);

const EditDiagram = () => (
  <div className="tour-diagram">
    <div style={{ padding: '12px' }}>
      <div className="playlist-card" style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ width: 40, height: 40, borderRadius: 6, background: '#d1d1d6', flexShrink: 0 }} />
          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>Summer Vibes</div>
            <div style={{ fontSize: 11, color: '#8e8e93' }}>30 songs</div>
          </div>
        </div>
        <button
          className="edit-button tour-diag-highlight"
          style={{ pointerEvents: 'none', fontSize: 12 }}
        >
          Edit Playlist
        </button>
      </div>
    </div>
  </div>
);

const LikeDislikeDiagram = () => (
  <div className="tour-diagram">
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {[
        { name: 'Blinding Lights', artist: 'The Weeknd', highlight: false },
        { name: 'Levitating', artist: 'Dua Lipa', highlight: true },
      ].map(track => (
        <div key={track.name} className="track-item" style={{ background: 'var(--bg-secondary, #f2f2f7)', borderRadius: 8, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <div style={{ width: 36, height: 36, borderRadius: 4, background: '#d1d1d6', flexShrink: 0 }} />
          <div className="track-info" style={{ flex: 1, minWidth: 0 }}>
            <div className="track-name" style={{ fontSize: 12 }}>{track.name}</div>
            <div className="track-artist" style={{ fontSize: 11 }}>{track.artist}</div>
          </div>
          <div className={track.highlight ? 'tour-diag-highlight' : ''} style={{ display: 'flex', gap: 6, borderRadius: 8, padding: '2px 4px' }}>
            <button className="track-reaction-button" style={{ pointerEvents: 'none' }}><Icons.ThumbsUp size={14} /></button>
            <button className="track-reaction-button" style={{ pointerEvents: 'none' }}><Icons.ThumbsDown size={14} /></button>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const RefineDiagram = () => (
  <div className="tour-diagram">
    <div style={{ padding: '12px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: '#8e8e93', textTransform: 'uppercase', letterSpacing: 0.5, marginBottom: 8 }}>
        Refinement Instructions
      </div>
      <div className="tour-diag-highlight" style={{ borderRadius: 12 }}>
        <div className="chat-input-wrapper" style={{ position: 'relative', margin: 0 }}>
          <input
            type="text"
            className="chat-input"
            placeholder="e.g. More upbeat, no ballads…"
            readOnly
            style={{ pointerEvents: 'none' }}
          />
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
        {['More energy', 'No rap', 'Add R&B'].map(tag => (
          <div key={tag} style={{ fontSize: 11, padding: '3px 10px', background: '#e5e5ea', borderRadius: 12, color: '#636366' }}>{tag}</div>
        ))}
      </div>
    </div>
  </div>
);

const AutoRefreshDiagram = () => (
  <div className="tour-diagram">
    <div style={{ padding: '12px' }}>
      <div className="form-group" style={{ marginBottom: 10 }}>
        <label style={{ fontSize: 12 }}>Auto-Update Frequency</label>
        <div className="option-items-grid tour-diag-highlight" style={{ borderRadius: 10, marginTop: 6 }}>
          {['Never', 'Daily', 'Weekly', 'Monthly'].map((label, i) => (
            <div key={label} className={`refresh-option-item option-item-compact${i === 1 ? ' active' : ''}`} style={{ pointerEvents: 'none', fontSize: 12 }}>
              <div className="option-checkbox">
                {i === 1 && <span className="checkmark" style={{ fontSize: 12 }}>✓</span>}
              </div>
              <span className="option-label">{label}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  </div>
);

// ── Steps ─────────────────────────────────────────────────────────────────────

const STEPS = [
  {
    emoji: '👋',
    title: 'Welcome to Fins!',
    description: "Let's take a quick tour to help you get started. We'll show you everything you need to create amazing playlists.",
    diagram: null,
  },
  {
    emoji: null,
    title: 'Generate Playlists',
    description: "Type what you want in natural language — artist names, genres, energy level, or time periods. Try: '30 upbeat pop songs by Taylor Swift and Dua Lipa from 2010–2020'.",
    diagram: <ChatInputDiagram />,
  },
  {
    emoji: null,
    title: 'Discover Artists',
    description: "Your Top Artists shows your most-played artists. Artists You Should Explore surfaces ones you haven't heard before and ones you haven't heard in a while. Tap any tile to instantly generate a playlist.",
    diagram: null,
    diagramComponent: ArtistsDiagram,
  },
  {
    emoji: null,
    title: 'My Playlists',
    description: 'View all your created playlists in one place. Tap the My Playlists tab to see your full collection, edit settings, or refine further.',
    diagram: <NavTabsDiagram />,
  },
  {
    emoji: null,
    title: 'Import Your Playlists',
    description: 'Already have playlists on Spotify or Apple Music? Tap Import to bring them into Fins and manage them with personalized refinements and auto-updates.',
    diagram: <ImportDiagram />,
  },
  {
    emoji: null,
    title: 'Like or Dislike Songs',
    description: 'Thumbs up gets you more songs like that one. Thumbs down removes it and avoids similar tracks in future updates.',
    diagram: <LikeDislikeDiagram />,
  },
  {
    emoji: null,
    title: 'Edit Your Playlists',
    description: 'Click Edit Playlist to access settings, add refinement instructions, manually refresh with new songs, and manage auto-update scheduling.',
    diagram: <EditDiagram />,
  },
  {
    emoji: null,
    title: 'Refine Your Playlists',
    description: 'Add instructions to shape your playlist — change genres, adjust tempo, shift the mood, and more. Refinements carry over to future auto-updates.',
    diagram: <RefineDiagram />,
  },
  {
    emoji: null,
    title: 'Auto-Refresh & Manual Refresh',
    description: 'Keep playlists fresh automatically — choose daily, weekly, or monthly updates at 5 AM in your local timezone. Or use Manual Refresh to add new songs right now.',
    diagram: <AutoRefreshDiagram />,
  },
  {
    emoji: '🚀',
    title: "You're All Set!",
    description: 'Connect Spotify or Apple Music from the profile menu to sync your playlists. Explore artist discovery, import your existing playlists, and start creating!',
    diagram: null,
  },
];

// ── Component ─────────────────────────────────────────────────────────────────

const ProductTour = ({ isOpen, onClose, onComplete }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [artistImages, setArtistImages] = useState({});

  useEffect(() => {
    if (isOpen) {
      setCurrentStep(0);
      document.body.style.overflow = 'hidden';
      fetch(`${API_BASE}/api/artist-images?names=${DIAGRAM_ARTIST_NAMES.join(',')}`)
        .then(r => r.json())
        .then(data => setArtistImages(data.images || {}))
        .catch(() => {});
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => { document.body.style.overflow = 'unset'; };
  }, [isOpen]);

  if (!isOpen) return null;

  const step = STEPS[currentStep];
  const isLast = currentStep === STEPS.length - 1;
  const isFirst = currentStep === 0;

  const handleNext = () => {
    if (isLast) {
      if (onComplete) onComplete();
      onClose();
    } else {
      setCurrentStep(s => s + 1);
    }
  };

  return (
    <>
      <div className="product-tour-overlay" onClick={onClose} style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.5)' }} />
      <div className="product-tour-tooltip center">
        <div className="product-tour-header">
          <h3>{step.title}</h3>
          <button className="tour-close-button" onClick={onClose}>×</button>
        </div>

        <div className="product-tour-body">
          {step.emoji && (
            <div style={{ fontSize: 48, textAlign: 'center', marginBottom: 16 }}>{step.emoji}</div>
          )}
          {step.diagramComponent ? <step.diagramComponent images={artistImages} /> : step.diagram}
          <p style={{ marginTop: (step.diagram || step.diagramComponent) ? 12 : 0 }}>{step.description}</p>
        </div>

        <div className="product-tour-footer">
          <div className="tour-progress">
            <span>{currentStep + 1} of {STEPS.length}</span>
            <div className="tour-progress-dots">
              {STEPS.map((_, i) => (
                <div
                  key={i}
                  className={`tour-dot ${i === currentStep ? 'active' : i < currentStep ? 'completed' : ''}`}
                  onClick={() => setCurrentStep(i)}
                  style={{ cursor: 'pointer' }}
                />
              ))}
            </div>
          </div>
          <div className="tour-buttons">
            {!isFirst && (
              <button className="tour-button secondary" onClick={() => setCurrentStep(s => s - 1)}>Back</button>
            )}
            <button className="tour-button primary" onClick={handleNext}>
              {isLast ? 'Get Started' : 'Next'}
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

export default ProductTour;
