import React, { useState, useRef, useEffect } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import playlistService from '../services/api';
import { isPaid } from '../utils/plan';
import Icons from './Icons';
import Toast from './Toast';
import '../styles/Generate.css';

const SUGGESTIONS = [
  'Upbeat hip-hop and R&B for a morning workout, high energy like Drake and Kendrick',
  'Chill indie folk for a Sunday morning, similar to Bon Iver and Iron & Wine',
  'Late night driving songs, moody electronic and alt-R&B like The Weeknd and Frank Ocean',
  'Focus instrumentals for deep work, ambient and post-rock like Explosions in the Sky',
  'Feel-good 2000s pop and rock road trip hits like Paramore and Fall Out Boy',
  'Upbeat Latin pop and reggaeton for a summer party, like Bad Bunny and J Balvin',
];

const REFINE_SUGGESTIONS = [
  'More upbeat energy',
  "Replace with songs I haven't heard before",
  'Add more variety in genres',
  'Keep only songs from the 2000s',
  'Make it more chill and relaxed',
];

function getGenreMessages(text) {
  const t = text.toLowerCase();
  if (t.includes('chill') || t.includes('relax') || t.includes('sleep') || t.includes('calm'))
    return ['Finding the perfect vibe...', 'Crafting a relaxing soundscape...', 'Blending smooth melodies...'];
  if (t.includes('workout') || t.includes('gym') || t.includes('run') || t.includes('energy'))
    return ['Pumping up the energy...', 'Finding your rhythm...', 'Building momentum...'];
  if (t.includes('focus') || t.includes('study') || t.includes('work') || t.includes('concentrate'))
    return ['Selecting focus-friendly tracks...', 'Building concentration vibes...', 'Finding the perfect flow...'];
  if (t.includes('party') || t.includes('dance') || t.includes('club'))
    return ['Turning up the heat...', 'Mixing the best drops...', 'Getting the crowd hyped...'];
  if (t.includes('love') || t.includes('romantic') || t.includes('date'))
    return ['Finding romantic melodies...', 'Crafting an intimate playlist...', 'Setting the mood...'];
  if (t.includes('sad') || t.includes('emotional') || t.includes('cry') || t.includes('breakup'))
    return ['Gathering emotional tracks...', 'Finding cathartic songs...', 'Building an emotional journey...'];
  return ['Discovering the perfect tracks...', 'Curating your playlist...', 'Blending songs harmoniously...', 'Building your soundtrack...'];
}

