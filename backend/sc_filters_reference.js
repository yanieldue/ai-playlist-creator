// SoundCharts API Filter Reference
// Complete lists of valid values for songGenres, songSubGenres, moods, and themes.
// All values must be sent lowercase to the SC API (e.g. 'sensual', not 'Sensual').
// Song counts as of ~March 2026.

const SC_MOODS = [
  'aggressive',      // 259.2K
  'amusing',         // 51.3K
  'anxious',         // 32.7K
  'bittersweet',     // 2.6M
  'bizarre',         // 2.8K
  'boastful',        // 334K
  'bouncy',          // 261
  'calm',            // 15.9K
  'cheerful',        // 998
  'complex',         // 1.9K
  'confessional',    // 2.2M
  'confident',       // 902K
  'confrontational', // 241.8K
  'controversial',   // 648
  'conversational',  // 1K
  'critical',        // 133.2K
  'cynical',         // 247.8K
  'dark',            // 807.7K
  'desperate',       // 149K
  'devotional',      // 240.1K
  'dreamy',          // 263.4K
  'emotional',       // 372K
  'empowering',      // 2.8M
  'energetic',       // 326.7K
  'epic',            // 7.8K
  'euphoric',        // 759K
  'excited',         // 21.4K
  'frustrated',      // 161.9K
  'haunting',        // 16.1K
  'hopeful',         // 1.5M
  'inspirational',   // 48.7K
  'intense',         // 1.1M
  'introspective',   // 1M
  'joyful',          // 2.9M
  'melancholic',     // 5M
  'narrative',       // 426
  'nostalgic',       // 1.3M
  'playful',         // 1.1M
  'poetic',          // 5.2K
  'reflective',      // 8.5M
  'romantic',        // 2.4M
  'sad',             // 1.7M
  'sensual',         // 57.2K
  'sentimental',     // 1.7M
  'serious',         // 40.3K
  'sincere',         // 2.7K
  'uplifting',       // 190.8K
];

