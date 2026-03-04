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
                  <span className={`reactions-thumb-circle${removing === song.id ? ' reactions-thumb-circle--loading' : ''}`}>
                    {activeSection === 'liked' ? (
                      <Icons.ThumbsUp size={16} color="white" />
                    ) : (
                      <Icons.ThumbsDown size={16} color="white" />
                    )}
                  </span>
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
