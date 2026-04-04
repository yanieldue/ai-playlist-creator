import React, { useState, useEffect, useRef } from 'react';
import Icons from './Icons';
import '../styles/FAQ.css';

const FAQ = ({ onBack }) => {
  const [expandedFaqId, setExpandedFaqId] = useState(null);
  const didAutoExpand = useRef(false);

  useEffect(() => {
    if (didAutoExpand.current) return;
    const hash = window.location.hash; // e.g. "#faq-14"
    if (!hash.startsWith('#faq-')) return;
    const id = parseInt(hash.slice(5), 10);
    if (!id) return;
    didAutoExpand.current = true;
    setExpandedFaqId(id);
    setTimeout(() => {
      const el = document.getElementById(`faq-${id}`);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  }, []);

  // FAQ data
  const faqs = [
    {
      id: 1,
      question: "How do I connect my music platform?",
      answer: "Tap 'Account' in the menu, then select 'Connected Music Platforms'. Tap 'Connect' next to Spotify or Apple Music and follow the steps to authorize. We currently support both platforms, with more coming in the future."
    },
    {
      id: 2,
      question: "How do I create a playlist?",
      answer: "Tap the + button on the home screen to see three options: From Prompt (describe what you want in natural language), From Mix (paste a YouTube DJ mix URL), or From Artist (search for an artist and build a playlist around their sound)."
    },
    {
      id: 3,
      question: "How does Create from Mix work?",
      answer: "Paste a YouTube DJ mix URL and Fins will look for the tracklist in the video description and top comments. If a tracklist is found, it matches each song to your music platform and creates the playlist. This works best with mixes that include a tracklist. Identifying songs from audio alone is not yet supported, but we're working on it."
    },
    {
      id: 4,
      question: "How do automatic playlist refreshes work?",
      answer: "When you enable auto-refresh for a playlist, it will automatically update with new songs at your chosen frequency (daily, weekly, or monthly). The playlist keeps its vibe while bringing in fresh songs. You can configure this in the playlist edit settings."
    },
    {
      id: 5,
      question: "What happens if I disconnect a music platform?",
      answer: "Disconnecting a platform will prevent new playlists from being created on that service, but your existing playlists will remain on the platform. You can reconnect at any time to resume."
    },
    {
      id: 6,
      question: "How do I change my email or password?",
      answer: "Go to 'Account' in the menu, then tap 'Email' or 'Password'. You'll need to confirm your current password to make changes."
    },
    {
      id: 7,
      question: "Can I refine playlists after they're created?",
      answer: "Yes. Go to 'My Playlists', tap the ⋮ menu on any playlist, and select 'Edit Playlist'. From there you can add refinement instructions to adjust the vibe, genres, tempo, and more. Refinements carry over to future auto-updates."
    },
    {
      id: 8,
      question: "How do I lock a song so it stays in my playlist?",
      answer: "Open a playlist and tap the lock icon next to any song. Locked songs are kept during manual and auto-refreshes. Tap the lock again to unlock and let the song rotate out naturally."
    },
    {
      id: 9,
      question: "How do I remove songs from a playlist?",
      answer: "In 'My Playlists', tap the ⋮ menu on a playlist and select 'Edit Playlist'. You'll see a remove button next to each song. You can also thumbs-down a song to remove it and avoid similar songs in future updates."
    },
    {
      id: 10,
      question: "What is manual refresh and how does it work?",
      answer: "Manual refresh updates your playlist with new songs on demand. Tap the ⋮ menu on any playlist and select 'Edit Playlist', go to the Manual Refresh section, specify how many new songs you want, and the playlist updates immediately."
    },
    {
      id: 11,
      question: "Can I see my unfinished playlists?",
      answer: "Yes. Drafts that haven't been finalized yet appear in the 'Unfinished Playlists' section on the home screen. You can continue editing or finalize them to push to your music platform."
    },
    {
      id: 12,
      question: "How do I delete a playlist?",
      answer: "In 'My Playlists', tap the three-dot menu on any playlist card and select 'Delete Playlist'. This removes it from Fins. If it's already on your music platform, you'll need to delete it there separately."
    },
    {
      id: 13,
      question: "What settings can I customize?",
      answer: "In Settings you can enable dark mode and set the default number of songs for new playlists. More options are coming in future updates."
    },
    {
      id: 14,
      question: "Why are some features limited on Apple Music?",
      answer: (
        <div>
          <p>Apple's Music API places certain restrictions on how third-party apps can interact with your library. As a result, some features in Fins behave differently when used with Apple Music playlists:</p>
          <p><strong>Replace All Songs (Manual Refresh)</strong><br />Apple Music does not allow apps to remove songs via its API. Because of this, Fins only supports "Add Songs" mode, where new tracks are added on top of your existing playlist.</p>
          <p><strong>Thumbs Down</strong><br />When you tap thumbs down, the song is hidden within Fins and helps improve future recommendations. However, it cannot be removed from your Apple Music library.</p>
          <p><strong>Delete Playlist</strong><br />Deleting a playlist in Fins removes it from the app only. The playlist will remain in your Apple Music library and must be deleted there manually.</p>
          <p>We continue to monitor updates to Apple's API and will enable additional functionality as soon as it becomes available.</p>
        </div>
      )
    }
  ];

  const toggleFaq = (faqId) => {
    setExpandedFaqId(expandedFaqId === faqId ? null : faqId);
  };

  return (
    <div className="faq-page">
      <div className="faq-header">
        <h1>FAQ</h1>
      </div>

      <div className="faq-content">
        <div className="faq-list">
          {faqs.map((faq) => (
            <div key={faq.id} id={`faq-${faq.id}`} className="faq-item-wrapper">
              <button
                className="faq-question-button"
                onClick={() => toggleFaq(faq.id)}
              >
                <span className="faq-question-text">{faq.question}</span>
                <Icons.ChevronRight
                  size={20}
                  color="#c7c7cc"
                  style={{
                    transform: expandedFaqId === faq.id ? 'rotate(90deg)' : 'rotate(0deg)',
                    transition: 'transform 0.2s'
                  }}
                />
              </button>

              {expandedFaqId === faq.id && (
                <div className="faq-answer">
                  {faq.answer}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default FAQ;
