import React, { useState, useRef, useEffect } from 'react';
import '../styles/MixAnalyzer.css';

const API_BASE_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';

export default function MixAnalyzerModal({ isOpen, onClose, onTracksFound, userId, platform }) {
  const [phase, setPhase]               = useState('input');   // input | analyzing | done | error
  const [url, setUrl]                   = useState('');
  const [videoTitle, setVideoTitle]     = useState('');
  const [videoDuration, setVideoDuration] = useState(0);
  const [tracks, setTracks]             = useState([]);
  const [unmatched, setUnmatched]       = useState([]);
  const [statusMsg, setStatusMsg]       = useState('');
  const [progress, setProgress]         = useState(null);   // { current, total, scanned }
  const [source, setSource]             = useState(null);   // 'description' | 'audio'
  const [totalExpected, setTotalExpected] = useState(null);
  const [errorMsg, setErrorMsg]         = useState('');
  const esRef = useRef(null);

  // Reset state when modal closes
  useEffect(() => {
    if (!isOpen) {
      esRef.current?.close();
      setPhase('input');
      setUrl('');
      setVideoTitle('');
      setVideoDuration(0);
      setTracks([]);
      setUnmatched([]);
      setStatusMsg('');
      setProgress(null);
      setSource(null);
      setErrorMsg('');
      setTotalExpected(null);
    }
  }, [isOpen]);

  const handleAnalyze = () => {
    const trimmed = url.trim();
    if (!trimmed) return;

    setPhase('analyzing');
    setTracks([]);
    setUnmatched([]);
    setStatusMsg('Connecting...');
    setErrorMsg('');
    setProgress(null);
    setSource(null);

    const params = new URLSearchParams({ youtubeUrl: trimmed, userId, platform: platform || 'spotify' });
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
          if (data.method === 'audio') {
            setStatusMsg('No tracklist found — scanning audio for songs...');
          } else {
            setStatusMsg(`Found tracklist · ${data.total} songs`);
          }
          break;
        case 'track':
          setTracks(prev => [...prev, data]);
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
          setPhase('done');
          setStatusMsg('');
          es.close();
          break;
        case 'error':
          setErrorMsg(data.message);
          setPhase('error');
          es.close();
          break;
        default:
          break;
      }
    };

    es.onerror = () => {
      setErrorMsg('Connection lost. Please try again.');
      setPhase('error');
      es.close();
    };
  };

  const handleStop = () => {
    esRef.current?.close();
    setPhase('done');
    setStatusMsg('');
  };

  const handleCreate = () => {
    const playlistName = videoTitle ? `Mix: ${videoTitle}` : 'Mix Playlist';
    onTracksFound(tracks, playlistName);
    onClose();
  };

  if (!isOpen) return null;

  const totalMinutes = Math.floor(videoDuration / 60);
  const scanPct = progress && videoDuration > 0
    ? Math.round((progress.current / Math.min(videoDuration, 7200)) * 100)
    : null;

  return (
    <div className="mix-overlay" onClick={onClose}>
      <div className="mix-sheet" onClick={e => e.stopPropagation()}>
        <div className="mix-handle" />

        {/* ── Input phase ── */}
        {phase === 'input' && (
          <div className="mix-input-phase">
            <div className="mix-title">Create from Mix</div>
            <p className="mix-subtitle">
              Paste a YouTube DJ mix link. Works best with mixes that include a tracklist in the description or comments.
            </p>
            <input
              type="url"
              className="mix-url-input"
              placeholder="https://youtube.com/watch?v=..."
              value={url}
              onChange={e => setUrl(e.target.value)}
              onKeyPress={e => { if (e.key === 'Enter' && url.trim()) handleAnalyze(); }}
              autoFocus
            />
            <button className="mix-analyze-btn" onClick={handleAnalyze} disabled={!url.trim()}>
              Analyze Mix
            </button>
          </div>
        )}

        {/* ── Analyzing / Done phase ── */}
        {(phase === 'analyzing' || phase === 'done') && (
          <div className="mix-results-phase">
            {/* Header */}
            <div className="mix-results-header">
              <div className="mix-results-title" title={videoTitle}>
                {videoTitle || 'Analyzing...'}
              </div>
              <div className="mix-results-meta">
                {tracks.length > 0 && (
                  <span className="mix-found-count">
                    {totalExpected ? `${tracks.length} / ${totalExpected} found` : `${tracks.length} found`}
                  </span>
                )}
                {totalMinutes > 0 && <span className="mix-duration">{totalMinutes} min</span>}
              </div>
            </div>

            {/* Source badge */}
            {source && (
              <div className={`mix-source-badge ${source}`}>
                {source === 'description' ? '📋 From tracklist' : '🎧 Audio scan'}
              </div>
            )}

            {/* Progress bar (audio scan only) */}
            {source === 'audio' && scanPct !== null && phase === 'analyzing' && (
              <div className="mix-progress-bar-wrap">
                <div className="mix-progress-bar" style={{ width: `${scanPct}%` }} />
              </div>
            )}

            {/* Status message */}
            {statusMsg && phase === 'analyzing' && (
              <div className="mix-status-row">
                <div className="mix-status-dot" />
                <span>{statusMsg}</span>
              </div>
            )}

            {/* Track list */}
            <div className="mix-track-list">
              {tracks.map((track, i) => (
                <div key={track.id || i} className="mix-track-item">
                  {track.image
                    ? <img src={track.image} alt={track.album} className="mix-track-img" />
                    : <div className="mix-track-img-placeholder" />
                  }
                  <div className="mix-track-info">
                    <div className="mix-track-name">{track.name}</div>
                    <div className="mix-track-artist">{track.artist}</div>
                  </div>
                </div>
              ))}

              {/* Loading pulse at the bottom during analysis */}
              {phase === 'analyzing' && (
                <div className="mix-loader-row">
                  <div className="wave-loader-small">
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                    <div className="wave-bar" />
                  </div>
                </div>
              )}

            </div>

            {/* Footer actions */}
            <div className="mix-footer">
              {phase === 'analyzing' && (
                <button className="mix-stop-btn" onClick={handleStop}>Stop & Review</button>
              )}
              {phase === 'done' && tracks.length > 0 && (
                <>
                  {totalExpected && unmatched.length > 0 && (
                    <div className="mix-summary-note">
                      We found {tracks.length} out of {totalExpected} songs on {platform === 'apple' ? 'Apple Music' : 'Spotify'}.{' '}
                      <span className="mix-summary-unmatched">{unmatched.map(t => t.title).join(', ')} {unmatched.length === 1 ? 'was' : 'were'} not available.</span>
                    </div>
                  )}
                  <button className="mix-create-btn" onClick={handleCreate}>
                    Create Playlist · {tracks.length} songs
                  </button>
                </>
              )}
              {phase === 'done' && tracks.length === 0 && (
                <div className="mix-empty-state">
                  No songs could be identified. This works best with mixes that include a tracklist in the description or comments.
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Error phase ── */}
        {phase === 'error' && (
          <div className="mix-error-phase">
            <div className="mix-error-icon">⚠️</div>
            <div className="mix-error-message">{errorMsg}</div>
            <button className="mix-retry-btn" onClick={() => setPhase('input')}>Try Again</button>
          </div>
        )}
      </div>
    </div>
  );
}
