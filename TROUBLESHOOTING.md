# 🔧 Troubleshooting Checklist

## Pre-Flight Checklist ✈️

Before starting, verify:

- [ ] Node.js installed (check: `node --version`)
- [ ] npm installed (check: `npm --version`)
- [ ] Spotify Developer account created
- [ ] Anthropic API account created
- [ ] VS Code installed (or your preferred editor)

## Setup Checklist 📋

### Backend Setup

- [ ] Navigated to `backend/` folder
- [ ] Ran `npm install` successfully
- [ ] Created `.env` file from `.env.example`
- [ ] Added `SPOTIFY_CLIENT_ID`
- [ ] Added `SPOTIFY_CLIENT_SECRET`
- [ ] Added `ANTHROPIC_API_KEY`
- [ ] Verified redirect URI: `http://localhost:3001/callback`
- [ ] Backend starts without errors (`npm run dev`)
- [ ] See message: "🎵 AI Playlist Creator Backend running on port 3001"

### Frontend Setup

- [ ] Navigated to `frontend/` folder
- [ ] Ran `npm install` successfully
- [ ] Created `.env` file (optional, defaults work)
- [ ] Frontend starts without errors (`npm start`)
- [ ] Browser opens to `http://localhost:3000`
- [ ] No console errors in browser (F12)

## Common Issues & Solutions 🔨

### Issue: "Cannot find module" errors

**Symptoms:**
```
Error: Cannot find module 'express'
```

**Solution:**
```bash
# Delete node_modules and reinstall
rm -rf node_modules
npm cache clean --force
npm install
```

---

### Issue: "Port already in use"

**Symptoms:**
```
Error: listen EADDRINUSE: address already in use :::3001
```

**Solution:**
```bash
# Option 1: Kill process on port
npx kill-port 3001
# or
npx kill-port 3000

# Option 2: Find and kill manually
# On Mac/Linux:
lsof -i :3001
kill -9 <PID>

# On Windows:
netstat -ano | findstr :3001
taskkill /PID <PID> /F
```

---

### Issue: "User not authenticated"

**Symptoms:**
- Error message after trying to generate playlist
- Says user not authenticated

**Solution:**
1. Clear browser localStorage:
   - Open Console (F12)
   - Type: `localStorage.clear()`
   - Press Enter
2. Refresh page
3. Click "Connect with Spotify" again
4. Authorize the app

---

### Issue: Spotify login redirects but doesn't work

**Symptoms:**
- Redirected back to app but still shows login button
- URL has `?error=auth_failed`

**Solution:**
1. Verify Spotify Dashboard settings:
   - Redirect URI MUST be exactly: `http://localhost:3001/callback`
   - No trailing slash
   - Check for typos
2. Check backend .env:
   - `SPOTIFY_REDIRECT_URI=http://localhost:3001/callback`
3. Restart backend server
4. Try login again

---

### Issue: "Failed to generate playlist"

**Symptoms:**
- Error after clicking generate
- Backend logs show errors

**Solution:**

**Check 1: Anthropic API Key**
```bash
# Verify key in .env
cat backend/.env | grep ANTHROPIC_API_KEY
```
- Key should start with "sk-ant-"
- Check you have credits at console.anthropic.com

**Check 2: Spotify Tokens**
- Make sure you've logged in with Spotify
- Check backend logs for "User not authenticated"

**Check 3: Network Issues**
- Backend logs may show API timeout
- Check your internet connection
- Try again in a few seconds

---

### Issue: No songs in generated playlist

**Symptoms:**
- Playlist generates but has 0 tracks
- Or very few tracks

**Solution:**
1. Try a more popular prompt:
   - Instead of: "Obscure indie bands from 2023"
   - Try: "Popular pop music"
2. Check backend logs:
   - Look for "Found X unique tracks"
   - Should show at least 20+
3. Try different search terms in your prompt

---

### Issue: Backend won't start

**Symptoms:**
```
Error: Cannot find module 'dotenv'
```
or
```
Error: ANTHROPIC_API_KEY is not defined
```

**Solution:**
```bash
# 1. Install dependencies
cd backend
npm install

# 2. Verify .env exists
ls -la .env

# 3. If not, create it
cp .env.example .env

# 4. Edit .env and add all required keys
nano .env  # or use VS Code

# 5. Try starting again
npm run dev
```

---

### Issue: Frontend shows blank white screen

**Symptoms:**
- Browser shows nothing
- Console shows errors

**Solution:**
1. Check browser console (F12):
   ```
   Look for red error messages
   ```

2. Common fixes:
   ```bash
   # Clear cache and reinstall
   cd frontend
   rm -rf node_modules package-lock.json
   npm cache clean --force
   npm install
   npm start
   ```

3. Check backend is running:
   ```bash
   curl http://localhost:3001/api/health
   # Should return: {"status":"OK",...}
   ```

---

### Issue: Playlist created but doesn't appear in Spotify

**Symptoms:**
- Success message appears
- Playlist not in Spotify app

**Solution:**
1. Refresh Spotify app/web player
2. Check "Your Library" → "Playlists"
3. Click the playlist URL from success message
4. Check Spotify app permissions:
   - Go to Account Settings → Apps
   - Verify "AI Playlist Creator" is connected

---

### Issue: "Failed to create playlist"

**Symptoms:**
- Error when clicking "Create Playlist on Spotify"