const SC_THEMES = [
  'acceptance',            // 42.5K
  'addiction',             // 147.6K
  'adventure',             // 48.4K
  'alcohol use',           // 27.3K
  'ambition',              // 333.4K
  'anger',                 // 314.3K
  'beauty',                // 110.8K
  'betrayal',              // 100.1K
  'celebration',           // 1.1M
  'change',                // 65.6K
  'childhood',             // 107.8K
  'coming of age',         // 123K
  'commitment',            // 32K
  'communication',         // 9.6K
  'community',             // 229.8K
  'conflict',              // 159.3K
  'confusion',             // 36.7K
  'connection',            // 26.7K
  'control',               // 31.2K
  'controversy',           // 15.1K
  'criticism',             // 35.8K
  'cultural appropriation',// 49.6K
  'dance and partying',    // 143.4K
  'danger',                // 15.1K
  'deception',             // 22.3K
  'dependency',            // 5.3K
  'depression',            // 754.6K
  'desire',                // 2.5M
  'despair',               // 776.3K
  'desperation',           // 40.3K
  'destiny',               // 3.3K
  'destruction',           // 66.6K
  'disappointment',        // 400.9K
  'distance',              // 1.1K
  'dreams and aspirations',// 526.1K
  'drug use',              // 203.4K
  'education',             // 11.9K
  'empathy',               // 40.8K
  'empowerment',           // 5.4M
  'environmentalism',      // 25.5K
  'escapism',              // 1.9M
  'euphoria',              // 2.5K
  'excitement',            // 5.4K
  'existentialism',        // 120.8K
  'exploration',           // 9.6K
  'faith',                 // 462.7K
  'fame',                  // 4.2K
  'family',                // 249.3K
  'fear',                  // 165.2K
  'forgiveness',           // 27.4K
  'freedom',               // 95.7K
  'friendship',            // 634.5K
  'frustration',           // 12.5K
  'gender roles',          // 5.5K
  'global issues',         // 704
  'gratitude',             // 69.4K
  'greed',                 // 10K
  'grief',                 // 2.4M
  'happiness',             // 337.4K
  'healing',               // 44.7K
  'health',                // 10.4K
  'heartbreak',            // 4.5M
  'hedonism',              // 519.5K
  'hip-hop rivalry',       // 348
  'history',               // 12.7K
  'home and belonging',    // 60.5K
  'hope',                  // 2.3M
  'humor',                 // 95K
  'identity',              // 2M
  'industry criticism',    // 370
  'innocence',             // 1.6K
  'insecurity',            // 5.3K
  'inspiration',           // 834
  'intimacy',              // 56.5K
  'jealousy',              // 24.4K
  'journey',               // 28.7K
  'justice',               // 21K
  'karma',                 // 1.9K
  'liberation',            // 488
  'life and existence',    // 36.3K
  'loneliness',            // 6M
  'longing',               // 2.8M
  'loss',                  // 489.3K
  'love',                  // 4.6M
  'loyalty',               // 9.9K
  'magic',                 // 7K
  'materialism',           // 113.6K
  'media criticism',       // 1.6K
  'melancholy',            // 95.6K
  'memories',              // 46.2K
  'memory',                // 20K
  'mental health',         // 940K
  'money',                 // 18.4K
  'moving on',             // 73K
  'music',                 // 43.1K
  'mystery',               // 7.6K
  'nationalism',           // 5.3K
  'nature',                // 149.8K
  'nostalgia',             // 1.5M
  'obsession',             // 30.3K
  'oppression',            // 115K
  'overcoming adversity',  // 2.2M
  'pain',                  // 48.3K
  'passion',               // 4.3K
  'patriotism',            // 5.7K
  'peace',                 // 11.2K
  'perseverance',          // 21.5K
  'politics',              // 24.1K
  'poverty',               // 15.1K
  'power',                 // 51.6K
  'pride',                 // 10.2K
  'racism',                // 10K
  'rebellion',             // 230.6K
  'redemption',            // 153.7K
  'regret',                // 274.2K
  'relationships',         // 5.4M
  'religion',              // 3.7K
  'revenge',               // 17.1K
  'romantic disappointment',// 128.3K
  'sacrifice',             // 12.7K
  'searching',             // 14.1K
  'seasons',               // 5.7K
  'secrets',               // 4.1K
  'self-discovery',        // 5.3M
  'self-expression',       // 252.2K
  'separation',            // 19.8K
  'sexuality',             // 180.6K
  'social change',         // 660.7K
  'spirituality',          // 508.2K
  'struggle',              // 318.9K
  'success',               // 274.7K
  'summer love',           // 14.3K
  'support',               // 149.2K
  'survival',              // 44.3K
  'technology',            // 12.9K
  'temptation',            // 4.6K
  'time',                  // 47.5K
  'tradition',             // 17.8K
  'transformation',        // 28.2K
  'travel and adventure',  // 14.3K
  'trust',                 // 27K
  'uncertainty',           // 1.9K
  'unity',                 // 40K
  'urban life',            // 158.2K
  'violence',              // 411.3K
  'vulnerability',         // 17.5K
  'waiting',               // 5.1K
  'war',                   // 57.9K
  'wealth',                // 36.1K
  'wealth inequality',     // 3.9K
  'work',                  // 25.1K
  'worship',               // 28.5K
  'youth culture',         // 266K
];

const SC_GENRES = [
  'african',      // 650.8K
  'alternative',  // 6.9M
  'asian',        // 1.4M
  'blues',        // 595.7K
  'classical',    // 2.5M
  'country',      // 1.1M
  'electro',      // 10.3M
  'european',     // 62.7K
  'folk',         // 3.2M
  'hip hop',      // 13M
  'holiday',      // 133.3K
  'instrumental', // 29.6K
  'jazz',         // 2.3M
  'kids',         // 1M
  'latin',        // 4.7M
  'mena',         // 137.4K
  'metal',        // 1.4M
  'others',       // 3.1M
  'pop',          // 13.3M
  'r&b',          // 3.4M
  'reggae',       // 894.6K
  'religious',    // 1.6M
  'rock',         // 9.8M
  'soundtrack',   // 2.4M
  'spoken',       // 317.5K
  'sports',       // 54.1K
];

