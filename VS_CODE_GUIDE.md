# VS Code Setup Guide for AI Playlist Creator

## Opening the Project in VS Code

### Method 1: From Terminal
```bash
# Navigate to the project folder
cd path/to/ai-playlist-creator

# Open in VS Code
code .
```

### Method 2: From VS Code
1. Open VS Code
2. File → Open Folder
3. Navigate to `ai-playlist-creator` folder
4. Click "Select Folder"

## Recommended VS Code Extensions

Install these for better development experience:

1. **ES7+ React/Redux/React-Native snippets**
   - Publisher: dsznajder
   - For React development shortcuts

2. **ESLint**
   - Publisher: Microsoft
   - Code quality and linting

3. **Prettier - Code formatter**
   - Publisher: Prettier
   - Auto-format code

4. **REST Client**
   - Publisher: Humao
   - Test API endpoints

5. **npm Intellisense**
   - Publisher: Christian Kohler
   - Autocomplete npm modules

## VS Code Terminal Setup

### Opening Multiple Terminals

1. **Terminal 1 - Backend**
   ```bash
   cd backend
   npm run dev
   ```

2. **Terminal 2 - Frontend**
   - Click the "+" icon in terminal panel (or Ctrl+Shift+`)
   ```bash
   cd frontend
   npm start
   ```

### Keyboard Shortcuts
- New Terminal: `Ctrl+Shift+` ` (Windows/Linux) or `Cmd+Shift+` ` (Mac)
- Split Terminal: `Ctrl+Shift+5` (Windows/Linux) or `Cmd+\` (Mac)
- Toggle Terminal: `Ctrl+` ` (Windows/Linux) or `Cmd+` ` (Mac)

## Project Workspace Layout

```
ai-playlist-creator/
├── 📁 backend/              # Backend server code
│   ├── server.js           # Main server file
│   ├── package.json        # Dependencies
│   └── .env                # API keys (you create this)
│
├── 📁 frontend/             # React frontend
│   ├── 📁 public/
│   │   └── index.html
│   ├── 📁 src/
│   │   ├── 📁 components/   # React components
│   │   ├── 📁 services/     # API calls
│   │   ├── 📁 styles/       # CSS files
│   │   ├── App.js
│   │   └── index.js
│   └── package.json
│
├── README.md               # Full documentation
├── QUICKSTART.md          # Quick setup guide
└── .gitignore             # Git ignore rules
```

## Editing Files in VS Code

### Backend Files to Edit

1. **backend/.env**
   - Add your API keys here
   - This file is gitignored (safe)

2. **backend/server.js**
   - Main server logic
   - API routes
   - AI integration

### Frontend Files to Edit

1. **frontend/src/components/PlaylistGenerator.js**
   - Main UI component
   - User interactions

2. **frontend/src/styles/PlaylistGenerator.css**
   - Visual styling
   - Colors and layouts

3. **frontend/src/services/api.js**
   - API communication
   - HTTP requests

## Running and Debugging

### Starting the Application

**Step 1: Start Backend**
```bash
# In VS Code terminal
cd backend
npm install          # First time only
npm run dev          # Start server
```

**Step 2: Start Frontend**
```bash
# In new VS Code terminal
cd frontend
npm install          # First time only
npm start            # Start React app
```

### Viewing Logs

- **Backend logs**: Check Terminal 1
- **Frontend logs**: Check Terminal 2 and Browser Console (F12)

### Common Commands

```bash
# Install dependencies
npm install

# Start development server
npm start           # Frontend
npm run dev         # Backend

# Clear cache (if issues)
npm cache clean --force
rm -rf node_modules
npm install
```

## Debugging Tips

### Backend Debugging

1. Add console.log statements in server.js:
```javascript
console.log('User prompt:', prompt);
console.log('AI response:', aiResponse);
console.log('Found tracks:', allTracks.length);
```

2. Check terminal for errors
3. Test API endpoints with REST Client or Postman

### Frontend Debugging

1. Open Browser DevTools (F12)
2. Check Console tab for errors
3. Check Network tab for API calls
4. Use React DevTools extension

### Environment Issues

**Backend won't start:**
```bash
# Check .env file exists and has all keys
cat .env

# Check port availability
lsof -i :3001

# Reinstall dependencies
rm -rf node_modules
npm install
```

**Frontend won't start:**
```bash
# Check backend is running first
curl http://localhost:3001/api/health

# Clear React cache
rm -rf node_modules
npm cache clean --force
npm install
```

## VS Code Settings (Optional)

Create `.vscode/settings.json` in project root:

```json
{
  "editor.formatOnSave": true,
  "editor.defaultFormatter": "esbenp.prettier-vscode",
  "javascript.updateImportsOnFileMove.enabled": "always",
  "editor.codeActionsOnSave": {
    "source.fixAll.eslint": true
  }
}
```

## Git Integration

### Initial Commit
```bash
git init
git add .
git commit -m "Initial commit: AI Playlist Creator"
```

### Useful Git Commands in VS Code Terminal
```bash
git status              # Check changes
git add .               # Stage all changes
git commit -m "message" # Commit changes
git log                 # View history
```

## Troubleshooting in VS Code

### Terminal Not Working
- Try: Terminal → New Terminal
- Or restart VS Code

### File Changes Not Detected
- Save all files: File → Save All (Ctrl+K S)
- Restart development servers

### Ports Already in Use
```bash
# Kill process on port 3001 (backend)
npx kill-port 3001

# Kill process on port 3000 (frontend)
npx kill-port 3000
```

## Productivity Tips

1. **Use Command Palette**: `Ctrl+Shift+P` (Windows/Linux) or `Cmd+Shift+P` (Mac)
2. **Quick File Open**: `Ctrl+P` (Windows/Linux) or `Cmd+P` (Mac)
3. **Split Editor**: Drag file tabs to split view
4. **Zen Mode**: View → Appearance → Zen Mode (distraction-free)
5. **Search Across Files**: `Ctrl+Shift+F` (Windows/Linux) or `Cmd+Shift+F` (Mac)

## Next Steps

1. Set up your API keys in `backend/.env`
2. Open two terminals in VS Code
3. Start backend and frontend
4. Open http://localhost:3000 in browser
5. Start creating playlists!

Happy coding! 🎵💻
