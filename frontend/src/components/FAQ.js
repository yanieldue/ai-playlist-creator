import React, { useState } from 'react';
import Icons from './Icons';
import '../styles/FAQ.css';

const FAQ = ({ onBack }) => {
  const [expandedFaqId, setExpandedFaqId] = useState(null);

  // FAQ data
  const faqs = [
    {
      id: 1,
      question: "How do I connect my Spotify account?",
      answer: "Click on 'Account' in the menu, then select 'Connected Music Platforms'. Click the 'Connect' button next to Spotify and you'll be redirected to Spotify to authorize the connection."
    },
    {
      id: 2,
      question: "Can I connect multiple music platforms?",
      answer: "Yes! You can connect both Spotify and Apple Music to your account. Your playlists will be synced to whichever platform you choose when generating or refreshing a playlist."
    },
    {
      id: 3,
      question: "How do I create a playlist?",
      answer: "Go to 'Generate Playlist' and describe what kind of music you want in natural language. For example, 'upbeat 80s pop songs' or 'relaxing acoustic music for studying'. Our AI will generate a personalized playlist based on your description."
    },
    {
      id: 4,
      question: "How do automatic playlist refreshes work?",
      answer: "When you enable auto-refresh for a playlist, we'll automatically update it with new songs based on your chosen frequency (daily, weekly, or monthly). The playlist will maintain its vibe while introducing fresh tracks. You can configure this in the playlist edit settings."
    },
    {
      id: 5,
      question: "What happens if I disconnect a music platform?",
      answer: "Disconnecting a platform will prevent new playlists from being created on that service, but your existing playlists will remain on the platform. You can reconnect at any time to resume playlist creation."
    },
    {
      id: 6,
      question: "How do I change my email or password?",
      answer: "Go to 'Account' in the menu, then click on 'Email' or 'Password'. You'll need to confirm your current password to make changes for security purposes."
    },
    {
      id: 7,
      question: "Can I refine playlists after they're created?",
      answer: "Absolutely! Go to 'My Playlists', click on any playlist, and click 'Edit Playlist'. You can use the 'Refine Playlist' option to chat with our AI and adjust the vibe, add or remove genres, change tempo, and more."
    },
    {
      id: 8,
      question: "How do I remove songs from a playlist?",
      answer: "In 'My Playlists', expand the playlist you want to edit, then click 'Edit Playlist'. You'll see checkboxes next to each song - select the ones you want to remove and click 'Remove Selected Songs'."
    },
    {
      id: 9,
      question: "What is manual refresh and how does it work?",
      answer: "Manual refresh lets you update your playlist with new songs whenever you want. Click 'Edit Playlist' on any playlist, go to the Manual Refresh section, specify how many new songs you want, and whether to only include new artists. The playlist will be updated immediately."
    },
    {
      id: 10,
      question: "Can I see my unfinished playlists?",
      answer: "Yes! Unfinished playlists are drafts that haven't been finalized yet. You can find them in the 'Unfinished Playlists' section on the Generate Playlist page. You can continue editing them or finalize them to add them to your Spotify account."
    },
    {
      id: 11,
      question: "How do I delete a playlist?",
      answer: "In 'My Playlists', click the three-dot menu (⋮) in the top-right corner of any playlist card, then select 'Delete Playlist'. This will remove the playlist from our system, but if it's already on Spotify, you'll need to delete it from there separately."
    },
    {
      id: 12,
      question: "What settings can I customize?",
      answer: "In the Settings page, you can enable/disable dark mode and set the default number of songs for new playlists. More customization options will be added in future updates!"
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
            <div key={faq.id} className="faq-item-wrapper">
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
