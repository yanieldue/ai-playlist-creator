const fs = require('fs');
const path = require('path');

const tokensFile = path.join(__dirname, '.tokens.json');
const usersFile = path.join(__dirname, '.users.json');

// Read the files
let tokens = JSON.parse(fs.readFileSync(tokensFile, 'utf8'));
let users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));

const oldUserId = 'spotify_1213022391';

// Delete the tokens
if (tokens[oldUserId]) {
  console.log(`Permanently deleting tokens for ${oldUserId}`);
  delete tokens[oldUserId];
  fs.writeFileSync(tokensFile, JSON.stringify(tokens, null, 2));
  console.log('✓ Tokens deleted');
}

// Make sure all users with this userId have it set to null
let updatedUsers = false;
for (const email in users) {
  if (users[email].userId === oldUserId) {
    console.log(`Clearing userId for ${email}`);
    users[email].userId = null;
    if (!users[email].connectedPlatforms) {
      users[email].connectedPlatforms = {};
    }
    users[email].connectedPlatforms.spotify = false;
    users[email].connectedPlatforms.apple = false;
    updatedUsers = true;
  }
}

if (updatedUsers) {
  fs.writeFileSync(usersFile, JSON.stringify(users, null, 2));
  console.log('✓ User records updated');
}

console.log('\n✓ Done! The old tokens are permanently removed.');
console.log('You MUST do the following in your browser:');
console.log('1. Open browser console (F12)');
console.log('2. Run: localStorage.clear()');
console.log('3. Refresh the page');
console.log('4. Log back in and connect to Spotify');
