import React, { useState, useEffect } from 'react';
import '../styles/ProductTour.css';

const ProductTour = ({ isOpen, onClose, onComplete }) => {
  const [currentStep, setCurrentStep] = useState(0);

  const steps = [
    {
      title: "Welcome to AI Playlist Creator!",
      description: "Let's take a quick tour to help you get started. We'll show you how to create amazing playlists with AI.",
      target: null,
      position: "center"
    },
    {
      title: "Generate Playlists",
      description: "Describe the kind of music you want in natural language. Try something like 'upbeat 80s pop songs' or 'relaxing acoustic music for studying'. Our AI will create a personalized playlist for you!",
      target: ".chat-input-container-apple",
      position: "top"
    },
    {
      title: "My Playlists",
      description: "View all your created playlists here. Click on any playlist to see its tracks, edit settings, or refine it further.",
      target: "[data-tab='playlists']",
      position: "bottom"
    },
    {
      title: "Refine Your Playlists",
      description: "After creating a playlist, you can chat with our AI to refine it. Add or remove genres, change the tempo, adjust the mood, and more!",
      target: ".playlist-card",
      position: "top"
    },
    {
      title: "Auto-Refresh Feature",
      description: "Enable automatic playlist refreshes to keep your playlists fresh with new songs. Choose from daily, weekly, or monthly updates.",
      target: ".playlist-card",
      position: "top"
    },
    {
      title: "Connect Your Music Platform",
      description: "Connect your Spotify or Apple Music account to sync your playlists. Access your account settings from the profile menu.",
      target: ".profile-section-topnav",
      position: "bottom"
    },
    {
      title: "Customize Settings",
      description: "Adjust your preferences including dark mode and default playlist size in the Settings page.",
      target: ".profile-section-topnav",
      position: "bottom"
    },
    {
      title: "Need Help?",
      description: "Visit the FAQ page anytime for answers to common questions. You can find it in the profile menu.",
      target: ".profile-section-topnav",
      position: "bottom"
    },
    {
      title: "You're All Set!",
      description: "That's it! Start creating amazing playlists with AI. Have fun exploring!",
      target: null,
      position: "center"
    }
  ];

  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden';
    } else {
      document.body.style.overflow = 'unset';
    }
    return () => {
      document.body.style.overflow = 'unset';
    };
  }, [isOpen]);

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
    onClose();
    setCurrentStep(0);
  };

  const handleComplete = () => {
    localStorage.setItem('productTourCompleted', 'true');
    if (onComplete) {
      onComplete();
    }
    onClose();
    setCurrentStep(0);
  };

  const getTooltipPosition = () => {
    const step = steps[currentStep];
    if (!step.target) return null;

    const targetElement = document.querySelector(step.target);
    if (!targetElement) return null;

    const rect = targetElement.getBoundingClientRect();
    const tooltipWidth = 400;
    const tooltipHeight = 200;
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
    if (!step.target) return null;

    const targetElement = document.querySelector(step.target);
    if (!targetElement) return null;

    const rect = targetElement.getBoundingClientRect();
    const padding = 8;

    return {
      top: rect.top - padding,
      left: rect.left - padding,
      width: rect.width + (padding * 2),
      height: rect.height + (padding * 2)
    };
  };

  if (!isOpen) return null;

  const step = steps[currentStep];
  const tooltipPos = getTooltipPosition();
  const highlightPos = getHighlightPosition();
  const isCenterStep = step.position === 'center';

  return (
    <div className="product-tour-overlay">
      {/* Highlight target element */}
      {highlightPos && (
        <>
          <div
            className="product-tour-highlight"
            style={{
              top: `${highlightPos.top}px`,
              left: `${highlightPos.left}px`,
              width: `${highlightPos.width}px`,
              height: `${highlightPos.height}px`
            }}
          />
          <div
            className="product-tour-spotlight"
            style={{
              top: `${highlightPos.top}px`,
              left: `${highlightPos.left}px`,
              width: `${highlightPos.width}px`,
              height: `${highlightPos.height}px`
            }}
          />
        </>
      )}

      {/* Tooltip */}
      <div
        className={`product-tour-tooltip ${isCenterStep ? 'center' : ''}`}
        style={isCenterStep ? {} : tooltipPos ? {
          top: `${tooltipPos.top}px`,
          left: `${tooltipPos.left}px`
        } : {}}
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
  );
};

export default ProductTour;