export default function Generate() {
  const navigate = useNavigate();
  const location = useLocation();
  const {
    initialPrompt = '',
    refineMode = false,
    initialPlaylist = null,
    initialChatMessages = [],
    returnTab = 'home',
  } = location.state || {};

  const userId = localStorage.getItem('userId');
  const activePlatform = localStorage.getItem('activePlatform') || 'spotify';
  const allowExplicit = localStorage.getItem('allowExplicit') !== 'false';

  const [phase, setPhase] = useState(refineMode ? 'refine' : initialPlaylist ? 'tracks' : 'input');
  const [prompt, setPrompt] = useState(initialPrompt);
  const [newArtistsOnly, setNewArtistsOnly] = useState(false);
  const [songCount, setSongCount] = useState(30);
  const [songCountDraft, setSongCountDraft] = useState(30);

  const [loading, setLoading] = useState(false);
  const [generatingMessage, setGeneratingMessage] = useState('');
  const [generatingPrompt, setGeneratingPrompt] = useState('');
  const [error, setError] = useState(null);
  const [weeklyLimitReached, setWeeklyLimitReached] = useState(false);

  const [generatedPlaylist, setGeneratedPlaylist] = useState(
    initialPlaylist
      ? { ...initialPlaylist, draftId: initialPlaylist.draftId || initialPlaylist.playlistId }
      : null
  );
  const [lockedTrackIds, setLockedTrackIds] = useState(
    new Set(initialPlaylist?.lockedTrackIds || [])
  );

  const [chatInput, setChatInput] = useState('');
  const [chatMessages, setChatMessages] = useState(initialChatMessages);
  const [chatLoading, setChatLoading] = useState(false);
  const [refineMessage, setRefineMessage] = useState('');

  const [toasts, setToasts] = useState([]);
  const [keyboardOpen, setKeyboardOpen] = useState(false);

  const showToast = (message, type = 'success') => {
    const id = Date.now();
    setToasts(prev => [...prev, { id, message, type }]);
  };

  const removeToast = (id) => {
    setToasts(prev => prev.filter(t => t.id !== id));
  };

  const isGeneratingRef = useRef(false);
  const generationIdRef = useRef(0);
  const genIntervalRef = useRef(null);
  const refineIntervalRef = useRef(null);
  const pageRef = useRef(null);
  const promptTextareaRef = useRef(null);
  const contentRef = useRef(null);

  // Redirect if not authenticated
  useEffect(() => {
    if (!userId) navigate('/', { replace: true });
  }, []);

  // Resize prompt textarea when prompt is set externally (e.g. suggestion click)
  useEffect(() => {
    const el = promptTextareaRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = el.scrollHeight + 'px';
  }, [prompt]);

  // Scroll chat to bottom when keyboard opens or new messages arrive
  useEffect(() => {
    if (phase === 'refine' && contentRef.current) {
      contentRef.current.scrollTop = contentRef.current.scrollHeight;
    }
  }, [keyboardOpen, phase, chatMessages]);

  // On iOS, shrink the page to the visual viewport height when keyboard opens,
  // and track keyboard state so we can hide the intro heading.
  useEffect(() => {
    document.body.style.overflow = 'hidden';

    const vv = window.visualViewport;
    if (!vv) return () => { document.body.style.overflow = ''; };

    // Keep the page perfectly aligned with the visual viewport.
    // On iOS, when the keyboard opens, vv.offsetTop becomes non-zero as the OS
    // scrolls to show the focused input — we compensate with a translateY so the
    // page moves down to match the visual viewport's top edge.
    const update = () => {
      if (!pageRef.current) return;
      pageRef.current.style.height = vv.height + 'px';
      pageRef.current.style.transform = `translateY(${vv.offsetTop}px)`;
      // Reveal the page once the viewport has settled (hides the flash during
      // keyboard opening where intermediate positions would otherwise be visible)
      pageRef.current.style.opacity = '1';
    };

    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    return () => {
      document.body.style.overflow = '';
      window.scrollTo(0, 0);
      if (pageRef.current) {
        pageRef.current.style.height = '';
        pageRef.current.style.transform = '';
      }
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
      if (pageRef.current) pageRef.current.style.opacity = '';
    };
  }, []);

  const hidePageForKeyboard = () => {
    if (pageRef.current) pageRef.current.style.opacity = '0';
  };

  const showPage = () => {
    if (pageRef.current) pageRef.current.style.opacity = '1';
  };

  const handleGenerate = async (retryCount = 0) => {
    if (!prompt.trim()) return;

    if (retryCount === 0) {
      if (isGeneratingRef.current) return;
      isGeneratingRef.current = true;
      generationIdRef.current += 1;
      setLoading(true);
      setGeneratingPrompt(prompt.trim());
      setPhase('loading');
      setError(null);
      setWeeklyLimitReached(false);
    }

    const myGenerationId = generationIdRef.current;

    const messages = getGenreMessages(prompt);
    let idx = 0;
    setGeneratingMessage(messages[0]);
    genIntervalRef.current = setInterval(() => {
      idx = (idx + 1) % messages.length;
      setGeneratingMessage(messages[idx]);
    }, 1500);

    let willRetry = false;
    try {
      const result = await playlistService.generatePlaylist(
        prompt.trim(), userId, activePlatform, allowExplicit, newArtistsOnly, songCount
      );
      clearInterval(genIntervalRef.current);

      // Ignore stale responses from a previous generation attempt
      if (myGenerationId !== generationIdRef.current) return;

      const playlist = {
        ...result,
        originalPrompt: prompt.trim(),
        requestedSongCount: songCount,
        chatMessages: [],
        excludedSongs: [],
        lockedTrackIds: [...lockedTrackIds],
      };

      if (retryCount === 0 && isPaid()) {
        try {
          const draft = await playlistService.saveDraft(userId, playlist);
          playlist.draftId = draft.draftId;
          // Save again so draftId is stored inside playlist_data (needed on reload)
          playlistService.saveDraft(userId, playlist).catch(() => {});
        } catch (_) {}
      }

      if (playlist.tracks?.length > 0) {
        setGeneratedPlaylist(playlist);
        setPhase('tracks');
      } else {
        setError('No tracks found. Please try a different prompt.');
      }
      setNewArtistsOnly(false);
      setSongCount(30);
      isGeneratingRef.current = false;
    } catch (err) {
      clearInterval(genIntervalRef.current);

      if (err.response?.status === 429 && err.response?.data?.code === 'WEEKLY_LIMIT_REACHED') {
        const resetsAt = err.response.data.resetsAt;
        const resetDate = resetsAt
          ? new Date(resetsAt).toLocaleDateString('en-US', { month: 'long', day: 'numeric' })
          : 'next week';
        setError(`You've hit your weekly limit. Come back on ${resetDate}.`);
        setWeeklyLimitReached(true);
        isGeneratingRef.current = false;
        setLoading(false);
        return;
      }

      const isRetryable = !err.response || [502, 503, 504].includes(err.response?.status);
      if (isRetryable && retryCount < 2) {
        willRetry = true;
        await new Promise(r => setTimeout(r, Math.pow(2, retryCount) * 1000));
        return handleGenerate(retryCount + 1);
      }

      setError(err.response?.data?.error || 'Something went wrong. Please try again.');
      isGeneratingRef.current = false;
    } finally {
      // Don't clear loading state if we're about to retry — keeps the button disabled
      if (!willRetry && (retryCount === 0 || retryCount >= 2)) {
        setLoading(false);
        setGeneratingMessage('');
      }
    }
  };

  const removeTrack = (trackId) => {
    const track = generatedPlaylist?.tracks?.find(t => t.id === trackId);
    setGeneratedPlaylist(prev => ({
      ...prev,
      tracks: prev.tracks.filter(t => t.id !== trackId),
      excludedSongs: track ? [...(prev.excludedSongs || []), track] : (prev.excludedSongs || []),
    }));
    if (track) showToast('Song removed', 'success');
  };

  const toggleLock = (trackId) => {
    const wasLocked = lockedTrackIds.has(trackId);
    setLockedTrackIds(prev => {
      const next = new Set(prev);
      wasLocked ? next.delete(trackId) : next.add(trackId);

      // Persist to draft immediately so the lock survives navigation.
      // Only save if draftId is already a draft-* key to avoid overwriting a live playlist record.
      if (generatedPlaylist?.draftId?.startsWith('draft-') && isPaid()) {
        playlistService.saveDraft(userId, {
          ...generatedPlaylist,
          lockedTrackIds: [...next],
        }).catch(() => {});
      }

      return next;
    });
    showToast(wasLocked ? 'Song removed from keep list' : "Song locked, song won't change when refining", 'success');
  };

  const handleRefine = async () => {
    if (!chatInput.trim() || chatLoading) return;
    const userMessage = chatInput.trim();

    setChatInput('');
    setChatLoading(true);
    setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);

    const msgs = ['Analyzing your request...', 'Finding the perfect tracks...', 'Curating your updated playlist...', 'Almost there...'];
    let i = 0;
    setRefineMessage(msgs[0]);
    refineIntervalRef.current = setInterval(() => {
      i = (i + 1) % msgs.length;
      setRefineMessage(msgs[i]);
    }, 1500);

    try {
      const originalPromptToUse = generatedPlaylist.originalPrompt || generatedPlaylist.playlistName;
      const descriptionContext = generatedPlaylist.description
        ? `\n\nPlaylist description: ${generatedPlaylist.description}` : '';
      const previousRefinements = chatMessages
        .filter(m => m.role === 'user').map(m => m.content).join('. ');
      const allTracks = generatedPlaylist.tracks || [];
      const lockedTracks = allTracks.filter(t => lockedTrackIds.has(t.id));
      const lockedContext = lockedTracks.length > 0
        ? `\n\nKeep these songs exactly as-is: ${lockedTracks.map(t => `"${t.name}" by ${t.artist}`).join(', ')}.`
        : '';
      const playlistArtists = [...new Set(allTracks.map(t => t.artist).filter(Boolean))].slice(0, 10);
      const artistContext = playlistArtists.length > 0
        ? `\n\nKey artists in this playlist: ${playlistArtists.join(', ')}.`
        : '';
      const refinementPrompt = previousRefinements
        ? `Original request: "${originalPromptToUse}"${descriptionContext}${lockedContext}${artistContext}\n\nPrevious refinements: ${previousRefinements}\n\nNew refinement: ${userMessage}`
        : `Original request: "${originalPromptToUse}"${descriptionContext}${lockedContext}${artistContext}\n\nRefinement: ${userMessage}`;

      const totalSongCount = generatedPlaylist.requestedSongCount || 30;
      const newSongCount = Math.max(1, totalSongCount - lockedTracks.length);
      const lockedUris = lockedTracks.map(t => t.uri).filter(Boolean);
      const excludedUris = (generatedPlaylist.excludedSongs || []).map(s => s.uri).filter(Boolean);

      const result = await playlistService.generatePlaylist(
        refinementPrompt,
        userId,
        activePlatform,
        allowExplicit,
        false,
        newSongCount,
        [...excludedUris, ...lockedUris],
        generatedPlaylist.playlistId || generatedPlaylist.draftId
      );

      clearInterval(refineIntervalRef.current);
      setRefineMessage('');

      const finalChatMessages = [
        ...chatMessages,
        { role: 'user', content: userMessage },
        { role: 'assistant', content: 'Updated your playlist.' },
      ];

      // Merge locked tracks back in at their original positions
      let mergedTracks = result.tracks || [];
      if (lockedTracks.length > 0) {
        const originalPositions = allTracks.reduce((acc, t, i) => {
          if (lockedTrackIds.has(t.id)) acc[t.id] = i;
          return acc;
        }, {});
        // Insert locked tracks at their original indices
        const merged = [...mergedTracks];
        for (const lt of lockedTracks) {
          const pos = Math.min(originalPositions[lt.id], merged.length);
          merged.splice(pos, 0, lt);
        }
        mergedTracks = merged;
      }

      const updated = {
        ...result,
        tracks: mergedTracks,
        originalPrompt: generatedPlaylist.originalPrompt,
        requestedSongCount: generatedPlaylist.requestedSongCount,
        excludedSongs: generatedPlaylist.excludedSongs,
        draftId: generatedPlaylist.draftId,
        playlistId: generatedPlaylist.playlistId,
        chatMessages: finalChatMessages,
        lockedTrackIds: [...lockedTrackIds],
      };

      setChatMessages(finalChatMessages);
      setGeneratedPlaylist(updated);
      setPhase('tracks');
      setChatLoading(false);

      // Persist chat history back to the draft so it survives navigation.
      // If draftId is a live playlist ID (not yet a draft-* key), await the save so we can
      // capture the server-assigned draft-* ID and update state — prevents the live playlist
      // record from being overwritten and avoids creating a new draft on every subsequent save.
      if (updated.draftId && isPaid()) {
        const needsDraftIdUpdate = !updated.draftId.startsWith('draft-');
        if (needsDraftIdUpdate) {
          try {
            const saved = await playlistService.saveDraft(userId, updated);
            if (saved?.draftId) {
              setGeneratedPlaylist(prev => ({ ...prev, draftId: saved.draftId }));
            }
          } catch (_) {}
        } else {
          playlistService.saveDraft(userId, updated).catch(() => {});
        }
      }
    } catch (err) {
      clearInterval(refineIntervalRef.current);
      setRefineMessage('');
      setChatMessages(prev => prev.slice(0, -1));
      setChatInput(userMessage);
      setPhase('refine');
      setChatLoading(false);
    }
  };

  const handleCreate = () => {
    navigate('/', {
      state: {
        pendingPlaylist: generatedPlaylist,
        pendingChatMessages: chatMessages,
        returnTab,
      },
    });
  };

  const goBack = () => {
    const updatedDraft = generatedPlaylist?.draftId
      ? { ...generatedPlaylist, lockedTrackIds: [...lockedTrackIds] }
      : null;
    if (phase === 'refine') {
      if (refineMode) { navigate('/', { state: { returnTab, updatedDraft } }); return; }
      setPhase('tracks');
      return;
    }
    if (phase === 'loading') { setPhase('input'); return; }
    if (phase === 'tracks') { navigate('/', { state: { returnTab, updatedDraft } }); return; }
    navigate('/', { state: { returnTab } });
  };

  return (
    <div className="generate-page" ref={pageRef}>
      {/* Header */}
      <div className="generate-header">
        <button className="generate-back-btn" onClick={goBack}>
          {phase === 'refine' ? <Icons.ChevronLeft size={22} /> : <Icons.Close size={20} />}
        </button>
        {(phase === 'tracks' || phase === 'loading') && generatedPlaylist && (
          <div className="generate-header-meta">
            <div className="generate-header-playlist-name">{generatedPlaylist.playlistName}</div>
            <div className="generate-header-song-count">{generatedPlaylist.tracks?.length || 0} songs</div>
          </div>
        )}
        {phase === 'refine' && (
          <div className="generate-header-meta">
            <div className="generate-header-playlist-name">Refine playlist</div>
            <div className="generate-header-song-count">{generatedPlaylist?.playlistName}</div>
          </div>
        )}
      </div>

      {/* Scrollable content for non-refine phases — kept in DOM as flex:1 spacer */}
      {phase !== 'refine' && (
        <div className="generate-content" ref={contentRef}>
          {phase === 'input' && (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minHeight: '100%' }}>
              <div className="generate-intro">
                <h2>What's the vibe today?</h2>
                <p>Let's make a playlist together.</p>
              </div>
              <div className="generate-tips-card">
                <div className="generate-tips-title">Tips for great playlists</div>
                <div>• Be specific — include artist names, genres, energy level, or era</div>
                <div style={{ marginTop: 4 }}>• Example: <em>"Upbeat indie songs like Phantogram from the past 5 years"</em></div>
              </div>
              {!keyboardOpen && (
                <>
                  <div className="generate-suggestions-label">Try asking</div>
                  {SUGGESTIONS.map(s => (
                    <button key={s} className="generate-suggestion-card" onClick={() => setPrompt(s)}>
                      <Icons.Sparkles size={16} style={{ flexShrink: 0 }} />
                      {s}
                    </button>
                  ))}
                </>
              )}
            </div>
          )}

          {phase === 'loading' && (
            <div style={{ display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', minHeight: '100%' }}>
              {generatingPrompt && <div className="generate-user-bubble">{generatingPrompt}</div>}
              {error ? (
                <div className="generate-error-box">
                  <span>{error}</span>
                  {weeklyLimitReached
                    ? <button onClick={() => navigate('/')}>Upgrade</button>
                    : <button onClick={() => { setError(null); handleGenerate(); }}>Try Again</button>
                  }
                </div>
              ) : (
                <div className="generate-ai-bubble" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div className="wave-loader-small">
                    <div className="wave-bar"></div>
                    <div className="wave-bar"></div>
                    <div className="wave-bar"></div>
                    <div className="wave-bar"></div>
                  </div>
                  <span style={{ fontSize: 13, color: '#b3b3b3' }}>{generatingMessage || 'Creating your playlist...'}</span>
                </div>
              )}
            </div>
          )}

          {phase === 'tracks' && generatedPlaylist && (
            <>
              {generatedPlaylist.tracks.map(track => (
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
                      <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                    </button>
                    <button
                      className={`generate-track-keep ${lockedTrackIds.has(track.id) ? 'active' : ''}`}
                      onClick={() => toggleLock(track.id)}
                      title={lockedTrackIds.has(track.id) ? 'Unkeep' : 'Keep when refining'}
                    >
                      {lockedTrackIds.has(track.id)
                        ? <svg viewBox="0 0 24 24" width="20" height="20" fill="currentColor"><path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 14.5v-9l6 4.5-6 4.5z"/></svg>
                        : <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/></svg>
                      }
                    </button>
                  </div>
                </div>
              ))}
              {generatedPlaylist.description && (
                <div className="generate-ai-summary">{generatedPlaylist.description}</div>
              )}
            </>
          )}
        </div>
      )}

      {/* Refine phase: wrapper owns both the scrollable chat history and the input bar
          so the input bar is always pinned to the bottom of the available space. */}
      {phase === 'refine' && (
        <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
          <div className="generate-content" ref={contentRef}>
            {generatedPlaylist?.originalPrompt && (
              <div className="generate-user-bubble">{generatedPlaylist.originalPrompt}</div>
            )}
            {chatMessages.map((msg, i) => (
              <div key={i} className={msg.role === 'user' ? 'generate-user-bubble' : 'generate-ai-bubble'}>
                {msg.content}
              </div>
            ))}
            {chatLoading && (
              <div className="generate-ai-bubble" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <div className="wave-loader-small">
                  <div className="wave-bar"></div>
                  <div className="wave-bar"></div>
                  <div className="wave-bar"></div>
                  <div className="wave-bar"></div>
                </div>
                <span style={{ fontSize: 13, color: '#b3b3b3' }}>{refineMessage}</span>
              </div>
            )}
            {chatMessages.length === 0 && !keyboardOpen && !chatLoading && (
              <>
                <div className="generate-suggestions-label">Try asking</div>
                {REFINE_SUGGESTIONS.map(s => (
                  <button key={s} className="generate-suggestion-card" onClick={() => setChatInput(s)}>
                    <Icons.Sparkles size={16} style={{ flexShrink: 0 }} />
                    {s}
                  </button>
                ))}
              </>
            )}
          </div>
          <div className="generate-input-bar">
            <div className="generate-input-row">
              <Icons.Sparkles size={18} style={{ color: '#b3b3b3', flexShrink: 0 }} />
              <textarea
                className="generate-text-input"
                value={chatInput}
                onChange={e => { setChatInput(e.target.value); e.target.style.height = '0px'; e.target.style.height = e.target.scrollHeight + 'px'; }}
                onKeyPress={e => { if (e.key === 'Enter' && !e.shiftKey && chatInput.trim() && !chatLoading) { e.preventDefault(); handleRefine(); } }}
                onFocus={() => setKeyboardOpen(true)}
                onBlur={() => setKeyboardOpen(false)}
                placeholder="Tell me what to change..."
                rows={1}
              />
              <button
                className="generate-send-btn"
                onClick={handleRefine}
                disabled={chatLoading || !chatInput.trim()}
                style={{ visibility: chatInput.trim() ? 'visible' : 'hidden' }}
              >
                <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Bottom bar — marginTop:auto pins it to bottom of flex container */}
      {phase === 'input' && (
        <div className="generate-input-bar" style={{ marginTop: 'auto' }}>
          <div className="generate-input-row">
            <Icons.Sparkles size={18} style={{ color: '#b3b3b3', flexShrink: 0 }} />
            <textarea
              ref={promptTextareaRef}
              className="generate-text-input"
              value={prompt}
              onChange={e => { setPrompt(e.target.value); e.target.style.height = '0px'; e.target.style.height = e.target.scrollHeight + 'px'; }}
              onKeyPress={e => { if (e.key === 'Enter' && !e.shiftKey && prompt.trim() && !loading) { e.preventDefault(); handleGenerate(); } }}
              onFocus={() => setKeyboardOpen(true)}
              onBlur={() => setKeyboardOpen(false)}
              placeholder="Tell me your ideas"
              rows={1}
            />
            <button
              className="generate-send-btn"
              onClick={() => handleGenerate()}
              disabled={loading || !prompt.trim()}
              style={{ visibility: prompt.trim() ? 'visible' : 'hidden' }}
            >
              <svg viewBox="0 0 24 24"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>
            </button>
          </div>
          <div className="generate-options-row">
            <button
              className={`generate-option-chip ${newArtistsOnly ? 'active' : ''}`}
              onClick={() => setNewArtistsOnly(!newArtistsOnly)}
            >
              <Icons.Sparkles size={13} /> New Artists Only
            </button>
            <div className="generate-option-chip">
              <Icons.Music size={13} />
              <span>Songs</span>
              <input
                type="number"
                value={songCountDraft}
                onChange={e => setSongCountDraft(e.target.value)}
                onBlur={() => { const n = parseInt(songCountDraft, 10); const v = isNaN(n) || n < 1 ? 30 : n; setSongCount(v); setSongCountDraft(v); }}
                className="generate-song-count-input"
              />
            </div>
          </div>
        </div>
      )}

      {phase === 'tracks' && generatedPlaylist && (
        <div className="generate-footer" style={{ marginTop: 'auto' }}>
          <button className="generate-refine-btn" onClick={() => setPhase('refine')}>
            ✦ Refine
          </button>
          <button className="generate-create-btn" onClick={handleCreate}>
            {refineMode ? 'Done' : 'Create'}
          </button>
        </div>
      )}

      {/* Toast Container */}
      {toasts.length > 0 && (
        <div className="toast-container generate-toast-container">
          {toasts.map(t => (
            <Toast key={t.id} message={t.message} type={t.type} onClose={() => removeToast(t.id)} />
          ))}
        </div>
      )}
    </div>
  );
}
