# Railway Deployment Guide

## What We've Done

✅ Installed PostgreSQL support (`pg` package)
✅ Created PostgreSQL database module (`database-postgres.js`)
✅ Updated `server.js` to auto-detect PostgreSQL via `DATABASE_URL` environment variable
✅ Your app now works with both SQLite (local) and PostgreSQL (production)

## Deployment Steps

### Step 1: Create Railway Account & Project

1. Go to https://railway.app
2. Sign up with GitHub
3. Click "New Project"
4. Choose "Provision PostgreSQL"
5. A PostgreSQL database will be created

### Step 2: Add Your Backend Code

1. In the same project, click "New Service"
2. Choose "Deploy from GitHub repo"
3. Select your `ai-playlist-creator` repository (you'll need to push to GitHub first)
4. Railway will detect it's a Node.js app

### Step 3: Configure Backend Service

1. Click on your backend service
2. Go to "Settings" tab
3. Set "Root Directory" to `backend`
4. Set "Start Command" to `node server.js`

### Step 4: Add Environment Variables

In your backend service, go to "Variables" tab and add:

```
SPOTIFY_CLIENT_ID=your_spotify_client_id
SPOTIFY_CLIENT_SECRET=your_spotify_client_secret
SPOTIFY_REDIRECT_URI=https://your-backend.railway.app/callback
ANTHROPIC_API_KEY=your_anthropic_api_key
NODE_ENV=production
PORT=3001
```

**Important:** Railway automatically provides `DATABASE_URL` - you don't need to add it!

### Step 5: Connect Database to Backend

1. In your backend service, go to "Variables" tab
2. Click "New Variable" > "Add Reference"
3. Select your PostgreSQL database
4. Choose `DATABASE_URL`
5. This links your backend to the database

### Step 6: Get Your Backend URL

1. In your backend service, go to "Settings" > "Domains"
2. Click "Generate Domain"
3. You'll get a URL like: `https://your-backend-production.up.railway.app`
4. Copy this URL - you'll need it for:
   - Spotify Developer Dashboard (add `/callback` to redirect URIs)
   - Frontend deployment

### Step 7: Update Spotify Developer Settings

1. Go to https://developer.spotify.com/dashboard
2. Select your app
3. Click "Edit Settings"
4. Add to "Redirect URIs":
   - `https://your-backend.railway.app/callback`
5. Save

### Step 8: Migrate Data to Railway PostgreSQL

After deployment, run this locally to migrate your data:

```bash
# First, get your Railway DATABASE_URL
# In Railway: Click your PostgreSQL service > Connect > Copy DATABASE_URL

# Set it temporarily
export DATABASE_URL="your_railway_database_url"

# Run migration
node migrate-sqlite-to-postgres.js
```

Your users and settings will now be in production!

## Deploy Frontend to Vercel

### Step 1: Create `.env.production`

Create `frontend/.env.production`:
```
REACT_APP_API_URL=https://your-backend.railway.app
```

### Step 2: Deploy to Vercel

1. Go to https://vercel.com
2. Sign up with GitHub
3. Click "New Project"
4. Import your `ai-playlist-creator` repository
5. Configure:
   - Framework Preset: Create React App
   - Root Directory: `frontend`
   - Build Command: `npm run build`
   - Output Directory: `build`
6. Add Environment Variables:
   - `REACT_APP_API_URL` = your Railway backend URL
7. Deploy!

### Step 3: Update CORS in Backend

After getting your Vercel URL, update `backend/server.js` CORS settings:

```javascript
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      'https://your-app.vercel.app', // Add your Vercel URL
      'http://localhost:3000'
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(null, true); // Allow all for now, restrict later
  },
  credentials: true
}));
```

Push this change to GitHub - Railway will auto-deploy!

## Testing Your Deployment

1. Visit your Vercel frontend URL
2. Try signing up and connecting Spotify
3. Check Railway logs for any errors:
   - Railway Dashboard > Your Service > Logs

## Costs

- **Railway**: First $5/month free, then ~$5-10/month for small apps
- **Vercel**: Free for hobby projects
- **Total**: ~$0-10/month to start

## Troubleshooting

### Database Connection Issues
- Check that DATABASE_URL is set in Railway
- Look at Railway logs for connection errors

### Spotify OAuth Not Working
- Verify callback URL matches in Spotify Dashboard and Railway environment variables
- Check that SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET are set

### Frontend Can't Connect to Backend
- Verify REACT_APP_API_URL is set correctly
- Check CORS settings in server.js
- Look at browser console for CORS errors

## Need Help?

Railway has great documentation: https://docs.railway.app
Vercel documentation: https://vercel.com/docs

---

## Optional: Custom Domain

### For Backend (Railway)
1. Railway Dashboard > Your Service > Settings > Domains
2. Add custom domain (e.g., api.yourdomain.com)
3. Add DNS records as shown by Railway

### For Frontend (Vercel)
1. Vercel Dashboard > Your Project > Settings > Domains
2. Add your domain
3. Follow DNS instructions

Then update all your Spotify callback URLs and environment variables!
