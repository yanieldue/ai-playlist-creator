# Architecture & Data Flow

## System Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        USER BROWSER                          │
│                                                              │
│  ┌────────────────────────────────────────────────────┐    │
│  │          React Frontend (Port 3000)                 │    │
│  │                                                     │    │
│  │  - PlaylistGenerator Component                     │    │
│  │  - API Service Layer                               │    │
│  │  - CSS Styling                                     │    │
│  └──────────────────┬──────────────────────────────────┘    │
│                     │                                        │
└─────────────────────┼────────────────────────────────────────┘
                      │ HTTP Requests (axios)
                      │
┌─────────────────────▼────────────────────────────────────────┐
│              Express Backend (Port 3001)                      │
│                                                              │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐     │
│  │   Spotify    │  │   Claude AI   │  │    Auth      │     │
│  │ Integration  │  │  Integration  │  │   Handler    │     │
│  └──────────────┘  └──────────────┘  └──────────────┘     │
│                                                              │
└───────────┬──────────────────┬───────────────────────────────┘
            │                  │
            │                  │
    ┌───────▼────────┐  ┌─────▼──────┐
    │  Spotify API   │  │ Claude API  │
    │  (External)    │  │ (External)  │
    └────────────────┘  └─────────────┘
```

## Request Flow

### 1. User Authentication Flow

```
User clicks "Connect with Spotify"
        │
        ▼
Frontend requests auth URL from backend
        │
        ▼
Backend generates Spotify OAuth URL
        │
        ▼
User redirected to Spotify login
        │
        ▼
User authorizes app
        │
        ▼
Spotify redirects to backend/callback
        │
        ▼
Backend exchanges code for tokens
        │
        ▼
Backend stores tokens & creates userId
        │
        ▼
User redirected back to frontend with userId
        │
        ▼
Frontend stores userId & updates UI
```

### 2. Playlist Generation Flow

```
User enters prompt: "Early 2000's pop music"
        │
        ▼
Frontend sends prompt + userId to backend
        │
        ▼
┌───────────────────────────────────────┐
│     BACKEND PROCESSING STARTS         │
└───────────────────────────────────────┘
        │
        ▼
Step 1: Send prompt to Claude AI
        │
        ▼
Claude analyzes prompt and generates:
  - Playlist name: "Y2K Pop Hits"
  - Description: "The best pop from 2000-2009"
  - Search queries: [
      "britney spears 2000",
      "NSYNC pop",
      "christina aguilera 2000s",
      ...15-20 queries
    ]
        │
        ▼
Step 2: Search Spotify for each query
        │
        ▼
For each search query:
  - Call Spotify Search API
  - Get top 5 tracks
  - Check for duplicates (by track ID)
  - Add unique tracks to collection
  - Wait 100ms (avoid rate limits)
        │
        ▼
Collected ~75-100 unique tracks
        │
        ▼
Step 3: Send tracks to Claude for curation
        │
        ▼
Claude receives track list and selects:
  - Best 25-30 songs matching theme
  - Good variety and flow
  - Popular and high-quality tracks
        │
        ▼
Step 4: Return curated playlist to frontend
        │
        ▼
Frontend displays:
  - Playlist name and description
  - Track list with album art
  - Track count
```

### 3. Playlist Creation Flow

```
User clicks "Create Playlist on Spotify"
        │
        ▼
Frontend sends track URIs to backend
        │
        ▼
Backend authenticates with stored tokens
        │
        ▼
Backend gets user's Spotify ID
        │
        ▼
Backend creates empty playlist on Spotify
        │
        ▼
Backend adds all tracks to playlist
        │
        ▼
Backend returns playlist URL
        │
        ▼
Frontend opens playlist in Spotify
```

## Component Breakdown

### Frontend Components

```
src/
├── index.js
│   └── Renders App to DOM
│
├── App.js
│   └── Root component
│       └── Renders PlaylistGenerator
│
├── components/
│   └── PlaylistGenerator.js
│       ├── State Management
│       │   ├── prompt (user input)
│       │   ├── userId (auth token)
│       │   ├── isAuthenticated (auth status)
│       │   ├── loading (generation state)
│       │   ├── generatedPlaylist (AI results)
│       │   └── error (error messages)
│       │
│       ├── Event Handlers
│       │   ├── handleSpotifyLogin()
│       │   ├── handleGeneratePlaylist()
│       │   ├── handleCreatePlaylist()
│       │   └── handleExampleClick()
│       │
│       └── UI Sections
│           ├── Header
│           ├── Auth Section (if not authenticated)
│           ├── Input Section
│           │   ├── Prompt textarea
│           │   ├── Example chips
│           │   └── Generate button
│           ├── Results Section
│           │   ├── Playlist header
│           │   ├── Track list
│           │   └── Create button
│           └── Footer
│
└── services/
    └── api.js
        ├── getSpotifyAuthUrl()
        ├── generatePlaylist()
        ├── createPlaylist()
        └── healthCheck()
