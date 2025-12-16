import React, { useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import PlaylistGenerator from './components/PlaylistGenerator';
import ForgotPassword from './components/ForgotPassword';
import ResetPassword from './components/ResetPassword';
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
          <Route path="/forgot-password" element={<ForgotPassword />} />
          <Route path="/reset-password" element={<ResetPassword />} />
        </Routes>
      </Router>
    </div>
  );
}

export default App;
