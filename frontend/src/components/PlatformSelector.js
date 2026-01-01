import React from 'react';
import '../styles/PlatformSelector.css';

/**
 * PlatformSelector Component
 * Allows users who have connected both Spotify and Apple Music
 * to choose which platform to use for playlist operations
 */
const PlatformSelector = ({ selectedPlatform, onPlatformChange, connectedPlatforms }) => {
  // Don't show selector if user only has one platform
  if (!connectedPlatforms || connectedPlatforms.length <= 1) {
    return null;
  }

  const hasSpotify = connectedPlatforms.includes('spotify');
  const hasAppleMusic = connectedPlatforms.includes('apple');

  return (
    <div className="platform-selector">
      <div className="platform-selector-label">
        Create playlist on:
      </div>
      <div className="platform-buttons">
        {hasSpotify && (
          <button
            className={`platform-button ${selectedPlatform === 'spotify' ? 'active' : ''}`}
            onClick={() => onPlatformChange('spotify')}
            aria-label="Use Spotify"
          >
            <svg className="platform-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M12 0C5.4 0 0 5.4 0 12s5.4 12 12 12 12-5.4 12-12S18.66 0 12 0zm5.521 17.34c-.24.359-.66.48-1.021.24-2.82-1.74-6.36-2.101-10.561-1.141-.418.122-.779-.179-.899-.539-.12-.421.18-.78.54-.9 4.56-1.021 8.52-.6 11.64 1.32.42.18.479.659.301 1.02zm1.44-3.3c-.301.42-.841.6-1.262.3-3.239-1.98-8.159-2.58-11.939-1.38-.479.12-1.02-.12-1.14-.6-.12-.48.12-1.021.6-1.141C9.6 9.9 15 10.561 18.72 12.84c.361.181.54.78.241 1.2zm.12-3.36C15.24 8.4 8.82 8.16 5.16 9.301c-.6.179-1.2-.181-1.38-.721-.18-.601.18-1.2.72-1.381 4.26-1.26 11.28-1.02 15.721 1.621.539.3.719 1.02.419 1.56-.299.421-1.02.599-1.559.3z"/>
            </svg>
            <span>Spotify</span>
          </button>
        )}

        {hasAppleMusic && (
          <button
            className={`platform-button ${selectedPlatform === 'apple' ? 'active' : ''}`}
            onClick={() => onPlatformChange('apple')}
            aria-label="Use Apple Music"
          >
            <svg className="platform-icon" viewBox="0 0 24 24" fill="currentColor">
              <path d="M23.997 6.124c0-.738-.065-1.47-.24-2.19-.317-1.31-1.062-2.31-2.18-3.043C21.003.517 20.373.285 19.7.164c-.517-.093-1.038-.135-1.564-.15-.04-.003-.083-.01-.124-.013H5.988c-.152.01-.303.017-.455.026C4.786.07 4.043.15 3.34.428 2.004.958 1.04 1.88.475 3.208c-.192.448-.292.925-.363 1.408-.056.392-.088.785-.1 1.18 0 .032-.007.062-.01.093v12.223c.01.14.017.283.027.424.05.815.154 1.624.497 2.373.65 1.42 1.738 2.353 3.234 2.801.42.127.856.187 1.293.228.555.053 1.11.06 1.667.06h11.03c.525 0 1.048-.034 1.57-.1.823-.106 1.597-.35 2.296-.81a5.28 5.28 0 0 0 1.88-2.207c.186-.42.293-.87.37-1.324.113-.675.138-1.358.137-2.04-.002-3.8 0-7.595-.003-11.393zm-6.423 3.99v5.712c0 .417-.058.827-.244 1.206-.29.59-.76.962-1.388 1.14-.35.1-.706.157-1.07.173-.95.045-1.773-.6-1.943-1.536-.142-.773.227-1.624 1.038-2.022.323-.16.67-.25 1.018-.324.378-.082.758-.153 1.134-.24.274-.063.457-.23.51-.516.014-.063.02-.13.02-.193 0-1.815 0-3.63-.002-5.443 0-.062-.01-.125-.026-.185-.04-.15-.15-.243-.304-.234-.16.01-.318.035-.475.066-.76.15-1.52.303-2.28.456l-2.325.47-1.374.278c-.016.003-.032.01-.048.013-.277.077-.377.203-.39.49-.002.042 0 .086 0 .13-.002 2.602 0 5.204-.003 7.805 0 .42-.047.836-.215 1.227-.278.64-.77 1.04-1.434 1.233-.35.1-.712.162-1.075.172-.96.025-1.763-.632-1.92-1.573-.084-.506.008-1.002.3-1.446.315-.477.762-.79 1.27-.99.357-.142.723-.25 1.1-.328.42-.086.838-.182 1.256-.27.115-.025.19-.087.223-.202.013-.045.017-.096.017-.143V6.883c0-.11.014-.217.048-.32.095-.29.283-.486.578-.55.54-.116 1.08-.222 1.62-.33l2.16-.432c.705-.14 1.412-.284 2.117-.424.424-.084.85-.17 1.275-.253.16-.032.324-.053.486-.065.353-.025.638.106.817.435.1.185.14.385.14.59 0 2.058-.002 4.117 0 6.175z"/>
            </svg>
            <span>Apple Music</span>
          </button>
        )}
      </div>
    </div>
  );
};

export default PlatformSelector;
