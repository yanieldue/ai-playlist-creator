# Quick Start Guide - AI Playlist Creator

## 🚀 Get Started in 5 Minutes

### 1. Get Your API Keys

**Spotify (2 minutes):**
1. Visit https://developer.spotify.com/dashboard
2. Click "Create an App"
3. Name it "AI Playlist Creator"
4. Copy your Client ID and Client Secret
5. In Settings, add redirect URI: `http://127.0.0.1:3001/callback`

**Anthropic (1 minute):**
1. Visit https://console.anthropic.com/
2. Sign up or log in
3. Go to API Keys section
4. Create a new key and copy it

### 2. Setup Backend (2 minutes)

```bash
# Navigate to backend folder
cd backend

# Install dependencies
npm install

# Create .env file from example
cp .env.example .env

# Edit .env and paste your keys:
# SPOTIFY_CLIENT_ID=paste_here
# SPOTIFY_CLIENT_SECRET=paste_here
# ANTHROPIC_API_KEY=paste_here
```

### 3. Setup Frontend (1 minute)

```bash
# Open new terminal, navigate to frontend
cd frontend

# Install dependencies
npm install

# Copy .env example (no changes needed)
cp .env.example .env
```

### 4. Run the App

**Terminal 1 - Backend:**
```bash
cd backend
npm run dev
```
Wait for: `🎵 AI Playlist Creator Backend running on port 3001`

**Terminal 2 - Frontend:**
```bash
cd frontend
npm start
```
Browser opens automatically at http://localhost:3000

### 5. Create Your First Playlist!

1. Click "Connect with Spotify"
2. Authorize the app
3. Type: "Early 2000's pop music"
4. Click "Generate Playlist"
5. Watch the AI magic happen! ✨
6. Click "Create Playlist on Spotify"

## 🎯 Pro Tips

- Try specific artists: "Music similar to Taylor Swift and Joji"
- Use moods: "Chill indie vibes for studying"
- Describe activities: "Workout rap music at the gym"
- Mix eras: "90s R&B slow jams"
- Get creative: "Road trip sing-along hits from the 2010s"

## ⚠️ Common Issues

**"User not authenticated"**
→ Refresh page and reconnect Spotify

**Backend won't start**
→ Check that port 3001 is free
→ Verify .env file has all keys

**Frontend shows errors**
→ Make sure backend is running first
→ Check backend terminal for errors

## 📱 Using the App

1. **Connect**: One-time Spotify authorization
2. **Describe**: Tell AI what you want
3. **Generate**: AI finds perfect songs
4. **Create**: Saves to your Spotify
5. **Enjoy**: Open in Spotify app

## 🎵 Example Prompts to Try

- "Early 2000's pop music"
- "Workout rap music at the gym"  
- "Music similar to Taylor Swift and Joji"
- "Chill indie vibes for studying"
- "90s R&B slow jams"
- "Electronic dance music for parties"

## 🔧 Need Help?

See the full README.md for detailed troubleshooting and documentation.

Happy playlist creating! 🎉
