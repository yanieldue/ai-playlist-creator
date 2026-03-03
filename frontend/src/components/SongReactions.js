import React, { useState, useEffect } from 'react';
import playlistService from '../services/api';
import Icons from './Icons';
import '../styles/SongReactions.css';

const SongReactions = ({ userId, onBack }) => {
  const [likedSongs, setLikedSongs] = useState([]);
  const [dislikedSongs, setDislikedSongs] = useState([]);
  const [activeSection, setActiveSection] = useState('liked');
  const [loading, setLoading] = useState(true);
  const [removing, setRemoving] = useState(null); // trackId being removed

  useEffect(() => {
    const fetchReactions = async () => {
      try {
        const data = await playlistService.getReactions(userId);
        setLikedSongs(data.likedSongs || []);
        setDislikedSongs(data.dislikedSongs || []);
      } catch (err) {
        console.error('Failed to load reactions:', err);
      } finally {
        setLoading(false);
      }
    };
    if (userId) fetchReactions();
  }, [userId]);

  const handleRemove = async (song) => {
    if (removing) return;
    setRemoving(song.id);
    try {
      await playlistService.reactToSong(
        song.playlistId,
        userId,
        song.id,
        song.uri,
        song.name,
        song.artist,
        null, // null removes the reaction
        song.image
      );
      if (activeSection === 'liked') {
        setLikedSongs(prev => prev.filter(s => s.id !== song.id));
      } else {
        setDislikedSongs(prev => prev.filter(s => s.id !== song.id));
      }
    } catch (err) {
      console.error('Failed to remove reaction:', err);
    } finally {
      setRemoving(null);
    }
  };

  const songs = activeSection === 'liked' ? likedSongs : dislikedSongs;

  return (
    <div className="reactions-page">
      <div className="reactions-header">
        <button className="reactions-back-btn" onClick={onBack}>
          <Icons.ChevronLeft size={20} />
        </button>
        <h1>Song Reactions</h1>
      </div>

      <div className="reactions-segment">
        <button
          className={`reactions-segment-btn ${activeSection === 'liked' ? 'active' : ''}`}
          onClick={() => setActiveSection('liked')}
        >
          <Icons.ThumbsUp size={14} /> Liked ({likedSongs.length})
        </button>
        <button
          className={`reactions-segment-btn ${activeSection === 'disliked' ? 'active' : ''}`}
          onClick={() => setActiveSection('disliked')}
        >
          <Icons.ThumbsDown size={14} /> Disliked ({dislikedSongs.length})
        </button>
      </div>

      <div className="reactions-content">
        {loading ? (
          <div className="reactions-empty">Loading…</div>
        ) : songs.length === 0 ? (
          <div className="reactions-empty">
            {activeSection === 'liked'
              ? "No liked songs yet. Thumbs up songs you enjoy!"
              : "No disliked songs yet."}
          </div>
        ) : (
          <ul className="reactions-list">
            {songs.map((song, i) => (
              <li key={`${song.id}-${i}`} className="reactions-track">
                {song.image ? (
                  <img src={song.image} alt={song.name} className="reactions-track-art" />
                ) : (
                  <div className="reactions-track-art reactions-track-art-placeholder">
                    <Icons.Music size={18} />
                  </div>
                )}
                <div className="reactions-track-info">
                  <div className="reactions-track-name">{song.name}</div>
                  <div className="reactions-track-artist">{song.artist}</div>
                  <div className="reactions-track-playlist">{song.playlistName}</div>
                </div>
                <button
                  className="reactions-track-icon-btn"
                  onClick={() => handleRemove(song)}
                  disabled={removing === song.id}
                  title={activeSection === 'liked' ? 'Remove like' : 'Remove dislike'}
                >
                  {activeSection === 'liked' ? (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="none" style={{ color: removing === song.id ? '#c7c7cc' : '#34c759' }}>
                      <path d="M14 9V5a3 3 0 0 0-3-3l-4 9v11h11.28a2 2 0 0 0 2-1.7l1.38-9a2 2 0 0 0-2-2.3zM7 22H4a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2h3"/>
                    </svg>
                  ) : (
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="none" style={{ color: removing === song.id ? '#c7c7cc' : '#ff3b30' }}>
                      <path d="M10 15v4a3 3 0 0 0 3 3l4-9V2H5.72a2 2 0 0 0-2 1.7l-1.38 9a2 2 0 0 0 2 2.3zm7-13h2.67A2.31 2.31 0 0 1 22 4v7a2.31 2.31 0 0 1-2.33 2H17"/>
                    </svg>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
};

export default SongReactions;
