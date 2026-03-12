import React, { useState } from 'react';
import '../styles/Settings.css';
import playlistService from '../services/api';

const Settings = ({ onBack }) => {
  const [allowExplicit, setAllowExplicit] = useState(() => {
    const saved = localStorage.getItem('allowExplicit');
    return saved !== null ? JSON.parse(saved) : true;
  });

  const [darkMode, setDarkMode] = useState(() => {
    const saved = localStorage.getItem('darkMode');
    const isDark = saved !== null ? JSON.parse(saved) : false;
    // Apply on initial load
    if (isDark) {
      document.documentElement.classList.add('dark-mode');
    }
    return isDark;
  });

  const [savedMessage, setSavedMessage] = useState('');

  const persistSettings = (newAllowExplicit, newDarkMode) => {
    localStorage.setItem('allowExplicit', JSON.stringify(newAllowExplicit));
    localStorage.setItem('darkMode', JSON.stringify(newDarkMode));
    setSavedMessage('Settings saved!');
    setTimeout(() => setSavedMessage(''), 2000);
    const email = localStorage.getItem('userEmail');
    if (email) {
      playlistService.updateSettings(email, { allowExplicit: newAllowExplicit, darkMode: newDarkMode }).catch(() => {});
    }
  };

  const handleToggleExplicit = (newValue) => {
    setAllowExplicit(newValue);
    persistSettings(newValue, darkMode);
  };

  const handleToggleDarkMode = (newValue) => {
    setDarkMode(newValue);
    if (newValue) {
      document.documentElement.classList.add('dark-mode');
    } else {
      document.documentElement.classList.remove('dark-mode');
    }
    persistSettings(allowExplicit, newValue);
  };

  return (
    <div className="settings-page">
      <div className="settings-header">
        <h1>Settings</h1>
      </div>

      <div className="settings-content">
        <div className="settings-list">
          <div className="settings-item">
            <div className="settings-item-left">
              <span className="settings-label">Explicit Content</span>
              <span className="settings-description">Allow songs with explicit lyrics</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={allowExplicit}
                onChange={(e) => handleToggleExplicit(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>

          <div className="settings-item">
            <div className="settings-item-left">
              <span className="settings-label">Dark Mode</span>
              <span className="settings-description">Use dark theme</span>
            </div>
            <label className="toggle-switch">
              <input
                type="checkbox"
                checked={darkMode}
                onChange={(e) => handleToggleDarkMode(e.target.checked)}
              />
              <span className="toggle-slider"></span>
            </label>
          </div>
        </div>

        {savedMessage && (
          <div className="settings-success-message">{savedMessage}</div>
        )}
      </div>
    </div>
  );
};

export default Settings;
