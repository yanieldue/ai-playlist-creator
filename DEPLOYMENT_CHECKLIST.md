# Deployment Checklist

## ✅ What's Ready

- [x] PostgreSQL database module created
- [x] Server auto-detects PostgreSQL vs SQLite
- [x] Migration script ready to transfer data
- [x] .gitignore configured to protect sensitive data
- [x] Frontend already configured for environment-based API URLs

## 📋 Next Steps (Do These in Order)

### 1. Push Code to GitHub

```bash
cd /Users/danielyue/Desktop/ai-playlist-creator

# Initialize git (if not already done)
git init

# Add all files
git add .

# Commit
git commit -m "Add PostgreSQL support and prepare for deployment"

# Create a new repository on GitHub
# Then connect it:
git remote add origin https://github.com/YOUR_USERNAME/ai-playlist-creator.git
git branch -M main
git push -u origin main
```

### 2. Deploy Backend to Railway

1. Go to https://railway.app
2. Sign up/login with GitHub
3. Click "New Project"
4. Choose "Provision PostgreSQL" (creates database)
5. In same project, click "+ New"
6. Choose "GitHub Repo" and select `ai-playlist-creator`
7. Railway auto-detects Node.js

**Configure Service:**
- Settings > Root Directory: `backend`
- Settings > Start Command: `node server.js`

**Add Environment Variables:**
Go to Variables tab and add:
```
SPOTIFY_CLIENT_ID=<from Spotify Dashboard>
SPOTIFY_CLIENT_SECRET=<from Spotify Dashboard>
SPOTIFY_REDIRECT_URI=https://YOUR-APP.up.railway.app/callback
ANTHROPIC_API_KEY=<your key>
NODE_ENV=production
PORT=3001
```

**Link Database:**
- Variables tab > "+ New Variable" > "Add Reference"
- Select PostgreSQL > DATABASE_URL
- This connects your app to the database

### 3. Update Spotify Developer Dashboard

1. Go to https://developer.spotify.com/dashboard
2. Click your app
3. "Edit Settings"
4. Add to Redirect URIs:
   ```
   https://YOUR-APP.up.railway.app/callback
   ```
5. Save

### 4. Deploy (Railway does this automatically!)

Once you push to GitHub, Railway auto-deploys. Watch the logs in Railway dashboard.

### 5. Migrate Your Data to Production Database

After Railway deployment succeeds:

```bash
# Get your Railway DATABASE_URL
# Railway Dashboard > PostgreSQL > Connect > Copy "Database URL"

# Run migration locally
cd backend
DATABASE_URL="postgresql://..." node migrate-sqlite-to-postgres.js
```

This copies all your users from SQLite to Railway's PostgreSQL!

### 6. Deploy Frontend to Vercel

**Create production environment file:**
```bash
cd frontend
echo "REACT_APP_API_URL=https://YOUR-APP.up.railway.app" > .env.production
```

**Deploy:**
1. Go to https://vercel.com
2. Sign up/login with GitHub
3. "New Project"
4. Import `ai-playlist-creator`
5. Configure:
   - Root Directory: `frontend`
   - Framework: Create React App
   - Build Command: `npm run build`
   - Output: `build`
6. Environment Variables:
   - `REACT_APP_API_URL` = `https://YOUR-APP.up.railway.app`
7. Deploy!

### 7. Test Your Live App!

1. Visit your Vercel URL (e.g., `https://your-app.vercel.app`)
2. Create an account
3. Connect Spotify
4. Generate a playlist!

### 8. Optional: Add Custom Domain

**Backend (Railway):**
- Settings > Domains > Add custom domain
- Point your DNS to Railway

**Frontend (Vercel):**
- Settings > Domains > Add domain
- Follow Vercel's DNS instructions

## 🆘 Troubleshooting

### "Database connection failed"
- Check that DATABASE_URL is linked in Railway Variables
- Look at Railway logs for specific error

### "Spotify redirect URI mismatch"
- Verify exact URL in Spotify Dashboard matches Railway URL
- Include `/callback` at the end

### "CORS error" in browser
- Update server.js CORS to include your Vercel URL
- Push change to GitHub (Railway auto-deploys)

### Frontend shows blank page
- Check browser console for errors
- Verify REACT_APP_API_URL in Vercel env variables
- Check that backend is running in Railway

## 💰 Estimated Costs

- Railway: $5/month free credit → ~$5-10/month after
- Vercel: FREE for hobby projects
- **Total: ~$0-10/month**

## 📚 Resources

- Railway Docs: https://docs.railway.app
- Vercel Docs: https://vercel.com/docs
- Detailed guide: See `backend/RAILWAY_DEPLOYMENT.md`

---

## Ready to Deploy?

1. Have your Spotify Client ID & Secret ready
2. Have your Anthropic API key ready
3. Create GitHub account if you don't have one
4. Follow steps 1-7 above!

Let me know when you're ready and I can help with any step!
