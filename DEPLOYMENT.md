# Deployment Guide

## Prerequisites
1. GitHub account
2. Vercel account (sign up at vercel.com)
3. Railway account (sign up at railway.app)

## Step 1: Push Code to GitHub

```bash
# Initialize git if not already done
git init

# Create .gitignore
cat > .gitignore << EOL
# Dependencies
node_modules/
.env
.env.local

# Database files
backend/.users.json
backend/.tokens.json
backend/.playlists.json
backend/.reactions.json
backend/.saved_playlists.json
backend/playlist-creator.db

# Logs
npm-debug.log*
yarn-debug.log*
yarn-error.log*

# Build
frontend/build/
.DS_Store
EOL

# Add and commit
git add .
git commit -m "Initial commit"

# Create repo on GitHub and push
# (Follow GitHub's instructions to create a new repository)
git remote add origin https://github.com/YOUR_USERNAME/ai-playlist-creator.git
git branch -M main
git push -u origin main
```

## Step 2: Deploy Backend to Railway

1. Go to https://railway.app
2. Click "New Project"
3. Choose "Deploy from GitHub repo"
4. Select your `ai-playlist-creator` repository
5. Railway will auto-detect it's a Node.js app
6. Add environment variables:
   - `SPOTIFY_CLIENT_ID`
   - `SPOTIFY_CLIENT_SECRET`
   - `SPOTIFY_REDIRECT_URI` (will be your Railway URL + /callback)
   - `ANTHROPIC_API_KEY`
   - `PORT` = 3001
7. Set the root directory to `backend`
8. Deploy!

Railway will give you a URL like: `https://your-app.railway.app`

**Update your Spotify App settings:**
- Go to https://developer.spotify.com/dashboard
- Add Railway callback URL: `https://your-app.railway.app/callback`

## Step 3: Deploy Frontend to Vercel

1. Create `frontend/.env.production`:
```
REACT_APP_API_URL=https://your-app.railway.app
```

2. Update `frontend/src/services/api.js` to use environment variable:
```javascript
const API_URL = process.env.REACT_APP_API_URL || 'http://localhost:3001';
```

3. Go to https://vercel.com
4. Click "New Project"
5. Import your GitHub repository
6. Set the root directory to `frontend`
7. Add environment variable:
   - `REACT_APP_API_URL` = your Railway backend URL
8. Deploy!

Vercel will give you a URL like: `https://your-app.vercel.app`

## Step 4: Update CORS Settings

Update `backend/server.js` CORS configuration:

```javascript
app.use(cors({
  origin: function(origin, callback) {
    const allowedOrigins = [
      'https://your-app.vercel.app',
      'http://localhost:3000',
      'http://localhost:3001'
    ];
    if (!origin || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    callback(new Error('Not allowed by CORS'));
  },
  credentials: true
}));
```

## Step 5: Custom Domain (Optional)

### Vercel (Frontend)
1. Buy domain from Namecheap, GoDaddy, etc.
2. In Vercel project settings > Domains
3. Add your domain and follow DNS instructions

### Railway (Backend)
1. In Railway project settings > Domains
2. Add custom domain for API (e.g., api.yourdomain.com)

## Alternative: All-in-One Deployment

If you want simpler deployment, you can serve the React build from Express:

1. Build React app: `cd frontend && npm run build`
2. Serve from Express in `backend/server.js`:
```javascript
// Serve React app
app.use(express.static(path.join(__dirname, '../frontend/build')));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/build/index.html'));
});
```
3. Deploy entire project to Railway or Render

## Cost Estimates

**Free Tier (Good for starting):**
- Vercel: Free (Hobby plan)
- Railway: $5/month credit (good for small apps)
- Total: ~$0-5/month

**Paid Tier (For production):**
- Vercel Pro: $20/month
- Railway: ~$10-20/month
- Total: ~$30-40/month

## Next Steps After Deployment

1. Set up monitoring (Railway/Vercel have built-in logs)
2. Add error tracking (Sentry.io)
3. Set up backups for your database
4. Consider migrating to PostgreSQL for better reliability
5. Add rate limiting to prevent abuse
6. Set up CI/CD for automatic deployments

## Need Help?

Let me know which deployment approach you prefer and I can help you set it up step by step!
