# 🎵 Spotify Redirect URI Configuration Guide

## 📋 Official Spotify Requirements

Based on Spotify's official documentation at:
https://developer.spotify.com/documentation/web-api/concepts/redirect_uri

---

## ✅ **Allowed Redirect URIs for Development**

Spotify allows these formats for local development:

### Option 1: HTTP Localhost (Recommended for This App)
```
http://localhost:3001/callback
```

### Option 2: HTTP with Port
```
http://localhost:3001/callback
```

### Option 3: HTTP 127.0.0.1
```
http://127.0.0.1:3001/callback
```

**Note:** Spotify allows `http://` for localhost/127.0.0.1 in development, but requires `https://` for production domains.

---

## 🔧 **Correct Setup for This Application**

### Step 1: Spotify Developer Dashboard

1. Go to https://developer.spotify.com/dashboard
2. Select your app (or create one)
3. Click **"Edit Settings"**
4. Scroll to **"Redirect URIs"**
5. Add **EXACTLY** (copy-paste this):
   ```
   http://localhost:3001/callback
   ```
6. Click **"Add"**
7. Click **"Save"** at the bottom

**Important:**
- ✅ Use `http://` (not `https://`) for localhost
- ✅ Include the port `:3001`
- ✅ Include the path `/callback`
- ❌ NO trailing slash
- ❌ NO query parameters

### Step 2: Backend Configuration

Edit `backend/.env`:

```env
SPOTIFY_CLIENT_ID=your_client_id_here
SPOTIFY_CLIENT_SECRET=your_client_secret_here
SPOTIFY_REDIRECT_URI=http://localhost:3001/callback

ANTHROPIC_API_KEY=your_anthropic_key_here
PORT=3001
FRONTEND_URL=http://localhost:3000
```

**Critical:** The `SPOTIFY_REDIRECT_URI` must EXACTLY match what you added in the Spotify Dashboard.

---

## 🚫 **Common Mistakes to Avoid**

### ❌ Wrong: HTTPS on localhost
```
https://localhost:3001/callback
```
**Why wrong:** Localhost doesn't have SSL certificate, Spotify allows HTTP for localhost

### ❌ Wrong: Missing port
```
http://localhost/callback
```
**Why wrong:** Must specify the port `:3001`

### ❌ Wrong: Trailing slash
```
http://localhost:3001/callback/
```
**Why wrong:** Extra slash causes mismatch

### ❌ Wrong: Different port
```
http://localhost:3000/callback
```
**Why wrong:** Must match backend port (3001, not frontend 3000)

### ❌ Wrong: No protocol
```
localhost:3001/callback
```
**Why wrong:** Must include `http://`

---

## 🔍 **Understanding Redirect URI Validation**

Spotify validates redirect URIs by:

1. **Exact String Match** - Must match character-for-character
2. **Protocol Check** - HTTP allowed for localhost, HTTPS required for production
3. **Whitelist Check** - URI must be in your app's redirect URI list

### How OAuth Flow Works:

```
User clicks "Connect with Spotify"
        ↓
Frontend requests auth URL from backend
        ↓
Backend generates Spotify OAuth URL with redirect_uri parameter
        ↓
User redirected to Spotify login
        ↓
User authorizes app
        ↓
Spotify validates redirect_uri is in whitelist
        ↓
Spotify redirects to: http://localhost:3001/callback?code=...
        ↓
Backend receives request at /callback route
        ↓
Backend exchanges code for access token
        ↓
Backend redirects to frontend with userId
```

---

## 🛡️ **Security Considerations**

### For Development (Current Setup)
- ✅ HTTP is acceptable for localhost
- ✅ Data doesn't leave your computer
- ✅ Standard practice for local dev

### For Production (Future Deployment)
You MUST change to:
```
https://yourdomain.com/callback
```

**Production Requirements:**
1. ✅ Use HTTPS (required by Spotify)
2. ✅ Valid SSL certificate
3. ✅ Real domain name
4. ✅ Update Spotify Dashboard with production URI
5. ✅ Update backend .env with production URI

---

## 🧪 **Testing Your Configuration**

### 1. Verify Spotify Dashboard
```bash
# Check your redirect URIs list includes:
http://localhost:3001/callback
```

