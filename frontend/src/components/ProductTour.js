import React, { useState, useEffect, useRef } from 'react';
import '../styles/ProductTour.css';

const ProductTour = ({ isOpen, onClose, onComplete, onNavigateHome, onNavigateToPlaylists, currentTab }) => {
  const [currentStep, setCurrentStep] = useState(0);
  const [showDemoPlaylist, setShowDemoPlaylist] = useState(false);
  const [showDemoModal, setShowDemoModal] = useState(false);
  const [isDemoExpanded, setIsDemoExpanded] = useState(false);

  // Refs for demo elements
  const editButtonRef = useRef(null);
  const refineInputRef = useRef(null);
  const autoRefreshRef = useRef(null);

  // Force re-render when refs are attached
  const [, forceRender] = useState(0);

  const steps = [
    {
      title: "Welcome to Playlist Creator!",
      description: "Let's take a quick tour to help you get started. We'll show you how to create amazing playlists.",
      target: null,
      targetRef: null,
      position: "center"
    },
    {
      title: "Generate Playlists",
      description: "Describe the kind of music you want in natural language. Be specific with artist names, genres, energy level, or time periods. For example: '30 upbeat pop songs by Taylor Swift, Dua Lipa, and similar artists from 2010-2020'",
      target: ".chat-input-container-apple",
      targetRef: null,
      position: "top"
    },
    {
      title: "My Playlists",
      description: "View all your created playlists here. Click on any playlist to see its tracks, edit settings, or refine it further.",
      target: ".nav-tab-item:nth-child(2)",
      targetRef: null,
      position: "bottom"
    },
    {
      title: "Edit Your Playlists",
      description: "Click the Edit Playlist button to access settings, refine your playlist, and manage auto-refresh options.",
      target: null,
      targetRef: editButtonRef,
      position: "bottom"
    },
    {
      title: "Refine Your Playlists",
      description: "Refine your playlist by adding instructions. Add or remove genres, change the tempo, adjust the mood, and more!",
      target: null,
      targetRef: refineInputRef,
      position: "left"
    },
    {
      title: "Auto-Refresh Feature",
      description: "Enable automatic playlist refreshes to keep your playlists fresh with new songs. Choose from daily, weekly, or monthly updates.",
      target: null,
      targetRef: autoRefreshRef,
      position: "left"
    },
    {
      title: "You're All Set!",
      description: "Connect your Spotify or Apple Music account from the profile menu to sync your playlists. Explore settings and FAQ for more options. Start creating amazing playlists!",
      target: null,
      targetRef: null,
      position: "center"
    }
  ];

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
      // Navigate to home page when tour starts
      if (onNavigateHome) {
        onNavigateHome();
      }
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen, onNavigateHome]);

  // Handle navigation and demo content
  useEffect(() => {
    if (!isOpen) return;

    // Steps 3-7 need playlists page
    if (currentStep >= 2 && currentStep <= 5) {
      if (onNavigateToPlaylists) {
        onNavigateToPlaylists();
      }

      // Steps 3-6 need demo playlist
      if (currentStep >= 2 && currentStep <= 5) {
        setShowDemoPlaylist(true);
        // Step 3: collapsed, Steps 4-6: expanded
        setIsDemoExpanded(currentStep >= 3);
        // Steps 5-6 need demo modal
        setShowDemoModal(currentStep >= 4 && currentStep <= 5);
      } else {
        setShowDemoPlaylist(false);
        setIsDemoExpanded(false);
        setShowDemoModal(false);
      }
    } else {
      // Steps 1-2 need home page
      if (onNavigateHome) {
        onNavigateHome();
      }
      setShowDemoPlaylist(false);
      setIsDemoExpanded(false);
      setShowDemoModal(false);
    }
  }, [isOpen, currentStep, onNavigateToPlaylists, onNavigateHome]);

  // Track if layout is ready - triggers re-render after demo content loads
  useEffect(() => {
    // For steps with highlights, trigger re-render after layout settles
    if (currentStep >= 1 && currentStep <= 5) {
      // Extra delay for step 4 to ensure Edit button is positioned
      if (currentStep === 3) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setTimeout(() => {
                forceRender(prev => prev + 1);
              }, 100);
            });
          });
        });
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            forceRender(prev => prev + 1);
          });
        });
      }
    }
  }, [currentStep, showDemoPlaylist, showDemoModal, isDemoExpanded]);

  // Lock scroll position during tour
  useEffect(() => {
    if (isOpen && currentStep >= 2) {
      window.scrollTo(0, 0);
      const handleScroll = () => window.scrollTo(0, 0);
      window.addEventListener('scroll', handleScroll);
      return () => window.removeEventListener('scroll', handleScroll);
    }
  }, [isOpen, currentStep]);

  const handleNext = () => {
    if (currentStep < steps.length - 1) {
      setCurrentStep(currentStep + 1);
    } else {
      handleComplete();
    }
  };

  const handlePrevious = () => {
    if (currentStep > 0) {
      setCurrentStep(currentStep - 1);
    }
  };

  const handleSkip = () => {
    localStorage.setItem('productTourCompleted', 'true');
    onClose();
    setCurrentStep(0);
    setShowDemoPlaylist(false);
    setShowDemoModal(false);
  };

  const handleComplete = () => {
    localStorage.setItem('productTourCompleted', 'true');
    if (onComplete) {
      onComplete();
    }
    // Navigate back to home page
    if (onNavigateHome) {
      onNavigateHome();
    }
    onClose();
    setCurrentStep(0);
    setShowDemoPlaylist(false);
    setShowDemoModal(false);
  };

  const getTooltipPosition = () => {
    const step = steps[currentStep];
    if (!step.target && !step.targetRef) return null;

    // Use ref if available, otherwise fall back to querySelector
    let targetElement = null;
    if (step.targetRef && step.targetRef.current) {
      targetElement = step.targetRef.current;
    } else if (step.target) {
      targetElement = document.querySelector(step.target);
    }

    if (!targetElement) {
      return null;
    }

    const rect = targetElement.getBoundingClientRect();
    const tooltipWidth = 400;
    const tooltipHeight = 320;
    const padding = 20;

    let top, left;

    switch (step.position) {
      case 'top':
        top = rect.top - tooltipHeight - padding;
        left = rect.left + (rect.width / 2) - (tooltipWidth / 2);
        break;
      case 'bottom':
        top = rect.bottom + padding;
        left = rect.left + (rect.width / 2) - (tooltipWidth / 2);
        break;
      case 'left':
        top = rect.top + (rect.height / 2) - (tooltipHeight / 2);
        left = rect.left - tooltipWidth - padding;
        break;
      case 'right':
        top = rect.top + (rect.height / 2) - (tooltipHeight / 2);
        left = rect.right + padding;
        break;
      default:
        return null;
    }

    // Keep tooltip within viewport
    const maxLeft = window.innerWidth - tooltipWidth - 20;
    const maxTop = window.innerHeight - tooltipHeight - 20;
    left = Math.max(20, Math.min(left, maxLeft));
    top = Math.max(20, Math.min(top, maxTop));

    return { top, left };
  };

  const getHighlightPosition = () => {
    const step = steps[currentStep];
    if (!step.target && !step.targetRef) return null;

    // Use ref if available, otherwise fall back to querySelector
    let targetElement = null;
    if (step.targetRef && step.targetRef.current) {
      targetElement = step.targetRef.current;
    } else if (step.target) {
      targetElement = document.querySelector(step.target);
    }

    if (!targetElement) return null;

    const rect = targetElement.getBoundingClientRect();

    // Use smaller padding for step 4 (Edit button) to fit tighter
    const padding = currentStep === 3 ? 8 : 12;

    // Calculate intended position with padding
    const intendedTop = rect.top - padding;
    const intendedLeft = rect.left - padding;

    // Clamp to viewport
    const top = Math.max(0, intendedTop);
    const left = Math.max(0, intendedLeft);

    // Adjust height if top was clipped
    const topClipped = intendedTop < 0 ? -intendedTop : 0;
    const height = rect.height + (padding * 2) - topClipped;

    return {
      top,
      left,
      width: rect.width + (padding * 2),
      height
    };
  };

  if (!isOpen) return null;

  const step = steps[currentStep];
  const tooltipPos = getTooltipPosition();
  const highlightPos = getHighlightPosition();
  const isCenterStep = step.position === 'center';

  return (
    <>
      <div className="product-tour-overlay">
        {/* Highlight target element - skip for steps 4 and 5 (they have inline styled borders) */}
        {highlightPos && currentStep !== 4 && currentStep !== 5 && (
          <div
            className="product-tour-highlight"
            style={{
              top: `${highlightPos.top}px`,
              left: `${highlightPos.left}px`,
              width: `${highlightPos.width}px`,
              height: `${highlightPos.height}px`
            }}
          />
        )}

        {/* Tooltip */}
        <div
          className={`product-tour-tooltip ${isCenterStep ? 'center' : ''}`}
          style={
            isCenterStep ? {} :
            (currentStep >= 1 && currentStep <= 5) ? {
              position: 'fixed',
              bottom: '20px',
              right: '20px',
              top: 'auto',
              left: 'auto',
              transform: 'none'
            } : {}
          }
        >
          <div className="product-tour-header">
            <h3>{step.title}</h3>
            <button className="tour-close-button" onClick={handleSkip}>
              ×
            </button>
          </div>

          <div className="product-tour-body">
            <p>{step.description}</p>
          </div>

          <div className="product-tour-footer">
            <div className="tour-progress">
              <span>{currentStep + 1} of {steps.length}</span>
              <div className="tour-progress-dots">
                {steps.map((_, index) => (
                  <div
                    key={index}
                    className={`tour-dot ${index === currentStep ? 'active' : ''} ${index < currentStep ? 'completed' : ''}`}
                  />
                ))}
              </div>
            </div>

            <div className="tour-buttons">
              {currentStep > 0 && (
                <button className="tour-button secondary" onClick={handlePrevious}>
                  Previous
                </button>
              )}
              {currentStep === 0 && (
                <button className="tour-button secondary" onClick={handleSkip}>
                  Skip Tour
                </button>
              )}
              <button className="tour-button primary" onClick={handleNext}>
                {currentStep === steps.length - 1 ? 'Get Started' : 'Next'}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Demo Playlist - Rendered in React */}
      {showDemoPlaylist && currentTab === 'playlists' && (
        <div className="tour-demo-playlist-container" style={{ position: 'fixed', top: '60px', left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 9999, overflow: 'hidden', padding: '0 2px' }}>
          <div style={{ paddingTop: '80px', maxWidth: '100%', margin: '0 auto' }}>
            <div className={`playlist-card tour-demo-playlist-card ${isDemoExpanded ? 'expanded' : ''}`} style={{ pointerEvents: 'none', marginBottom: '16px' }}>
              <div className="playlist-card-header">
                <div className="playlist-header-actions">
                  <div className="playlist-menu-container">
                    <button className="playlist-menu-button" title="More options">
                      ⋮
                    </button>
                  </div>
                  <span className="expand-icon">{isDemoExpanded ? '▼' : '▶'}</span>
                </div>
                <div className="playlist-header-content">
                  <div className="playlist-cover-image" style={{
                    backgroundImage: 'url(https://i.scdn.co/image/ab67616d0000b273bb54dde68cd23e2a268ae0f5)',
                    backgroundSize: 'cover',
                    backgroundPosition: 'center'
                  }}></div>
                  <div className="playlist-info">
                    <h2>Upbeat Pop Hits</h2>
                    <p className="playlist-meta">Created just now</p>
                  </div>
                </div>
              </div>

              {isDemoExpanded && (
                <div className="playlist-details">
                  <div className="playlist-controls">
                    <button ref={editButtonRef} className="edit-button tour-demo-edit-button" style={{ width: 'auto', minWidth: 'fit-content' }}>
                      Edit Playlist
                    </button>
                  </div>
                  <div className="tracks-list">
                    <div className="track-item">
                      <img src="https://i.scdn.co/image/ab67616d0000b273bb54dde68cd23e2a268ae0f5" alt="Midnights" className="track-image" />
                      <div className="track-content">
                        <div className="track-info">
                          <div className="track-name">Anti-Hero</div>
                          <div className="track-artist">Taylor Swift</div>
                        </div>
                      </div>
                    </div>
                    <div className="track-item">
                      <img src="https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36" alt="After Hours" className="track-image" />
                      <div className="track-content">
                        <div className="track-info">
                          <div className="track-name">Blinding Lights</div>
                          <div className="track-artist">The Weeknd</div>
                        </div>
                      </div>
                    </div>
                    <div className="track-item">
                      <img src="https://i.scdn.co/image/ab67616d0000b273e787cffec20aa2a396a61647" alt="1989" className="track-image" />
                      <div className="track-content">
                        <div className="track-info">
                          <div className="track-name">Shake It Off</div>
                          <div className="track-artist">Taylor Swift</div>
                        </div>
                      </div>
                    </div>
                    <div className="track-item">
                      <img src="https://i.scdn.co/image/ab67616d0000b27356ac7b86e090f307e218e9c8" alt="thank u, next" className="track-image" />
                      <div className="track-content">
                        <div className="track-info">
                          <div className="track-name">thank u, next</div>
                          <div className="track-artist">Ariana Grande</div>
                        </div>
                      </div>
                    </div>
                    <div className="track-item">
                      <img src="https://i.scdn.co/image/ab67616d0000b273e787cffec20aa2a396a61647" alt="1989" className="track-image" />
                      <div className="track-content">
                        <div className="track-info">
                          <div className="track-name">Blank Space</div>
                          <div className="track-artist">Taylor Swift</div>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Demo Modal - Rendered in React */}
      {showDemoModal && currentTab === 'playlists' && (
        <div className="modal-overlay tour-demo-modal" style={{ zIndex: 10005, pointerEvents: 'none', background: 'transparent' }}>
          <div className="edit-options-modal tour-demo-edit-modal" style={{ pointerEvents: 'none', minHeight: '500px' }}>
            <div className="edit-options-header">
              <div className="playlist-icon" style={{ background: 'linear-gradient(135deg, #667eea 0%, #764ba2 100%)' }}>
                🎵
              </div>
              <h2 className="edit-options-title">Upbeat Pop Hits</h2>
            </div>

            <div className="edit-options-list">
              <div ref={refineInputRef} className={`modal-section ${currentStep === 4 ? 'tour-refine-section' : ''}`} style={currentStep === 4 ? { background: '#fff7ed', borderRadius: '8px', border: '2px solid #fbbf24', padding: '16px' } : {}}>
                <h3 className="section-title" style={{ margin: '0 0 8px 0' }}>Refine Playlist</h3>
                <p className="section-description" style={{ margin: '0 0 12px 0' }}>Add instructions to customize future auto-updates</p>
                <div className="chat-input-container tour-demo-chat-input" style={{ position: 'relative', display: currentStep === 4 ? 'block' : 'none' }}>
                  <input type="text" placeholder="Refine your playlist!" className="chat-input" readOnly style={{ cursor: 'default', paddingRight: '40px' }}/>
                  <svg viewBox="0 0 24 24" style={{ width: '20px', height: '20px', fill: '#8e8e93', position: 'absolute', right: '12px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}>
                    <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
                  </svg>
                </div>
              </div>

              <div ref={autoRefreshRef} className={`modal-section ${currentStep === 5 ? 'tour-auto-refresh-section' : ''}`} style={currentStep === 5 ? { background: '#eff6ff', borderRadius: '8px', border: '2px solid #3b82f6', padding: '16px' } : {}}>
                <h3 className="section-title" style={{ margin: '0 0 8px 0' }}>Auto-Update Settings</h3>
                <p className="section-description" style={{ margin: '0 0 12px 0' }}>Automatically refresh your playlist on schedule</p>
                <div className="form-group" style={{ display: currentStep === 5 ? 'block' : 'none' }}>
                  <label htmlFor="update-frequency" style={{ display: 'block', marginBottom: '8px', fontSize: '14px', color: '#1a202c' }}>Auto-Update Frequency</label>
                  <select id="update-frequency" className="playlist-select tour-demo-select" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '15px', background: 'white' }}>
                    <option>Never</option>
                    <option selected>Daily</option>
                    <option>Weekly</option>
                    <option>Monthly</option>
                  </select>
                </div>
              </div>

              <div className="modal-section">
                <h3 className="section-title">Playlist Settings</h3>
                <p className="section-description">Configure privacy and visibility</p>
              </div>
            </div>

            <div className="modal-footer">
              <button className="cancel-button">Cancel</button>
              <button className="save-settings-button">Save Settings</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
};

export default ProductTour;
