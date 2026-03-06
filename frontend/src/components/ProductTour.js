import React, { useState, useEffect, useRef } from 'react';
import '../styles/ProductTour.css';

const ProductTour = ({ isOpen, onClose, onComplete, onNavigateHome, onNavigateToPlaylists, currentTab }) => {
  const [currentStep, setCurrentStep] = useState(0);
  // Demo visibility is derived from currentStep — no state needed, always pre-rendered
  const demoPlaylistVisible = currentStep >= 3 && currentStep <= 8;
  const demoExpanded = currentStep >= 5 && currentStep <= 8;
  const demoModalVisible = currentStep >= 7 && currentStep <= 8;

  // Refs for demo elements
  const importButtonRef = useRef(null);
  const editButtonRef = useRef(null);
  const trackActionsRef = useRef(null);
  const refineInputRef = useRef(null);
  const autoRefreshRef = useRef(null);
  const tooltipRef = useRef(null);

  // Force re-render when refs are attached
  const [, forceRender] = useState(0);
  // Track whether tooltip position has settled (prevents flash on mobile)
  const [positionReady, setPositionReady] = useState(false);

  // Step indices reference:
  //  0 - Welcome (center, home)
  //  1 - Generate Playlists (home, chat input)
  //  2 - Discover Artists (center, home) ← NEW
  //  3 - My Playlists tab (playlists, nav tab)
  //  4 - Import Playlists (playlists, import button) ← NEW
  //  5 - Edit Playlist (playlists, demo edit button)
  //  6 - Like/Dislike Songs (playlists, demo track actions)
  //  7 - Refine Playlists (playlists, demo modal refine)
  //  8 - Auto-Refresh (playlists, demo modal auto-refresh)
  //  9 - Song Reactions & Profile (home, profile button) ← NEW
  // 10 - You're All Set! (center, home)

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
      title: "Discover Artists",
      description: "Explore music beyond the chat! Your Top Artists shows your most-played artists from the last 4 weeks. Artists You Should Explore surfaces artists you haven't listened to yet and artists you haven't listened to in a while. Tap any artist tile to instantly generate a playlist around them.",
      target: null,
      targetRef: null,
      position: "center"
    },
    {
      title: "My Playlists",
      description: "View all your created playlists here. Click on any playlist to see its tracks, edit settings, or refine it further.",
      target: ".nav-tab-item:nth-child(2)",
      targetRef: null,
      position: "bottom"
    },
    {
      title: "Import Your Playlists",
      description: "Already have playlists on Spotify or Apple Music? Tap Import to bring them into Playlist Creator and manage them with AI-powered refinements and auto-updates.",
      target: null,
      targetRef: importButtonRef,
      position: "bottom"
    },
    {
      title: "Edit Your Playlists",
      description: "Click the Edit Playlist button to access settings, add refinement instructions, manually refresh with new songs, and manage auto-update scheduling.",
      target: null,
      targetRef: editButtonRef,
      position: "bottom"
    },
    {
      title: "Like or Dislike Songs",
      description: "Use the thumbs up to add more songs like this, or thumbs down to remove it and avoid similar tracks in future updates.",
      target: null,
      targetRef: trackActionsRef,
      position: "top"
    },
    {
      title: "Refine Your Playlists",
      description: "Refine your playlist by adding instructions. Add or remove genres, change the tempo, adjust the mood, and more!",
      target: null,
      targetRef: refineInputRef,
      position: "bottom"
    },
    {
      title: "Auto-Refresh & Manual Refresh",
      description: "Keep playlists fresh automatically — choose daily, weekly, or monthly updates. Or use Manual Refresh to add new songs right now. Both modes let you append to the playlist or fully replace the songs.",
      target: null,
      targetRef: autoRefreshRef,
      position: "bottom"
    },
    {
      title: "You're All Set!",
      description: "Connect your Spotify or Apple Music account from the profile menu to sync your playlists. Explore the artist discovery sections, import your existing playlists, and start creating amazing music!",
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

  // Handle navigation between home and playlists tab
  useEffect(() => {
    if (!isOpen) return;
    if (currentStep >= 3 && currentStep <= 8) {
      if (onNavigateToPlaylists) onNavigateToPlaylists();
    } else {
      if (onNavigateHome) onNavigateHome();
    }
  }, [isOpen, currentStep, onNavigateToPlaylists, onNavigateHome]);

  // Track if layout is ready - triggers re-render after demo content loads
  useEffect(() => {
    setPositionReady(false);
    // For steps with highlights, trigger re-render after layout settles
    if (currentStep >= 1 && currentStep <= 7) {
      // Extra delay for step 5 (edit button) to ensure it is positioned
      if (currentStep === 5) {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            requestAnimationFrame(() => {
              setTimeout(() => {
                forceRender(prev => prev + 1);
                setPositionReady(true);
              }, 100);
            });
          });
        });
      } else {
        requestAnimationFrame(() => {
          requestAnimationFrame(() => {
            forceRender(prev => prev + 1);
            setPositionReady(true);
          });
        });
      }
    } else {
      // Center steps: position is always ready (CSS handles centering)
      setPositionReady(true);
    }
  }, [currentStep]);

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
  };

  const handleComplete = () => {
    localStorage.setItem('productTourCompleted', 'true');
    if (onComplete) onComplete();
    if (onNavigateHome) onNavigateHome();
    onClose();
    setCurrentStep(0);
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
    const tooltipWidth = tooltipRef.current ? tooltipRef.current.offsetWidth : 400;
    const tooltipHeight = tooltipRef.current ? tooltipRef.current.offsetHeight : 320;
    const gap = 7; // half of 14px rotated-square arrow, so arrow tip exactly meets target

    let top, left, right;

    switch (step.position) {
      case 'top':
        top = rect.top - tooltipHeight - gap;
        left = rect.left + (rect.width / 2) - (tooltipWidth / 2);
        break;
      case 'bottom':
        top = rect.bottom + gap;
        left = rect.left + (rect.width / 2) - (tooltipWidth / 2);
        break;
      case 'left':
        top = rect.top + (rect.height / 2) - (tooltipHeight / 2);
        // Use `right` CSS property so tooltip's right edge is anchored exactly to rect.left
        right = window.innerWidth - rect.left;
        break;
      case 'right':
        top = rect.top + (rect.height / 2) - (tooltipHeight / 2);
        left = rect.right + gap;
        break;
      default:
        return null;
    }

    // Keep tooltip within viewport
    const maxTop = window.innerHeight - tooltipHeight - 20;
    top = Math.max(20, Math.min(top, maxTop));
    if (left !== undefined) {
      const maxLeft = window.innerWidth - tooltipWidth - 20;
      left = Math.max(20, Math.min(left, maxLeft));
    }

    return right !== undefined ? { top, right } : { top, left };
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

    // Use smaller padding for steps 1, 4, and 6 to fit tighter around compact UI elements
    const padding = currentStep === 1 ? 6 : (currentStep === 5 || currentStep === 6) ? 6 : 12;

    // Calculate intended position with padding
    const intendedTop = rect.top - padding;
    const intendedLeft = rect.left - padding;
    const intendedWidth = rect.width + (padding * 2);
    const intendedHeight = rect.height + (padding * 2);

    // Clamp to viewport
    const top = Math.max(0, intendedTop);
    const left = Math.max(0, intendedLeft);

    // Adjust dimensions if clipped at edges
    const topClipped = intendedTop < 0 ? -intendedTop : 0;
    const leftClipped = intendedLeft < 0 ? -intendedLeft : 0;

    // Ensure highlight doesn't extend beyond right edge
    const maxWidth = window.innerWidth - left;
    const width = Math.min(intendedWidth - leftClipped, maxWidth);

    // Ensure highlight doesn't extend beyond bottom edge
    const maxHeight = window.innerHeight - top;
    const height = Math.min(intendedHeight - topClipped, maxHeight);

    return {
      top,
      left,
      width,
      height
    };
  };

  if (!isOpen) return null;

  const step = steps[currentStep];
  const tooltipPos = getTooltipPosition();
  const isCenterStep = step.position === 'center';
  const isMobile = window.innerWidth <= 768;

  const arrowDirectionMap = { bottom: 'up', top: 'down', left: 'right', right: 'left' };

  // For mobile: position tooltip on opposite side of target, arrow points toward target
  const getMobileTooltipConfig = () => {
    if (isCenterStep) return { style: {}, arrowClass: '' };
    const baseStyle = {
      position: 'fixed',
      left: '50%',
      right: 'auto',
      transform: 'translateX(-50%)',
      width: 'calc(100% - 32px)',
      maxWidth: '100%',
    };

    const targetEl = step.targetRef?.current || (step.target ? document.querySelector(step.target) : null);
    if (!targetEl) {
      return { style: { ...baseStyle, bottom: '20px', top: 'auto' }, arrowClass: '' };
    }

    const rect = targetEl.getBoundingClientRect();
    // If element is outside the viewport (clipped by overflow:hidden), fall back to bottom
    if (rect.bottom <= 0 || rect.top >= window.innerHeight) {
      return { style: { ...baseStyle, bottom: '20px', top: 'auto' }, arrowClass: '' };
    }

    const targetCenterX = rect.left + rect.width / 2;
    const targetCenterY = rect.top + rect.height / 2;
    const arrowX = Math.max(16, Math.min(targetCenterX - 16, window.innerWidth - 48));
    const gap = 12;

    if (targetCenterY < window.innerHeight * 0.55) {
      // Target in top half: place tooltip just below the target, arrow points up
      const top = Math.min(rect.bottom + gap, window.innerHeight - 320);
      return {
        style: { ...baseStyle, top: `${top}px`, bottom: 'auto', '--arrow-x': `${arrowX}px` },
        arrowClass: 'arrow-up',
      };
    } else {
      // Target in bottom half: place tooltip just above the target, arrow points down
      const bottom = Math.min(window.innerHeight - rect.top + gap, window.innerHeight - 80);
      return {
        style: { ...baseStyle, bottom: `${bottom}px`, top: 'auto', '--arrow-x': `${arrowX}px` },
        arrowClass: 'arrow-down',
      };
    }
  };

  const mobileConfig = isMobile ? getMobileTooltipConfig() : null;

  const arrowClass = (!isCenterStep && !isMobile && tooltipPos && step.position) ? `arrow-${arrowDirectionMap[step.position] || ''}` : '';

  // Compute arrow offset so it points at the target's center
  const getArrowOffsetStyle = () => {
    if (!tooltipPos || isCenterStep || isMobile) return {};
    const targetEl = step.targetRef?.current || (step.target ? document.querySelector(step.target) : null);
    if (!targetEl) return {};
    const rect = targetEl.getBoundingClientRect();
    if (step.position === 'bottom' || step.position === 'top') {
      const tooltipW = tooltipRef.current ? tooltipRef.current.offsetWidth : 400;
      const offset = Math.max(16, Math.min((rect.left + rect.width / 2) - tooltipPos.left, tooltipW - 16));
      return { '--arrow-x': `${offset}px` };
    } else {
      // Min 26px so arrow clears the 16px border-radius — avoids visual gap between card edge and arrow
      const offset = Math.max(26, Math.min((rect.top + rect.height / 2) - tooltipPos.top, 200));
      return { '--arrow-y': `${offset}px` };
    }
  };

  return (
    <>
      <div className="product-tour-overlay">
        {/* Tooltip */}
        <div
          ref={tooltipRef}
          className={`product-tour-tooltip ${isCenterStep ? 'center' : ''} ${isMobile && !isCenterStep ? 'mobile-positioned' : ''} ${isMobile ? (mobileConfig?.arrowClass || '') : arrowClass}`}
          style={
            isCenterStep ? {} :
            isMobile ? { ...mobileConfig?.style, visibility: positionReady ? 'visible' : 'hidden' } :
            tooltipPos ? {
              position: 'fixed',
              top: `${tooltipPos.top}px`,
              ...(tooltipPos.right !== undefined
                ? { right: `${tooltipPos.right}px`, left: 'auto' }
                : { left: `${tooltipPos.left}px` }),
              transform: 'none',
              ...getArrowOffsetStyle()
            } : {
              position: 'fixed',
              bottom: '20px',
              right: '20px',
              top: 'auto',
              left: 'auto',
              transform: 'none'
            }
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

      {/* Demo Playlist - always in DOM, visibility toggled to avoid mount animations */}
      <div className="tour-demo-playlist-container" style={{ position: 'fixed', top: '60px', left: 0, right: 0, bottom: 0, pointerEvents: 'none', zIndex: 9999, overflow: 'hidden', padding: '0 2px', visibility: demoPlaylistVisible ? 'visible' : 'hidden' }}>
          <div style={{ padding: '0 16px', maxWidth: '100%', margin: '0 auto' }}>
            {/* Demo playlists header (replicates real page header) */}
            <div className="playlists-header" style={{ pointerEvents: 'none' }}>
              <h1>My Playlists</h1>
              <p className="playlists-count">1 playlist created</p>
              <button ref={importButtonRef} className="import-button" style={{ pointerEvents: 'none' }}>Import</button>
            </div>
            <div className={`playlist-card tour-demo-playlist-card ${demoExpanded ? 'expanded' : ''}`} style={{ pointerEvents: 'none', marginBottom: '16px' }}>
              <div className="playlist-card-header">
                <div className="playlist-header-actions">
                  <div className="playlist-menu-container">
                    <button className="playlist-menu-button" title="More options">
                      ⋮
                    </button>
                  </div>
                  <span className="expand-icon">{demoExpanded ? '▼' : '▶'}</span>
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

              <div className="playlist-details" style={{ display: demoExpanded ? 'block' : 'none' }}>
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
                        <div className={`track-actions ${currentStep === 6 ? 'tour-highlight-reactions' : ''}`}>
                          <button ref={trackActionsRef} className="track-reaction-button" title="I like this! Add more songs like this">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
                            </svg>
                          </button>
                          <button className="track-reaction-button" title="Not for me. Exclude similar songs">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path>
                            </svg>
                          </button>
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
                        <div className="track-actions">
                          <button className="track-reaction-button" title="I like this! Add more songs like this">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
                            </svg>
                          </button>
                          <button className="track-reaction-button" title="Not for me. Exclude similar songs">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path>
                            </svg>
                          </button>
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
                        <div className="track-actions">
                          <button className="track-reaction-button" title="I like this! Add more songs like this">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
                            </svg>
                          </button>
                          <button className="track-reaction-button" title="Not for me. Exclude similar songs">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path>
                            </svg>
                          </button>
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
                        <div className="track-actions">
                          <button className="track-reaction-button" title="I like this! Add more songs like this">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
                            </svg>
                          </button>
                          <button className="track-reaction-button" title="Not for me. Exclude similar songs">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path>
                            </svg>
                          </button>
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
                        <div className="track-actions">
                          <button className="track-reaction-button" title="I like this! Add more songs like this">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"></path>
                            </svg>
                          </button>
                          <button className="track-reaction-button" title="Not for me. Exclude similar songs">
                            <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                              <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"></path>
                            </svg>
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
            </div>
          </div>
        </div>

      {/* Demo Modal - always in DOM, visibility toggled to avoid mount animations */}
      <div className="modal-overlay tour-demo-modal" style={{ zIndex: 9999, pointerEvents: 'none', background: 'transparent', visibility: demoModalVisible ? 'visible' : 'hidden' }}>
          <div className="edit-options-modal tour-demo-edit-modal" style={{ pointerEvents: 'none', minHeight: '500px' }}>
            <div className="edit-options-header">
              <div className="playlist-icon" style={{
                backgroundImage: 'url(https://i.scdn.co/image/ab67616d0000b273bb54dde68cd23e2a268ae0f5)',
                backgroundSize: 'cover',
                backgroundPosition: 'center'
              }}>
              </div>
              <h2 className="edit-options-title">Upbeat Pop Hits</h2>
            </div>

            <div className="edit-options-list">
              <div ref={refineInputRef} className="modal-section" style={{ background: 'transparent', border: 'none' }}>
                <h3 className="section-title" style={{ margin: '0 0 8px 0' }}>Refine Playlist</h3>
                <p className="section-description" style={{ margin: '0 0 12px 0' }}>Add instructions to customize future auto-updates</p>
                <div className="chat-input-container tour-demo-chat-input" style={{ display: currentStep === 7 ? 'flex' : 'none', position: 'relative' }}>
                  <input type="text" placeholder="Refine your playlist!" className="chat-input" readOnly style={{ cursor: 'default', flex: 1, border: 'none', background: 'transparent' }}/>
                  <svg viewBox="0 0 24 24" style={{ width: '20px', height: '20px', fill: '#8e8e93', flexShrink: 0 }}>
                    <path d="M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z"/>
                  </svg>
                </div>
              </div>

              <div ref={autoRefreshRef} className="modal-section">
                <h3 className="section-title" style={{ margin: '0 0 8px 0' }}>Auto-Update Settings</h3>
                <p className="section-description" style={{ margin: '0 0 12px 0' }}>Automatically refresh your playlist on schedule</p>
                <div className="form-group" style={{ display: currentStep === 8 ? 'block' : 'none' }}>
                  <label htmlFor="update-frequency" style={{ display: 'block', marginBottom: '8px', fontSize: '14px', color: '#1a202c' }}>Auto-Update Frequency</label>
                  <select id="update-frequency" defaultValue="Daily" className="playlist-select tour-demo-select" style={{ width: '100%', padding: '10px', borderRadius: '8px', border: '1px solid #e2e8f0', fontSize: '15px', background: 'white' }}>
                    <option>Never</option>
                    <option>Daily</option>
                    <option>Weekly</option>
                    <option>Monthly</option>
                  </select>
                </div>
              </div>
            </div>

            <div className="modal-footer">
              <button className="cancel-button">Cancel</button>
              <button className="save-settings-button">Save Settings</button>
            </div>
          </div>
        </div>
    </>
  );
};

export default ProductTour;