**Solution:**
1. Check Spotify token hasn't expired:
   - Refresh page
   - Try again
   - If fails, disconnect and reconnect Spotify

2. Verify playlist settings in server.js:
   ```javascript
   public: true  // Make sure this is set
   ```

3. Check Spotify app permissions:
   - Must have "playlist-modify-public"
   - Must have "playlist-modify-private"

---

### Issue: AI generates weird playlists

**Symptoms:**
- Songs don't match prompt
- Random unrelated songs

**Solution:**
1. Be more specific in prompt:
   - ❌ "Good music"
   - ✅ "Upbeat pop music from 2020s"

2. Include context:
   - ❌ "Workout music"
   - ✅ "High energy rap and EDM for intense gym workouts"

3. Use artist references:
   - ✅ "Music similar to Taylor Swift and Ariana Grande"

---

## Quick Diagnostic Commands 🔍

```bash
# Check if Node.js installed
node --version
npm --version

# Check if ports are available
lsof -i :3000  # Frontend
lsof -i :3001  # Backend

# Check backend health
curl http://localhost:3001/api/health

# View backend logs
# (Just look at the terminal where you ran npm run dev)

# Check environment variables (backend)
cd backend
cat .env

# Test Spotify connection (in browser console)
fetch('http://localhost:3001/api/auth/spotify')
  .then(r => r.json())
  .then(console.log)
```

## Debugging in VS Code 🐛

### Enable Detailed Logging

Add to `server.js`:
```javascript
// After: const anthropic = new Anthropic(...)
console.log('✅ Anthropic API initialized');

// In /api/generate-playlist route:
console.log('📝 Received prompt:', prompt);
console.log('🔑 User ID:', userId);

// After AI response:
console.log('🤖 AI Response:', JSON.stringify(aiData, null, 2));

// After Spotify search:
console.log('🎵 Found tracks:', allTracks.length);
console.log('📋 Track details:', allTracks.map(t => t.name));
```

### Browser Console Debugging

Press F12 and add in Console:
```javascript
// Enable detailed logging
localStorage.setItem('debug', 'true');

// Check stored userId
console.log('User ID:', localStorage.getItem('userId'));

// Test API connection
fetch('http://localhost:3001/api/health')
  .then(r => r.json())
  .then(console.log)
  .catch(console.error);
```

## Still Having Issues? 🆘

### Step-by-Step Reset

```bash
# 1. Stop all servers (Ctrl+C in both terminals)

# 2. Clear everything
cd backend
rm -rf node_modules package-lock.json
cd ../frontend
rm -rf node_modules package-lock.json

# 3. Clear npm cache
npm cache clean --force

# 4. Reinstall everything
cd ../backend
npm install
cd ../frontend
npm install

# 5. Verify .env files exist and are correct
cat backend/.env
cat frontend/.env

# 6. Restart everything
# Terminal 1:
cd backend && npm run dev

# Terminal 2:
cd frontend && npm start

# 7. Clear browser data
# Open browser console (F12)
# Application tab → Storage → Clear site data

# 8. Refresh browser
```

## Environment Variables Reference 📝

### Backend .env (Required)

```env
SPOTIFY_CLIENT_ID=your_client_id_from_spotify_dashboard
SPOTIFY_CLIENT_SECRET=your_client_secret_from_spotify_dashboard
SPOTIFY_REDIRECT_URI=http://localhost:3001/callback
ANTHROPIC_API_KEY=sk-ant-your_key_from_anthropic
PORT=3001
FRONTEND_URL=http://localhost:3000
```

### Frontend .env (Optional)

```env
REACT_APP_API_URL=http://localhost:3001
```

## Getting More Help 📞

If you're still stuck:

1. **Check the logs carefully**
   - Backend terminal shows server errors
   - Browser console (F12) shows frontend errors
   - Read the error messages completely

2. **Verify all prerequisites**
   - Node.js version 16+
   - Valid API keys
   - Correct Spotify redirect URI

3. **Try the example requests**
   - Use exact example prompts
   - Don't modify code yet
   - Get basic functionality working first

4. **Review documentation**
   - README.md - Comprehensive guide
   - ARCHITECTURE.md - How it works
   - VS_CODE_GUIDE.md - Editor setup

## Success Indicators ✅

You'll know everything is working when:

- ✅ Backend shows: "🎵 AI Playlist Creator Backend running on port 3001"
- ✅ Frontend opens browser automatically
- ✅ No red errors in browser console
- ✅ "Connect with Spotify" button appears
- ✅ Spotify login works and redirects back
- ✅ Example prompts are clickable
- ✅ Generate button works
- ✅ Playlist generates with songs
- ✅ Songs have album artwork
- ✅ Create button adds to Spotify
- ✅ Playlist opens in Spotify

## Prevention Tips 🛡️

Avoid future issues:

1. **Always start backend first**, then frontend
2. **Don't commit .env files** to git
3. **Keep dependencies updated** (but test first)
4. **Monitor API quotas** (Spotify, Anthropic)
5. **Check logs regularly** for warnings
6. **Test after any changes**
7. **Keep API keys secure**

---

**Remember:** Most issues are solved by:
1. Checking .env files are correct
2. Ensuring both servers are running
3. Clearing browser cache/localStorage
4. Reading error messages carefully

Happy troubleshooting! 🎉
