# ✅ Setup Guide - Using 127.0.0.1:3001/callback

Great choice! Using `127.0.0.1` is often more reliable than `localhost` with Spotify's OAuth.

---

## 🎯 **Your Configuration**

### Spotify Dashboard
```
http://127.0.0.1:3001/callback
```

### Backend Configuration
```env
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/callback
PORT=3001
```

---

## 📋 **Complete Setup Steps**

### Step 1: Spotify Dashboard ✅

1. Go to https://developer.spotify.com/dashboard
2. Open your app (or create new one)
3. Click **"Edit Settings"**
4. Under **"Redirect URIs"**, add:
   ```
   http://127.0.0.1:3001/callback
   ```
5. Click **"Add"**
6. Click **"Save"** at the bottom
7. Copy your **Client ID**
8. Click **"Show Client Secret"** and copy it

---

### Step 2: Backend Configuration

Navigate to the backend folder and create `.env` file:

```bash
cd backend
cp .env.example .env
```

Edit `backend/.env` with your credentials:

```env
# Spotify Credentials (from Dashboard)
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/callback

# Anthropic API Key (from console.anthropic.com)
ANTHROPIC_API_KEY=your_anthropic_key_here

# Server Configuration
PORT=3001
FRONTEND_URL=http://localhost:3000
```

**Important:** Replace the placeholder values with your actual keys!

---

### Step 3: Install Dependencies

If you haven't already:

```bash
# Backend
cd backend
npm install

# Frontend (in new terminal)
cd frontend
npm install
```

---

### Step 4: Start the Application

**Terminal 1 - Backend:**
```bash
cd backend
npm run dev
```

You should see:
```
🎵 AI Playlist Creator Backend running on port 3001
📝 Make sure to set up your .env file with API credentials
```

**Terminal 2 - Frontend:**
```bash
cd frontend
npm start
```

Browser should automatically open to: `http://localhost:3000`

---

## 🧪 **Testing Your Setup**

### 1. Check Backend is Running

Open a new terminal and run:
```bash
curl http://127.0.0.1:3001/api/health
```

Should return:
```json
{"status":"OK","timestamp":"..."}
```

### 2. Test OAuth URL Generation

In browser console at `http://localhost:3000`, run:
```javascript
fetch('http://localhost:3001/api/auth/spotify')
  .then(r => r.json())
  .then(data => console.log(data.url))
```

Should output a long URL containing:
```
...redirect_uri=http%3A%2F%2F127.0.0.1%3A3001%2Fcallback...
```
(URL-encoded version of your redirect URI)

### 3. Test Complete OAuth Flow

1. Go to `http://localhost:3000`
2. Click **"Connect with Spotify"**
3. Login to Spotify (if needed)
4. Click **"Agree"** to authorize
5. Should redirect back to app (URL will briefly show 127.0.0.1:3001)
6. Should land back at `http://localhost:3000` with login confirmed

---

## 🎮 **Using the App**

Once authenticated:

1. **Enter a prompt:**
   ```
   Early 2000's pop music
   ```
   Or click an example prompt

2. **Click "Generate Playlist"**
   - AI analyzes your prompt
   - Searches Spotify
   - Removes duplicates
   - Curates best tracks
   - Takes 10-30 seconds

3. **Review the playlist**
   - See track names, artists, album art
   - Verify it matches what you wanted

4. **Click "Create Playlist on Spotify"**
   - Saves to your Spotify account
   - Opens in Spotify

---

## 🔍 **Verifying Your Configuration**

### Check Spotify Dashboard
```
✅ Redirect URI: http://127.0.0.1:3001/callback
✅ Status: Active/Saved
✅ Client ID: Copied
✅ Client Secret: Copied
```

### Check backend/.env
```bash
cat backend/.env
```

Should show:
```
SPOTIFY_CLIENT_ID=BQC... (or similar)
SPOTIFY_CLIENT_SECRET=abc123... (or similar)
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/callback
ANTHROPIC_API_KEY=sk-ant-...
PORT=3001
FRONTEND_URL=http://localhost:3000
```

### Check Both Servers Running
```bash
# Terminal 1 should show:
🎵 AI Playlist Creator Backend running on port 3001

# Terminal 2 should show:
Compiled successfully!
Local: http://localhost:3000
```

---

## 💡 **Why 127.0.0.1 Works Better**

### localhost vs 127.0.0.1

**localhost** is a hostname that resolves to `127.0.0.1`

**127.0.0.1** is the actual IP address

### Why 127.0.0.1 is more reliable:

✅ **No DNS lookup** - Direct IP connection
✅ **More explicit** - Exact address, no ambiguity
✅ **Works with Spotify** - Better OAuth compatibility
✅ **Consistent** - Same behavior across systems

---

## 🆘 **Troubleshooting**

### Issue: "Invalid redirect_uri"

**Solution:**
1. Verify Spotify Dashboard shows: `http://127.0.0.1:3001/callback`
2. Verify backend/.env shows: `SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/callback`
3. Must match EXACTLY (no trailing slash, correct port)
4. Restart backend after any .env changes

### Issue: Backend won't start

**Solution:**
```bash
# Check if port 3001 is available
lsof -i :3001

# If in use, kill it:
npx kill-port 3001

# Then restart:
cd backend
npm run dev
```

### Issue: "User not authenticated"

**Solution:**
1. Clear browser localStorage:
   - Press F12 (open console)
   - Type: `localStorage.clear()`
   - Refresh page
2. Click "Connect with Spotify" again

### Issue: OAuth redirects but doesn't authenticate

**Solution:**
1. Check backend terminal for errors
2. Verify both servers are running
3. Check backend/.env has all required values
4. Restart both servers

---

## 📊 **Configuration Summary**

| Component | Value | Status |
|-----------|-------|--------|
| **Spotify Redirect URI** | http://127.0.0.1:3001/callback | ✅ |
| **Backend Port** | 3001 | ✅ |
| **Frontend Port** | 3000 | ✅ |
| **Backend URL** | http://127.0.0.1:3001 or http://localhost:3001 | ✅ |
| **Frontend URL** | http://localhost:3000 | ✅ |

**Both 127.0.0.1 and localhost work for accessing the backend from frontend!**

---

## 🎯 **Quick Reference Commands**

```bash
# Check backend .env
cat backend/.env

# Start backend
cd backend && npm run dev

# Start frontend (new terminal)
cd frontend && npm start

# Check backend health
curl http://127.0.0.1:3001/api/health

# View backend logs
# (just look at Terminal 1 where backend is running)

# Stop servers
# Press Ctrl+C in each terminal
```

---

## ✅ **You're All Set!**

Your configuration with `127.0.0.1:3001/callback` is optimal and should work perfectly!

**Next Steps:**
1. Make sure both servers are running
2. Go to `http://localhost:3000`
3. Click "Connect with Spotify"
4. Start creating amazing playlists! 🎵

---

**Need more help?** Check:
- **TROUBLESHOOTING.md** - Common issues
- **README.md** - Full documentation
- **QUICKSTART.md** - Fast setup guide

Happy playlist creating! 🎉
