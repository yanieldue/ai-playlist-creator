import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import Icons from './Icons';
import Toast from './Toast';
import { isWeeklyLimitActive, getWeeklyLimitResetDate, setWeeklyLimitResetsAt } from '../utils/plan';
import '../styles/Generate.css';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

export default function FromMix() {
  const navigate = useNavigate();
  const location = useLocation();
  const { returnTab = 'home' } = location.state || {};

  const userId         = localStorage.getItem('userId');
  const activePlatform = localStorage.getItem('activePlatform') || 'spotify';

  const [phase, setPhase]             = useState('input');   // input | analyzing | tracks
  const [url, setUrl]                 = useState('');
  const [videoTitle, setVideoTitle]   = useState('');
  const [videoDuration, setVideoDuration] = useState(0);
  const [tracks, setTracks]           = useState([]);
  const [removedIds, setRemovedIds]   = useState(new Set());
  const [statusMsg, setStatusMsg]     = useState('');
  const [progress, setProgress]       = useState(null);
  const [source, setSource]           = useState(null);
  const [unmatched, setUnmatched]     = useState([]);
  const [totalExpected, setTotalExpected] = useState(null);
  const [error, setError]             = useState('');
  const [toasts, setToasts]           = useState([]);
  const [editedName, setEditedName]   = useState('');
  const [editingName, setEditingName] = useState(false);

  const esRef      = useRef(null);
  const pageRef    = useRef(null);
  const contentRef = useRef(null);

  const showToast = (msg, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, msg, type }]);
  };

  // Redirect if not authenticated
  useEffect(() => {
    if (!userId) navigate('/', { replace: true });
  }, []); // eslint-disable-line

  // Sync editable name when video title loads
  useEffect(() => {
    if (videoTitle && !editedName) setEditedName(`Mix: ${videoTitle}`);
  }, [videoTitle]); // eslint-disable-line

  // iOS visual viewport fix (same as Generate.js)
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    const vv = window.visualViewport;
    if (!vv) return () => { document.body.style.overflow = ''; };
    const update = () => {
      if (!pageRef.current) return;
      pageRef.current.style.height = vv.height + 'px';
      pageRef.current.style.transform = `translateY(${vv.offsetTop}px)`;
      pageRef.current.style.opacity = '1';
    };
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      document.body.style.overflow = '';
      window.scrollTo(0, 0);
      if (pageRef.current) { pageRef.current.style.height = ''; pageRef.current.style.transform = ''; }
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  // Scroll to bottom as tracks appear
  useEffect(() => {
    if (phase === 'analyzing' && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [tracks, phase]);

  const handleAnalyze = () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    if (isWeeklyLimitActive()) {
      const resetDate = getWeeklyLimitResetDate();
      setError(`You've reached your 1 playlist per week limit. Upgrade to Pro for unlimited generations, or try again after ${resetDate}.`);
      return;
    }

    setPhase('analyzing');
    setTracks([]);
    setRemovedIds(new Set());
    setUnmatched([]);
    setTotalExpected(null);
    setStatusMsg('Connecting...');
    setError('');
    setProgress(null);
    setSource(null);

    const params = new URLSearchParams({ youtubeUrl: trimmed, userId, platform: activePlatform });
    const es = new EventSource(`${API_BASE_URL}/api/analyze-mix?${params}`);
    esRef.current = es;

    es.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      switch (data.type) {
        case 'status':
          setStatusMsg(data.message);
          break;
        case 'info':
          setVideoTitle(data.title || '');
          setVideoDuration(data.duration || 0);
          setStatusMsg(`Analyzing "${data.title}"...`);
          break;
        case 'source':
          setSource(data.method);
          if (data.total) setTotalExpected(data.total);
          setStatusMsg(data.method === 'audio'
            ? 'No tracklist found — scanning audio for songs...'
            : `Found tracklist · ${data.total} songs`);
          break;
        case 'track':
          setTracks(prev => [...prev, data]);
          setStatusMsg('');
          break;
        case 'unmatched':
          setUnmatched(prev => [...prev, data]);
          break;
        case 'progress': {
          setProgress(data);
          const m = Math.floor(data.current / 60);
          const s = String(data.current % 60).padStart(2, '0');
          const tm = Math.floor(data.total / 60);
          setStatusMsg(`Scanning ${m}:${s} / ${tm}:00 · ${data.scanned} segments checked`);
          break;
        }
        case 'done':
          setPhase('tracks');
          setStatusMsg('');
          es.close();
          break;
        case 'error':
          if (data.code === 'WEEKLY_LIMIT_REACHED') {
            if (data.resetsAt) setWeeklyLimitResetsAt(data.resetsAt);
            const resetDate = getWeeklyLimitResetDate();
            setError(`You've reached your 1 playlist per week limit. Upgrade to Pro for unlimited generations${resetDate ? `, or try again after ${resetDate}` : ''}.`);
          } else {
            setError(data.message);
          }
          setPhase('input');
          es.close();
          break;
        default:
          break;
      }
    };

    es.onerror = () => {
      setError('Connection lost. Please try again.');
      setPhase('input');
      es.close();
    };
  };

  const handleStop = () => {
    esRef.current?.close();
    setPhase('tracks');
    setStatusMsg('');
  };

  const removeTrack = (id) => {
    setTracks(prev => prev.filter(t => t.id !== id));
    showToast('Song removed');
  };

  const tabPath = (tab) => tab === 'playlists' ? '/playlists' : '/';

  const handleCreate = () => {
    const finalName = editedName.trim() || `Mix: ${videoTitle}` || 'Mix Playlist';
    const playlist = {
      tracks,
      playlistName: finalName,
      description: `Songs identified from: ${videoTitle || url}`,
      requestedSongCount: tracks.length,
      originalPrompt: finalName,
      chatMessages: [],
      excludedSongs: [],
    };
    navigate(tabPath(returnTab), {
      state: {
        pendingPlaylist: playlist,
        pendingChatMessages: [],
        returnTab,
        autoCreate: true,
        editedPlaylistName: finalName,
        updateFrequency: 'never',
        updateMode: 'replace',
      },
    });
  };

  const goBack = () => {
    esRef.current?.close();
    if (phase === 'analyzing') { setPhase('input'); return; }
    navigate(tabPath(returnTab), { state: { returnTab } });
  };

  const totalMinutes = Math.floor(videoDuration / 60);
  const scanPct = progress && videoDuration > 0
    ? Math.round((progress.current / Math.min(videoDuration, 7200)) * 100)
    : null;

  const visibleTracks = tracks.filter(t => !removedIds.has(t.id));

  return (
    <div className="generate-page" ref={pageRef}>
      {/* Header */}
      <div className="generate-header">
        <button className="generate-back-btn" onClick={goBack}>
          <Icons.Close size={20} />
        </button>
        {(phase === 'analyzing' || phase === 'tracks') && (
          <div className="generate-header-meta">
            {phase === 'tracks' && editingName ? (
              <input
                className="generate-playlist-name-input"
                value={editedName}
                onChange={e => setEditedName(e.target.value)}
                onBlur={() => setEditingName(false)}
                onKeyDown={e => { if (e.key === 'Enter') setEditingName(false); }}
                autoFocus
              />
            ) : (
              <div className="generate-header-name-row">
                <span className="generate-header-playlist-name" title={videoTitle}>
                  {editedName || videoTitle || 'Analyzing...'}
                </span>
                {phase === 'tracks' && (
                  <button className="generate-edit-name-btn" onClick={() => setEditingName(true)}>
                    <Icons.Edit size={13} />
                  </button>
                )}
              </div>
            )}
            <div className="generate-header-song-count">
              {visibleTracks.length} song{visibleTracks.length !== 1 ? 's' : ''}
              {totalMinutes > 0 && ` · ${totalMinutes} min mix`}
            </div>
          </div>
        )}
      </div>

      {/* Scrollable content */}
      <div className="generate-content" ref={contentRef}>
        {/* Input phase */}
        {phase === 'input' && (
          <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minHeight: '100%' }}>
            <div className="generate-intro">
              <h2><Icons.Headphones size={28} style={{ verticalAlign: 'middle', marginRight: 8 }} /> Create from Mix</h2>
              <p>Paste a YouTube DJ mix link. We'll find every song.</p>
            </div>
            <div className="generate-tips-card">
              <div className="generate-tips-title">How to use</div>
              <div>• Only YouTube links are supported for now. More platforms coming soon.</div>
              <div style={{ marginTop: 4 }}>• Works best with mixes that include a tracklist in the description or comments</div>
              <div style={{ marginTop: 4 }}>• Support for mixes without a tracklist is in the works</div>
            </div>
            {error && (
              <div className="generate-error-box" style={{ marginTop: 12 }}>
                <span>{error}</span>
              </div>
            )}
          </div>
        )}

        {/* Analyzing phase */}
        {phase === 'analyzing' && (
          <>
            {/* Source badge */}
            {source && (
              <div className={`mix-source-badge ${source}`} style={{ margin: '12px 0 8px' }}>
                {source === 'description'
                  ? <><Icons.Clipboard size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> From tracklist</>
                  : <><Icons.Headphones size={14} style={{ verticalAlign: 'middle', marginRight: 4 }} /> Audio scan</>
                }
              </div>
            )}

            {/* Progress bar */}
            {source === 'audio' && scanPct !== null && (
              <div className="mix-progress-bar-wrap" style={{ margin: '0 0 8px' }}>
                <div className="mix-progress-bar" style={{ width: `${scanPct}%` }} />
              </div>
            )}

            {/* Tracks appearing live */}
            {visibleTracks.map((track, i) => (
              <div key={track.id || i} className="generate-track-item">
                {track.image
                  ? <img src={track.image} alt={track.album} className="generate-track-img" />
                  : <div className="generate-track-img-placeholder" />
                }
                <div className="generate-track-info">
                  <div className="generate-track-name">{track.name}</div>
                  <div className="generate-track-artist">{track.artist}</div>
                </div>
              </div>
            ))}

            {/* Loading pulse with status */}
            <div className="generate-ai-bubble" style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 8 }}>
              <div className="wave-loader-small">
                <div className="wave-bar" /><div className="wave-bar" />
                <div className="wave-bar" /><div className="wave-bar" />
              </div>
              {statusMsg && <span style={{ fontSize: 13, color: '#b3b3b3' }}>{statusMsg}</span>}
            </div>
          </>
        )}

        {/* Tracks phase */}
        {phase === 'tracks' && (
          <>
            {visibleTracks.length === 0 && (
              <div className="generate-error-box">
                <span>No songs could be identified from this mix.</span>
              </div>
            )}
            {visibleTracks.map(track => (
              <div key={track.id} className="generate-track-item">
                {track.image
                  ? <img src={track.image} alt={track.album} className="generate-track-img" />
                  : <div className="generate-track-img-placeholder" />
                }
                <div className="generate-track-info">
                  <div className="generate-track-name">
                    {track.name}
                    {track.explicit && <span className="explicit-badge">E</span>}
                  </div>
                  <div className="generate-track-artist">{track.artist}</div>
                </div>
                <div className="generate-track-actions">
                  <button className="generate-track-remove" onClick={() => removeTrack(track.id)} title="Remove">
                    <Icons.MinusCircle size={20} />
                  </button>
                </div>
              </div>
            ))}
          </>
        )}
      </div>

      {/* Input bar (input phase) */}
      {phase === 'input' && (
        <div className="generate-input-bar" style={{ marginTop: 'auto' }}>
          <div className="generate-input-row">
            <Icons.Link size={18} style={{ flexShrink: 0, opacity: 0.5 }} />
            <textarea
              className="generate-text-input"
              value={url}
              onChange={e => { setUrl(e.target.value); e.target.style.height = '0px'; e.target.style.height = e.target.scrollHeight + 'px'; }}
              onKeyPress={e => { if (e.key === 'Enter' && !e.shiftKey && url.trim()) { e.preventDefault(); handleAnalyze(); } }}
              placeholder="Paste YouTube link..."
              rows={1}
            />
            <button
              className="generate-send-btn"
              onClick={handleAnalyze}
              disabled={!url.trim()}
              style={{ visibility: url.trim() ? 'visible' : 'hidden' }}
            >
              <Icons.Send size={20} />
            </button>
          </div>
        </div>
      )}

      {/* Analyzing footer */}
      {phase === 'analyzing' && (
        <div className="generate-footer">
          <button
            className="generate-refine-btn"
            onClick={handleStop}
            style={{ width: '100%' }}
          >
            Stop & Review
          </button>
        </div>
      )}

      {/* Tracks footer */}
      {phase === 'tracks' && visibleTracks.length > 0 && (
        <div className="generate-footer">
          {totalExpected && unmatched.length > 0 && (
            <div style={{ fontSize: '0.82rem', color: '#8e8e93', textAlign: 'center', marginBottom: 10, lineHeight: 1.4 }}>
              We found {visibleTracks.length} out of {totalExpected} songs on {activePlatform === 'apple' ? 'Apple Music' : 'Spotify'}.{' '}
              {unmatched.map(t => t.title).join(', ')} {unmatched.length === 1 ? 'was' : 'were'} not available.
            </div>
          )}
          <button className="generate-create-btn" onClick={handleCreate}>
            Create
          </button>
        </div>
      )}

      {/* Toasts */}
      {toasts.length > 0 && (
        <div className="toast-container generate-toast-container">
          {toasts.map(t => (
            <Toast key={t.id} message={t.msg} type={t.type} onClose={() => setToasts(prev => prev.filter(x => x.id !== t.id))} />
          ))}
        </div>
      )}
    </div>
  );
}