const SC_SUBGENRES = [
  'acoustic blues',          // 4.6K
  'african',                 // 649.1K
  'afrikaans',               // 2.8K
  'afrobeats',               // 902
  'alternative',             // 6.9M
  'amapiano',                // 962
  'anime',                   // 17.4K
  'arabesque',               // 264
  'arabic',                  // 5.1K
  'asian',                   // 1.2M
  'audiobooks',              // 925.7K
  'baile funk',              // 11.2K
  'banda/grupero',           // 18.5K
  'baroque',                 // 53K
  'bluegrass',               // 1.1K
  'blues',                   // 595.7K
  'bolero',                  // 50.6K
  'bollywood',               // 63.5K
  'bossa',                   // 1.2K
  'brasilian music',         // 990.3K
  'cantonese pop',           // 6.5K
  'chicago blues',           // 11.7K
  "children's music",        // 1.5M
  'chill out/trip-hop/lounge', // 260.9K
  'christian',               // 1.6M
  'christmas',               // 133.3K
  'classical',               // 2.5M
  'classical period',        // 15K
  'comedy',                  // 234.5K
  'contemporary r&b',        // 36.2K
  'contemporary soul',       // 26.4K
  'corridos',                // 28.3K
  'country',                 // 1.1M
  'cumbia',                  // 69.3K
  'dance',                   // 6.5M
  'dancehall/ragga',         // 118.5K
  'dirty south',             // 22.2K
  'disco',                   // 192.7K
  'dub',                     // 48.4K
  'dubstep',                 // 69.4K
  'east coast',              // 21.3K
  'electronic',              // 8.4M
  'electro pop/electro rock',// 20.3K
  'film ost',                // 931.4K
  'flamenco',                // 16.8K
  'folk',                    // 1.5M
  'forro',                   // 15.5K
  'french chanson',          // 73.5K
  'french pop',              // 21.4K
  'french rap',              // 36.5K
  'french rock',             // 2.4K
  'german pop',              // 29.4K
  'gospel',                  // 280.9K
  'grime',                   // 14.1K
  'hard rock',               // 362.9K
  'hip-hop & rap',           // 13M
  'indian music',            // 176.5K
  'indie pop',               // 1.4M
  'indie pop/folk',          // 236.4K
  'indie rock',              // 2.1M
  'indie rock/pop rock',     // 387K
  'international folklore',  // 233.7K
  'international pop',       // 268.5K
  'jazz',                    // 2.3M
  'jazz instrumental',       // 29.6K
  'jazz vocal',              // 14.9K
  'j-pop',                   // 69.5K
  'k-pop',                   // 216.2K
  'latin',                   // 3.8M
  'mandarin pop',            // 19.7K
  'metal',                   // 1.4M
  'middle eastern',          // 130.3K
  'musical theater',         // 44.8K
  'norteño',                 // 66.6K
  'old school r&b',          // 4K
  'opera',                   // 101.3K
  'ost',                     // 1.6M
  'pop',                     // 12.1M
  'pop in spanish',          // 11.2K
  'r&b',                     // 1.3M
  'r&b, funk & soul',        // 3M
  'reggae',                  // 894.6K
  'reggaeton',               // 157.5K
  'rock',                    // 8.7M
  'rock & roll/rockabilly',  // 173.5K
  'salsa',                   // 34.1K
  'singer/songwriter',       // 2.3M
  'ska',                     // 141.4K
  'soul',                    // 879.4K
  'spoken word',             // 82K
  'techno/house',            // 940.2K
  'trance',                  // 262.4K
  'traditional mexicano',    // 161.9K
  'urbano latino',           // 12.3K
  'west coast',              // 3.1K
  'worldwide',               // 3M
];

module.exports = { SC_MOODS, SC_THEMES, SC_GENRES, SC_SUBGENRES };
