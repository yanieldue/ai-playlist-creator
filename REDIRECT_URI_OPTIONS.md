# Spotify Redirect URI - Multiple Working Options

## If Spotify Won't Accept http://localhost:3001/callback

Try these alternatives in order until one works:

---

## **Option 1: Standard Port 8888 (Most Compatible)**

### Spotify Dashboard:
```
http://localhost:8888/callback
```

### backend/.env:
```env
SPOTIFY_CLIENT_ID=your_client_id
SPOTIFY_CLIENT_SECRET=your_client_secret
SPOTIFY_REDIRECT_URI=http://localhost:8888/callback
PORT=8888
FRONTEND_URL=http://localhost:3000
ANTHROPIC_API_KEY=your_anthropic_key
```

### Start Backend:
```bash
cd backend
npm run dev
```

---

## **Option 2: Use 127.0.0.1**

### Spotify Dashboard:
```
http://127.0.0.1:3001/callback
```

### backend/.env:
```env
SPOTIFY_REDIRECT_URI=http://127.0.0.1:3001/callback
PORT=3001
```

---

## **Option 3: No Port (Port 80)**

### Spotify Dashboard:
```
http://localhost/callback
```

### backend/.env:
```env
SPOTIFY_REDIRECT_URI=http://localhost/callback
PORT=80
```

### Start Backend (needs sudo):
```bash
cd backend
sudo npm run dev
```

---

## **Option 4: Alternative Port 8080**

### Spotify Dashboard:
```
http://localhost:8080/callback
```

### backend/.env:
```env
SPOTIFY_REDIRECT_URI=http://localhost:8080/callback
PORT=8080
```

---

## **Option 5: Just Root Path**

### Spotify Dashboard:
```
http://localhost:3001
```

### backend/.env:
```env
SPOTIFY_REDIRECT_URI=http://localhost:3001
PORT=3001
```

Then update server.js callback route from `/callback` to `/`

---

## **Testing Each Option**

After trying each option:

1. Add URI in Spotify Dashboard
2. Click "Add"
3. Click "Save" at bottom
4. Update backend/.env to match
5. Restart backend
6. Test at http://localhost:3000

---

## **Which One Should I Use?**

### **Recommended: Option 1 (Port 8888)**
- Most compatible with Spotify
- Standard OAuth testing port
- No special permissions needed

### If that fails: Option 2 (127.0.0.1)
- IP address instead of localhost
- Sometimes more reliable

### If all fail: Contact me with the exact error message!

---

## **Current Working Configuration**

Once you find what works, write it here:

```
✅ Working Redirect URI: _______________________

Used in:
- Spotify Dashboard: _______________________
- backend/.env: _______________________
- Backend Port: _______________________
```
