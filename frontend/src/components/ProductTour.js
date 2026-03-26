import React, { useState, useEffect } from 'react';
import '../styles/ProductTour.css';
import Icons from './Icons';
import mp from '../utils/mixpanel';

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
const HARDCODED_ARTIST_IMAGES = {
  'Kendrick Lamar': '/tour-artist-kendrick.jpg',
  'SZA': '/tour-artist-sza.jpg',
  'Drake': '/tour-artist-drake.jpg',
  'Rihanna': '/tour-artist-rihanna.jpg',
};
const API_BASE = process.env.REACT_APP_API_URL || 'http://localhost:3001';

const ArtistsDiagram = ({ artistImages = {} }) => (
  <div className="tour-diagram">
    <div style={{ padding: '12px', overflowX: 'hidden' }}>
      <div className="tour-diag-highlight" style={{ borderRadius: 12, display: 'flex', gap: 10, padding: '8px', overflow: 'hidden' }}>
        {DIAGRAM_ARTIST_NAMES.map(name => (
          <div key={name} className="artist-card-apple" style={{ flex: '1 1 0', minWidth: 0, cursor: 'default' }}>
            <div className="artist-card-image" style={{ width: 70, height: 70, borderRadius: 8, background: '#d1d1d6', overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              {artistImages[name]
                ? <img src={artistImages[name]} alt={name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
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

const PLAYLIST_COVER_ARTISTS = ['Kendrick Lamar', 'SZA', 'Drake', 'Rihanna'];

const PlaylistCover = ({ img, size = 36 }) => (
  <div style={{ width: size, height: size, borderRadius: 6, background: '#d1d1d6', flexShrink: 0, overflow: 'hidden', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
    {img && <img src={img} alt="" style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
  </div>
);

const NavTabsDiagram = ({ artistImages = {} }) => (
  <div className="tour-diagram">
    <div style={{ padding: '12px 12px 8px' }}>
      <div style={{ display: 'flex', justifyContent: 'center', gap: 8, marginBottom: 12 }}>
        <button className="nav-tab-item" style={{ pointerEvents: 'none', fontSize: 13 }}>Home</button>
        <button className="nav-tab-item active tour-diag-highlight" style={{ pointerEvents: 'none', fontSize: 13, borderRadius: 8, padding: '4px 12px' }}>My Playlists</button>
      </div>
      {[['Kendrick Lamar', 'Summer Vibes'], ['SZA', 'Late Night Mix']].map(([artist, name], i) => (
        <div key={i} className="playlist-card" style={{ marginBottom: 8, padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
          <PlaylistCover img={artistImages[artist]} />
          <div>
            <div style={{ fontSize: 12, fontWeight: 600 }}>{name}</div>
            <div style={{ fontSize: 11, color: '#8e8e93' }}>20 songs</div>
          </div>
        </div>
      ))}
    </div>
  </div>
);

const ImportDiagram = ({ artistImages = {} }) => (
  <div className="tour-diagram">
    <div style={{ padding: '12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <span style={{ fontSize: 15, fontWeight: 700 }}>My Playlists</span>
        <button className="import-button tour-diag-highlight" style={{ pointerEvents: 'none', fontSize: 12, padding: '7px 14px' }}>
          Import
        </button>
      </div>
      <div className="playlist-card" style={{ padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10 }}>
        <PlaylistCover img={artistImages['Drake']} />
        <div>
          <div style={{ fontSize: 12, fontWeight: 600 }}>Rap Favorites</div>
          <div style={{ fontSize: 11, color: '#8e8e93' }}>24 songs</div>
        </div>
      </div>
    </div>
  </div>
);

const EditDiagram = ({ artistImages = {} }) => (
  <div className="tour-diagram">
    <div style={{ padding: '12px' }}>
      <div className="playlist-card" style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <PlaylistCover img={artistImages['Rihanna']} size={40} />
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

const DIAGRAM_TRACKS = [
  { name: 'Blinding Lights', artist: 'The Weeknd', highlight: false },
  { name: 'Levitating', artist: 'Dua Lipa', highlight: true },
];

const LikeDislikeDiagram = ({ trackImages = {} }) => (
  <div className="tour-diagram">
    <div style={{ padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6 }}>
      {DIAGRAM_TRACKS.map(track => {
        const key = `${track.name}|${track.artist}`;
        return (
          <div key={track.name} className="tour-diag-track-row" style={{ borderRadius: 8, padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ width: 36, height: 36, borderRadius: 4, background: '#d1d1d6', flexShrink: 0, overflow: 'hidden' }}>
              {trackImages[key] && <img src={trackImages[key]} alt={track.name} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />}
            </div>
            <div className="track-info" style={{ flex: 1, minWidth: 0 }}>
              <div className="track-name" style={{ fontSize: 12 }}>{track.name}</div>
              <div className="track-artist" style={{ fontSize: 11 }}>{track.artist}</div>
            </div>
            <div className={track.highlight ? 'tour-diag-highlight' : ''} style={{ display: 'flex', gap: 6, borderRadius: 8, padding: '2px 4px' }}>
              <button className="track-reaction-button" style={{ pointerEvents: 'none' }}><Icons.Heart size={14} /></button>
              <button className="track-reaction-button" style={{ pointerEvents: 'none' }}><Icons.Close size={14} /></button>
            </div>
          </div>
        );
      })}
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
    title: 'Generate from a Prompt',
    description: "Describe what you want in natural language. Try artist names, genres, energy level, or time periods. For example: '30 upbeat pop songs by Taylor Swift and Dua Lipa from 2010 to 2020'.",
    diagram: <ChatInputDiagram />,
  },
  {
    emoji: null,
    title: 'Create from a Mix',
    description: "Paste a YouTube DJ mix URL and Fins will pull the tracklist from the description or comments and find every song on your music platform. Great for discovering what was in a mix you loved.",
    diagram: null,
  },
  {
    emoji: null,
    title: 'Create from an Artist',
    description: "Your Top Artists shows your most-played artists. Artists You Should Explore surfaces ones you haven't listened to in a while or haven't tried yet. Tap any artist to instantly generate a playlist of songs that match their style.",
    diagram: null,
    diagramComponent: ArtistsDiagram,
  },
  {
    emoji: null,
    title: 'My Playlists',
    description: 'View all your created playlists in one place. Tap the My Playlists tab to see your full collection, edit settings, or refine further.',
    diagram: null,
    diagramComponent: NavTabsDiagram,
  },
  {
    emoji: null,
    title: 'Import Your Playlists',
    description: 'Already have playlists on Spotify or Apple Music? Tap Import to bring them into Fins and manage them with refinements and auto-updates.',
    diagram: null,
    diagramComponent: ImportDiagram,
  },
  {
    emoji: null,
    title: 'Like or Dislike Songs',
    description: 'Thumbs up gets you more songs like that one. Thumbs down removes it and avoids similar songs in future updates.',
    diagram: null,
    diagramComponent: LikeDislikeDiagram,
  },
  {
    emoji: null,
    title: 'Edit and Lock Songs',
    description: 'Click Edit Playlist to manage your playlist. Lock any song to keep it from being removed during refreshes. Unlock it anytime to let it rotate out naturally.',
    diagram: null,
    diagramComponent: EditDiagram,
  },
  {
    emoji: null,
    title: 'Refine Your Playlists',
    description: 'Add instructions to shape your playlist. Change genres, adjust tempo, shift the mood, and more. Refinements carry over to future auto-updates.',
    diagram: <RefineDiagram />,
  },
  {
    emoji: null,
    title: 'Auto-Refresh and Manual Refresh',
    description: 'Keep playlists fresh automatically. Choose daily, weekly, or monthly updates at 5 AM in your local timezone. Or use Update Now to add new songs right now.',
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

const DIAGRAM_TRACK_KEYS = DIAGRAM_TRACKS.map(t => `${t.name}|${t.artist}`);

const ProductTour = ({ isOpen, onClose, onComplete }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [artistImages, setArtistImages] = useState({});
  const [trackImages, setTrackImages] = useState({});

  useEffect(() => {
    if (isOpen) {
      setCurrentStep(0);
      mp.track('Product Tour Started');
      document.body.style.overflow = 'hidden';
      setArtistImages(HARDCODED_ARTIST_IMAGES);
      fetch(`${API_BASE}/api/track-images?tracks=${encodeURIComponent(DIAGRAM_TRACK_KEYS.join(','))}`)
        .then(r => r.json())
        .then(data => setTrackImages(data.images || {}))
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
      mp.track('Product Tour Completed', { steps_viewed: currentStep + 1 });
      if (onComplete) onComplete();
      onClose();
    } else {
      mp.track('Tour Step Viewed', { step: currentStep + 1, total_steps: STEPS.length });
      setCurrentStep(s => s + 1);
    }
  };

  return (
    <>
      <div className="product-tour-overlay" onClick={() => { mp.track('Product Tour Skipped', { step: currentStep, total_steps: STEPS.length }); onClose(); }} style={{ pointerEvents: 'auto', background: 'rgba(0,0,0,0.5)' }} />
      <div className="product-tour-tooltip center">
        <div className="product-tour-header">
          <h3>{step.title}</h3>
          <button className="tour-close-button" onClick={() => { mp.track('Product Tour Skipped', { step: currentStep, total_steps: STEPS.length }); onClose(); }}>×</button>
        </div>

        <div className="product-tour-body">
          {step.emoji && (
            <div style={{ fontSize: 48, textAlign: 'center', marginBottom: 16 }}>{step.emoji}</div>
          )}
          {step.diagramComponent ? <step.diagramComponent artistImages={artistImages} trackImages={trackImages} /> : step.diagram}
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