### 2. Verify Backend .env
```bash
cd backend
cat .env | grep SPOTIFY_REDIRECT_URI

# Should output:
# SPOTIFY_REDIRECT_URI=http://localhost:3001/callback
```

### 3. Test Backend Server
```bash
cd backend
npm run dev

# Should see:
# 🎵 AI Playlist Creator Backend running on port 3001
```

### 4. Test Auth URL Generation
Open browser console at `http://localhost:3000` and run:
```javascript
fetch('http://localhost:3001/api/auth/spotify')
  .then(r => r.json())
  .then(data => console.log(data.url))
```

Should output URL containing:
```
...redirect_uri=http%3A%2F%2Flocalhost%3A3001%2Fcallback...
```
(URL-encoded version of `http://localhost:3001/callback`)

### 5. Test Complete Flow
1. Start both servers
2. Go to `http://localhost:3000`
3. Click "Connect with Spotify"
4. Authorize on Spotify
5. Should redirect back successfully

---

## ❗ **Troubleshooting Redirect URI Issues**

### Error: "INVALID_CLIENT: Invalid redirect URI"

**Cause:** Redirect URI doesn't match Spotify Dashboard

**Solution:**
1. Copy from Spotify Dashboard EXACTLY
2. Paste into backend/.env
3. Ensure no extra spaces or characters
4. Restart backend server

### Error: "redirect_uri_mismatch"

**Cause:** URI in request doesn't match whitelist

**Solution:**
```bash
# 1. Check Spotify Dashboard whitelist
# 2. Check backend/.env file
# 3. Verify they EXACTLY match
# 4. Restart backend server
```

### Error: "Cannot GET /callback"

**Cause:** Backend not running or route not set up

**Solution:**
```bash
cd backend
npm run dev
# Verify server starts successfully
```

### Browser Shows "Not Secure" Warning

**This is NORMAL and SAFE** for localhost development
- Spotify allows HTTP for localhost
- Your data doesn't leave your computer
- Standard development practice
- Will use HTTPS in production

---

## 📱 **Multiple Redirect URIs (Optional)**

You can add multiple redirect URIs in Spotify Dashboard:

```
http://localhost:3001/callback          (for development)
http://127.0.0.1:3001/callback          (alternative local)
https://yourdomain.com/callback         (for production)
https://staging.yourdomain.com/callback (for staging)
```

**Just ensure your backend .env uses the correct one for your environment!**

---

## 🌐 **For Production Deployment**

When you deploy to production:

### 1. Update Spotify Dashboard
Add production URI:
```
https://yourdomain.com/callback
```

### 2. Update Backend Environment Variables
```env
SPOTIFY_REDIRECT_URI=https://yourdomain.com/callback
FRONTEND_URL=https://yourdomain.com
```

### 3. Ensure HTTPS
- Use SSL certificate (Let's Encrypt, Cloudflare, etc.)
- Configure reverse proxy (Nginx, Apache)
- Update DNS settings

### 4. Test Thoroughly
- Test OAuth flow in production
- Verify redirect works
- Check for CORS issues

---

## ✅ **Quick Verification Checklist**

Before testing authentication:

- [ ] Spotify Dashboard has `http://localhost:3001/callback` in Redirect URIs
- [ ] Clicked "Save" in Spotify Dashboard
- [ ] Backend .env has `SPOTIFY_REDIRECT_URI=http://localhost:3001/callback`
- [ ] No trailing slashes anywhere
- [ ] Backend running on port 3001
- [ ] Frontend running on port 3000
- [ ] No typos in the URI

**If all checked, the OAuth flow should work perfectly!**

---

## 📚 **Additional Resources**

- **Spotify Authorization Guide**: https://developer.spotify.com/documentation/web-api/concepts/authorization
- **Spotify Redirect URI Docs**: https://developer.spotify.com/documentation/web-api/concepts/redirect_uri
- **OAuth 2.0 Spec**: https://oauth.net/2/

---

## 💡 **Key Takeaways**

1. ✅ `http://localhost:3001/callback` is CORRECT and SAFE for development
2. ✅ Spotify officially allows HTTP for localhost
3. ✅ "Not secure" warning is normal and expected
4. ✅ Must match EXACTLY between Dashboard and .env
5. ✅ Production requires HTTPS with real domain

**Your configuration is correct as long as it matches exactly in both places!** 🎵

---

Need more help? Check TROUBLESHOOTING.md or README.md in your project!
