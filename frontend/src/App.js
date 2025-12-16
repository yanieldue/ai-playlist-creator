import React, { useEffect } from 'react';
import PlaylistGenerator from './components/PlaylistGenerator';
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
      <PlaylistGenerator />
    </div>
  );
}

export default App;