```

### Backend Routes

```
server.js
│
├── Middleware
│   ├── CORS
│   ├── JSON Parser
│   └── dotenv config
│
├── Initialization
│   ├── Spotify API client
│   └── Anthropic API client
│
├── Routes
│   ├── GET /api/auth/spotify
│   │   └── Returns Spotify OAuth URL
│   │
│   ├── GET /callback
│   │   ├── Receives auth code from Spotify
│   │   ├── Exchanges for access tokens
│   │   ├── Stores tokens in memory
│   │   └── Redirects to frontend
│   │
│   ├── POST /api/generate-playlist
│   │   ├── Receives: prompt, userId
│   │   ├── Step 1: AI prompt analysis
│   │   ├── Step 2: Spotify search
│   │   ├── Step 3: Duplicate removal
│   │   ├── Step 4: AI curation
│   │   └── Returns: curated playlist
│   │
│   ├── POST /api/create-playlist
│   │   ├── Receives: userId, name, description, tracks
│   │   ├── Gets user's Spotify ID
│   │   ├── Creates playlist
│   │   ├── Adds tracks
│   │   └── Returns: playlist URL
│   │
│   └── GET /api/health
│       └── Returns: server status
│
└── Server Listen (Port 3001)
```

## Data Structures

### Frontend State

```javascript
{
  prompt: "Early 2000's pop music",
  userId: "user_1234567890",
  isAuthenticated: true,
  loading: false,
  generatedPlaylist: {
    playlistName: "Y2K Pop Hits",
    description: "The best pop music from 2000-2009",
    trackCount: 28,
    tracks: [
      {
        id: "spotify_track_id",
        name: "Oops!...I Did It Again",
        artist: "Britney Spears",
        uri: "spotify:track:...",
        album: "Oops!...I Did It Again",
        image: "https://..."
      },
      // ... more tracks
    ]
  },
  error: null
}
```

### Backend Token Storage

```javascript
userTokens = Map {
  "user_1234567890" => {
    access_token: "BQC...",
    refresh_token: "AQD..."
  }
}
```

### AI Response Structure

**Step 1 - Prompt Analysis:**
```json
{
  "playlistName": "Y2K Pop Hits",
  "description": "The best pop music from 2000-2009",
  "searchQueries": [
    "britney spears 2000",
    "NSYNC pop",
    "christina aguilera 2000s",
    "backstreet boys",
    "pink 2000s",
    "nelly furtado",
    "avril lavigne pop",
    "justin timberlake 2000s",
    "kelly clarkson 2002",
    "beyonce early 2000s",
    "usher 2004",
    "maroon 5 this love",
    "black eyed peas 2000s",
    "rihanna 2005",
    "50 cent in da club"
  ]
}
```

**Step 2 - Track Curation:**
```json
[1, 5, 7, 12, 15, 18, 22, 25, 28, 31, ...]
// Indices of selected tracks
```

## API Integration Details

### Spotify API

**Endpoints Used:**
- `POST /api/token` - Get access tokens
- `GET /v1/me` - Get user profile
- `GET /v1/search` - Search for tracks
- `POST /v1/users/{id}/playlists` - Create playlist
- `POST /v1/playlists/{id}/tracks` - Add tracks

**Rate Limits:**
- 429 Too Many Requests if exceeded
- App includes delays between requests

### Anthropic Claude API

**Model Used:** `claude-sonnet-4-20250514`

**Parameters:**
- `max_tokens`: 1000-2000
- `messages`: User prompts
- Temperature: Default

**Use Cases:**
1. Analyze user prompt
2. Generate search queries
3. Curate final track selection

## Security Considerations

### Current Implementation (Development)
- Tokens stored in memory (Map)
- User IDs are temporary
- No persistent sessions

### Production Recommendations
1. Use proper database for tokens
2. Implement user sessions with Redis
3. Add JWT authentication
4. Use HTTPS only
5. Implement token refresh logic
6. Rate limiting on API endpoints
7. Input validation and sanitization
8. Encrypt sensitive data at rest

## Performance Optimization

### Current Implementation
- 100ms delay between Spotify searches
- Duplicate checking with Set
- Limited to 5 tracks per search query

### Potential Improvements
1. Cache search results
2. Batch Spotify API calls
3. Implement pagination
4. Use Redis for session storage
5. Add CDN for static assets
6. Implement service workers
7. Lazy load track images

## Error Handling

### Frontend
- Display user-friendly error messages
- Catch network errors
- Handle authentication failures
- Validate user input

### Backend
- Try-catch blocks around API calls
- Log errors to console
- Return descriptive error messages
- Handle rate limiting gracefully

## Monitoring & Logging

### Current Logging
```javascript
console.log('Generating playlist for prompt:', prompt);
console.log('AI generated:', aiData);
console.log(`Found ${allTracks.length} unique tracks`);
console.log(`Selected ${selectedTracks.length} tracks`);
```

### Production Logging (Recommended)
- Winston or Pino for structured logging
- Log levels: error, warn, info, debug
- Log to files and external services
- Track API usage and errors
- Monitor response times

## Scaling Considerations

### Current Limits
- In-memory token storage
- Single server instance
- No load balancing

### Scaling Strategy
1. Database for user data (PostgreSQL/MongoDB)
2. Redis for session management
3. Message queue for playlist generation (RabbitMQ)
4. Multiple backend instances
5. Load balancer (Nginx)
6. Separate microservices:
   - Auth service
   - Playlist generation service
   - Spotify integration service

Happy building! 🚀
