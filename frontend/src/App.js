import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import PlaylistGenerator from './components/PlaylistGenerator';
import PlatformSelection from './components/PlatformSelection';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import Pricing from './components/Pricing';
import Generate from './components/Generate';
import FromMix from './components/FromMix';
import AppleMusicRedirect from './components/AppleMusicRedirect';
import './styles/App.css';

function App() {
  useEffect(() => {
    // Apply dark mode on app load if it was saved
    const darkModeSetting = localStorage.getItem('darkMode');
    if (darkModeSetting !== null) {
      const isDark = JSON.parse(darkModeSetting);
      if (isDark) {
        document.documentElement.classList.add('dark-mode');
      } else {
        document.documentElement.classList.remove('dark-mode');
      }
    }
  }, []);

  return (
    <div className="App">
      <Router>
        <Routes>
          <Route path="/" element={<PlaylistGenerator />} />
          <Route path="/login" element={<PlaylistGenerator />} />
          <Route path="/playlists" element={<PlaylistGenerator />} />
          <Route path="/settings" element={<PlaylistGenerator />} />
          <Route path="/account" element={<PlaylistGenerator />} />
          <Route path="/faq" element={<PlaylistGenerator />} />
          <Route path="/reactions" element={<PlaylistGenerator />} />
          <Route path="/feedback" element={<PlaylistGenerator />} />
          <Route path="/platform-selection" element={<PlatformSelection />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/pricing" element={<Pricing />} />
          <Route path="/generate" element={<Generate />} />
          <Route path="/from-mix" element={<FromMix />} />
          <Route path="/apple-music-redirect" element={<AppleMusicRedirect />} />
        </Routes>
      </Router>
    </div>
  );
}

export default App;
