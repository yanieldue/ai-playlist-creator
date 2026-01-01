import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import PlaylistGenerator from './components/PlaylistGenerator';
import PlatformSelection from './components/PlatformSelection';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
import Account from './components/Account';
import FAQ from './components/FAQ';
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
          <Route path="/platform-selection" element={<PlatformSelection />} />
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/account" element={<Account />} />
          <Route path="/faq" element={<FAQ />} />
        </Routes>
      </Router>
    </div>
  );
}

export default App;
